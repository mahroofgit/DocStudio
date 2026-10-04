// PDF import and page rendering via pdf.js (vendored, loaded on first use).

import { assets, newCanvas, canvasToBlob } from './imaging.js';
import { store } from './store.js';
import { uid } from './geometry.js';

let libPromise = null;

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src + ' — check your connection.'));
    document.head.appendChild(s);
  });
}

export function pdfjs() {
  if (!libPromise) {
    libPromise = loadScript('vendor/pdf.min.js').then(() => {
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      return lib;
    });
    libPromise.catch(() => { libPromise = null; });
  }
  return libPromise;
}

async function openDoc(asset) {
  if (!asset._doc) {
    asset._doc = pdfjs().then((lib) => lib.getDocument({
      data: new Uint8Array(asset.bytes.slice(0)),
      cMapUrl: 'vendor/cmaps/', cMapPacked: true,
      standardFontDataUrl: 'vendor/standard_fonts/',
      isEvalSupported: false,
    }).promise);
    asset._doc.catch(() => { asset._doc = null; });
  }
  return asset._doc;
}

/** Imports a PDF file → asset with each page's effective size (crop box, /Rotate applied). */
export async function importPdfFile(file) {
  const bytes = await file.arrayBuffer();
  const asset = { id: uid(), type: 'pdf', name: (file.name || 'Document').replace(/\.pdf$/i, ''), bytes, mime: 'application/pdf' };
  let doc;
  try {
    doc = await openDoc(asset);
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error(`“${file.name}” is password-protected.`);
    throw new Error(`Couldn't open the PDF “${file.name}”.`);
  }
  asset.pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    asset.pages.push({ w: vp.width, h: vp.height });
  }
  assets.set(asset.id, asset);
  await store.putAsset({ id: asset.id, type: 'pdf', name: asset.name, bytes, mime: asset.mime, pages: asset.pages });
  return asset;
}

/** Renders one page (0-based) to a canvas whose longest side is ≤ maxPixel. */
export async function renderPdfPage(asset, index, maxPixel) {
  const doc = await openDoc(asset);
  const page = await doc.getPage(index + 1);
  const vp1 = page.getViewport({ scale: 1 });
  let scale = maxPixel / Math.max(vp1.width, vp1.height);
  const maxArea = 16000000;
  if (vp1.width * vp1.height * scale * scale > maxArea) scale = Math.sqrt(maxArea / (vp1.width * vp1.height));
  const vp = page.getViewport({ scale });
  const c = newCanvas(vp.width, vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return c;
}

const previews = new Map();   // `${asset}:${index}` → url | Promise
let readyListener = () => {};
export function onPreviewReady(fn) { readyListener = fn; }

/** Canvas preview URL for a PDF element, or null while it renders. */
export function pdfPreview(assetId, index) {
  const key = `${assetId}:${index}`;
  const v = previews.get(key);
  if (typeof v === 'string') return v;
  if (!v) {
    const asset = assets.get(assetId);
    if (!asset) return null;
    const p = renderPdfPage(asset, index, 1600)
      .then((c) => canvasToBlob(c, 'image/jpeg', 0.9).then((b) => { c.width = c.height = 1; return b; }))
      .then((b) => { const url = URL.createObjectURL(b); previews.set(key, url); readyListener(); return url; })
      .catch((e) => { console.warn('pdf preview failed', e); previews.delete(key); });
    previews.set(key, p);
  }
  return null;
}

/** Waits for a preview (thumbnails / raster export). */
export async function pdfPreviewAsync(assetId, index) {
  const url = pdfPreview(assetId, index);
  if (url) return url;
  const v = previews.get(`${assetId}:${index}`);
  return (await v) || null;
}
