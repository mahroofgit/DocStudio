// Export screen (port of ExportSheet.swift): format, pages, quality, resolution, colour mode,
// live size estimate with upload-limit badges, Fit under N MB, a preview of the compressed
// result, searchable text and password protection — then the iOS share sheet.

import * as E from './export.js';
import { state, currentPageIndex, saveNow } from './model.js';
import { icon } from './icons.js';

const FORMAT_KEY = 'export.lastFormat', PRESET_KEY = 'export.lastPreset', TARGET_KEY = 'export.targetMB';
const LIMITS = [1, 2, 5, 10, 25];

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function openExporter(format) {
  const pages = state.doc.pages;
  const current = currentPageIndex();
  const title = state.doc.title;
  saveNow();

  // ---- initial options (last format and preset are remembered)
  const fmt = format || store.get(FORMAT_KEY) || 'pdf';
  let o = E.defaultOptions(E.FORMATS[fmt] ? fmt : 'pdf');
  E.applyPreset(o, store.get(PRESET_KEY) || 'balanced');
  // Default to the scan look if every image is a B&W / grayscale scan.
  const modes = pages.flatMap((p) => p.elements).filter((e) => e.kind === 'image').map((e) => e.scan?.mode);
  if (modes.length && modes.every((m) => m === 'blackWhite')) o.colorMode = 'blackWhite';
  else if (modes.length && modes.every((m) => m === 'grayscale' || m === 'blackWhite')) o.colorMode = 'grayscale';

  let estimate = null, estimating = false, previewPos = 0, actualPixels = false;
  let fitting = false, fitMessage = '', exporting = false, progress = 0, result = null, errorText = '';
  let targetMB = parseFloat(store.get(TARGET_KEY) || '2') || 2;
  let estGen = 0, prevGen = 0, fitGen = 0, exportGen = 0, estTimer = null, prevTimer = null;

  const selected = () => E.pageIndices(o, pages.length, current);
  const selectedPages = () => selected().map((i) => pages[i]);

  // ---------------------------------------------------------------- DOM
  const root = h('div', { id: 'exporter', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export' });
  const pvCanvasWrap = h('div', { class: 'pv-stage' });
  const pvLabel = h('span', { class: 'pv-label' });
  const pvCount = h('span', { class: 'pv-count' });
  const pvPrev = h('button', { class: 'btn icon small', 'aria-label': 'Previous page', html: icon('left'), onclick: () => { previewPos--; schedulePreview(0); update(); } });
  const pvNext = h('button', { class: 'btn icon small', 'aria-label': 'Next page', html: icon('right'), onclick: () => { previewPos++; schedulePreview(0); update(); } });
  const pvMode = seg([['fit', 'Fit'], ['px', '1:1 Pixels']], () => (actualPixels ? 'px' : 'fit'), (v) => { actualPixels = v === 'px'; showPreview(); update(); });
  const pvNote = h('div', { class: 'pv-note' });
  const pvSpinner = h('span', { class: 'spinner', hidden: true });

  const header = h('header', {},
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('h2', {}, 'Export'),
    h('span', { style: { width: '72px' } }));

  const previewBox = h('div', { class: 'pv' },
    h('div', { class: 'pv-bar' }, pvLabel, pvSpinner, h('span', { class: 'grow' }), pvPrev, pvCount, pvNext, pvMode),
    pvCanvasWrap, pvNote);

  // Format
  const formatSeg = seg(Object.entries(E.FORMATS).map(([k, f]) => [k, f.label]), () => o.format, (v) => set({ format: v }));
  const formatDesc = h('p', { class: 'muted' });
  // Pages
  const scopeSeg = seg([['all', `All (${pages.length})`], ['current', 'Current'], ['range', 'Range']], () => o.scope, (v) => set({ scope: v }));
  const rangeInput = h('input', { class: 'text-input', placeholder: 'e.g. 1-3, 5', inputmode: 'text', autocomplete: 'off', enterkeyhint: 'done' });
  rangeInput.addEventListener('input', () => set({ rangeText: rangeInput.value }));
  const rangeWarn = h('p', { class: 'warn' });
  // Quality
  const presetSeg = seg(E.PRESETS.map((p) => [p.id, p.label]), () => E.matchingPreset(o), (v) => set(E.applyPreset({ ...o }, v)));
  const qualityVal = h('span', { class: 'val' });
  const qualitySlider = h('input', { type: 'range', min: 0.1, max: 1, step: 0.01, 'aria-label': 'Image compression' });
  qualitySlider.addEventListener('input', () => set({ quality: Math.round(parseFloat(qualitySlider.value) * 100) / 100 }));
  const losslessNote = h('p', { class: 'muted' });
  const dpiSelect = h('select', { class: 'select', 'aria-label': 'Resolution' }, ...E.DPI_CHOICES.map((d) => h('option', { value: d }, E.dpiLabel(d))));
  dpiSelect.addEventListener('change', () => set({ dpi: +dpiSelect.value }));
  const colorSeg = seg(E.COLOR_MODES, () => o.colorMode, (v) => set({ colorMode: v }));
  // Size box
  const sizeBig = h('span', { class: 'size-big' });
  const sizeSpin = h('span', { class: 'spinner', hidden: true });
  const perPage = h('span', { class: 'muted' });
  const badges = h('div', { class: 'badges' });
  const targetInput = h('input', { class: 'text-input narrow', inputmode: 'decimal', value: String(targetMB), 'aria-label': 'Target size in MB', enterkeyhint: 'done' });
  targetInput.addEventListener('change', () => { const v = parseFloat(targetInput.value.replace(',', '.')); if (v > 0) { targetMB = v; store.set(TARGET_KEY, String(v)); } update(); });
  const fitBtn = h('button', { class: 'btn', onclick: fitToTarget }, 'Auto-Adjust');
  const fitMsg = h('p', { class: 'muted' });
  const ocrNote = h('p', { class: 'muted small' }, 'Searchable text adds a little per page (not included above).');
  // PDF options
  const ocrToggle = toggle('Searchable text (OCR)', () => o.searchableText, (v) => set({ searchableText: v }));
  const vectorToggle = toggle('Keep imported PDF pages as vectors', () => o.keepVectorPages, (v) => set({ keepVectorPages: v }));
  const pwToggle = toggle('Password protect', () => o.usePassword, (v) => set({ usePassword: v }));
  const pwInput = h('input', { class: 'text-input', type: 'password', placeholder: 'Password', autocomplete: 'new-password', enterkeyhint: 'done' });
  pwInput.addEventListener('input', () => { o.password = pwInput.value; update(); });
  const pdfSection = section('PDF Options', ocrToggle,
    h('p', { class: 'muted' }, 'Adds an invisible text layer to scanned pages so you can search, select and copy text. English, recognized on this device (the first use downloads about 7 MB).'),
    vectorToggle, pwToggle, pwInput);

  const controls = h('div', { class: 'ex-controls' },
    section('Format', formatSeg, formatDesc),
    section('Pages', scopeSeg, rangeInput, rangeWarn),
    section('Quality', presetSeg,
      h('div', { class: 'q-row' }, h('span', {}, 'Image compression'), qualityVal),
      h('div', { class: 'q-row' }, h('small', {}, 'Smaller'), qualitySlider, h('small', {}, 'Sharper')),
      losslessNote,
      h('div', { class: 'row nowrap' }, h('span', { class: 'lbl' }, 'Resolution'), dpiSelect),
      h('div', { class: 'row nowrap' }, h('span', { class: 'lbl' }, 'Color'), h('div', { class: 'grow' }, colorSeg))),
    h('div', { class: 'size-box' },
      h('div', { class: 'size-head' }, h('div', {}, h('div', { class: 'cap' }, 'ESTIMATED SIZE'), h('div', { class: 'row nowrap', style: { margin: 0 } }, sizeBig, sizeSpin)), perPage),
      badges,
      h('div', { class: 'row nowrap', style: { marginTop: '10px', marginBottom: 0 } }, h('span', {}, 'Fit under'), targetInput, h('span', {}, 'MB'), h('span', { class: 'grow' }), fitBtn),
      fitMsg, ocrNote),
    pdfSection);

  const footer = h('footer', {});
  root.append(header, previewBox, controls, footer);
  document.body.append(root);

  // ---------------------------------------------------------------- helpers

  function section(title, ...kids) { return h('div', { class: 'section' }, h('h3', {}, title), ...kids); }
  function seg(options, get, setv) {
    const wrap = h('div', { class: 'seg' });
    const btns = options.map(([v, label]) => { const b = h('button', { onclick: () => setv(v) }, label); wrap.append(b); return [v, b]; });
    wrap.sync = () => { const cur = get(); btns.forEach(([v, b]) => b.classList.toggle('on', v === cur)); };
    return wrap;
  }
  function toggle(label, get, setv) {
    const input = h('input', { type: 'checkbox', role: 'switch' });
    input.addEventListener('change', () => setv(input.checked));
    const el = h('label', { class: 'switch' }, h('span', {}, label), input);
    el.sync = () => { input.checked = !!get(); };
    el.input = input;
    return el;
  }

  function set(patch) {
    const old = o;
    o = { ...o, ...patch };
    if (!E.FORMATS[o.format]) o.format = 'pdf';
    if (patch.format) store.set(FORMAT_KEY, o.format);
    const preset = E.matchingPreset(o);
    if (preset) store.set(PRESET_KEY, preset);
    if (E.renderSignature(old) !== E.renderSignature(o) || old.scope !== o.scope || old.rangeText !== o.rangeText) {
      if (previewPos >= Math.max(1, selected().length)) previewPos = 0;
      fitMessage = '';
      result = null; errorText = '';
      fitGen++; fitting = false;
      refresh();
    }
    update();
  }

  function refresh() { scheduleEstimate(); schedulePreview(); }

  function scheduleEstimate() {
    const gen = ++estGen;
    clearTimeout(estTimer);
    const sel = selectedPages();
    if (!sel.length) { estimate = null; estimating = false; update(); return; }
    estimating = true;
    estTimer = setTimeout(async () => {
      const opts = { ...o };
      try {
        const bytes = await E.estimateSize(sel, opts, title, () => gen !== estGen || !root.isConnected);
        if (gen !== estGen) return;
        estimate = bytes;
      } catch (e) {
        if (e.name === 'Cancelled' || gen !== estGen) return;
        console.warn(e); estimate = null;
      }
      estimating = false;
      update();
    }, 450);
  }

  let pvCanvas = null;
  function schedulePreview(delay = 200) {
    const gen = ++prevGen;
    clearTimeout(prevTimer);
    const idx = selected();
    if (!idx.length) { setPreview(null); update(); return; }
    pvSpinner.hidden = false;
    prevTimer = setTimeout(async () => {
      const page = pages[idx[Math.min(previewPos, idx.length - 1)]];
      try {
        const c = await E.preview(page, { ...o }, () => gen !== prevGen || !root.isConnected);
        if (gen !== prevGen) { c.width = c.height = 0; return; }
        setPreview(c);
      } catch (e) {
        if (e.name !== 'Cancelled') console.warn(e);
      }
      if (gen === prevGen) pvSpinner.hidden = true;
    }, delay);
  }
  function setPreview(c) {
    if (pvCanvas && pvCanvas !== c) pvCanvas.width = pvCanvas.height = 0;
    pvCanvas = c;
    showPreview();
  }
  function showPreview() {
    pvCanvasWrap.replaceChildren();
    pvCanvasWrap.classList.toggle('px', actualPixels);
    if (!pvCanvas) {
      pvCanvasWrap.append(h('div', { class: 'muted' }, selected().length ? '' : 'No pages selected'));
      pvNote.textContent = ' ';
      return;
    }
    pvCanvas.className = 'pv-img';
    pvCanvas.style.width = actualPixels ? `${pvCanvas.width}px` : '';
    pvCanvas.style.height = actualPixels ? `${pvCanvas.height}px` : '';
    pvCanvasWrap.append(pvCanvas);
    pvNote.textContent = `Rendered with your settings, ${pvCanvas.width} × ${pvCanvas.height} px.` +
      (actualPixels ? '' : ' Switch to 1:1 Pixels to inspect text sharpness and compression.');
  }

  async function fitToTarget() {
    const sel = selectedPages();
    const target = Math.round(targetMB * 1e6);
    if (!sel.length || !(target > 0)) return;
    const gen = ++fitGen;
    fitting = true; fitMessage = ''; update();
    try {
      const found = await E.optionsFitting(target, sel, { ...o }, title, () => gen !== fitGen || !root.isConnected);
      if (gen !== fitGen) return;
      fitting = false;
      if (found) {
        const msg = `Set to ${Math.round(found.quality * 100)}% quality at ${E.dpiLabel(found.dpi)}.`;
        set({ quality: found.quality, dpi: found.dpi });
        fitMessage = E.usesJPEG(found) ? msg : `Set to ${E.dpiLabel(found.dpi)}.`;
      } else {
        fitMessage = `Can't get under ${targetMB} MB even at 72 dpi. Try Grayscale or B&W, or fewer pages.`;
      }
    } catch (e) {
      if (gen !== fitGen) return;
      fitting = false;
      if (e.name !== 'Cancelled') fitMessage = `Couldn't adjust: ${e.message}`;
    }
    update();
  }

  async function doExport() {
    const sel = selectedPages();
    if (!sel.length) return;
    store.set(FORMAT_KEY, o.format);
    const gen = ++exportGen;
    exporting = true; progress = 0; result = null; errorText = ''; update();
    try {
      const files = await E.runExport(sel, { ...o }, title, (f) => { progress = f; updateFooter(); }, () => gen !== exportGen || !root.isConnected);
      if (gen !== exportGen) return;
      result = files;
    } catch (e) {
      if (gen !== exportGen) return;
      if (e.name !== 'Cancelled') { console.error(e); errorText = `Export failed: ${e.message || e}`; }
    }
    exporting = false;
    update();
  }

  function close() {
    estGen++; prevGen++; fitGen++; exportGen++;
    clearTimeout(estTimer); clearTimeout(prevTimer);
    setPreview(null);
    root.remove();
    E.serial(() => E.clearExportCache());
  }

  // ---------------------------------------------------------------- render state

  function update() {
    const sel = selected();
    const count = sel.length;
    [formatSeg, scopeSeg, presetSeg, colorSeg, pvMode].forEach((s) => s.sync());
    [ocrToggle, vectorToggle, pwToggle].forEach((t) => t.sync());

    formatDesc.textContent = {
      pdf: `Exact page sizes. Text stays vector; images use ${o.colorMode === 'blackWhite' ? 'lossless 1-bit compression.' : 'JPEG compression.'}`,
      docx: 'Opens in Word and Pages. Each page becomes a section with images placed at their exact positions.',
      jpeg: 'One JPEG image per page: good for photos and for sites that only accept images.',
      png: 'One lossless PNG image per page: sharpest text, larger files.',
    }[o.format];

    rangeInput.hidden = o.scope !== 'range';
    if (document.activeElement !== rangeInput) rangeInput.value = o.rangeText;
    rangeWarn.hidden = !(o.scope === 'range' && !count);
    rangeWarn.textContent = `Enter page numbers between 1 and ${pages.length}.`;

    const jpeg = E.usesJPEG(o);
    qualityVal.textContent = jpeg ? `${Math.round(o.quality * 100)}% quality` : 'Lossless';
    if (document.activeElement !== qualitySlider) qualitySlider.value = o.quality;
    qualitySlider.disabled = !jpeg;
    losslessNote.hidden = jpeg;
    losslessNote.textContent = o.colorMode === 'blackWhite'
      ? 'Black & white is stored losslessly at 1 bit per pixel: crisp and very small.'
      : 'PNG is lossless; use resolution to change the size.';
    dpiSelect.value = String(o.dpi);

    sizeBig.textContent = E.fileSize(estimate);
    sizeSpin.hidden = !estimating;
    perPage.textContent = estimate != null && count > 1 ? `≈ ${E.fileSize(Math.round(estimate / count))} / page` : '';
    badges.replaceChildren(...(estimate == null ? [] : LIMITS.map((mb) => {
      const fits = estimate <= mb * 1e6;
      return h('span', { class: 'badge' + (fits ? ' ok' : ''), title: fits ? `Fits common ${mb} MB upload limits` : `Larger than ${mb} MB` }, `${fits ? '✓' : '✕'} ${mb} MB`);
    })));
    if (document.activeElement !== targetInput) targetInput.value = String(targetMB);
    fitBtn.disabled = fitting || !count;
    fitBtn.innerHTML = fitting ? '<span class="spinner"></span>' : 'Auto-Adjust';
    fitMsg.hidden = !fitMessage;
    fitMsg.textContent = fitMessage;
    ocrNote.hidden = !(o.searchableText && o.format === 'pdf');

    pdfSection.hidden = o.format !== 'pdf';
    vectorToggle.input.disabled = o.colorMode !== 'color';
    vectorToggle.classList.toggle('disabled', o.colorMode !== 'color');
    pwInput.hidden = !o.usePassword;
    if (document.activeElement !== pwInput) pwInput.value = o.password;

    const pos = Math.min(previewPos, Math.max(0, count - 1));
    previewPos = pos;
    pvLabel.textContent = count ? `Preview · page ${sel[pos] + 1}` : 'Preview';
    pvCount.textContent = count > 1 ? `${pos + 1} / ${count}` : '';
    pvPrev.hidden = pvNext.hidden = count <= 1;
    pvPrev.disabled = pos === 0;
    pvNext.disabled = pos >= count - 1;
    updateFooter();
  }

  function updateFooter() {
    const count = selected().length;
    footer.replaceChildren();
    if (exporting) {
      const bar = h('div', {}); bar.style.width = `${Math.round(progress * 100)}%`;
      footer.append(h('div', { class: 'grow' },
        h('div', { class: 'muted' }, o.searchableText && o.format === 'pdf' ? 'Recognizing text and building…' : 'Building…'),
        h('div', { class: 'progress' }, bar)),
      h('button', { class: 'btn', onclick: () => { exportGen++; exporting = false; update(); } }, 'Stop'));
      return;
    }
    if (result) {
      const total = result.reduce((n, f) => n + f.size, 0);
      const name = result.length === 1 ? result[0].name : `${result.length} images`;
      footer.append(
        h('div', { class: 'result' }, h('span', { class: 'ic', html: icon(o.format === 'pdf' ? 'pdf' : o.format === 'docx' ? 'word' : 'photo') }),
          h('span', { class: 'tx' }, h('b', {}, name), h('small', {}, E.fileSize(total)))),
        h('div', { class: 'row nowrap', style: { margin: 0 } },
          h('button', { class: 'btn primary grow', html: icon('share') + 'Share / Save', onclick: () => shareFiles(result) }),
          h('button', { class: 'btn', onclick: () => result.forEach(downloadFile) }, 'Download'),
          h('button', { class: 'btn', onclick: close }, 'Done')),
        h('p', { class: 'muted small center' }, result.length > 1
          ? 'Share opens the iOS sheet: Save Images to Photos, Save to Files, Print, AirDrop…'
          : 'Share opens the iOS sheet: Save to Files, Print, AirDrop, Mail…'));
      return;
    }
    if (errorText) footer.append(h('p', { class: 'warn', style: { width: '100%' } }, errorText));
    const needsPw = o.format === 'pdf' && o.usePassword && !o.password;
    const label = E.FORMATS[o.format].perPage && count > 1 ? `Export ${count} Images` : `Export ${E.FORMATS[o.format].label}`;
    footer.append(h('div', { class: 'foot-size' }, h('b', {}, E.fileSize(estimate)), h('small', {}, estimating ? 'estimating…' : 'estimated')),
      h('button', { class: 'btn primary grow', disabled: !count || needsPw || null, onclick: doExport }, label));
  }

  update();
  refresh();
}

// ------------------------------------------------------------------ sharing

export async function shareFiles(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: files.length === 1 ? files[0].name : undefined }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  files.forEach(downloadFile);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
