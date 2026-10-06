// Home screen and document library: quick tools, Recents, All Documents,
// Settings, and the big camera button that starts a scan.

import * as M from './model.js';
import { state } from './model.js';
import { icon } from './icons.js';
import { h, btn, sheet, sheetItem, toast, alertDialog, confirmDialog, promptDialog, openCalibration, openInstallHelp, APP_VERSION } from './ui.js';
import { UNIT_ORDER } from './geometry.js';
import { startScan, importToReview } from './scanner.js';

const $ = (s) => document.querySelector(s);
let tab = 'home', query = '', sortBy = localStorage.getItem('docSort') || 'modified';
let thumbUrls = [];
let openHooks = { exporter: () => {} };
export function setHomeHooks(h) { Object.assign(openHooks, h); }

export function initHome() {
  const root = $('#home');
  root.innerHTML = `
    <header class="home-head">
      <div class="home-title"><img src="icons/favicon-32.png" alt=""><b>DocPrint Studio</b></div>
      <label class="search">${icon('view')}<input type="search" placeholder="Search documents" autocomplete="off" enterkeyhint="search"></label>
    </header>
    <main class="home-body"></main>
    <nav class="home-tabs">
      <button data-tab="home">${icon('home')}<span>Home</span></button>
      <button data-tab="docs">${icon('doc')}<span>Documents</span></button>
      <button class="fab" aria-label="Scan with camera">${icon('camera')}</button>
      <button data-tab="tools">${icon('scan')}<span>Tools</span></button>
      <button data-tab="settings">${icon('menuDots')}<span>Settings</span></button>
    </nav>
    <input type="file" id="home-pick-images" accept="image/*" multiple hidden>
    <input type="file" id="home-pick-files" accept="image/*,application/pdf,.pdf,.heic,.heif,.jpg,.jpeg,.png,.tif,.tiff" multiple hidden>`;
  root.querySelector('input[type=search]').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
  root.querySelectorAll('.home-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
  root.querySelector('.fab').addEventListener('click', () => startScan({ mode: 'new' }));
  root.querySelector('#home-pick-images').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length) importToReview(files, { mode: 'new' });
  });
  root.querySelector('#home-pick-files').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length) importFilesAsDocument(files);
  });
  M.onLibraryChange(() => { if (!root.hidden) render(); });
}

export async function showHome() {
  await M.closeDocument();
  $('#home').hidden = false;
  render();
}
export function hideHome() { $('#home').hidden = true; }
export const homeVisible = () => !$('#home').hidden;

/** Opens a library document in the editor. */
export async function openDoc(id) {
  const ok = await M.openDocument(id);
  if (!ok) { alertDialog('That document could not be opened.'); return false; }
  hideHome();
  return true;
}

/** PDFs become a document straight away; photos go through the scan review first. */
async function importFilesAsDocument(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  const images = files.filter((f) => !pdfs.includes(f));
  if (pdfs.length) {
    await M.createDocument(pdfs[0].name.replace(/\.pdf$/i, ''));
    hideHome();
    await M.importFiles(pdfs);
    if (images.length) importToReview(images, { mode: 'append' });
    return;
  }
  if (images.length) importToReview(images, { mode: 'new' });
}

const fmtDate = (t) => {
  const d = new Date(t), pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function render() {
  const root = $('#home');
  root.querySelectorAll('.home-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  root.querySelector('.search').hidden = tab === 'settings' || tab === 'tools';
  const body = root.querySelector('.home-body');
  thumbUrls.forEach((u) => URL.revokeObjectURL(u)); thumbUrls = [];
  const docs = await M.listDocuments();
  const shown = docs.filter((d) => !query || d.title.toLowerCase().includes(query));
  body.replaceChildren();

  if (tab === 'home') {
    body.append(toolsGrid(true));
    const head = h('div', { class: 'list-head' }, h('h2', {}, 'Recents'),
      docs.length > 5 ? h('button', { class: 'link', onclick: () => { tab = 'docs'; render(); } }, `View All ›`) : null);
    body.append(head);
    if (!docs.length) body.append(emptyState());
    shown.slice(0, query ? 50 : 5).forEach((d, i) => body.append(docRow(d, i === 0 && !query)));
  } else if (tab === 'docs') {
    const sorter = h('div', { class: 'seg small-seg' }, ...[['modified', 'Recent'], ['created', 'Created'], ['title', 'Name']].map(([k, l]) =>
      h('button', { class: sortBy === k ? 'on' : '', onclick: () => { sortBy = k; localStorage.setItem('docSort', k); render(); } }, l)));
    body.append(h('div', { class: 'list-head' }, h('h2', {}, `All Documents · ${docs.length}`)), sorter);
    const sorted = [...shown].sort((a, b) => (sortBy === 'title' ? a.title.localeCompare(b.title) : b[sortBy] - a[sortBy]));
    if (!docs.length) body.append(emptyState());
    sorted.forEach((d) => body.append(docRow(d, false)));
  } else if (tab === 'tools') {
    body.append(h('div', { class: 'list-head' }, h('h2', {}, 'Tools')), toolsGrid(false));
  } else {
    body.append(settingsView());
  }
}

function toolsGrid(compact) {
  const tool = (ic, label, fn, cls = '') => h('button', { class: 'qtool ' + cls, onclick: fn }, h('span', { class: 'qi', html: icon(ic) }), h('span', {}, label));
  const items = [
    tool('scan', 'Smart Scan', () => startScan({ mode: 'new' }), 'c1'),
    tool('photo', 'Import Images', () => $('#home-pick-images').click(), 'c2'),
    tool('file', 'Import Files', () => $('#home-pick-files').click(), 'c3'),
    tool('pageAdd', 'Blank Document', async () => { await M.createDocument('Untitled'); hideHome(); }, 'c4'),
  ];
  if (!compact) {
    items.push(
      tool('rect', 'ID Photo / Card', async () => { await M.createDocument('ID photos'); hideHome(); toast('Add a photo, then pick a size in Edit → Size presets (passport 35 × 45 mm, 2 × 2 in, ID card).', 5000); }, 'c5'),
      tool('markup', 'Sign & Mark Up', () => toast('Open a document, then tap Markup.'), 'c6'),
      tool('pdf', 'PDF to Word', () => toast('Open a PDF, tap Export and choose Word.'), 'c7'),
      tool('ruler', 'Calibrate', () => openCalibration(), 'c8'));
  }
  return h('div', { class: 'qtools' }, ...items);
}

function emptyState() {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-ic', html: icon('scan') }),
    h('b', {}, 'No documents yet'),
    h('p', {}, 'Tap the camera to scan paper, or import photos and PDFs.'),
    btn(icon('camera') + 'Scan a Document', () => startScan({ mode: 'new' }), 'btn primary'));
}

function docRow(d, expanded) {
  let thumb;
  if (d.thumb) { const u = URL.createObjectURL(d.thumb); thumbUrls.push(u); thumb = h('img', { src: u, alt: '' }); }
  else thumb = h('div', { class: 'ph', html: icon('doc') });
  const row = h('div', { class: 'doc' + (expanded ? ' expanded' : '') },
    h('button', { class: 'doc-main', onclick: () => openDoc(d.id) },
      h('span', { class: 'doc-thumb' }, thumb),
      h('span', { class: 'doc-tx' }, h('b', {}, d.title), h('small', {}, `${fmtDate(d.modified)}  ·  ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}`))),
    h('button', { class: 'doc-more', 'aria-label': 'More', html: icon('menuDots'), onclick: () => docMenu(d) }));
  if (!expanded) return row;
  return h('div', {}, row, h('div', { class: 'doc-actions' },
    h('button', { onclick: () => shareDoc(d.id, 'pdf') }, 'Share'),
    h('button', { onclick: () => shareDoc(d.id, 'docx') }, 'To Word'),
    h('button', { onclick: () => openDoc(d.id) }, 'Open')));
}

async function shareDoc(id, format) {
  if (await openDoc(id)) openHooks.exporter(format);
}

function docMenu(d) {
  const s = sheet(d.title, h('div', { class: 'sheet-list' },
    sheetItem('doc', 'Open', null, () => { s.close(); openDoc(d.id); }),
    sheetItem('share', 'Share / Export…', 'PDF, Word, JPEG or PNG', () => { s.close(); shareDoc(d.id, null); }),
    sheetItem('text', 'Rename', null, () => { s.close(); promptDialog('Document name', d.title, (v) => M.renameDocument(d.id, v)); }),
    sheetItem('duplicate', 'Duplicate', null, async () => { s.close(); await M.duplicateDocument(d.id); toast('Duplicated'); }),
    sheetItem('trash', 'Delete', null, () => {
      s.close();
      confirmDialog(`Delete “${d.title}”? This can't be undone.`, 'Delete', () => M.deleteDocument(d.id), true);
    }, true)));
}

function settingsView() {
  const wrap = h('div', { class: 'settings' });
  const seg = h('div', { class: 'seg' }, ...UNIT_ORDER.map((u) => h('button', { class: state.ui.unit === u ? 'on' : '', onclick: () => { M.setPref('unit', u); render(); } }, u)));
  const usage = h('small', { class: 'muted' }, ' ');
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => { usage.textContent = `Storage used on this device: ${(e.usage / 1e6).toFixed(1)} MB`; }).catch(() => {});
  }
  wrap.append(
    h('div', { class: 'list-head' }, h('h2', {}, 'Settings')),
    h('div', { class: 'section' }, h('h3', {}, 'Units'), seg),
    h('div', { class: 'sheet-list' },
      sheetItem('ruler', 'Calibrate Actual Size', 'Make 100% zoom match real paper', () => openCalibration()),
      sheetItem('home', 'Install on iPhone', 'Add to Home Screen for a full-screen app that works offline', () => openInstallHelp())),
    h('p', { class: 'muted center' }, `DocPrint Studio for iPhone · v${APP_VERSION}`),
    h('p', { class: 'center' }, usage),
    h('p', { class: 'muted center small' }, 'Documents are stored only on this device. Export or share anything you want to keep elsewhere.'));
  return wrap;
}
