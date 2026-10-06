// Scan review: go through the scanned pages one by one — crop
// corners, filter, rotate, retake, delete, reorder, add more — then place them in a document.

import * as M from './model.js';
import { SCAN_PRESETS, DEFAULT_SCAN } from './model.js';
import { whenDisplay, ensureImageReady, assets } from './imaging.js';
import { isFullQuad, normalizedAngle } from './geometry.js';
import { icon } from './icons.js';
import { confirmDialog, toast } from './ui.js';
import { editQuad } from './perspective.js';
import { openCamera, discardSession } from './scanner.js';
import { hideHome } from './home.js';

const $ = (s) => document.querySelector(s);
const FILTERS = [
  ['original', 'Original'], ['colorScan', 'Enhance'], ['grayscale', 'Gray'], ['blackWhite', 'B&W'],
];

export function openReview(session) {
  let index = 0, panel = null, gen = 0;
  // A fresh element each time, so listeners from an earlier session can't fire again.
  const prev = $('#review');
  const root = prev.cloneNode(false);
  prev.replaceWith(root);
  root.innerHTML = `
    <header>
      <button class="btn ghost" data-a="discard">Discard</button>
      <h2 class="rv-title"></h2>
      <button class="btn primary" data-a="done">Done</button>
    </header>
    <div class="rv-stage">
      <button class="rv-nav prev" data-a="prev" aria-label="Previous page">${icon('left')}</button>
      <div class="rv-page"><img alt=""><span class="spinner"></span></div>
      <button class="rv-nav next" data-a="next" aria-label="Next page">${icon('right')}</button>
    </div>
    <div class="rv-panel" hidden></div>
    <div class="rv-strip"></div>
    <nav class="rv-tools">
      <button data-a="crop">${icon('corners')}<span>Crop</span></button>
      <button data-a="rotate">${icon('rotR')}<span>Rotate</span></button>
      <button data-a="filter">${icon('wand')}<span>Filter</span></button>
      <button data-a="retake">${icon('camera')}<span>Retake</span></button>
      <button data-a="delete">${icon('trash')}<span>Delete</span></button>
    </nav>`;
  root.hidden = false;
  document.body.classList.add('modal-open');

  const img = root.querySelector('.rv-page img');
  const pageBox = root.querySelector('.rv-page');
  const strip = root.querySelector('.rv-strip');
  const panelEl = root.querySelector('.rv-panel');
  const cur = () => session.pages[index];

  // ---- rendering
  async function showPage() {
    const p = cur();
    if (!p) return;
    root.querySelector('.rv-title').textContent = `Page ${index + 1} of ${session.pages.length}`;
    root.querySelector('.prev').hidden = index === 0;
    root.querySelector('.next').hidden = index >= session.pages.length - 1;
    const g = ++gen;
    pageBox.classList.add('loading');
    await p.ready;
    const d = await whenDisplay({ asset: p.asset, quad: p.quad, scan: p.scan }).catch(() => null);
    if (g !== gen || !d) return;
    p.preview = d;
    img.src = d.url;
    layoutPage();
    pageBox.classList.remove('loading');
    updateThumb(index);
    renderPanel();
  }

  /** Fits the (possibly rotated) page image inside the stage. */
  function layoutPage() {
    const p = cur(), d = p && p.preview;
    if (!d) return;
    const stage = root.querySelector('.rv-stage');
    const W = stage.clientWidth - 24, H = stage.clientHeight - 24;
    const quarter = Math.abs(normalizedAngle(p.rotation)) % 180 === 90;
    const bw = quarter ? d.h : d.w, bh = quarter ? d.w : d.h;
    const k = Math.min(W / bw, H / bh);
    img.style.width = `${d.w * k}px`; img.style.height = `${d.h * k}px`;
    img.style.transform = `rotate(${p.rotation}deg)`;
  }

  function renderStrip() {
    strip.replaceChildren();
    session.pages.forEach((p, i) => {
      const t = document.createElement('button');
      t.className = 'rv-thumb' + (i === index ? ' on' : '');
      t.innerHTML = `<img alt=""><b>${i + 1}</b>`;
      t.addEventListener('click', () => { if (!t.dataset.dragged) { index = i; renderStrip(); showPage(); } });
      dragToReorder(t, i);
      strip.append(t);
      updateThumb(i, t);
    });
    const add = document.createElement('button');
    add.className = 'rv-thumb add';
    add.innerHTML = `${icon('plus')}<span>Add</span>`;
    add.addEventListener('click', addMore);
    strip.append(add);
    strip.children[index]?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  async function updateThumb(i, el = strip.children[i]) {
    const p = session.pages[i];
    if (!p || !el) return;
    const imgEl = el.querySelector('img');
    if (p.preview) imgEl.src = p.preview.url;
    else {
      await p.ready;
      const d = await whenDisplay({ asset: p.asset, quad: p.quad, scan: p.scan }).catch(() => null);
      if (d) { p.preview = d; imgEl.src = d.url; }
    }
    imgEl.style.transform = `rotate(${p.rotation}deg)`;
  }

  function renderPanel() {
    panelEl.hidden = panel !== 'filter';
    root.querySelectorAll('.rv-tools button').forEach((b) => b.classList.toggle('on', b.dataset.a === panel));
    if (panel !== 'filter') return;
    const p = cur();
    const mode = p.scan.mode;
    panelEl.innerHTML = `
      <div class="rv-filters">${FILTERS.map(([m, l]) => `<button data-filter="${m}" class="${m === mode ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${mode === 'blackWhite' ? `<label class="rv-slider"><span>Ink</span><input type="range" min="0" max="1" step="0.01" value="${p.scan.inkSensitivity ?? 0.5}"></label>` : ''}
      <button class="btn ghost small" data-a="apply-all">Apply to all pages</button>`;
    const slider = panelEl.querySelector('input[type=range]');
    if (slider) {
      let t = null;
      slider.addEventListener('input', () => {
        p.scan = { ...p.scan, inkSensitivity: parseFloat(slider.value) };
        p.preview = null;
        clearTimeout(t); t = setTimeout(showPage, 120);
      });
    }
  }

  // ---- actions
  async function crop() {
    const p = cur();
    await p.ready;
    const r = await editQuad(p.asset, p.quad);
    if (!r) return;
    p.quad = r.quad; p.userQuad = true; p.preview = null;
    showPage();
  }

  function rotate() {
    const p = cur();
    p.rotation = normalizedAngle((p.rotation || 0) + 90);
    layoutPage();
    updateThumb(index);
  }

  function setFilter(mode) {
    const p = cur();
    p.scan = { ...SCAN_PRESETS[mode] };
    p.preview = null;
    showPage();
  }

  function applyAll() {
    const s = cur().scan;
    session.pages.forEach((p) => { if (p !== cur()) { p.scan = { ...s }; p.preview = null; } });
    renderStrip();
    toast(`Applied to all ${session.pages.length} pages`);
  }

  function retake() {
    const at = index;
    root.hidden = true;
    openCamera(session, {
      single: true, replaceAt: at,
      onDone: () => {
        // The new photo went in at `at`; the old one moved to at + 1.
        const old = session.pages.splice(at + 1, 1)[0];
        if (old) discardSession({ pages: [old] });
        root.hidden = false; index = at; renderStrip(); showPage();
      },
      onCancel: () => { root.hidden = false; },
    });
  }

  function remove() {
    confirmDialog('Delete this page?', 'Delete', () => {
      const [p] = session.pages.splice(index, 1);
      discardSession({ pages: [p] });
      if (!session.pages.length) { close(); return; }
      index = Math.min(index, session.pages.length - 1);
      renderStrip(); showPage();
    }, true);
  }

  function addMore() {
    root.hidden = true;
    const before = session.pages.length;
    openCamera(session, {
      onDone: () => { root.hidden = false; if (session.pages.length > before) index = before; renderStrip(); showPage(); },
      onCancel: () => { root.hidden = false; renderStrip(); },
    });
  }

  async function done() {
    const btn = root.querySelector('[data-a=done]');
    btn.disabled = true;
    M.busy(true);
    try {
      await Promise.all(session.pages.map((p) => p.ready));
      const scans = session.pages.map((p) => ({ asset: p.asset, quad: isFullQuad(p.quad) ? null : p.quad, scan: { ...DEFAULT_SCAN, ...p.scan }, rotation: p.rotation }));
      if (session.mode === 'new') {
        await M.createDocument(null, new Set(scans.map((s) => s.asset)));
        hideHome();
      }
      M.addScannedPages(scans);
      await M.saveNow();
      close();
      toast(`${scans.length} page${scans.length === 1 ? '' : 's'} added — fine-tune in Edit and Scan`);
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      toast(`Couldn't add the pages: ${e.message || e}`);
    } finally { M.busy(false); }
  }

  function close() {
    gen++;
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('modal-open');
    window.removeEventListener('resize', layoutPage);
  }

  // ---- gestures: swipe between pages; drag thumbnails to reorder
  let sx = null;
  const stage = root.querySelector('.rv-stage');
  stage.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) sx = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx; sx = null;
    if (dx < -60 && index < session.pages.length - 1) { index++; renderStrip(); showPage(); }
    if (dx > 60 && index > 0) { index--; renderStrip(); showPage(); }
  });

  function dragToReorder(t, i) {
    let timer = null, start = null, held = false, dx = 0;
    t.addEventListener('pointerdown', (e) => {
      start = e.clientX; held = false; dx = 0; delete t.dataset.dragged;
      timer = setTimeout(() => { held = true; t.classList.add('lifted'); try { t.setPointerCapture(e.pointerId); } catch { /* ignore */ } }, 350);
    });
    t.addEventListener('pointermove', (e) => {
      if (start == null) return;
      if (!held) { if (Math.abs(e.clientX - start) > 8) { clearTimeout(timer); start = null; } return; }
      dx = e.clientX - start;
      t.style.transform = `translateX(${dx}px) scale(1.08)`;
    });
    const end = () => {
      clearTimeout(timer);
      if (held && Math.abs(dx) > 10) {
        t.dataset.dragged = '1';
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const others = [...strip.querySelectorAll('.rv-thumb:not(.add)')].filter((x) => x !== t);
        const to = others.filter((x) => { const b = x.getBoundingClientRect(); return b.left + b.width / 2 < cx; }).length;
        const [p] = session.pages.splice(i, 1);
        session.pages.splice(to, 0, p);
        index = to;
        setTimeout(() => { renderStrip(); showPage(); }, 0);
      }
      t.classList.remove('lifted'); t.style.transform = '';
      start = null; held = false;
    };
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
  }

  root.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { setFilter(f.dataset.filter); return; }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'prev' && index > 0) { index--; renderStrip(); showPage(); }
    if (a === 'next' && index < session.pages.length - 1) { index++; renderStrip(); showPage(); }
    if (a === 'crop') crop();
    if (a === 'rotate') rotate();
    if (a === 'filter') { panel = panel === 'filter' ? null : 'filter'; renderPanel(); }
    if (a === 'apply-all') applyAll();
    if (a === 'retake') retake();
    if (a === 'delete') remove();
    if (a === 'done') done();
    if (a === 'discard') {
      confirmDialog(`Discard ${session.pages.length === 1 ? 'this scan' : `these ${session.pages.length} pages`}?`, 'Discard', () => { discardSession(session); close(); }, true);
    }
  });
  window.addEventListener('resize', layoutPage);

  // Make sure every proxy is ready before the first page shows.
  session.pages.forEach((p) => ensureImageReady(assets.get(p.asset)).catch(() => {}));
  renderStrip();
  showPage();
}
