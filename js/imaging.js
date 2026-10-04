// Image assets: import (orientation, DPI, size limits), ≤2000 px proxies for live editing,
// the background scan worker, processed-preview cache and full-resolution renders for export.

import { store } from './store.js';
import { uid, isFullQuad } from './geometry.js';

export const assets = new Map();          // id → asset record (see makeImageAsset / pdf assets)
export const MAX_ORIGINAL = 4096;         // keeps every bitmap inside iOS canvas limits
export const PROXY_MAX = 2000;

// ------------------------------------------------------------------ worker

const worker = new Worker('js/scan-worker.js');
let msgId = 0;
const calls = new Map();
worker.onmessage = (e) => {
  const c = calls.get(e.data.id);
  if (!c) return;
  calls.delete(e.data.id);
  if (e.data.error) c.reject(new Error(e.data.error)); else c.resolve(e.data);
};
function call(msg, transfer = []) {
  const id = ++msgId;
  msg.id = id;
  return new Promise((resolve, reject) => { calls.set(id, { resolve, reject }); worker.postMessage(msg, transfer); });
}

// ------------------------------------------------------------------ helpers

export function isIdentityScan(s) {
  return !s || (s.mode === 'original' && s.exposure === 0 && s.contrast === 1 && s.saturation === 1 && s.gamma === 1 && s.sharpness === 0);
}

export function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality));
}

export async function decodeBlob(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error('unsupported image');
  }
  return { img, url };
}

/** Reads orientation and resolution from JPEG (JFIF/EXIF) or PNG (pHYs). */
export function readImageMeta(buf) {
  const v = new DataView(buf);
  const meta = { orientation: 1, dpi: null };
  try {
    if (v.getUint16(0) === 0xffd8) {
      let p = 2;
      while (p + 4 < v.byteLength) {
        const marker = v.getUint16(p);
        const len = v.getUint16(p + 2);
        if (marker === 0xffe0 && v.getUint32(p + 4) === 0x4a464946) {          // JFIF
          const units = v.getUint8(p + 11), xd = v.getUint16(p + 12);
          if (units === 1 && xd > 1) meta.dpi = meta.dpi || xd;
          if (units === 2 && xd > 1) meta.dpi = meta.dpi || xd * 2.54;
        } else if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) {   // Exif
          const t = p + 10, le = v.getUint16(t) === 0x4949;
          const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
          const ifd = u32(4), count = u16(ifd);
          let xres = null, unit = 2;
          for (let i = 0; i < count; i++) {
            const e = ifd + 2 + i * 12, tag = u16(e);
            if (tag === 0x0112) meta.orientation = u16(e + 8);
            if (tag === 0x011a) { const off = u32(e + 8); const den = u32(off + 4); if (den) xres = u32(off) / den; }
            if (tag === 0x0128) unit = u16(e + 8);
          }
          if (xres && xres > 1 && !meta.dpi) meta.dpi = unit === 3 ? xres * 2.54 : xres;
        } else if (marker === 0xffda) break;
        p += 2 + len;
      }
    } else if (v.getUint32(0) === 0x89504e47) {
      let p = 8;
      while (p + 8 < v.byteLength) {
        const len = v.getUint32(p), type = v.getUint32(p + 4);
        if (type === 0x70485973) {                                               // pHYs
          const ppu = v.getUint32(p + 8), unit = v.getUint8(p + 16);
          if (unit === 1 && ppu > 0) meta.dpi = ppu * 0.0254;
          break;
        }
        if (type === 0x49444154) break;                                          // IDAT
        p += 12 + len;
      }
    }
  } catch { /* malformed metadata: ignore */ }
  if (meta.dpi && (meta.dpi < 50 || meta.dpi > 4800)) meta.dpi = null;
  return meta;
}

// ------------------------------------------------------------------ import

/** Imports an image file → stored asset. Normalizes orientation and caps the size. */
export async function importImageFile(file) {
  const buf = await file.arrayBuffer();
  const meta = readImageMeta(buf);
  let type = (file.type || '').toLowerCase();
  const head = new Uint8Array(buf.slice(0, 4));
  if (head[0] === 0xff && head[1] === 0xd8) type = 'image/jpeg';
  else if (head[0] === 0x89 && head[1] === 0x50) type = 'image/png';

  const { img, url } = await decodeBlob(new Blob([buf], { type: type || 'image/*' }));
  let w = img.naturalWidth, h = img.naturalHeight;
  URL.revokeObjectURL(url);
  if (!w || !h) throw new Error('unsupported image');

  const k = Math.min(1, MAX_ORIGINAL / Math.max(w, h));
  const keep = (type === 'image/jpeg' || type === 'image/png') && meta.orientation === 1 && k === 1;
  let bytes = buf, mime = type, dpi = meta.dpi;
  if (!keep) {
    const cw = Math.round(w * k), ch = Math.round(h * k);
    const c = newCanvas(cw, ch);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    mime = type === 'image/png' ? 'image/png' : 'image/jpeg';
    bytes = await (await canvasToBlob(c, mime, 0.95)).arrayBuffer();
    if (dpi) dpi *= k;
    w = cw; h = ch;
  }
  const asset = {
    id: uid(), type: 'image', name: (file.name || 'Photo').replace(/\.[^.]+$/, '') || 'Photo',
    bytes, mime, w, h, dpi: dpi || null,
  };
  assets.set(asset.id, asset);
  await store.putAsset(persistable(asset));
  return asset;
}

export function persistable(a) {
  const { id, type, name, bytes, mime, w, h, dpi, pages } = a;
  return { id, type, name, bytes, mime, w, h, dpi, pages };
}

export function blobOf(asset) {
  if (!asset._blob) asset._blob = new Blob([asset.bytes], { type: asset.mime });
  return asset._blob;
}

/** Decodes the original, builds the ≤2000 px proxy, sends it to the worker. Memoized. */
export function ensureImageReady(asset) {
  if (!asset._ready) {
    asset._ready = (async () => {
      const { img, url } = await decodeBlob(blobOf(asset));
      asset.url = url;
      const k = Math.min(1, PROXY_MAX / Math.max(asset.w, asset.h));
      const pw = Math.max(1, Math.round(asset.w * k)), ph = Math.max(1, Math.round(asset.h * k));
      const c = newCanvas(pw, ph);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, pw, ph);
      const data = ctx.getImageData(0, 0, pw, ph).data;
      await call({ type: 'setProxy', asset: asset.id, w: pw, h: ph, data }, [data.buffer]);
      asset.proxyW = pw; asset.proxyH = ph;
      asset.proxyUrl = k === 1 ? url : URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.9));
      c.width = c.height = 1;
      return asset;
    })();
    asset._ready.catch(() => { asset._ready = null; });
  }
  return asset._ready;
}

// ------------------------------------------------------------------ processed previews

const cache = new Map();        // key → { url, w, h }
const inflight = new Map();     // key → Promise
const lastShown = new Map();    // element id → { url, w, h }
const jobs = new Map();         // element id → { running, next }
let readyListener = () => {};
export function onDisplayReady(fn) { readyListener = fn; }

export const displayKey = (el) => `${el.asset}|${JSON.stringify(isFullQuad(el.quad) ? null : el.quad)}|${JSON.stringify(el.scan)}`;

/**
 * What to show for an image element right now. Returns {url, w, h} (possibly a stale
 * result while a new one renders) or null when nothing is available yet.
 */
export function getDisplay(el) {
  const asset = assets.get(el.asset);
  if (!asset) return null;
  if (isFullQuad(el.quad) && isIdentityScan(el.scan)) {
    if (asset.proxyUrl) return { url: asset.proxyUrl, w: asset.proxyW, h: asset.proxyH, fresh: true };
    ensureImageReady(asset).then(() => readyListener(null, el.id), () => {});
    return null;
  }
  const key = displayKey(el);
  const hit = cache.get(key);
  if (hit) { lastShown.set(el.id, hit); return { ...hit, fresh: true }; }
  schedule(el, key);
  return lastShown.get(el.id) || (asset.proxyUrl ? { url: asset.proxyUrl, w: asset.proxyW, h: asset.proxyH } : null);
}

/** Resolves with the processed preview for an element (used for the aspect fix after unwarping). */
export function whenDisplay(el) {
  if (isFullQuad(el.quad) && isIdentityScan(el.scan)) {
    const a = assets.get(el.asset);
    return ensureImageReady(a).then(() => ({ w: a.proxyW, h: a.proxyH }));
  }
  const key = displayKey(el);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  return produce(key, el.asset, el.quad, el.scan);
}

function schedule(el, key) {
  let j = jobs.get(el.id);
  if (!j) { j = { running: false, next: null }; jobs.set(el.id, j); }
  j.next = { key, asset: el.asset, quad: el.quad, scan: el.scan };
  if (j.running) return;
  j.running = true;
  (async () => {
    while (j.next) {
      const r = j.next; j.next = null;
      try {
        const res = await produce(r.key, r.asset, r.quad, r.scan);
        lastShown.set(el.id, res);
        readyListener(r.key, el.id);
      } catch (e) { console.warn('render failed', e); }
    }
    j.running = false;
  })();
}

function produce(key, assetId, quad, scan) {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const asset = assets.get(assetId);
    await ensureImageReady(asset);
    const res = await call({ type: 'process', asset: assetId, quad: isFullQuad(quad) ? null : quad, settings: scan });
    const c = newCanvas(res.w, res.h);
    c.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
    const url = URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.92));
    c.width = c.height = 1;
    const entry = { url, w: res.w, h: res.h };
    cache.set(key, entry);
    evict();
    return entry;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}

function evict() {
  if (cache.size <= 48) return;
  const shown = new Set([...lastShown.values()].map((e) => e.url));
  for (const [k, v] of cache) {
    if (cache.size <= 40) break;
    if (shown.has(v.url)) continue;
    cache.delete(k);
    URL.revokeObjectURL(v.url);
  }
}

/** Document edge detection on the proxy. Returns a normalized quad or null. */
export async function detectDocument(assetId) {
  const asset = assets.get(assetId);
  await ensureImageReady(asset);
  const res = await call({ type: 'detect', asset: assetId });
  return res.quad || null;
}

/** Unwarp preview for the corner editor (no filters). */
export async function previewQuad(assetId, quad) {
  const res = await whenDisplay({ asset: assetId, quad, scan: { mode: 'original', exposure: 0, contrast: 1, saturation: 1, gamma: 1, sharpness: 0, hardThreshold: false, threshold: 0.55 } });
  return res;
}

// ------------------------------------------------------------------ full resolution (export)

/** Processed full-resolution canvas for an image element. */
export async function fullResCanvas(el) {
  const asset = assets.get(el.asset);
  const { img, url } = await decodeBlob(blobOf(asset));
  const c = newCanvas(asset.w, asset.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, asset.w, asset.h);
  URL.revokeObjectURL(url);
  if (isFullQuad(el.quad) && isIdentityScan(el.scan)) return c;
  const data = ctx.getImageData(0, 0, asset.w, asset.h).data;
  c.width = c.height = 1;
  const res = await call({ type: 'process', w: asset.w, h: asset.h, data, quad: isFullQuad(el.quad) ? null : el.quad, settings: el.scan }, [data.buffer]);
  const out = newCanvas(res.w, res.h);
  out.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
  return out;
}

/** Encoded full-resolution bitmap for PDF / DOCX: PNG for B&W and grayscale, JPEG otherwise. */
export async function fullResBytes(el) {
  const asset = assets.get(el.asset);
  if (isFullQuad(el.quad) && isIdentityScan(el.scan) && (asset.mime === 'image/jpeg' || asset.mime === 'image/png')) {
    return { bytes: new Uint8Array(asset.bytes), png: asset.mime === 'image/png', w: asset.w, h: asset.h };
  }
  const c = await fullResCanvas(el);
  const png = el.scan && (el.scan.mode === 'blackWhite' || el.scan.mode === 'grayscale');
  const blob = await canvasToBlob(c, png ? 'image/png' : 'image/jpeg', 0.92);
  const out = { bytes: new Uint8Array(await blob.arrayBuffer()), png, w: c.width, h: c.height };
  c.width = c.height = 1;
  return out;
}

export function forgetAsset(id) {
  const a = assets.get(id);
  if (!a) return;
  if (a.type === 'image') call({ type: 'dropProxy', asset: id }).catch(() => {});
  assets.delete(id);
}
