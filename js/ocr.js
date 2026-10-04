// On-device text recognition for searchable PDFs (Tesseract, English). Loaded on first use;
// the engine and language data come from this site, so it also works offline once cached.

import { loadScript } from './pdfsupport.js';

let workerPromise = null;
const abs = (p) => new URL(p, location.href).href;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript('vendor/tesseract/tesseract.min.js');
      return window.Tesseract.createWorker('eng', 1 /* LSTM only */, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core/'),
        langPath: abs('vendor/tesseract/lang'),
        workerBlobURL: false,
        gzip: true,
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/**
 * Recognizes words in a canvas. Returns [{ text, box: {x, y, w, h} }] with the box normalized
 * to 0…1 (origin top-left).
 */
export async function recognizeWords(canvas) {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
  const W = canvas.width, H = canvas.height;
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          const t = (word.text || '').trim();
          if (!t || word.confidence < 30) continue;
          const b = word.bbox;
          words.push({ text: t, box: { x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H } });
        }
      }
    }
  }
  return words;
}

export async function terminateOCR() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  if (w) await w.terminate();
}
