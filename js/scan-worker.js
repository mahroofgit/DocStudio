// Scan pipeline (web port of ScanFilterManager.swift + DocumentDetector.swift).
//
// Order: perspective → illumination flattening → exposure → color controls → gamma
//        → monochrome / threshold → sharpening.
// Runs in a Web Worker so the canvas stays responsive while sliders move.

'use strict';

const proxies = new Map();   // asset id → { w, h, data: Uint8ClampedArray (RGBA) }

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'setProxy') {
      proxies.set(m.asset, { w: m.w, h: m.h, data: m.data });
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'dropProxy') {
      proxies.delete(m.asset);
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'process') {
      const src = m.data ? { w: m.w, h: m.h, data: m.data } : proxies.get(m.asset);
      if (!src) throw new Error('missing image data');
      const out = processImage(src, m.quad, m.settings);
      self.postMessage({ id: m.id, w: out.w, h: out.h, data: out.data }, [out.data.buffer]);
    } else if (m.type === 'detect') {
      const src = proxies.get(m.asset);
      if (!src) throw new Error('missing image data');
      self.postMessage({ id: m.id, quad: detectQuad(src) });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};

// ---------------------------------------------------------------- pipeline

function isFull(q) {
  if (!q) return true;
  const F = [[0, 0], [1, 0], [1, 1], [0, 1]];
  return q.every((p, i) => Math.abs(p[0] - F[i][0]) < 1e-4 && Math.abs(p[1] - F[i][1]) < 1e-4);
}

function isIdentity(s) {
  return !s || (s.mode === 'original' && s.exposure === 0 && s.contrast === 1 && s.saturation === 1 &&
    s.gamma === 1 && s.sharpness === 0);
}

function processImage(src, quad, s) {
  let img = src;
  if (!isFull(quad)) img = perspectiveCorrect(src, quad);
  if (isIdentity(s)) {
    if (img === src) return { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) };
    return img;
  }
  return applyFilters(img, s, img !== src);
}

/** Projective map from the unit square to the quad (Heckbert). */
function squareToQuad(P) {
  const [x0, y0] = P[0], [x1, y1] = P[1], [x2, y2] = P[2], [x3, y3] = P[3];
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return { a: x1 - x0, b: x3 - x0, c: x0, d: y1 - y0, e: y3 - y0, f: y0, g: 0, h: 0 };
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0, g, h,
  };
}

function perspectiveCorrect(src, quad) {
  const P = quad.map(([x, y]) => [x * src.w, y * src.h]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.round((dist(P[0], P[1]) + dist(P[3], P[2])) / 2);
  let H = Math.round((dist(P[0], P[3]) + dist(P[1], P[2])) / 2);
  W = Math.max(1, W); H = Math.max(1, H);
  const maxArea = 16000000;                       // iOS canvas limit
  if (W * H > maxArea) { const k = Math.sqrt(maxArea / (W * H)); W = Math.floor(W * k); H = Math.floor(H * k); }
  const M = squareToQuad(P);
  const out = new Uint8ClampedArray(W * H * 4);
  const sd = src.data, sw = src.w, sh = src.h;
  let o = 0;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      const z = M.g * u + M.h * v + 1;
      let x = (M.a * u + M.b * v + M.c) / z - 0.5;
      let y = (M.d * u + M.e * v + M.f) / z - 0.5;
      if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1;
      if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1;
      const x0 = x | 0, y0 = y | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      o += 4;
    }
  }
  return { w: W, h: H, data: out };
}

const LR = 0.2125, LG = 0.7154, LB = 0.0721;   // Rec.709 luma, as Core Image

function applyFilters(img, s, inPlace) {
  const { w, h } = img;
  const src = img.data;
  const out = inPlace ? src : new Uint8ClampedArray(src.length);
  const n = w * h;

  const light = s.mode !== 'original' ? illuminationMap(img) : null;
  const expo = Math.pow(2, s.exposure || 0);
  const mono = s.mode === 'blackWhite' || s.mode === 'grayscale';
  const sat = mono ? 0 : s.saturation;
  const con = s.contrast;
  const power = 1 / Math.max(0.05, s.gamma);
  const curve = s.mode === 'blackWhite'
    ? (s.hardThreshold ? hardCurve(s.threshold) : softCurve(s.threshold)) : null;

  // Per-pixel tonal work: gamma and the B&W curve go through 4096-entry LUTs.
  const L = 4096;
  const gammaLUT = new Float32Array(L + 1);
  for (let i = 0; i <= L; i++) gammaLUT[i] = power === 1 ? i / L : Math.pow(i / L, power);
  const curveLUT = curve ? new Float32Array(L + 1) : null;
  if (curve) for (let i = 0; i <= L; i++) curveLUT[i] = curve(i / L);
  const lut = (t, v) => t[v <= 0 ? 0 : v >= 1 ? L : (v * L + 0.5) | 0];

  let lightAt = null;
  if (light) {
    const { lw, lh, ld, scale } = light;
    lightAt = (x, y, c) => {
      let fx = (x + 0.5) * scale - 0.5, fy = (y + 0.5) * scale - 0.5;
      if (fx < 0) fx = 0; else if (fx > lw - 1) fx = lw - 1;
      if (fy < 0) fy = 0; else if (fy > lh - 1) fy = lh - 1;
      const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(lw - 1, x0 + 1), y1 = Math.min(lh - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const a = ld[(y0 * lw + x0) * 3 + c], b = ld[(y0 * lw + x1) * 3 + c];
      const d = ld[(y1 * lw + x0) * 3 + c], e = ld[(y1 * lw + x1) * 3 + c];
      const top = a + (b - a) * ax, bot = d + (e - d) * ax;
      return top + (bot - top) * ay;
    };
  }

  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p += 4) {
      let r = src[p] / 255, g = src[p + 1] / 255, b = src[p + 2] / 255;
      if (lightAt) {
        r = Math.min(1, r / Math.max(1 / 255, lightAt(x, y, 0)));
        g = Math.min(1, g / Math.max(1 / 255, lightAt(x, y, 1)));
        b = Math.min(1, b / Math.max(1 / 255, lightAt(x, y, 2)));
      }
      if (expo !== 1) { r *= expo; g *= expo; b *= expo; }
      if (sat !== 1) {
        const l = LR * r + LG * g + LB * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      }
      if (con !== 1) { r = (r - 0.5) * con + 0.5; g = (g - 0.5) * con + 0.5; b = (b - 0.5) * con + 0.5; }
      r = lut(gammaLUT, r); g = lut(gammaLUT, g); b = lut(gammaLUT, b);
      if (mono) {
        let l = LR * r + LG * g + LB * b;
        if (curveLUT) l = lut(curveLUT, l);
        r = g = b = l;
      }
      out[p] = r * 255 + 0.5; out[p + 1] = g * 255 + 0.5; out[p + 2] = b * 255 + 0.5;
      out[p + 3] = src[p + 3];
    }
  }

  if (s.sharpness > 0) sharpenLuminance(out, w, h, s.sharpness, 1.5);
  return { w, h, data: out };
}

/** Paper illumination estimate: ≤512 px copy → max filter (erases ink) → wide blur. */
function illuminationMap(img) {
  const { w, h, data } = img;
  const scale = Math.min(1, 512 / Math.max(w, h));
  const lw = Math.max(1, Math.round(w * scale)), lh = Math.max(1, Math.round(h * scale));
  const realScaleX = lw / w;
  // Area-average downsample.
  const sum = new Float32Array(lw * lh * 3), cnt = new Float32Array(lw * lh);
  for (let y = 0; y < h; y++) {
    const ly = Math.min(lh - 1, (y * lh / h) | 0);
    for (let x = 0; x < w; x++) {
      const lx = Math.min(lw - 1, (x * lw / w) | 0);
      const i = ly * lw + lx, p = (y * w + x) * 4;
      sum[i * 3] += data[p]; sum[i * 3 + 1] += data[p + 1]; sum[i * 3 + 2] += data[p + 2]; cnt[i]++;
    }
  }
  let ld = new Float32Array(lw * lh * 3);
  for (let i = 0; i < lw * lh; i++) {
    const c = cnt[i] || 1;
    ld[i * 3] = sum[i * 3] / c / 255; ld[i * 3 + 1] = sum[i * 3 + 1] / c / 255; ld[i * 3 + 2] = sum[i * 3 + 2] / c / 255;
  }
  ld = maxFilter3(ld, lw, lh, 7);
  for (let k = 0; k < 3; k++) ld = boxBlur3(ld, lw, lh, boxRadius(14, k));
  return { lw, lh, ld, scale: realScaleX };
}

function maxFilter3(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let m = 0;
    for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) { const v = src[(y * w + k) * 3 + c]; if (v > m) m = v; }
    tmp[(y * w + x) * 3 + c] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let m = 0;
    for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) { const v = tmp[(k * w + x) * 3 + c]; if (v > m) m = v; }
    out[(y * w + x) * 3 + c] = m;
  }
  return out;
}

// Three box blurs approximate a Gaussian with the given sigma.
function boxRadius(sigma, pass) {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return ((pass < m ? wl : wu) - 1) / 2;
}

function boxBlur3(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const div = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c];
    for (let x = 0; x < w; x++) {
      tmp[(y * w + x) * 3 + c] = acc / div;
      const add = Math.min(w - 1, x + r + 1), rem = Math.max(0, x - r);
      acc += src[(y * w + add) * 3 + c] - src[(y * w + rem) * 3 + c];
    }
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
    for (let y = 0; y < h; y++) {
      out[(y * w + x) * 3 + c] = acc / div;
      const add = Math.min(h - 1, y + r + 1), rem = Math.max(0, y - r);
      acc += tmp[(add * w + x) * 3 + c] - tmp[(rem * w + x) * 3 + c];
    }
  }
  return out;
}

function hardCurve(t) { return (v) => (v >= t ? 1 : 0); }

/** Soft "photocopy" curve through the same five points as the macOS app (monotone cubic). */
function softCurve(t) {
  const xs = [0, Math.max(0.05, t - 0.30), t, Math.min(0.95, t + 0.20), 1];
  const ys = [0, 0.02, 0.5, 0.98, 1];
  const n = xs.length, d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return (v) => {
    if (v <= 0) return 0; if (v >= 1) return 1;
    let i = 0; while (i < n - 2 && v > xs[i + 1]) i++;
    const hh = xs[i + 1] - xs[i], tt = (v - xs[i]) / hh;
    const t2 = tt * tt, t3 = t2 * tt;
    return Math.min(1, Math.max(0, (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + tt) * hh * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1]));
  };
}

/** Unsharp mask on luminance only (like CISharpenLuminance). */
function sharpenLuminance(data, w, h, amount, sigma) {
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) Y[i] = LR * data[p] + LG * data[p + 1] + LB * data[p + 2];
  const rad = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * rad + 1);
  let ks = 0;
  for (let i = -rad; i <= rad; i++) { k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + rad]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(n), B = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; a += Y[y * w + xx] * k[i + rad]; }
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; a += tmp[yy * w + x] * k[i + rad]; }
    B[y * w + x] = a;
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const delta = (Y[i] - B[i]) * amount;
    data[p] += delta; data[p + 1] += delta; data[p + 2] += delta;   // Uint8ClampedArray clamps
  }
}

// ---------------------------------------------------------------- document detection

/**
 * Finds the four corners of a sheet of paper. Returns a normalized quad
 * [[x,y] TL, TR, BR, BL] or null.
 *
 * Paper is the large bright, low-saturation region: score each pixel for
 * "paperness", split with Otsu, keep the best blob, fill its holes (text),
 * take the convex hull and pick the largest-area quadrilateral on that hull.
 */
function detectQuad(src) {
  const maxSide = 320;
  const scale = Math.min(1, maxSide / Math.max(src.w, src.h));
  const w = Math.max(8, Math.round(src.w * scale)), h = Math.max(8, Math.round(src.h * scale));
  const n = w * h;

  // Area-average downsample into paperness.
  const acc = new Float32Array(n * 3), cnt = new Float32Array(n);
  for (let y = 0; y < src.h; y++) {
    const sy = Math.min(h - 1, (y * h / src.h) | 0);
    for (let x = 0; x < src.w; x++) {
      const sx = Math.min(w - 1, (x * w / src.w) | 0), i = sy * w + sx, p = (y * src.w + x) * 4;
      acc[i * 3] += src.data[p]; acc[i * 3 + 1] += src.data[p + 1]; acc[i * 3 + 2] += src.data[p + 2]; cnt[i]++;
    }
  }
  const P = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = cnt[i] || 1;
    const r = acc[i * 3] / c, g = acc[i * 3 + 1] / c, b = acc[i * 3 + 2] / c;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    P[i] = mx * (1 - 0.7 * sat);
  }
  const Pb = blur3x3(P, w, h);

  // Otsu.
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, Pb[i] | 0))]++;
  let total = 0; for (let i = 0; i < 256; i++) total += i * hist[i];
  let sumB = 0, wB = 0, best = -1, T = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (total - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; T = t; }
  }

  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = Pb[i] > T ? 1 : 0;
  const r = Math.max(1, Math.round(Math.min(w, h) / 100));
  mask = dilate(erode(mask, w, h, r), w, h, r);     // open: cut thin bridges to background
  mask = erode(dilate(mask, w, h, r), w, h, r);     // close: heal small gaps

  // Connected components.
  const label = new Int32Array(n).fill(-1);
  const comps = [];
  const queue = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = comps.length;
    let qh = 0, qt = 0; queue[qt++] = i; label[i] = id;
    let area = 0, border = 0;
    while (qh < qt) {
      const j = queue[qh++]; area++;
      const x = j % w, y = (j / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && mask[k] && label[k] < 0) { label[k] = id; queue[qt++] = k; }
    }
    comps.push({ id, area, border });
  }
  if (!comps.length) return null;

  const cIdx = ((h / 2) | 0) * w + ((w / 2) | 0);
  const perimeter = 2 * (w + h);
  let pick = null, pickScore = -1;
  for (const c of comps) {
    if (c.area < n * 0.04) continue;
    let score = c.area;
    if (label[cIdx] === c.id) score *= 2;
    score *= 1 - 0.6 * Math.min(1, c.border / perimeter);   // background usually wraps the border
    if (score > pickScore) { pickScore = score; pick = c; }
  }
  if (!pick) return null;

  // Fill holes: everything not reachable from the border without crossing the blob.
  const reach = new Uint8Array(n);
  let qh = 0, qt = 0;
  const seed = (i) => { if (!reach[i] && label[i] !== pick.id) { reach[i] = 1; queue[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const j = queue[qh++], x = j % w, y = (j / w) | 0;
    if (x > 0) seed(j - 1); if (x < w - 1) seed(j + 1); if (y > 0) seed(j - w); if (y < h - 1) seed(j + w);
  }

  // Boundary pixels of the filled blob → convex hull.
  const pts = [];
  let blobArea = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (reach[i]) continue;
    blobArea++;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || reach[i - 1] || reach[i + 1] || reach[i - w] || reach[i + w]) {
      pts.push([x + 0.5, y + 0.5]);
    }
  }
  if (blobArea > n * 0.97) return null;               // nothing distinguishes paper from background
  let hull = convexHull(pts);
  if (hull.length < 4) return null;
  if (hull.length > 64) {
    const step = hull.length / 64;
    hull = Array.from({ length: 64 }, (_, k) => hull[Math.floor(k * step)]);
  }
  const quad = maxAreaQuad(hull);
  if (!quad) return null;

  // Order TL, TR, BR, BL (clockwise on screen, starting nearest the top-left).
  let q = quad.slice();
  if (signedArea(q) < 0) q.reverse();               // make clockwise in Y-down space
  let start = 0, bestS = Infinity;
  q.forEach((p, i) => { if (p[0] + p[1] < bestS) { bestS = p[0] + p[1]; start = i; } });
  q = [0, 1, 2, 3].map((k) => q[(start + k) % 4]);
  const norm = q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
  const area = Math.abs(signedArea(norm));
  if (area < 0.04 || area > 0.985) return null;
  return norm;
}

function blur3x3(src, w, h) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      a += src[yy * w + xx]; c++;
    }
    out[y * w + x] = a / c;
  }
  return out;
}

function morph(mask, w, h, r, isMax) {
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = isMax ? 0 : 1;
    for (let k = x - r; k <= x + r; k++) {
      const m = k < 0 || k >= w ? (isMax ? 0 : 1) : mask[y * w + k];
      if (isMax ? m : !m) { v = isMax ? 1 : 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = isMax ? 0 : 1;
    for (let k = y - r; k <= y + r; k++) {
      const m = k < 0 || k >= h ? (isMax ? 0 : 1) : tmp[k * w + x];
      if (isMax ? m : !m) { v = isMax ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}
const erode = (m, w, h, r) => morph(m, w, h, r, false);
const dilate = (m, w, h, r) => morph(m, w, h, r, true);

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

/** Largest-area quadrilateral whose corners are hull vertices (n ≤ 64, brute force with pruning). */
function maxAreaQuad(hull) {
  const n = hull.length;
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  let best = 0, bq = null;
  for (let i = 0; i < n; i++) for (let k = i + 2; k < n; k++) {
    // For the diagonal i–k, the best j (between) and l (after) maximise each triangle independently.
    let a1 = 0, bj = -1;
    for (let j = i + 1; j < k; j++) { const a = tri(hull[i], hull[j], hull[k]); if (a > a1) { a1 = a; bj = j; } }
    let a2 = 0, bl = -1;
    for (let l = k + 1; l < n + i; l++) { const L = l % n; const a = tri(hull[k], hull[L], hull[i]); if (a > a2) { a2 = a; bl = L; } }
    if (bj >= 0 && bl >= 0 && a1 + a2 > best) { best = a1 + a2; bq = [hull[i], hull[bj], hull[k], hull[bl]]; }
  }
  return bq;
}
