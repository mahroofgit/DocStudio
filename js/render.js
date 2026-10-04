// Draws a page into a 2D canvas: thumbnails, "save page as image", and raster fallbacks
// for text the PDF standard fonts can't encode.

import { fontInfo, wrapText, LINE_HEIGHT, BASELINE } from './geometry.js';
import { getDisplay, fullResCanvas, assets } from './imaging.js';
import { pdfPreviewAsync, renderPdfPage } from './pdfsupport.js';

const measureCtx = document.createElement('canvas').getContext('2d');
const baselineCache = new Map();

export const cssFont = (el, px) => {
  const f = fontInfo(el.font);
  return `${f.weight} ${px}px ${f.css}`;
};

/** First-baseline offset (× font size) matching the CSS line box used on the canvas. */
export function baselineFactor(fontId) {
  if (baselineCache.has(fontId)) return baselineCache.get(fontId);
  const f = fontInfo(fontId);
  measureCtx.font = `${f.weight} 100px ${f.css}`;
  const m = measureCtx.measureText('Hg');
  let v = BASELINE;
  if (m.fontBoundingBoxAscent != null && m.fontBoundingBoxDescent != null) {
    const A = m.fontBoundingBoxAscent / 100, D = m.fontBoundingBoxDescent / 100;
    v = (LINE_HEIGHT - (A + D)) / 2 + A;
  }
  baselineCache.set(fontId, v);
  return v;
}

/** Text lines for an element, wrapped with the browser's own font metrics (in points). */
export function layoutTextLines(el) {
  measureCtx.font = cssFont(el, 100);
  return wrapText(el.text || '', el.w, (s) => (measureCtx.measureText(s).width / 100) * el.size);
}

/** Draws a text element into ctx whose units are page points (already transformed). */
export function drawTextLocal(ctx, el) {
  const lines = layoutTextLines(el);
  ctx.font = cssFont(el, el.size);
  ctx.fillStyle = el.color || '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left';
  const x = el.align === 'center' ? 0 : el.align === 'right' ? el.w / 2 : -el.w / 2;
  const base = baselineFactor(el.font) * el.size;
  lines.forEach((line, i) => ctx.fillText(line, x, -el.h / 2 + base + i * el.size * LINE_HEIGHT));
}

const imgCache = new Map();
async function loadImg(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  imgCache.set(url, p);
  if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value);
  return p;
}

/**
 * Renders `page` into a new canvas at `scale` px per point.
 * fullRes: use full-resolution processed images and high-res PDF pages (export).
 */
export async function renderPage(page, scale, { fullRes = false } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(page.w * scale));
  c.height = Math.max(1, Math.round(page.h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  for (const el of page.elements) {
    ctx.save();
    ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
    ctx.rotate(((el.rotation || 0) * Math.PI) / 180);
    ctx.globalAlpha = el.opacity ?? 1;
    try {
      if (el.kind === 'text') {
        drawTextLocal(ctx, el);
      } else if (el.kind === 'image') {
        let src = null;
        if (fullRes) src = await fullResCanvas(el);
        else {
          const d = getDisplay(el);
          if (d) src = await loadImg(d.url);
        }
        if (src) {
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(src, -el.w / 2, -el.h / 2, el.w, el.h);
          if (fullRes && src.width) { src.width = src.height = 1; }
        }
      } else if (el.kind === 'pdf') {
        const asset = assets.get(el.asset);
        if (fullRes && asset) {
          const px = Math.max(el.w, el.h) * scale;
          const pc = await renderPdfPage(asset, el.pageIndex, Math.min(6000, Math.max(800, px)));
          ctx.drawImage(pc, -el.w / 2, -el.h / 2, el.w, el.h);
          pc.width = pc.height = 1;
        } else {
          const url = await pdfPreviewAsync(el.asset, el.pageIndex);
          if (url) ctx.drawImage(await loadImg(url), -el.w / 2, -el.h / 2, el.w, el.h);
        }
      }
    } catch (e) { console.warn('render element failed', e); }
    ctx.restore();
  }
  return c;
}
