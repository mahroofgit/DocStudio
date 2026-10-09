// Resize Image tool (Home → Resize Image): change a photo's size in pixels, mm, cm or inches,
// set its print resolution, and save it as JPEG, PNG or WebP. Works on one photo or a batch.

import { icon } from './icons.js';
import { h, toast } from './ui.js';
import { decodeBlob, readImageMeta, newCanvas, canvasToBlob } from './imaging.js';
import { fileSize } from './export.js';
import { shareFiles } from './exportui.js';
import { chunk } from './png.js';

const MAX_AREA = 16777216;                 // iOS canvas limit (4096 × 4096)
const PER_INCH = { px: 1, in: 1, cm: 2.54, mm: 25.4 };
const DIGITS = { px: 0, in: 2, cm: 2, mm: 1 };
const FORMATS = [
  { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
  { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', lossy: false },
  { id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true },
];
const PRESETS = [
  { label: 'Passport 35 × 45 mm', unit: 'mm', w: 35, h: 45, dpi: 300, fit: 'crop' },
  { label: '2 × 2 in', unit: 'in', w: 2, h: 2, dpi: 300, fit: 'crop' },
  { label: '4 × 6 in', unit: 'in', w: 4, h: 6, dpi: 300, fit: 'crop', orient: true },
  { label: '5 × 7 in', unit: 'in', w: 5, h: 7, dpi: 300, fit: 'crop', orient: true },
  { label: 'A4', unit: 'mm', w: 210, h: 297, dpi: 300, fit: 'pad', orient: true },
  { label: 'Square 1080 px', unit: 'px', w: 1080, h: 1080, fit: 'crop' },
  { label: 'Full HD 1920 px', unit: 'px', w: 1920, h: 1080, fit: 'crop', orient: true },
  { label: 'Email 1200 px', unit: 'px', long: 1200 },
];

let webpOK = null;
function supportsWebP() {
  if (webpOK == null) { try { webpOK = newCanvas(2, 2).toDataURL('image/webp').startsWith('data:image/webp'); } catch { webpOK = false; } }
  return webpOK;
}

// ------------------------------------------------------------------ settings → pixels

/** Output size in pixels for one image, plus how the source maps onto it. */
function plan(f, o) {
  let W, H;
  if (o.mode === 'percent') { W = f.w * o.percent / 100; H = f.h * o.percent / 100; }
  else if (o.lock) {
    if (o.driver === 'h') { H = o.hPx; W = H * f.w / f.h; } else { W = o.wPx; H = W * f.h / f.w; }
  } else { W = o.wPx; H = o.hPx; }
  W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
  let src = { x: 0, y: 0, w: f.w, h: f.h }, dst = { x: 0, y: 0, w: W, h: H };
  if (o.mode === 'size' && !o.lock) {
    if (o.fit === 'crop') {
      const s = Math.max(W / f.w, H / f.h);
      src = { w: W / s, h: H / s }; src.x = (f.w - src.w) / 2; src.y = (f.h - src.h) / 2;
    } else if (o.fit === 'pad') {
      const s = Math.min(W / f.w, H / f.h);
      dst = { w: f.w * s, h: f.h * s }; dst.x = (W - dst.w) / 2; dst.y = (H - dst.h) / 2;
    }
  }
  return { W, H, src, dst };
}

/** Draws the image at the new size, halving in steps when shrinking a lot (sharper result). */
function draw(f, p, fmt) {
  const { W, H, src, dst } = p;
  let cur = f.img, cx = src.x, cy = src.y, cw = src.w, ch = src.h;
  // First pass: no more than the canvas limit, and no more than 2× the final size per halving step.
  let tw = cw, th = ch;
  const k0 = Math.min(1, Math.sqrt(MAX_AREA / (cw * ch)));
  tw *= k0; th *= k0;
  while (tw / 2 >= dst.w * 1.5 && th / 2 >= dst.h * 1.5) { tw /= 2; th /= 2; }
  if (tw < cw * 0.999) {
    let c = newCanvas(tw, th), ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
    cur = c; cx = 0; cy = 0; cw = c.width; ch = c.height;
    while (cw / 2 >= dst.w * 1.5 && ch / 2 >= dst.h * 1.5) {
      const n = newCanvas(cw / 2, ch / 2), nctx = n.getContext('2d');
      nctx.imageSmoothingQuality = 'high';
      nctx.drawImage(cur, 0, 0, n.width, n.height);
      cur.width = cur.height = 0;
      cur = n; cw = n.width; ch = n.height;
    }
  }
  const out = newCanvas(W, H), ctx = out.getContext('2d');
  if (fmt.id === 'jpeg' || dstPadded(p)) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, cx, cy, cw, ch, dst.x, dst.y, dst.w, dst.h);
  if (cur !== f.img) cur.width = cur.height = 0;
  return out;
}
const dstPadded = (p) => p.dst.w < p.W - 0.5 || p.dst.h < p.H - 0.5;

// ------------------------------------------------------------------ resolution metadata

function jpegWithDPI(bytes, dpi) {
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[6] === 0x4a && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
    bytes[13] = 1; bytes[14] = d >> 8; bytes[15] = d & 255; bytes[16] = d >> 8; bytes[17] = d & 255;
    return bytes;
  }
  // No JFIF header: insert one after the start marker.
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2)); out.set(app0, 2); out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}
function pngWithDPI(bytes, dpi) {
  const phys = new Uint8Array(9), v = new DataView(phys.buffer), ppm = Math.round(dpi / 0.0254);
  v.setUint32(0, ppm); v.setUint32(4, ppm); phys[8] = 1;
  // Rebuild the chunk list with our pHYs right after IHDR (dropping any existing one).
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  for (let p = 8; p + 8 <= bytes.length;) {
    const len = dv.getUint32(p), type = dv.getUint32(p + 4), end = p + 12 + len;
    if (type !== 0x70485973) parts.push(bytes.subarray(p, end));
    if (type === 0x49484452) parts.push(chunk('pHYs', phys));          // after IHDR
    p = end;
  }
  const out = new Uint8Array(parts.reduce((n, q) => n + q.length, 0));
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

async function encode(f, o, quality = o.quality) {
  const fmt = FORMATS.find((x) => x.id === o.format);
  const p = plan(f, o);
  if (p.W * p.H > MAX_AREA) throw new Error('too large');
  const c = draw(f, p, fmt);
  try {
    let bytes = new Uint8Array(await (await canvasToBlob(c, fmt.mime, fmt.lossy ? quality : undefined)).arrayBuffer());
    if (fmt.id === 'jpeg') bytes = jpegWithDPI(bytes, o.dpi);
    if (fmt.id === 'png') bytes = pngWithDPI(bytes, o.dpi);
    return { bytes, W: p.W, H: p.H, mime: fmt.mime, ext: fmt.ext };
  } finally { c.width = c.height = 0; }
}

// ------------------------------------------------------------------ screen

const $ = (s) => document.querySelector(s);
let picker = null;

/** Opens the photo picker, then the resize screen. */
export function startResize() {
  if (!picker) {
    picker = h('input', { type: 'file', accept: 'image/*,.heic,.heif', multiple: true, hidden: true });
    document.body.append(picker);
    picker.addEventListener('change', () => {
      const files = [...picker.files]; picker.value = '';
      if (files.length) openResizer(files);
    });
  }
  picker.click();
}

async function loadFile(file) {
  const buf = await file.arrayBuffer();
  const meta = readImageMeta(buf);
  const { img, url } = await decodeBlob(new Blob([buf], { type: file.type || 'image/*' }));
  return {
    name: (file.name || 'Photo').replace(/\.[^.]+$/, '') || 'Photo',
    img, url, w: img.naturalWidth, h: img.naturalHeight, dpi: meta.dpi ? Math.round(meta.dpi) : null, size: file.size,
    type: (file.type || '').replace('image/', '').toUpperCase() || 'Image',
  };
}

export async function openResizer(fileList) {
  let images;
  try { images = await Promise.all(fileList.map(loadFile)); }
  catch { toast('That image format isn’t supported.'); return; }
  images = images.filter((f) => f.w && f.h);
  if (!images.length) return;

  const first = images[0];
  const saved = (() => { try { return JSON.parse(localStorage.getItem('resizeOpts') || '{}'); } catch { return {}; } })();
  const o = {
    mode: 'size', unit: saved.unit || 'px', lock: true, driver: 'w', fit: 'crop', percent: 50,
    wPx: first.w, hPx: first.h, dpi: first.dpi || 300,
    format: saved.format && (saved.format !== 'webp' || supportsWebP()) ? saved.format : 'jpeg',
    quality: saved.quality || 0.85,
  };
  let idx = 0, gen = 0, timer = null, result = null, busy = false, message = '';
  let names = images.map((f) => f.name);

  const root = h('div', { id: 'resizer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Resize Image' });
  const close = () => {
    gen++; clearTimeout(timer);
    if (result?.url) URL.revokeObjectURL(result.url);
    images.forEach((f) => URL.revokeObjectURL(f.url));
    root.remove(); document.body.classList.remove('modal-open');
  };
  const addMore = h('input', { type: 'file', accept: 'image/*,.heic,.heif', multiple: true, hidden: true });
  addMore.addEventListener('change', async () => {
    const files = [...addMore.files]; addMore.value = '';
    try {
      const more = (await Promise.all(files.map(loadFile))).filter((f) => f.w && f.h);
      images.push(...more); names.push(...more.map((f) => f.name));
      idx = images.length - more.length;
      update(); schedule(0);
    } catch { toast('That image format isn’t supported.'); }
  });

  // ---- preview
  const pvImg = h('img', { class: 'pv-img', alt: '' });
  const pvPrev = h('button', { class: 'btn icon small', 'aria-label': 'Previous image', html: icon('left'), onclick: () => { idx--; update(); schedule(0); } });
  const pvNext = h('button', { class: 'btn icon small', 'aria-label': 'Next image', html: icon('right'), onclick: () => { idx++; update(); schedule(0); } });
  const pvLabel = h('span', { class: 'pv-label grow' });
  const pvCount = h('span', { class: 'pv-count' });
  const pvRemove = h('button', { class: 'btn icon small', 'aria-label': 'Remove image', html: icon('trash'), onclick: () => {
    URL.revokeObjectURL(images[idx].url);
    images.splice(idx, 1); names.splice(idx, 1);
    if (!images.length) { close(); return; }
    idx = Math.min(idx, images.length - 1); update(); schedule(0);
  } });
  const info = h('div', { class: 'pv-note' });

  // ---- controls
  const segOf = (items, get, set) => {
    const wrap = h('div', { class: 'seg' });
    const bs = items.map(([v, label]) => { const b = h('button', { onclick: () => { set(v); changed(); } }, label); wrap.append(b); return [v, b]; });
    wrap.refresh = () => bs.forEach(([v, b]) => b.classList.toggle('on', get() === v));
    return wrap;
  };
  const numInput = (label, get, set) => {
    const input = h('input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off' });
    const unit = h('span', { class: 'unit' });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('input', () => { const v = parseFloat(input.value.replace(',', '.')); if (v > 0) { set(v); changed(true); } });
    input.addEventListener('blur', () => update());
    const field = h('div', { class: 'field' }, h('label', {}, label), input, unit);
    field.refresh = (val, u) => { if (document.activeElement !== input) input.value = val; unit.textContent = u; };
    return field;
  };

  const toUnit = (px) => (o.unit === 'px' ? px : (px / o.dpi) * PER_INCH[o.unit]);
  const fromUnit = (v) => (o.unit === 'px' ? v : (v / PER_INCH[o.unit]) * o.dpi);
  const fmtNum = (v, u) => String(+v.toFixed(DIGITS[u]));

  const modeSeg = segOf([['size', 'Dimensions'], ['percent', 'Percentage']], () => o.mode, (v) => { o.mode = v; });
  const unitSeg = segOf([['px', 'px'], ['mm', 'mm'], ['cm', 'cm'], ['in', 'in']], () => o.unit, (v) => { o.unit = v; });
  const wField = numInput('W', null, (v) => {
    o.wPx = fromUnit(v); o.driver = 'w';
    if (o.lock) { const f = images[idx]; o.hPx = o.wPx * f.h / f.w; }
  });
  const hField = numInput('H', null, (v) => {
    o.hPx = fromUnit(v); o.driver = 'h';
    if (o.lock) { const f = images[idx]; o.wPx = o.hPx * f.w / f.h; }
  });
  const lockBtn = h('button', { class: 'btn icon', onclick: () => {
    o.lock = !o.lock;
    if (o.lock) { const f = images[idx]; if (o.driver === 'h') o.wPx = o.hPx * f.w / f.h; else o.hPx = o.wPx * f.h / f.w; }
    changed();
  } });
  const fitSeg = segOf([['crop', 'Crop to fill'], ['pad', 'Fit inside'], ['stretch', 'Stretch']], () => o.fit, (v) => { o.fit = v; });
  const fitNote = h('p', { class: 'muted small' });
  const dpiField = numInput('Resolution', null, (v) => {
    // Pixel sizes stay put when working in pixels; print sizes stay put in mm / cm / in.
    if (o.unit !== 'px') { const k = v / o.dpi; o.wPx *= k; o.hPx *= k; }
    o.dpi = Math.min(2400, v);
  });
  const dpiChips = h('div', { class: 'chips' }, ...[72, 150, 300, 600].map((d) => h('button', { class: 'chip', 'data-dpi': d, onclick: () => {
    if (o.unit !== 'px') { const k = d / o.dpi; o.wPx *= k; o.hPx *= k; }
    o.dpi = d; changed();
  } }, `${d}`)));
  const presetChips = h('div', { class: 'chips' }, ...PRESETS.map((p) => h('button', { class: 'chip', onclick: () => applyPreset(p) }, p.label)));
  const pctRange = h('input', { type: 'range', min: 1, max: 200, step: 1 });
  const pctVal = h('span', { class: 'val' });
  pctRange.addEventListener('input', () => { o.percent = +pctRange.value; changed(true); });
  const pctChips = h('div', { class: 'chips' }, ...[10, 25, 50, 75, 150, 200].map((p) => h('button', { class: 'chip', 'data-pct': p, onclick: () => { o.percent = p; changed(); } }, `${p}%`)));
  const fmtSeg = segOf(FORMATS.filter((f) => f.id !== 'webp' || supportsWebP()).map((f) => [f.id, f.label]), () => o.format, (v) => { o.format = v; });
  const qRange = h('input', { type: 'range', min: 0.1, max: 1, step: 0.01 });
  const qVal = h('span', { class: 'val' });
  qRange.addEventListener('input', () => { o.quality = +qRange.value; changed(true); });
  const qRow = h('div', { class: 'q-row' }, h('span', { class: 'lbl' }, 'Quality'), qRange, qVal);
  const targetInput = h('input', { class: 'text-input narrow', type: 'text', inputmode: 'decimal', value: localStorage.getItem('resizeTargetKB') || '500' });
  const fitBtn = h('button', { class: 'btn', onclick: fitUnder }, 'Fit');
  const targetRow = h('div', { class: 'q-row' }, h('span', { class: 'lbl' }, 'Max size'), targetInput, h('span', {}, 'KB'), fitBtn);
  const fmtNote = h('p', { class: 'muted small' });
  const nameInput = h('input', { class: 'text-input', type: 'text', autocomplete: 'off', enterkeyhint: 'done' });
  nameInput.addEventListener('input', () => { names[idx] = nameInput.value.trim() || images[idx].name; });
  const warn = h('p', { class: 'warn' });

  const sizeBox = h('div', {}, h('div', { class: 'row' }, unitSeg),
    h('div', { class: 'row nowrap' }, wField, lockBtn, hField),
    h('div', { class: 'fit-wrap' }, fitSeg, fitNote));
  const pctBox = h('div', {}, h('div', { class: 'q-row' }, h('span', { class: 'lbl' }, 'Scale'), pctRange, pctVal), h('div', { style: { marginTop: '10px' } }, pctChips));
  const dpiBox = h('div', { class: 'section' }, h('h3', {}, 'Print Resolution'),
    h('div', { class: 'row nowrap' }, dpiField, h('span', { class: 'muted' }, 'DPI')), dpiChips,
    h('p', { class: 'muted small dpi-note' }));

  const footSize = h('div', { class: 'foot-size' }, h('b', {}, '—'), h('small', {}, ''));
  const saveBtn = h('button', { class: 'btn primary grow', onclick: save }, 'Save Image');
  const footer = h('footer', {}, footSize, saveBtn);

  root.append(
    h('header', {},
      h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
      h('h2', {}, 'Resize Image'),
      h('button', { class: 'btn ghost', onclick: () => addMore.click(), html: icon('add') + '<span>Add</span>' })),
    h('div', { class: 'pv' }, h('div', { class: 'pv-bar' }, pvLabel, pvPrev, pvCount, pvNext, pvRemove), h('div', { class: 'pv-stage' }, pvImg), info),
    h('div', { class: 'ex-controls' },
      h('div', { class: 'section' }, h('h3', {}, 'Resize By'), modeSeg, h('div', { style: { marginTop: '10px' } }, sizeBox, pctBox)),
      h('div', { class: 'section' }, h('h3', {}, 'Presets'), presetChips),
      dpiBox,
      h('div', { class: 'section' }, h('h3', {}, 'Format'), fmtSeg, qRow, targetRow, fmtNote),
      h('div', { class: 'section' }, h('h3', {}, 'File Name'), nameInput),
      warn),
    footer, addMore);
  document.body.append(root);
  document.body.classList.add('modal-open');

  function applyPreset(p) {
    const f = images[idx];
    o.mode = 'size';
    if (p.long) {
      o.unit = 'px'; o.lock = true;
      if (f.w >= f.h) { o.driver = 'w'; o.wPx = Math.min(p.long, f.w); o.hPx = o.wPx * f.h / f.w; }
      else { o.driver = 'h'; o.hPx = Math.min(p.long, f.h); o.wPx = o.hPx * f.w / f.h; }
    } else {
      if (p.dpi) o.dpi = p.dpi;
      o.unit = p.unit; o.lock = false; o.fit = p.fit;
      let w = p.w, hh = p.h;
      // Paper and print sizes follow the photo's orientation.
      if (p.orient && (f.w > f.h) !== (w > hh)) [w, hh] = [hh, w];
      o.wPx = fromUnit(w); o.hPx = fromUnit(hh);
    }
    changed();
  }

  function changed(typing) {
    try { localStorage.setItem('resizeOpts', JSON.stringify({ unit: o.unit, format: o.format, quality: o.quality })); } catch { /* private mode */ }
    message = '';
    update();
    schedule(typing ? 350 : 120);
  }

  function update() {
    const f = images[idx], p = plan(f, o), fmt = FORMATS.find((x) => x.id === o.format);
    const n = images.length;
    pvLabel.textContent = f.name;
    pvCount.textContent = `${idx + 1}/${n}`;
    [pvPrev, pvNext, pvCount].forEach((e) => { e.hidden = n < 2; });
    pvPrev.disabled = idx === 0; pvNext.disabled = idx === n - 1;
    const physical = (px) => `${fmtNum(px / o.dpi * PER_INCH[o.unit === 'px' ? 'cm' : o.unit], o.unit === 'px' ? 'cm' : o.unit)}`;
    const pu = o.unit === 'px' ? 'cm' : o.unit;
    info.textContent = `Original ${f.w} × ${f.h} px · ${fileSize(f.size)}${f.dpi ? ` · ${f.dpi} DPI` : ''}   →   ${p.W} × ${p.H} px · ${physical(p.W)} × ${physical(p.H)} ${pu}`;
    modeSeg.refresh(); unitSeg.refresh(); fitSeg.refresh(); fmtSeg.refresh();
    sizeBox.hidden = o.mode !== 'size'; pctBox.hidden = o.mode !== 'percent';
    const shownW = o.lock ? p.W : o.wPx, shownH = o.lock ? p.H : o.hPx;
    wField.refresh(fmtNum(toUnit(shownW), o.unit), o.unit);
    hField.refresh(fmtNum(toUnit(shownH), o.unit), o.unit);
    lockBtn.innerHTML = icon(o.lock ? 'lock' : 'unlock');
    lockBtn.setAttribute('aria-label', o.lock ? 'Keep proportions (on)' : 'Keep proportions (off)');
    lockBtn.classList.toggle('on', o.lock);
    sizeBox.querySelector('.fit-wrap').hidden = o.lock;
    fitNote.textContent = { crop: 'Fills the whole size and trims the edges that don’t fit (centered).', pad: 'Shows the whole photo with white margins.', stretch: 'Fills the size exactly, changing the proportions.' }[o.fit];
    dpiField.refresh(String(Math.round(o.dpi)), '');
    dpiChips.querySelectorAll('[data-dpi]').forEach((c) => c.classList.toggle('on', +c.dataset.dpi === Math.round(o.dpi)));
    dpiBox.querySelector('.dpi-note').textContent = o.unit === 'px'
      ? 'Saved in the file so it prints at the size above. Changing it keeps the pixels.'
      : 'Pixels per inch used to turn the print size into pixels. 300 is photo quality.';
    pctRange.value = o.percent; pctVal.textContent = `${o.percent}%`;
    pctChips.querySelectorAll('[data-pct]').forEach((c) => c.classList.toggle('on', +c.dataset.pct === o.percent));
    qRow.hidden = targetRow.hidden = !fmt.lossy;
    qRange.value = o.quality; qVal.textContent = `${Math.round(o.quality * 100)}%`;
    fmtNote.textContent = fmt.id === 'png' ? 'Lossless; keeps transparency. Larger files for photos.'
      : fmt.id === 'webp' ? 'Smaller than JPEG at the same quality; not every app opens it.' : 'Best for photos and smallest files.';
    if (document.activeElement !== nameInput) nameInput.value = names[idx];
    const tooBig = images.some((g) => { const q = plan(g, o); return q.W * q.H > MAX_AREA; });
    warn.textContent = tooBig ? `That’s more than ${Math.round(MAX_AREA / 1e6)} megapixels, which iPhone can’t handle. Use a smaller size or resolution.` : message;
    warn.hidden = !warn.textContent;
    saveBtn.disabled = tooBig || busy || null;
    saveBtn.textContent = busy ? 'Saving…' : n > 1 ? `Save ${n} Images` : 'Save Image';
  }

  function schedule(ms) {
    clearTimeout(timer);
    const my = ++gen;
    footSize.querySelector('small').textContent = 'estimating…';
    timer = setTimeout(async () => {
      try {
        const r = await encode(images[idx], o);
        if (my !== gen) return;
        if (result?.url) URL.revokeObjectURL(result.url);
        result = { ...r, url: URL.createObjectURL(new Blob([r.bytes], { type: r.mime })) };
        pvImg.src = result.url;
        footSize.querySelector('b').textContent = fileSize(r.bytes.length);
        footSize.querySelector('small').textContent = images.length > 1 ? 'this image' : 'file size';
      } catch {
        if (my !== gen) return;
        footSize.querySelector('b').textContent = '—';
        footSize.querySelector('small').textContent = '';
      }
    }, ms);
  }

  async function fitUnder() {
    const kb = parseFloat(targetInput.value.replace(',', '.'));
    if (!(kb > 0)) { toast('Enter a size in KB'); return; }
    localStorage.setItem('resizeTargetKB', String(kb));
    const target = kb * 1024;
    fitBtn.disabled = true; fitBtn.textContent = '…';
    try {
      // Largest quality whose file fits (checks every image in a batch).
      const fits = async (q) => { for (const f of images) if ((await encode(f, o, q)).bytes.length > target) return false; return true; };
      let lo = 0.1, hi = 0.98;
      if (!(await fits(lo))) { message = `Even at the lowest quality it’s over ${kb} KB. Make the image smaller too.`; o.quality = lo; }
      else {
        for (let i = 0; i < 7; i++) { const mid = (lo + hi) / 2; if (await fits(mid)) lo = mid; else hi = mid; }
        o.quality = Math.floor(lo * 100) / 100;
        message = '';
      }
      update(); schedule(0);
    } finally { fitBtn.disabled = false; fitBtn.textContent = 'Fit'; }
  }

  async function save() {
    busy = true; update();
    try {
      const files = [];
      for (let i = 0; i < images.length; i++) {
        const r = await encode(images[i], o);
        const base = (names[i] || images[i].name).replace(/[\\/:*?"<>|]+/g, '-');
        files.push(new File([r.bytes], `${base}-${r.W}x${r.H}.${r.ext}`, { type: r.mime }));
      }
      await shareFiles(files);
    } catch (e) {
      toast(`Couldn’t save: ${e.message || e}`);
    } finally { busy = false; update(); }
  }

  update();
  schedule(0);
}
