// Geometry shared by the canvas and the exporters.
// All page geometry is stored in PDF points (1/72 inch), origin TOP-LEFT, Y down —
// exactly like the macOS app. Units are only used for display and entry.

export const UNITS = {
  mm: { symbol: 'mm', ppu: 72 / 25.4, digits: 1, nudge: 72 / 25.4 },
  cm: { symbol: 'cm', ppu: 72 / 2.54, digits: 2, nudge: 72 / 25.4 },
  in: { symbol: 'in', ppu: 72, digits: 3, nudge: 72 / 16 },
};
export const UNIT_ORDER = ['mm', 'cm', 'in'];

export const toPoints = (v, unit) => v * UNITS[unit].ppu;
export const fromPoints = (pt, unit) => pt / UNITS[unit].ppu;
export const fmtUnit = (pt, unit, withSymbol = true) => {
  const u = UNITS[unit];
  const s = (pt / u.ppu).toFixed(u.digits);
  return withSymbol ? `${s} ${u.symbol}` : s;
};
export const mm = (v) => toPoints(v, 'mm');

export const PAPERS = [
  { id: 'letter', name: 'US Letter', detail: '8.5 × 11 in', w: 612, h: 792 },
  { id: 'legal', name: 'US Legal', detail: '8.5 × 14 in', w: 612, h: 1008 },
  { id: 'a4', name: 'A4', detail: '210 × 297 mm', w: mm(210), h: mm(297) },
  { id: 'a3', name: 'A3', detail: '297 × 420 mm', w: mm(297), h: mm(420) },
  { id: 'a5', name: 'A5', detail: '148 × 210 mm', w: mm(148), h: mm(210) },
];
export const A4 = PAPERS[2];

export function paperName(w, h) {
  for (const p of PAPERS) {
    const portrait = Math.abs(p.w - w) < 1 && Math.abs(p.h - h) < 1;
    const landscape = Math.abs(p.w - h) < 1 && Math.abs(p.h - w) < 1;
    if (portrait || landscape) return p.name + (landscape && w > h ? ' landscape' : '');
  }
  return 'Custom';
}

export const SIZE_PRESETS = [
  { label: 'Passport photo — 35 × 45 mm', w: mm(35), h: mm(45) },
  { label: 'US passport/visa — 2 × 2 in', w: 144, h: 144 },
  { label: 'ID card — 85.6 × 54 mm', w: mm(85.6), h: mm(54) },
  { label: 'Business card — 3.5 × 2 in', w: 252, h: 144 },
];

export function normalizedAngle(d) {
  let a = d % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.round(a * 1000) / 1000;
}

/** Rotates a vector by `deg` in a Y-down system (positive = clockwise on screen). */
export function rotate(x, y, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

export const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];

/** Corners of a rotated frame, page coordinates: TL, TR, BR, BL. */
export function corners(r, rotation) {
  const [cx, cy] = center(r), hw = r.w / 2, hh = r.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => {
    const [rx, ry] = rotate(x, y, rotation);
    return [rx + cx, ry + cy];
  });
}

export function boundingBox(r, rotation) {
  if (!rotation || rotation % 360 === 0) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const pts = corners(r, rotation);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Is page point (px,py) inside the rotated frame? */
export function hitTest(r, rotation, px, py, slop = 0) {
  const [cx, cy] = center(r);
  const [lx, ly] = rotate(px - cx, py - cy, -rotation);
  return Math.abs(lx) <= r.w / 2 + slop && Math.abs(ly) <= r.h / 2 + slop;
}

/** Snaps the edges / center of `rect` to the nearest target lines within `threshold`. */
export function snap(rect, targetsX, targetsY, threshold) {
  const res = { dx: 0, dy: 0, xLine: null, yLine: null };
  const near = (cands, targets) => {
    let best = null;
    for (const c of cands) for (const t of targets) {
      const d = t - c;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best[0]))) best = [d, t];
    }
    return best;
  };
  const bx = near([rect.x, rect.x + rect.w / 2, rect.x + rect.w], targetsX);
  if (bx) { res.dx = bx[0]; res.xLine = bx[1]; }
  const by = near([rect.y, rect.y + rect.h / 2, rect.y + rect.h], targetsY);
  if (by) { res.dy = by[0]; res.yLine = by[1]; }
  return res;
}

// Resize handles: direction from the center in local (unrotated) space.
export const HANDLES = {
  tl: [-1, -1], t: [0, -1], tr: [1, -1], r: [1, 0],
  br: [1, 1], b: [0, 1], bl: [-1, 1], l: [-1, 0],
};

/** New frame after dragging `handle` by (dx,dy) page points, keeping the opposite side fixed. */
export function resize(start, rotation, handle, dx, dy, aspectLocked, minSize = 2) {
  const [lx, ly] = rotate(dx, dy, -rotation);
  const [hx, hy] = HANDLES[handle];
  let w = start.w + lx * hx;
  let h = start.h + ly * hy;
  if (aspectLocked && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if (hx !== 0 && hy !== 0) {
      if (Math.abs(w / start.w - 1) >= Math.abs(h / start.h - 1)) h = w / ratio; else w = h * ratio;
    } else if (hx !== 0) h = w / ratio;
    else w = h * ratio;
  }
  w = Math.max(minSize, w); h = Math.max(minSize, h);
  const [sx, sy] = rotate(((w - start.w) / 2) * hx, ((h - start.h) / 2) * hy, rotation);
  const [cx, cy] = center(start);
  return { x: cx + sx - w / 2, y: cy + sy - h / 2, w, h };
}

export function aspectFit(w, h, bounds) {
  if (w <= 0 || h <= 0) return { ...bounds };
  const s = Math.min(bounds.w / w, bounds.h / h);
  const fw = w * s, fh = h * s;
  return { x: bounds.x + (bounds.w - fw) / 2, y: bounds.y + (bounds.h - fh) / 2, w: fw, h: fh };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Math.random().toString(36).slice(2) + Date.now().toString(36));

// Normalized quad helpers (corners TL, TR, BR, BL; 0…1, origin top-left).
export const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
export const isFullQuad = (q) => !q || q.every((p, i) => Math.abs(p[0] - FULL_QUAD[i][0]) < 1e-4 && Math.abs(p[1] - FULL_QUAD[i][1]) < 1e-4);

/** Approximate width / height of the un-warped result for an image of size w×h. */
export function quadOutputSize(q, w, h) {
  const P = q.map(([x, y]) => [x * w, y * h]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: (d(P[0], P[1]) + d(P[3], P[2])) / 2, h: (d(P[0], P[3]) + d(P[1], P[2])) / 2 };
}

// ---- Text layout (shared by canvas thumbnails, raster export and the PDF exporter) ----

export const FONTS = [
  { id: 'Helvetica', css: 'Helvetica, Arial, sans-serif', weight: 400, pdf: 'Helvetica' },
  { id: 'Helvetica-Bold', css: 'Helvetica, Arial, sans-serif', weight: 700, pdf: 'HelveticaBold' },
  { id: 'Times-Roman', css: '"Times New Roman", Times, serif', weight: 400, pdf: 'TimesRoman' },
  { id: 'Times-Bold', css: '"Times New Roman", Times, serif', weight: 700, pdf: 'TimesRomanBold' },
  { id: 'Courier', css: '"Courier New", Courier, monospace', weight: 400, pdf: 'Courier' },
  { id: 'Avenir Next', css: '"Avenir Next", Avenir, "Segoe UI", sans-serif', weight: 400, pdf: null },
  { id: 'Georgia', css: 'Georgia, serif', weight: 400, pdf: null },
  { id: 'Menlo', css: 'Menlo, Consolas, monospace', weight: 400, pdf: null },
];
export const fontInfo = (id) => FONTS.find((f) => f.id === id) || FONTS[0];
export const LINE_HEIGHT = 1.2;      // × font size
export const BASELINE = 0.92;        // first baseline below the top, × font size (≈ CSS line box of 1.2)

/** Greedy word wrap. `measure(str)` returns the width in the same units as `maxWidth`. */
export function wrapText(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    const tokens = para.match(/\S+\s*/g) || [para];
    let line = para.match(/^\s*/)[0];
    for (const tok of tokens) {
      const trial = line + tok;
      if (measure(trial.trimEnd()) <= maxWidth || line.trim() === '') {
        if (measure(trial.trimEnd()) > maxWidth && line.trim() === '') {
          // A single word wider than the box: break it by characters.
          let piece = line;
          for (const ch of tok) {
            if (measure((piece + ch).trimEnd()) > maxWidth && piece.trim() !== '') { out.push(piece.trimEnd()); piece = ''; }
            piece += ch;
          }
          line = piece;
        } else line = trial;
      } else {
        out.push(line.trimEnd());
        line = tok;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
