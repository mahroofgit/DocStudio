// Document viewer: opening a document shows its pages in one vertical scroll, with a page
// counter. Edit opens the page editor; Add, Mark Up, Share and To Word are one tap away.

import * as M from './model.js';
import { state } from './model.js';
import { icon } from './icons.js';
import { h, sheet, sheetItem, promptDialog, confirmDialog, toast, openPanel } from './ui.js';
import { renderPage } from './render.js';
import { startScan, importToReview } from './scanner.js';
import { showHome } from './home.js';

const $ = (s) => document.querySelector(s);
const cache = new Map();      // page id → { sig, url }
let hooks = { exporter: () => {} };
let observer = null, renderQueue = Promise.resolve(), visibleIndex = 0;

export function setViewerHooks(h2) { Object.assign(hooks, h2); }
export const viewerVisible = () => !$('#viewer').hidden;

export function initViewer() {
  const root = $('#viewer');
  root.innerHTML = `
    <header class="vw-head">
      <button class="icon-btn vw-back" data-a="back" aria-label="Documents">${icon('back')}</button>
      <button class="vw-title" data-a="rename"><span></span></button>
      <button class="icon-btn" data-a="more" aria-label="More">${icon('menuDots')}</button>
    </header>
    <main class="vw-pages"></main>
    <div class="vw-counter"></div>
    <nav class="vw-bar">
      <button data-a="add">${icon('add')}<span>Add</span></button>
      <button data-a="edit">${icon('edit')}<span>Edit</span></button>
      <button data-a="markup">${icon('markup')}<span>Mark Up</span></button>
      <button data-a="share">${icon('share')}<span>Share</span></button>
      <button data-a="word">${icon('word')}<span>To Word</span></button>
    </nav>
    <input type="file" class="vw-pick-photos" accept="image/*" multiple hidden>
    <input type="file" class="vw-pick-files" accept="image/*,application/pdf,.pdf,.heic,.heif,.jpg,.jpeg,.png,.tif,.tiff" multiple hidden>`;
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'back') showHome();
    if (a === 'rename') promptDialog('Document name', state.doc.title, async (v) => { M.rename(v); await M.saveNow(); render(); });
    if (a === 'more') moreMenu();
    if (a === 'add') addMenu();
    if (a === 'edit') openEditor(null);
    if (a === 'markup') openEditor('markup');
    if (a === 'share') hooks.exporter(null);
    if (a === 'word') hooks.exporter('docx');
  });
  root.querySelector('.vw-pick-photos').addEventListener('change', (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length) importToReview(files, { mode: 'append' });
  });
  root.querySelector('.vw-pick-files').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
    const images = files.filter((f) => !pdfs.includes(f));
    if (pdfs.length) { selectLast(); await M.importFiles(pdfs); }
    if (images.length) importToReview(images, { mode: 'append' });
  });
  root.querySelector('.vw-pages').addEventListener('scroll', updateCounter, { passive: true });
  M.subscribe((flags) => { if (viewerVisible() && (flags.has('doc') || flags.has('render'))) scheduleRender(); });
  window.addEventListener('resize', () => { if (viewerVisible()) { cache.clear(); render(); } });
}

/** New pages go after the last one when adding from the viewer. */
function selectLast() {
  const P = state.doc.pages;
  M.selectPage(P[P.length - 1].id);
}

export function showViewer(scrollToPageId = null) {
  const root = $('#viewer');
  root.hidden = false;
  render().then(() => {
    const id = scrollToPageId || state.ui.pageId;
    const el = root.querySelector(`[data-page="${id}"]`);
    if (el && scrollToPageId) el.scrollIntoView({ block: 'start' });
    updateCounter();
  });
}
export function hideViewer() { $('#viewer').hidden = true; }

function openEditor(panel) {
  const P = state.doc.pages;
  const page = P[Math.min(visibleIndex, P.length - 1)];
  if (page) M.selectPage(page.id);
  hideViewer();
  if (panel) openPanel(panel);
}

let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 250); }

async function render() {
  const root = $('#viewer');
  root.querySelector('.vw-title span').textContent = state.doc.title;
  const list = root.querySelector('.vw-pages');
  const W = Math.min(list.clientWidth || window.innerWidth, 900) - 24;
  const pages = state.doc.pages;
  // Reuse existing cards; add / remove / reorder as needed.
  const existing = new Map([...list.children].map((c) => [c.dataset.page, c]));
  const keep = new Set(pages.map((p) => p.id));
  for (const [id, c] of existing) if (!keep.has(id)) c.remove();
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) paint(en.target);
  }, { root: list, rootMargin: '600px 0px' });
  pages.forEach((p, i) => {
    let card = existing.get(p.id);
    if (!card) {
      card = h('button', { class: 'vw-page', 'data-page': p.id, 'aria-label': `Page ${i + 1}` }, h('img', { alt: '' }));
      card.addEventListener('click', () => { M.selectPage(p.id); visibleIndex = state.doc.pages.findIndex((q) => q.id === p.id); hideViewer(); });
    }
    card.style.width = `${W}px`;
    card.style.height = `${(W * p.h) / p.w}px`;
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
    observer.observe(card);
  });
  // Repaint visible cards whose page changed.
  [...list.children].forEach((c) => { const pg = pages.find((p) => p.id === c.dataset.page); if (pg && cache.get(pg.id)?.sig !== sigOf(pg, W)) c.dataset.painted = ''; });
  updateCounter();
}

const sigOf = (page, W) => JSON.stringify(page) + '|' + W;

function paint(card) {
  const page = state.doc.pages.find((p) => p.id === card.dataset.page);
  if (!page) return;
  const W = parseFloat(card.style.width);
  const sig = sigOf(page, W);
  const hit = cache.get(page.id);
  const img = card.querySelector('img');
  if (hit && hit.sig === sig) { if (img.src !== hit.url) img.src = hit.url; return; }
  if (card.dataset.painted === sig) return;
  card.dataset.painted = sig;
  renderQueue = renderQueue.then(async () => {
    if (!card.isConnected) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const c = await renderPage(page, (W * dpr) / page.w);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
    c.width = c.height = 0;
    const old = cache.get(page.id);
    const url = URL.createObjectURL(blob);
    cache.set(page.id, { sig, url });
    img.src = url;
    if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
  }).catch((e) => console.warn('page render failed', e));
}

function updateCounter() {
  const root = $('#viewer');
  const list = root.querySelector('.vw-pages');
  const cards = [...list.children];
  const top = list.getBoundingClientRect().top + list.clientHeight * 0.35;
  let idx = 0;
  cards.forEach((c, i) => { if (c.getBoundingClientRect().top <= top) idx = i; });
  visibleIndex = idx;
  const n = cards.length;
  const counter = root.querySelector('.vw-counter');
  counter.textContent = `${Math.min(idx + 1, n)}/${n}`;
  counter.hidden = n < 2;
}

function addMenu() {
  const root = $('#viewer');
  const s = sheet('Add Pages', h('div', { class: 'sheet-list' },
    sheetItem('scan', 'Scan Pages', 'Camera with Single or Batch capture', () => { s.close(); selectLast(); startScan({ mode: 'append' }); }),
    sheetItem('photo', 'Import Photos', 'Then review and crop each page', () => { s.close(); selectLast(); root.querySelector('.vw-pick-photos').click(); }),
    sheetItem('file', 'Import Files', 'Images or PDFs', () => { s.close(); selectLast(); root.querySelector('.vw-pick-files').click(); }),
    sheetItem('pageAdd', 'Blank Page', 'At the end of the document', () => { s.close(); selectLast(); M.addPage(); toast('Blank page added'); })));
}

function moreMenu() {
  const id = state.docId;
  const s = sheet(state.doc.title, h('div', { class: 'sheet-list' },
    sheetItem('text', 'Rename', null, () => { s.close(); promptDialog('Document name', state.doc.title, async (v) => { M.rename(v); await M.saveNow(); render(); }); }),
    sheetItem('share', 'Share / Export…', 'PDF, Word, JPEG or PNG', () => { s.close(); hooks.exporter(null); }),
    sheetItem('duplicate', 'Duplicate Document', null, async () => { s.close(); await M.duplicateDocument(id); toast('Duplicated — it’s in your documents'); }),
    sheetItem('trash', 'Delete Document', null, () => {
      s.close();
      confirmDialog(`Delete “${state.doc.title}”? This can't be undone.`, 'Delete', async () => { await M.deleteDocument(id); showHome(); }, true);
    }, true)));
}
