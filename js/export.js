// Export engine (port of ExportEngine.swift / ExportOptions.swift): PDF, Word, JPEG and PNG with
// controllable page range, resolution, JPEG compression and colour mode (color / grayscale /
// 1-bit B&W), live size estimates, "fit under N MB", previews of the compressed result,
// searchable PDFs (OCR text layer) and password protection.

import { assets, blobOf, fullResCanvas, isIdentityScan, newCanvas, canvasToBlob } from './imaging.js';
import { renderPdfPage, loadScript } from './pdfsupport.js';
import { layoutTextLines, baselineFactor, drawTextLocal } from './render.js';
import { fontInfo, rotate, LINE_HEIGHT, isFullQuad } from './geometry.js';
import { zipStore } from './zip.js';
import { zlibDeflate, packBits, encodeGrayPNG } from './png.js';
import { encryptPDF } from './pdfcrypt.js';
import { recognizeWords } from './ocr.js';
import { isMarkup, drawList, pdfPathOps, drawMarkupCanvas, markupPad, hexToRgb01 } from './markup.js';

// ------------------------------------------------------------------ options

export const FORMATS = {
  pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  docx: { label: 'Word', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', perPage: true },
  png: { label: 'PNG', ext: 'png', mime: 'image/png', perPage: true },
};
export const COLOR_MODES = [['color', 'Color'], ['grayscale', 'Grayscale'], ['blackWhite', 'B&W']];
export const PRESETS = [
  { id: 'maximum', label: 'Max', quality: 0.95, dpi: 0 },
  { id: 'high', label: 'High', quality: 0.85, dpi: 300 },
  { id: 'balanced', label: 'Balanced', quality: 0.75, dpi: 200 },
  { id: 'small', label: 'Small', quality: 0.6, dpi: 150 },
  { id: 'smallest', label: 'Smallest', quality: 0.45, dpi: 100 },
];
export const DPI_CHOICES = [72, 100, 150, 200, 300, 600, 0];
export function dpiLabel(dpi) {
  return { 0: 'Original', 72: '72 dpi · screen', 150: '150 dpi · email', 200: '200 dpi · documents', 300: '300 dpi · print' }[dpi] || `${dpi} dpi`;
}

export function defaultOptions(format = 'pdf') {
  return {
    format, quality: 0.75, dpi: 200, colorMode: 'color', scope: 'all', rangeText: '',
    searchableText: false, keepVectorPages: true, usePassword: false, password: '',
  };
}
export function applyPreset(o, id) {
  const p = PRESETS.find((x) => x.id === id);
  if (p) { o.quality = p.quality; o.dpi = p.dpi; }
  return o;
}
export const matchingPreset = (o) => PRESETS.find((p) => Math.abs(p.quality - o.quality) < 0.005 && p.dpi === o.dpi)?.id || null;
/** Whether lossy compression applies (B&W and PNG are lossless). */
export const usesJPEG = (o) => o.format !== 'png' && o.colorMode !== 'blackWhite';
/** Settings that change the bytes produced (OCR / password excluded). */
export const renderSignature = (o) => `${o.format}|${o.quality}|${o.dpi}|${o.colorMode}|${o.keepVectorPages}`;
const effectiveDPI = (o) => (o.dpi === 0 ? 300 : o.dpi);

/** Zero-based page indices to export, in document order. */
export function pageIndices(o, count, current) {
  if (o.scope === 'current') return count ? [Math.min(Math.max(0, current), count - 1)] : [];
  if (o.scope === 'range') return parseRange(o.rangeText, count);
  return Array.from({ length: count }, (_, i) => i);
}

/** Parses "1-3, 5, 8-" (1-based, inclusive). Invalid parts are ignored. */
export function parseRange(text, count) {
  const set = new Set();
  for (const part of String(text || '').split(/[,; ]+/).filter(Boolean)) {
    const bits = part.split('-').map((s) => s.trim());
    if (bits.length === 1 && /^\d+$/.test(bits[0])) {
      const n = +bits[0];
      if (n >= 1 && n <= count) set.add(n - 1);
    } else if (bits.length === 2) {
      const lo = Math.max(1, /^\d+$/.test(bits[0]) ? +bits[0] : 1);
      const hi = Math.min(count, /^\d+$/.test(bits[1]) ? +bits[1] : count);
      for (let n = lo; n <= hi; n++) set.add(n - 1);
    }
  }
  return [...set].sort((a, b) => a - b);
}

export function fileSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

// ------------------------------------------------------------------ jobs & caches

export class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'Cancelled'; } }

/** Progress / cancellation for one export run. */
class Job {
  constructor(total = 1, onProgress = () => {}, isCancelled = () => false) {
    this.total = Math.max(1, total); this.done = 0; this.onProgress = onProgress; this.isCancelled = isCancelled;
  }
  check() { if (this.isCancelled()) throw new Cancelled(); }
  step() { this.done++; this.onProgress(Math.min(1, this.done / this.total)); this.check(); }
}

// One heavy task at a time keeps memory predictable on a phone.
let chain = Promise.resolve();
export function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const processedCache = new Map();   // key → { blob, w, h }
const scaledCache = new Map();      // key → { canvas, w, h, gray }
const preparedCache = new Map();    // key → prepared image
const ocrCache = new Map();         // sig → words
const SCALED_BUDGET = 24e6, PREPARED_BUDGET = 160e6, PROCESSED_BUDGET = 120e6;

function touch(map, key) { const v = map.get(key); map.delete(key); map.set(key, v); return v; }
function evict(map, budget, sizeOf, dispose = () => {}) {
  let total = 0;
  for (const v of map.values()) total += sizeOf(v);
  for (const [k, v] of map) {
    if (total <= budget || map.size <= 1) break;
    total -= sizeOf(v); dispose(v); map.delete(k);
  }
}

export function clearExportCache() {
  for (const v of scaledCache.values()) { v.canvas.width = v.canvas.height = 0; }
  processedCache.clear(); scaledCache.clear(); preparedCache.clear();
}

const sig = (el) => (el.kind === 'image'
  ? `${el.asset}|${JSON.stringify(isFullQuad(el.quad) ? null : el.quad)}|${JSON.stringify(el.scan)}`
  : `${el.asset}|pdf${el.pageIndex}`);

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);
  return img;
}
const release = (src) => { if (src && typeof src.close === 'function') src.close(); };

// ------------------------------------------------------------------ element images

/** Full-resolution processed source: scan filters + perspective applied; PDF pages rasterized. */
async function processedSource(el, o) {
  const a = assets.get(el.asset);
  if (!a) throw new Error('A picture on this page is missing — re-import it.');
  if (el.kind === 'image') {
    if (isFullQuad(el.quad) && isIdentityScan(el.scan)) return { blob: blobOf(a), w: a.w, h: a.h };
    const key = sig(el);
    if (processedCache.has(key)) return touch(processedCache, key);
    const c = await fullResCanvas(el);
    const lossless = el.scan && (el.scan.mode === 'blackWhite' || el.scan.mode === 'grayscale');
    const rec = { blob: await canvasToBlob(c, lossless ? 'image/png' : 'image/jpeg', 0.97), w: c.width, h: c.height };
    c.width = c.height = 0;
    processedCache.set(key, rec);
    evict(processedCache, PROCESSED_BUDGET, (v) => v.blob.size);
    return rec;
  }
  const dpi = Math.max(effectiveDPI(o), 150);
  const key = `${sig(el)}@${dpi}`;
  if (processedCache.has(key)) return touch(processedCache, key);
  const s = a.pages[el.pageIndex];
  const c = await renderPdfPage(a, el.pageIndex, (Math.max(s.w, s.h) * dpi) / 72);
  const rec = { blob: await canvasToBlob(c, 'image/png'), w: c.width, h: c.height };
  c.width = c.height = 0;
  processedCache.set(key, rec);
  evict(processedCache, PROCESSED_BUDGET, (v) => v.blob.size);
  return rec;
}

/** High-quality downscale (repeated halving avoids aliasing), flattened onto white. */
function drawScaled(src, sw, sh, tw, th) {
  let cur = src, cw = sw, ch = sh;
  const temps = [];
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
    const t = newCanvas(nw, nh);
    const tc = t.getContext('2d');
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    temps.push(t); cur = t; cw = nw; ch = nh;
  }
  const out = newCanvas(tw, th);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
  temps.forEach((t) => { t.width = t.height = 0; });
  return out;
}

/** Converts a canvas in place to grayscale or 1-bit B&W (threshold 50 %); returns the gray plane. */
function applyColorMode(canvas, mode) {
  if (mode === 'color') return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = canvas.width * canvas.height;
  const gray = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let l = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    if (mode === 'blackWhite') l = l >= 128 ? 255 : 0;
    gray[i] = l + 0.5;
    d[p] = d[p + 1] = d[p + 2] = gray[i]; d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return gray;
}

/** Source resampled to the export resolution and converted to the export colour mode. */
async function scaledImage(el, o) {
  const src = await processedSource(el, o);
  let tw = src.w, th = src.h;
  if (o.dpi > 0) { tw = Math.min(src.w, (el.w / 72) * o.dpi); th = Math.min(src.h, (el.h / 72) * o.dpi); }
  const w = Math.max(8, Math.round(tw)), h = Math.max(8, Math.round(th));
  const key = `${sig(el)}|${w}x${h}|${o.colorMode}|${o.dpi}`;
  if (scaledCache.has(key)) return touch(scaledCache, key);
  const bmp = await decode(src.blob);
  const canvas = drawScaled(bmp, src.w, src.h, w, h);
  release(bmp);
  const rec = { key, canvas, w, h, gray: applyColorMode(canvas, o.colorMode) };
  scaledCache.set(key, rec);
  evict(scaledCache, SCALED_BUDGET, (v) => v.w * v.h, (v) => { v.canvas.width = v.canvas.height = 0; });
  return rec;
}

/** Encoded image for embedding: JPEG at the chosen quality, or lossless 1-bit for B&W. */
async function prepare(el, o) {
  const s = await scaledImage(el, o);
  const key = o.colorMode === 'blackWhite' ? `${s.key}|bits` : `${s.key}|q${o.quality}`;
  if (preparedCache.has(key)) return touch(preparedCache, key);
  let rec;
  if (o.colorMode === 'blackWhite') {
    const { bits, rowBytes } = packBits(s.gray, s.w, s.h);
    let png = null;
    rec = {
      kind: 'bits', bits, rowBytes, w: s.w, h: s.h, size: bits.length,
      png: async () => (png ||= await encodeGrayPNG(bits, s.w, s.h, 1, rowBytes)),
    };
  } else {
    const bytes = new Uint8Array(await (await canvasToBlob(s.canvas, 'image/jpeg', o.quality)).arrayBuffer());
    rec = { kind: 'jpeg', bytes, w: s.w, h: s.h, size: bytes.length };
  }
  preparedCache.set(key, rec);
  evict(preparedCache, PREPARED_BUDGET, (v) => v.size);
  return rec;
}

/** Something drawable that looks exactly like the embedded (compressed) image. */
async function compressedDrawable(el, o) {
  const p = await prepare(el, o);
  if (p.kind === 'bits') return { src: (await scaledImage(el, o)).canvas, dispose: () => {} };
  const bmp = await decode(new Blob([p.bytes], { type: 'image/jpeg' }));
  return { src: bmp, dispose: () => release(bmp) };
}

// ------------------------------------------------------------------ OCR

async function ocrWords(el, o) {
  const key = sig(el);
  if (ocrCache.has(key)) return ocrCache.get(key);
  const src = await processedSource(el, o);
  const k = Math.min(1, 2600 / Math.max(src.w, src.h));
  const bmp = await decode(src.blob);
  const c = drawScaled(bmp, src.w, src.h, Math.round(src.w * k), Math.round(src.h * k));
  release(bmp);
  let words = [];
  try { words = await recognizeWords(c); } finally { c.width = c.height = 0; }
  ocrCache.set(key, words);
  return words;
}

// ------------------------------------------------------------------ text colour per mode

function adjustedColor(hex, mode) {
  if (mode === 'color') return hex;
  const [r, g, b] = hexToRgb(hex);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (mode === 'blackWhite') return l < 0.6 ? '#000000' : '#ffffff';
  const v = Math.round(l * 255).toString(16).padStart(2, '0');
  return `#${v}${v}${v}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ------------------------------------------------------------------ PDF

let pdfLibPromise = null;
function pdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = loadScript('vendor/pdf-lib.min.js').then(() => window.PDFLib);
    pdfLibPromise.catch(() => { pdfLibPromise = null; });
  }
  return pdfLibPromise;
}

const vectorPDF = (el, o) => el.kind === 'pdf' && o.keepVectorPages && o.colorMode === 'color' && o.format === 'pdf';

async function buildPDF(pages, o, title, job, { searchable = false } = {}) {
  const L = await pdfLib();
  const { PDFDocument, StandardFonts, rgb, degrees } = L;
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('DocPrint Studio');
  out.setProducer('DocPrint Studio (web)');
  out.setCreationDate(new Date());
  const ctx = out.context;

  const fonts = {};
  const font = async (name) => (fonts[name] ||= await out.embedFont(StandardFonts[name]));
  const srcDocs = {};
  const srcDoc = async (assetId) => (srcDocs[assetId] ||= await PDFDocument.load(assets.get(assetId).bytes.slice(0), { ignoreEncryption: true }));
  const embedded = new Map();

  for (const page of pages) {
    const pdfPage = out.addPage([page.w, page.h]);
    const H = page.h;

    /** Bottom-left corner + rotation for something dw×dh centered on the element, rotated clockwise by rotCW. */
    const placement = (el, dw, dh, rotCW) => {
      const cx = el.x + el.w / 2, cy = H - (el.y + el.h / 2);
      const phi = (-rotCW * Math.PI) / 180;
      const ox = (-dw / 2) * Math.cos(phi) + (dh / 2) * Math.sin(phi);
      const oy = (-dw / 2) * Math.sin(phi) - (dh / 2) * Math.cos(phi);
      return { x: cx + ox, y: cy + oy, rotate: degrees(-rotCW) };
    };
    const gstate = (opacity) => {
      if (opacity >= 0.999) return [];
      const name = pdfPage.node.newExtGState('GS', ctx.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
      return [L.setGraphicsState(name)];
    };

    for (const el of page.elements) {
      const opacity = el.opacity ?? 1;
      const rot = el.rotation || 0;
      if (el.kind === 'text') {
        await drawPdfText(pdfPage, { ...el, color: adjustedColor(el.color, o.colorMode) }, H, font, out, { rgb, degrees, placement });
      } else if (isMarkup(el)) {
        drawPdfMarkup(L, pdfPage, ctx, el, H, o);
      } else if (vectorPDF(el, o)) {
        const src = await srcDoc(el.asset);
        const sp = src.getPage(el.pageIndex);
        const box = sp.getCropBox();
        const pr = ((sp.getRotation().angle % 360) + 360) % 360;
        const [emb] = await out.embedPages([sp], [{ left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height }]);
        const quarter = pr % 180 !== 0;
        const xScale = (quarter ? el.h : el.w) / box.width;
        const yScale = (quarter ? el.w : el.h) / box.height;
        pdfPage.drawPage(emb, { ...placement(el, box.width * xScale, box.height * yScale, rot + pr), xScale, yScale, opacity });
      } else {
        const p = await prepare(el, o);
        const key = `${p.kind}|${p.w}x${p.h}|${p.kind === 'jpeg' ? p.bytes.length : p.bits.length}|${sig(el)}|${o.quality}`;
        let ref = embedded.get(key);
        if (!ref) {
          if (p.kind === 'jpeg') {
            ref = (await out.embedJpg(p.bytes)).ref;
          } else {
            ref = ctx.register(ctx.stream(await zlibDeflate(p.bits), {
              Type: 'XObject', Subtype: 'Image', Width: p.w, Height: p.h,
              ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'FlateDecode',
            }));
          }
          embedded.set(key, ref);
        }
        const name = pdfPage.node.newXObject('Im', ref);
        const pl = placement(el, el.w, el.h, rot);
        pdfPage.pushOperators(
          L.pushGraphicsState(), ...gstate(opacity),
          L.translate(pl.x, pl.y), L.rotateDegrees(-rot), L.scale(el.w, el.h), L.drawObject(name),
          L.popGraphicsState(),
        );
        if (searchable) drawInvisibleText(L, pdfPage, el, H, await ocrWords(el, o), await font('Helvetica'));
      }
      job.step();
    }
  }
  return out.save({ useObjectStreams: false });
}

/** Element-local coordinates (origin at the frame's top-left, Y down, in points) → PDF page. */
function localMatrix(el, H) {
  const phi = (-(el.rotation || 0) * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
  const cx = el.x + el.w / 2, cy = H - (el.y + el.h / 2);
  return [c, s, s, -c, cx - c * el.w / 2 - s * el.h / 2, cy - s * el.w / 2 + c * el.h / 2];
}

/** Shapes and drawings as vector paths (highlighter multiplies like a real marker). */
function drawPdfMarkup(L, pdfPage, ctx, el, H, o) {
  const opacity = el.opacity ?? 1;
  const ops = [L.pushGraphicsState(), L.concatTransformationMatrix(...localMatrix(el, H)),
    L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round)];
  for (const d of drawList(el, el.w, el.h, (c) => adjustedColor(c, o.colorMode))) {
    ops.push(L.pushGraphicsState());
    const alpha = opacity * (d.alpha ?? 1);
    if (alpha < 0.999 || d.multiply) {
      const gs = { Type: 'ExtGState', ca: alpha, CA: alpha };
      if (d.multiply) gs.BM = 'Multiply';
      ops.push(L.setGraphicsState(pdfPage.node.newExtGState('GS', ctx.obj(gs))));
    }
    ops.push(...pdfPathOps(L, d.path));
    if (d.fill) ops.push(L.setFillingRgbColor(...hexToRgb01(d.fill)), L.fill());
    else ops.push(L.setStrokingRgbColor(...hexToRgb01(d.stroke)), L.setLineWidth(d.width), L.stroke());
    ops.push(L.popGraphicsState());
  }
  ops.push(L.popGraphicsState());
  pdfPage.pushOperators(...ops);
}

/** Shapes and drawings as a transparent PNG (for Word), plus the padded frame it covers. */
async function markupImage(el, o) {
  const pad = markupPad(el);
  const frame = { ...el, x: el.x - pad, y: el.y - pad, w: el.w + 2 * pad, h: el.h + 2 * pad };
  const scale = effectiveDPI(o) / 72;
  const c = newCanvas(Math.ceil(frame.w * scale), Math.ceil(frame.h * scale));
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.translate(pad, pad);
  drawMarkupCanvas(g, el, (col) => adjustedColor(col, o.colorMode));
  const png = new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
  c.width = c.height = 0;
  return { png, frame };
}

/** OCR'd words drawn invisibly over the element so the PDF can be searched, selected and copied. */
function drawInvisibleText(L, pdfPage, el, H, words, f) {
  if (!words.length) return;
  const key = pdfPage.node.newFontDictionary(f.name, f.ref);
  const phi = (-(el.rotation || 0) * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
  const cx = el.x + el.w / 2, cy = H - (el.y + el.h / 2);
  const ops = [
    L.pushGraphicsState(),
    // Element-local coordinates: origin at the frame's top-left, Y down, in points.
    L.concatTransformationMatrix(c, s, s, -c, cx - c * el.w / 2 - s * el.h / 2, cy - s * el.w / 2 + c * el.h / 2),
    L.beginText(), L.setFontAndSize(key, 1), L.setTextRenderingMode(L.TextRenderingMode.Invisible),
  ];
  for (const w of words) {
    const text = encodable(f, w.text);
    const width1 = f.widthOfTextAtSize(text, 1);
    const ww = w.box.w * el.w, hh = w.box.h * el.h;
    if (!(width1 > 0) || ww < 0.5 || hh < 0.5) continue;
    ops.push(L.setTextMatrix(ww / width1, 0, 0, -hh * 0.85, w.box.x * el.w, w.box.y * el.h + hh * 0.8), L.showText(f.encodeText(text)));
  }
  ops.push(L.endText(), L.popGraphicsState());
  pdfPage.pushOperators(...ops);
}

const encodableCache = new Map();
function encodable(f, text) {
  let out = '';
  for (const ch of text) {
    let ok = encodableCache.get(ch);
    if (ok === undefined) { try { f.encodeText(ch); ok = true; } catch { ok = false; } encodableCache.set(ch, ok); }
    out += ok ? ch : '?';
  }
  return out;
}

async function drawPdfText(pdfPage, el, H, font, out, { rgb, degrees, placement }) {
  // `el.color` has already been adjusted to the export colour mode.
  const info = fontInfo(el.font);
  const opacity = el.opacity ?? 1;
  const lines = layoutTextLines(el);
  if (info.pdf) {
    try {
      const f = await font(info.pdf);
      const [r, g, b] = hexToRgb(el.color);
      const base = baselineFactor(el.font) * el.size;
      const ops = lines.map((line, i) => {
        const width = f.widthOfTextAtSize(line, el.size);           // throws if not encodable
        const lx = el.align === 'center' ? -width / 2 : el.align === 'right' ? el.w / 2 - width : -el.w / 2;
        const ly = -el.h / 2 + base + i * el.size * LINE_HEIGHT;     // local, Y down
        const [rx, ry] = rotate(lx, ly, el.rotation || 0);
        return { line, x: el.x + el.w / 2 + rx, y: H - (el.y + el.h / 2 + ry) };
      });
      for (const o of ops) {
        if (!o.line) continue;
        pdfPage.drawText(o.line, { x: o.x, y: o.y, size: el.size, font: f, color: rgb(r, g, b), rotate: degrees(-(el.rotation || 0)), opacity });
      }
      return;
    } catch { /* characters outside WinAnsi → raster fallback below */ }
  }
  // Fonts without a PDF standard equivalent (or non-Latin text): 300 dpi transparent PNG.
  // The bitmap is symmetric around the frame center so it rotates exactly like the frame.
  const scale = 300 / 72;
  const pad = el.size;                                  // room for overhanging glyphs
  const halfW = el.w / 2 + pad;
  const halfH = Math.max(el.h / 2, lines.length * el.size * LINE_HEIGHT - el.h / 2) + pad;
  const c = document.createElement('canvas');
  c.width = Math.ceil(2 * halfW * scale);
  c.height = Math.ceil(2 * halfH * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(halfW, halfH);
  drawTextLocal(ctx, el);
  const png = new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
  c.width = c.height = 1;
  const img = await out.embedPng(png);
  const dw = 2 * halfW, dh = 2 * halfH;
  pdfPage.drawImage(img, { ...placement(el, dw, dh, el.rotation || 0), width: dw, height: dh, opacity });
}

// ------------------------------------------------------------------ DOCX

const EMU = 12700, TWIP = 20;
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emu = (pt) => Math.round(pt * EMU);
const twips = (pt) => Math.round(pt * TWIP);

function sectPr(w, h) {
  const orient = w > h ? ' w:orient="landscape"' : '';
  return `<w:sectPr><w:pgSz w:w="${twips(w)}" w:h="${twips(h)}"${orient}/>` +
    '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
}

function anchorXML(el, relID, id, z, name) {
  const x = emu(el.x), y = emu(el.y), cx = Math.max(1, emu(el.w)), cy = Math.max(1, emu(el.h));
  let r = (el.rotation || 0) % 360; if (r < 0) r += 360;
  const rot = Math.round(r * 60000);
  const rotAttr = rot ? ` rot="${rot}"` : '';
  const height = 251658240 + z * 1024;
  const alpha = (el.opacity ?? 1) < 0.999 ? `<a:alphaModFix amt="${Math.round((el.opacity ?? 1) * 100000)}"/>` : '';
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${height}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${xmlEscape(el.name || '')}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relID}">${alpha}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm${rotAttr}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
}

function textFrame(el) {
  const x = twips(el.x), y = twips(el.y), w = Math.max(1, twips(el.w)), h = Math.max(1, twips(el.h));
  const jc = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left';
  const color = (el.color || '#000000').replace('#', '').toUpperCase();
  const half = Math.max(2, Math.round(el.size * 2));
  const fontName = xmlEscape(el.font.replace('-Bold', '').replace('-Roman', ''));
  const bold = el.font.includes('Bold') ? '<w:b/>' : '';
  const rPr = `<w:rPr><w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:cs="${fontName}"/>${bold}` +
    `<w:color w:val="${color}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`;
  let runs = '';
  String(el.text || '').split('\n').forEach((line, i) => {
    if (i > 0) runs += `<w:r>${rPr}<w:br/></w:r>`;
    runs += `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
  });
  return `<w:p><w:pPr><w:framePr w:w="${w}" w:h="${h}" w:hRule="exact" w:wrap="around" w:vAnchor="page" w:hAnchor="page" w:x="${x}" w:y="${y}"/>` +
    `<w:spacing w:before="0" w:after="0"/><w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;
}

async function buildDOCX(pages, o, title, job) {
  const media = [];
  let body = '', drawingID = 1;

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    let anchors = '', frames = '';
    for (let z = 0; z < page.elements.length; z++) {
      const el = page.elements[z];
      if (el.kind === 'text') frames += textFrame(el);
      else if (isMarkup(el)) {
        const { png, frame } = await markupImage(el, o);
        const n = media.length + 1;
        const relID = `rIdImg${n}`, fileName = `image${n}.png`;
        media.push({ fileName, data: png, relID });
        anchors += anchorXML(frame, relID, drawingID++, z, fileName);
      } else {
        const prep = await prepare(el, o);
        const pic = prep.kind === 'bits' ? { data: await prep.png(), png: true } : { data: prep.bytes, png: false };
        const n = media.length + 1;
        const relID = `rIdImg${n}`, fileName = `image${n}.${pic.png ? 'png' : 'jpeg'}`;
        media.push({ fileName, data: pic.data, relID });
        anchors += anchorXML(el, relID, drawingID++, z, fileName);
      }
      job.step();
    }
    body += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>' + anchors + '</w:p>';
    body += frames;
    if (pi < pages.length - 1) {
      body += '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:rPr><w:sz w:val="2"/></w:rPr>' + sectPr(page.w, page.h) + '</w:pPr></w:p>';
    }
  }
  const last = pages[pages.length - 1];
  body += sectPr(last.w, last.h);

  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`;

  let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  for (const m of media) rels += `<Relationship Id="${m.relID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.fileName}"/>`;
  rels += '</Relationships>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica" w:cs="Helvetica"/>' +
    '<w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>' +
    '</w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>';

  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>DocPrint Studio</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    '</cp:coreProperties>';

  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    `<Application>DocPrint Studio</Application><Pages>${pages.length}</Pages></Properties>`;

  const enc = new TextEncoder();
  const files = [
    ['[Content_Types].xml', enc.encode(contentTypes)],
    ['_rels/.rels', enc.encode(rootRels)],
    ['docProps/core.xml', enc.encode(core)],
    ['docProps/app.xml', enc.encode(app)],
    ['word/document.xml', enc.encode(document)],
    ['word/styles.xml', enc.encode(styles)],
    ['word/_rels/document.xml.rels', enc.encode(rels)],
    ...media.map((m) => [`word/media/${m.fileName}`, m.data]),
  ];
  return [zipStore(files)];
}

// ------------------------------------------------------------------ page bitmaps (JPEG / PNG / previews)

/**
 * Rasterizes a page at the export resolution (capped by maxPixels and the iOS canvas limit).
 * compressed: draw images exactly as they'll be embedded (previews of PDF / Word).
 */
async function renderPageRaster(page, o, job, { compressed = false, maxPixels = Infinity } = {}) {
  let scale = effectiveDPI(o) / 72;
  scale = Math.min(scale, maxPixels / Math.max(page.w, page.h));
  const maxArea = 16e6;
  if (page.w * page.h * scale * scale > maxArea) scale = Math.sqrt(maxArea / (page.w * page.h));
  const canvas = newCanvas(page.w * scale, page.h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / page.w, canvas.height / page.h);
  for (const el of page.elements) {
    ctx.save();
    ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
    ctx.rotate(((el.rotation || 0) * Math.PI) / 180);
    ctx.globalAlpha = el.opacity ?? 1;
    if (el.kind === 'text') {
      drawTextLocal(ctx, { ...el, color: adjustedColor(el.color, o.colorMode) });
    } else if (isMarkup(el)) {
      ctx.translate(-el.w / 2, -el.h / 2);
      drawMarkupCanvas(ctx, el, (c) => adjustedColor(c, o.colorMode));
    } else if (compressed && vectorPDF(el, o)) {
      const pc = await renderPdfPage(assets.get(el.asset), el.pageIndex, Math.max(el.w, el.h) * scale);
      ctx.drawImage(pc, -el.w / 2, -el.h / 2, el.w, el.h);
      pc.width = pc.height = 0;
    } else {
      const d = compressed ? await compressedDrawable(el, o) : { src: (await scaledImage(el, o)).canvas, dispose: () => {} };
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(d.src, -el.w / 2, -el.h / 2, el.w, el.h);
      d.dispose();
    }
    ctx.restore();
    job.step();
  }
  applyColorMode(canvas, o.colorMode);
  return canvas;
}

/** Writes the resolution into a JPEG's JFIF header so it prints at its true size. */
function stampJpegDPI(bytes, dpi) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] === 0xe0 &&
      bytes[6] === 0x4a && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
    const d = Math.round(dpi);
    bytes[13] = 1; bytes[14] = d >> 8; bytes[15] = d & 255; bytes[16] = d >> 8; bytes[17] = d & 255;
  }
  return bytes;
}

async function pageFile(page, o, job) {
  const c = await renderPageRaster(page, o, job);
  const dpi = (c.width / page.w) * 72;
  try {
    if (o.format === 'png') {
      if (o.colorMode === 'color') return new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const gray = new Uint8Array(c.width * c.height);
      for (let i = 0; i < gray.length; i++) gray[i] = d[i * 4];
      if (o.colorMode === 'blackWhite') {
        const { bits, rowBytes } = packBits(gray, c.width, c.height);
        return await encodeGrayPNG(bits, c.width, c.height, 1, rowBytes, dpi);
      }
      return await encodeGrayPNG(gray, c.width, c.height, 8, c.width, dpi);
    }
    return stampJpegDPI(new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', o.quality)).arrayBuffer()), dpi);
  } finally {
    c.width = c.height = 0;
  }
}

// ------------------------------------------------------------------ whole export

const elementCount = (pages) => pages.reduce((n, p) => n + p.elements.length, 0);

/** Builds the output files' bytes (one item, or one per page for JPEG / PNG). */
async function build(pages, o, title, job, { searchable = false, encrypt = false } = {}) {
  if (!pages.length) throw new Error('No pages are selected for export.');
  if (o.format === 'pdf') {
    let bytes = await buildPDF(pages, o, title, job, { searchable });
    if (encrypt && o.usePassword && o.password) bytes = await encryptPDF(bytes, o.password);
    return [bytes];
  }
  if (o.format === 'docx') return buildDOCX(pages, o, title, job);
  const files = [];
  for (const p of pages) files.push(await pageFile(p, o, job));
  return files;
}

/** Estimated output size in bytes (without OCR or encryption, like the Mac app). */
export function estimateSize(pages, o, title, isCancelled) {
  return serial(async () => {
    const files = await build(pages, o, title, new Job(1, () => {}, isCancelled));
    return files.reduce((n, f) => n + f.length, 0);
  });
}

/** Preview of one page exactly as it will look after compression. */
export function preview(page, o, isCancelled, maxPixels = 2000) {
  return serial(async () => {
    const job = new Job(1, () => {}, isCancelled);
    if (o.format === 'pdf' || o.format === 'docx') return renderPageRaster(page, o, job, { compressed: true, maxPixels });
    const c = await renderPageRaster(page, o, job, { maxPixels });
    if (o.format === 'png' || o.colorMode === 'blackWhite') return c;
    const bmp = await decode(await canvasToBlob(c, 'image/jpeg', o.quality));
    c.getContext('2d').drawImage(bmp, 0, 0);
    release(bmp);
    return c;
  });
}

/** Highest quality (then resolution) whose output fits in targetBytes, or null if none does. */
export async function optionsFitting(targetBytes, pages, options, title, isCancelled) {
  const o = { ...options };
  const lower = [300, 200, 150, 100, 72].filter((d) => options.dpi === 0 || d < options.dpi);
  const size = async () => { if (isCancelled()) throw new Cancelled(); return estimateSize(pages, o, title, isCancelled); };
  for (const dpi of [options.dpi, ...lower]) {
    o.dpi = dpi;
    if (!usesJPEG(o)) {
      if ((await size()) <= targetBytes) return { ...o };
      continue;
    }
    o.quality = 0.3;
    if ((await size()) > targetBytes) continue;
    let lo = 0.3, hi = 0.95;
    for (let i = 0; i < 6; i++) {
      o.quality = (lo + hi) / 2;
      if ((await size()) <= targetBytes) lo = o.quality; else hi = o.quality;
    }
    o.quality = Math.floor(lo * 100) / 100;
    return { ...o };
  }
  return null;
}

const safeName = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled';

/** Runs the export and returns File objects ready to share. */
export function runExport(pages, o, title, onProgress, isCancelled) {
  return serial(async () => {
    const searchable = o.format === 'pdf' && o.searchableText;
    const job = new Job(elementCount(pages) * (searchable ? 2 : 1) + (FORMATS[o.format].perPage ? pages.length : 0) + 1, onProgress, isCancelled);
    const files = await build(pages, o, title, job, { searchable, encrypt: true });
    const f = FORMATS[o.format];
    const base = safeName(title);
    if (files.length === 1) return [new File([files[0]], `${base}.${f.ext}`, { type: f.mime })];
    const digits = String(files.length).length;
    return files.map((b, i) => new File([b], `${base}-${String(i + 1).padStart(digits, '0')}.${f.ext}`, { type: f.mime }));
  });
}
