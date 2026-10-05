// Document model (web port of DocumentModel.swift): pages, elements, guides, selection,
// snapshot undo/redo and continuous autosave.

import {
  A4, PAPERS, uid, normalizedAngle, boundingBox, aspectFit, center, isFullQuad, quadOutputSize, UNITS,
} from './geometry.js';
import { store } from './store.js';
import {
  assets, importImageFile, persistable, onDisplayReady, whenDisplay, detectDocument, displayKey, forgetAsset,
} from './imaging.js';
import { importPdfFile, onPreviewReady } from './pdfsupport.js';
import { DEFAULT_STYLE, simplify } from './markup.js';

export const DEFAULT_SCAN = Object.freeze({
  mode: 'original', exposure: 0, contrast: 1, saturation: 1, gamma: 1, sharpness: 0, hardThreshold: false, inkSensitivity: 0.5,
});
// Presets stay neutral: the pipeline measures each photo and sets levels automatically,
// so the sliders are only for taste.
export const SCAN_PRESETS = {
  original: { ...DEFAULT_SCAN },
  colorScan: { ...DEFAULT_SCAN, mode: 'colorScan', sharpness: 0.3 },
  grayscale: { ...DEFAULT_SCAN, mode: 'grayscale', sharpness: 0.3 },
  blackWhite: { ...DEFAULT_SCAN, mode: 'blackWhite' },
};

/** Older saved documents used a global B&W threshold; it became the adaptive ink sensitivity. */
function migrateDoc(doc) {
  for (const p of doc.pages) for (const e of p.elements) {
    if (e.kind !== 'image' || !e.scan) continue;
    if ('threshold' in e.scan) { delete e.scan.threshold; }
    e.scan = { ...DEFAULT_SCAN, ...e.scan };
  }
  return doc;
}
export const isIdentitySettings = (s) => JSON.stringify({ ...DEFAULT_SCAN, ...s }) === JSON.stringify(DEFAULT_SCAN);

const region = (navigator.language || 'en-US').split('-')[1] || '';
const letterRegion = ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE'].includes(region.toUpperCase());
const defaultPaper = letterRegion ? PAPERS[0] : A4;

// ------------------------------------------------------------------ state

export const state = {
  doc: newDoc(),
  ui: {
    pageId: null,
    selId: null,
    unit: localStorage.getItem('unit') || (region.toUpperCase() === 'US' ? 'in' : 'mm'),
    snap: localStorage.getItem('snap') !== '0',
    showGuides: localStorage.getItem('showGuides') !== '0',
    inspectorTab: 'transform',
    fitMargin: parseFloat(localStorage.getItem('fitMargin') || '0') || 0,   // points, used by Fit to Page
  },
};
if (!UNITS[state.ui.unit]) state.ui.unit = 'mm';
state.ui.pageId = state.doc.pages[0].id;

function newDoc() {
  return { title: 'Untitled', pages: [{ id: uid(), w: defaultPaper.w, h: defaultPaper.h, elements: [] }], guides: [] };
}

// ------------------------------------------------------------------ change notification

const listeners = new Set();
let pendingFlags = new Set();
let rafQueued = false;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(...flags) {
  flags.forEach((f) => pendingFlags.add(f));
  if (flags.includes('doc')) scheduleSave();
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    const f = pendingFlags; pendingFlags = new Set();
    listeners.forEach((fn) => fn(f));
  });
}

// UI hooks set by ui.js
export const hooks = { toast: (m) => console.log(m), alert: (m) => alert(m), busy: () => {} };
let busyCount = 0;
export function busy(on) { busyCount += on ? 1 : -1; hooks.busy(busyCount > 0); }

// ------------------------------------------------------------------ accessors

export const pages = () => state.doc.pages;
export const currentPageIndex = () => Math.max(0, state.doc.pages.findIndex((p) => p.id === state.ui.pageId));
export const currentPage = () => state.doc.pages[currentPageIndex()];
export function selected() {
  const p = currentPage();
  return p ? p.elements.find((e) => e.id === state.ui.selId) || null : null;
}
export function findElement(id) {
  for (const p of state.doc.pages) {
    const i = p.elements.findIndex((e) => e.id === id);
    if (i >= 0) return { page: p, el: p.elements[i], index: i };
  }
  return null;
}

// ------------------------------------------------------------------ undo / redo

const undoStack = [], redoStack = [];
let lastKey = null, lastKeyTime = 0;
const snapshot = () => JSON.stringify(state.doc);

export function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
  lastKey = null;
}
/** One undo step for a burst of edits with the same key (slider drags, typing). */
export function checkpointCoalesced(key) {
  const now = performance.now();
  if (key === lastKey && now - lastKeyTime < 1200) { lastKeyTime = now; return; }
  checkpoint();
  lastKey = key; lastKeyTime = now;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state.doc = JSON.parse(undoStack.pop());
  lastKey = null;
  repairSelection();
  emit('doc', 'sel');
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state.doc = JSON.parse(redoStack.pop());
  lastKey = null;
  repairSelection();
  emit('doc', 'sel');
}
function repairSelection() {
  if (!state.doc.pages.some((p) => p.id === state.ui.pageId)) state.ui.pageId = state.doc.pages[0].id;
  if (!currentPage().elements.some((e) => e.id === state.ui.selId)) state.ui.selId = null;
}

// ------------------------------------------------------------------ autosave

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
export function saveNow() {
  clearTimeout(saveTimer);
  return store.set('doc', { doc: state.doc, pageId: state.ui.pageId, savedAt: Date.now() });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', () => saveNow());

export async function loadSaved() {
  const saved = await store.get('doc');
  const recs = await store.allAssets();
  for (const r of recs) assets.set(r.id, { ...r });
  if (saved && saved.doc && saved.doc.pages && saved.doc.pages.length) {
    state.doc = migrateDoc(saved.doc);
    state.doc.guides = state.doc.guides || [];
    state.ui.pageId = saved.pageId;
    repairSelection();
  }
  // Garbage-collect assets nothing references any more.
  const used = referencedAssets(JSON.stringify(state.doc));
  const orphans = recs.filter((r) => !used.has(r.id)).map((r) => r.id);
  orphans.forEach(forgetAsset);
  store.deleteAssets(orphans);
  emit('doc', 'sel', 'view');
}
function referencedAssets(json) {
  const set = new Set();
  for (const m of json.matchAll(/"asset":"([^"]+)"/g)) set.add(m[1]);
  return set;
}

export async function newDocument() {
  checkpoint();
  state.doc = newDoc();
  state.ui.pageId = state.doc.pages[0].id;
  state.ui.selId = null;
  undoStack.length = 0; redoStack.length = 0;
  emit('doc', 'sel', 'view');
  await saveNow();
  const all = await store.allAssets();
  all.forEach((r) => forgetAsset(r.id));
  await store.clearAssets();
}

export function rename(title) {
  title = (title || '').trim() || 'Untitled';
  if (title === state.doc.title) return;
  checkpoint();
  state.doc.title = title;
  emit('doc');
}

export function setPref(key, value) {
  state.ui[key] = value;
  localStorage.setItem(key, typeof value === 'boolean' ? (value ? '1' : '0') : value);
  emit('ui');
}

// ------------------------------------------------------------------ pages

export function selectPage(id) {
  if (state.ui.pageId === id) return;
  state.ui.pageId = id;
  state.ui.selId = null;
  emit('sel', 'view');
}

export function addPage(afterId) {
  checkpoint();
  const cur = currentPage();
  const page = { id: uid(), w: cur ? cur.w : defaultPaper.w, h: cur ? cur.h : defaultPaper.h, elements: [] };
  const i = afterId ? state.doc.pages.findIndex((p) => p.id === afterId) : currentPageIndex();
  state.doc.pages.splice(Math.min(state.doc.pages.length, i + 1), 0, page);
  state.ui.pageId = page.id; state.ui.selId = null;
  emit('doc', 'sel', 'view');
}

export function duplicatePage(id) {
  const i = state.doc.pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  checkpoint();
  const copy = JSON.parse(JSON.stringify(state.doc.pages[i]));
  copy.id = uid();
  copy.elements.forEach((e) => { e.id = uid(); });
  state.doc.pages.splice(i + 1, 0, copy);
  state.ui.pageId = copy.id; state.ui.selId = null;
  emit('doc', 'sel', 'view');
}

export function deletePage(id) {
  const i = state.doc.pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  checkpoint();
  state.doc.pages.splice(i, 1);
  if (!state.doc.pages.length) state.doc.pages.push({ id: uid(), w: defaultPaper.w, h: defaultPaper.h, elements: [] });
  if (state.ui.pageId === id) state.ui.pageId = state.doc.pages[Math.min(i, state.doc.pages.length - 1)].id;
  state.ui.selId = null;
  emit('doc', 'sel', 'view');
}

/** Moves a page to a new position (thumbnail drag). */
export function movePageTo(id, index) {
  const P = state.doc.pages;
  const i = P.findIndex((p) => p.id === id);
  index = Math.max(0, Math.min(P.length - 1, index));
  if (i < 0 || i === index) return;
  checkpoint();
  const [p] = P.splice(i, 1);
  P.splice(index, 0, p);
  emit('doc');
}

export function movePage(id, delta) {
  const P = state.doc.pages;
  const i = P.findIndex((p) => p.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= P.length) return;
  checkpoint();
  const [p] = P.splice(i, 1);
  P.splice(j, 0, p);
  emit('doc');
}

/** Rotates the page 90° and its content with it (width/height swap). */
export function rotatePage(id, clockwise) {
  const p = state.doc.pages.find((q) => q.id === id);
  if (!p) return;
  checkpoint();
  const W = p.w, H = p.h;
  for (const e of p.elements) {
    const [cx, cy] = center(e);
    const [nx, ny] = clockwise ? [H - cy, cx] : [cy, W - cx];
    e.x = nx - e.w / 2; e.y = ny - e.h / 2;
    e.rotation = normalizedAngle((e.rotation || 0) + (clockwise ? 90 : -90));
  }
  p.w = H; p.h = W;
  emit('doc', 'view');
}

export function setPageSize(w, h) {
  if (!(w >= 36 && h >= 36)) { hooks.toast('Pages must be at least half an inch.'); return; }
  checkpoint();
  const p = currentPage();
  p.w = w; p.h = h;
  emit('doc', 'view');
}
export function setPaper(paper) {
  const p = currentPage();
  const landscape = p.w > p.h;
  setPageSize(landscape ? paper.h : paper.w, landscape ? paper.w : paper.h);
}
export function toggleOrientation() { const p = currentPage(); setPageSize(p.h, p.w); }

// ------------------------------------------------------------------ import

/** Imports images / PDFs from a file picker or drop. `autoScan` runs Scan Enhance on photos. */
export async function importFiles(files, { autoScan = false, point = null } = {}) {
  let offset = 0;
  for (const f of files) {
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    busy(true);
    try {
      if (isPdf) {
        const asset = await importPdfFile(f);
        addPdfPages(asset);
      } else {
        const asset = await importImageFile(f);
        const id = addImage(asset, point ? [point[0] + offset, point[1] + offset] : null);
        offset += 18;
        if (autoScan) await scanEnhance(id);
      }
    } catch (e) {
      hooks.alert(e.message === 'unsupported image'
        ? `“${f.name || 'That file'}” isn't an image or PDF DocPrint Studio can open.`
        : e.message || String(e));
    } finally {
      busy(false);
    }
  }
}

function addPdfPages(asset) {
  const newPages = asset.pages.map((s, i) => ({
    id: uid(), w: s.w, h: s.h,
    elements: [{
      id: uid(), kind: 'pdf', asset: asset.id, pageIndex: i, x: 0, y: 0, w: s.w, h: s.h,
      rotation: 0, aspectLocked: true, opacity: 1, name: `${asset.name} – p${i + 1}`,
    }],
  }));
  if (!newPages.length) return;
  checkpoint();
  const P = state.doc.pages;
  if (P.length === 1 && P[0].elements.length === 0) state.doc.pages = newPages;
  else P.splice(currentPageIndex() + 1, 0, ...newPages);
  if (state.doc.title === 'Untitled') state.doc.title = asset.name;
  state.ui.pageId = newPages[0].id; state.ui.selId = null;
  emit('doc', 'sel', 'view');
}

function addImage(asset, point) {
  const page = currentPage();
  // Embedded DPI gives true physical size for scans; otherwise assume 150 dpi.
  const dpi = asset.dpi || 150;
  let w = asset.w * 72 / dpi, h = asset.h * 72 / dpi;
  const fit = Math.min(1, (page.w * 0.85) / w, (page.h * 0.85) / h);
  w *= fit; h *= fit;
  const [cx, cy] = point || [page.w / 2, page.h / 2];
  const el = {
    id: uid(), kind: 'image', asset: asset.id, x: cx - w / 2, y: cy - h / 2, w, h, rotation: 0,
    aspectLocked: true, opacity: 1, name: asset.name, quad: null, scan: { ...DEFAULT_SCAN },
  };
  checkpoint();
  page.elements.push(el);
  state.ui.selId = el.id;
  emit('doc', 'sel');
  return el.id;
}

/** Adds a text box (in `rect`, or centered on the page) and selects it for editing. */
export function addText(rect = null) {
  const page = currentPage();
  const r = rect || { x: page.w / 2 - 100, y: page.h / 2 - 20, w: 200, h: 40 };
  const el = {
    id: uid(), kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0,
    aspectLocked: false, opacity: 1, name: 'Text',
    text: 'Text', font: 'Helvetica', size: 18, color: '#000000', align: 'left',
  };
  checkpoint();
  page.elements.push(el);
  state.ui.selId = el.id;
  state.ui.inspectorTab = 'transform';
  emit('doc', 'sel');
  return el.id;
}

// ------------------------------------------------------------------ markup

function loadStyle() {
  try { return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem('markupStyle') || '{}') }; } catch { return { ...DEFAULT_STYLE }; }
}
state.ui.tool = 'select';
state.ui.markupStyle = loadStyle();
state.ui.constrain = localStorage.getItem('constrain') === '1';

/** Switches the canvas tool. Choosing a drawing tool clears the selection (like macOS Markup). */
export function setTool(id) {
  const prev = state.ui.tool;
  state.ui.tool = id;
  if (id !== 'select' && id !== prev) state.ui.selId = null;
  emit('ui', 'sel');
}

export function setMarkupStyle(patch) {
  Object.assign(state.ui.markupStyle, patch);
  try { localStorage.setItem('markupStyle', JSON.stringify(state.ui.markupStyle)); } catch { /* ignore */ }
  emit('ui');
}

const SHAPE_NAMES = { rectangle: 'Rectangle', ellipse: 'Oval', line: 'Line', arrow: 'Arrow' };

/** Adds a rectangle / oval (from the drag rectangle) or a line / arrow (from start to end). */
export function addShape(kind, a, b) {
  const st = state.ui.markupStyle;
  const linear = kind === 'line' || kind === 'arrow';
  const shape = {
    kind, stroke: st.color, fill: linear ? null : st.fill, lineWidth: st.lineWidth, cornerRadius: 0,
    start: [0, 0], end: [1, 1], arrowAtStart: false, arrowAtEnd: true,
  };
  let x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (linear) {
    // Keep a minimum thickness so purely horizontal / vertical lines still have a frame.
    if (w < 1) { x -= (1 - w) / 2; w = 1; }
    if (h < 1) { y -= (1 - h) / 2; h = 1; }
    shape.start = [(a[0] - x) / w, (a[1] - y) / h];
    shape.end = [(b[0] - x) / w, (b[1] - y) / h];
  }
  const el = { id: uid(), kind: 'shape', x, y, w, h, rotation: 0, aspectLocked: false, opacity: 1, name: SHAPE_NAMES[kind], shape };
  checkpoint();
  currentPage().elements.push(el);
  state.ui.selId = el.id;
  state.ui.inspectorTab = 'transform';
  emit('doc', 'sel');
  return el.id;
}

/** Adds one freehand pen or highlighter stroke (points in page coordinates). */
export function addInk(raw, highlighter) {
  const st = state.ui.markupStyle;
  const width = highlighter ? st.highlighterWidth : st.penWidth;
  let pts = simplify(raw, 0.6);
  if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1]]);     // a dot
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // Pad by half the stroke so the whole line sits inside the frame.
  const x = Math.min(...xs) - width / 2, y = Math.min(...ys) - width / 2;
  const w = Math.max(...xs) - Math.min(...xs) + width, h = Math.max(...ys) - Math.min(...ys) + width;
  const ink = { points: pts.map((p) => [(p[0] - x) / w, (p[1] - y) / h]), color: highlighter ? st.highlighterColor : st.color, lineWidth: width, highlighter };
  const el = { id: uid(), kind: 'ink', x, y, w, h, rotation: 0, aspectLocked: true, opacity: 1, name: highlighter ? 'Highlight' : 'Drawing', ink };
  checkpoint();
  currentPage().elements.push(el);
  emit('doc');
  return el.id;
}

export function updateShape(id, patch) {
  checkpointCoalesced('shape-' + id + Object.keys(patch).join());
  updateElement(id, (e) => { if (e.shape) Object.assign(e.shape, patch); });
}

export function updateInk(id, patch) {
  checkpointCoalesced('ink-' + id + Object.keys(patch).join());
  updateElement(id, (e) => { if (e.ink) Object.assign(e.ink, patch); });
}

// ------------------------------------------------------------------ element editing

export function select(id) {
  if (state.ui.selId === id) return;
  state.ui.selId = id;
  if (id && state.ui.inspectorTab === 'scan' && selected()?.kind !== 'image') state.ui.inspectorTab = 'transform';
  emit('sel');
}

/** Mutates an element without a checkpoint (callers decide). */
export function updateElement(id, fn) {
  const f = findElement(id);
  if (!f) return;
  fn(f.el);
  emit('doc');
}

export function deleteSelected() {
  const el = selected();
  if (!el) return;
  checkpoint();
  const p = currentPage();
  p.elements = p.elements.filter((e) => e.id !== el.id);
  state.ui.selId = null;
  emit('doc', 'sel');
}

export function duplicateSelected() {
  const el = selected();
  if (!el) return;
  checkpoint();
  const copy = JSON.parse(JSON.stringify(el));
  copy.id = uid(); copy.x += 12; copy.y += 12;
  currentPage().elements.push(copy);
  state.ui.selId = copy.id;
  emit('doc', 'sel');
}

export function nudgeSelected(dx, dy) {
  const el = selected();
  if (!el) return;
  checkpointCoalesced('nudge-' + el.id);
  el.x += dx; el.y += dy;
  emit('doc');
}

export function setFrame(id, frame, key = 'frame') {
  checkpointCoalesced(`${key}-${id}`);
  updateElement(id, (e) => Object.assign(e, frame));
}

/** W or H typed in the inspector; honours the aspect lock. */
export function resizeSelected({ w, h }) {
  const el = selected();
  if (!el) return;
  checkpoint();
  const ratio = el.w / el.h;
  if (w != null && w > 0) { el.w = w; if (el.aspectLocked) el.h = w / ratio; }
  if (h != null && h > 0) { el.h = h; if (el.aspectLocked) el.w = h * ratio; }
  emit('doc');
}
/** Exact size ignoring the lock (presets), keeping the center. */
export function resizeFree(w, h) {
  const el = selected();
  if (!el) return;
  checkpoint();
  const [cx, cy] = center(el);
  Object.assign(el, { x: cx - w / 2, y: cy - h / 2, w, h });
  emit('doc');
}

export function setRotation(id, deg, key = 'rotation') {
  checkpointCoalesced(`${key}-${id}`);
  updateElement(id, (e) => { e.rotation = normalizedAngle(deg); });
}
export function rotateSelected(delta) {
  const el = selected();
  if (!el) return;
  checkpoint();
  el.rotation = normalizedAngle((el.rotation || 0) + delta);
  emit('doc');
}

export function reorderSelected(action) {
  const el = selected(), p = currentPage();
  if (!el) return;
  const i = p.elements.indexOf(el), last = p.elements.length - 1;
  const target = { forward: Math.min(i + 1, last), backward: Math.max(i - 1, 0), front: last, back: 0 }[action];
  if (target === i) return;
  checkpoint();
  p.elements.splice(i, 1);
  p.elements.splice(target, 0, el);
  emit('doc');
}

export function align(a) {
  const el = selected(), p = currentPage();
  if (!el) return;
  const bb = boundingBox(el, el.rotation);
  let dx = 0, dy = 0;
  if (a === 'left') dx = -bb.x;
  if (a === 'centerH') dx = p.w / 2 - (bb.x + bb.w / 2);
  if (a === 'right') dx = p.w - (bb.x + bb.w);
  if (a === 'top') dy = -bb.y;
  if (a === 'centerV') dy = p.h / 2 - (bb.y + bb.h / 2);
  if (a === 'bottom') dy = p.h - (bb.y + bb.h);
  checkpoint();
  el.x += dx; el.y += dy;
  emit('doc');
}

/**
 * Fits the selection to the page (inside the fit margin).
 * Aspect ratio locked → scaled to fit, centered, proportions kept.
 * Aspect ratio unlocked → stretched to fill the page area exactly (e.g. a scanned form to A4).
 * `stretch` overrides the lock state when given.
 */
export function fitSelectedToPage(stretch = null) {
  const el = selected();
  if (el) fitElementToPage(el.id, stretch);
}

/** Fit to Page for any element on its own page. `undoable: false` folds it into the caller's undo step. */
export function fitElementToPage(id, stretch = null, { undoable = true } = {}) {
  const f = findElement(id);
  if (!f) return;
  const el = f.el, p = f.page;
  const m = Math.max(0, Math.min(state.ui.fitMargin, p.w / 2 - 1, p.h / 2 - 1));
  const area = { x: m, y: m, w: p.w - 2 * m, h: p.h - 2 * m };
  // A 90°/270° element occupies its frame rotated, so fit against the swapped area.
  const quarterTurned = Math.abs(normalizedAngle(el.rotation || 0)) % 180 === 90;
  const tw = quarterTurned ? area.h : area.w, th = quarterTurned ? area.w : area.h;
  const fill = stretch ?? !el.aspectLocked;
  const size = fill ? { w: tw, h: th } : aspectFit(el.w, el.h, { x: 0, y: 0, w: tw, h: th });
  if (undoable) checkpoint();
  el.w = size.w; el.h = size.h;
  el.x = area.x + area.w / 2 - size.w / 2;
  el.y = area.y + area.h / 2 - size.h / 2;
  if (!quarterTurned) el.rotation = 0;
  emit('doc');
}

/** Natural width ÷ height of the element's content (after any perspective correction). */
export function naturalAspect(el) {
  const a = el && assets.get(el.asset);
  if (!a) return null;
  if (el.kind === 'image') {
    if (isFullQuad(el.quad)) return a.w / a.h;
    const o = quadOutputSize(el.quad, a.w, a.h);
    return o.h > 0 ? o.w / o.h : null;
  }
  if (el.kind === 'pdf') { const s = a.pages && a.pages[el.pageIndex]; return s && s.h > 0 ? s.w / s.h : null; }
  return null;
}

/** Undoes any stretching: keeps the width and centre, restores the content's true proportions. */
export function restoreProportions() {
  const el = selected();
  const aspect = naturalAspect(el);
  if (!el || !aspect) return;
  checkpoint();
  const [cx, cy] = center(el);
  el.h = el.w / aspect;
  el.y = cy - el.h / 2; el.x = cx - el.w / 2;
  emit('doc');
}

export function isStretched(el) {
  const aspect = naturalAspect(el);
  if (!aspect || !(el.h > 0)) return false;
  return Math.abs(el.w / el.h - aspect) / aspect > 0.005;
}

export function setAspectLocked(id, locked) {
  const f = findElement(id);
  if (!f || f.el.aspectLocked === locked) return;
  checkpoint();
  f.el.aspectLocked = locked;
  emit('doc');
}

/** "Original pixel size @ N dpi" using the processed (possibly un-warped) aspect. */
export async function setSelectedAtDPI(dpi) {
  const el = selected();
  if (!el || el.kind !== 'image') return;
  const a = assets.get(el.asset);
  const d = await whenDisplay(el);
  const k = a.w / (a.proxyW || a.w);
  resizeFree(d.w * k * 72 / dpi, d.h * k * 72 / dpi);
}

export function updateText(id, patch) {
  checkpointCoalesced('text-' + id + Object.keys(patch).join());
  updateElement(id, (e) => Object.assign(e, patch));
}

export function toggleAspectLock() {
  const el = selected();
  if (!el) return;
  checkpoint();
  el.aspectLocked = !el.aspectLocked;
  emit('doc');
}

export function setOpacity(id, v) {
  checkpointCoalesced('opacity-' + id);
  updateElement(id, (e) => { e.opacity = v; });
}

// ------------------------------------------------------------------ guides (document-wide, like the Mac app)

export function addGuide(axis, pos) {
  const g = { id: uid(), axis, pos };
  state.doc.guides.push(g);
  emit('doc');
  return g.id;
}
export function moveGuide(id, pos) {
  const g = state.doc.guides.find((x) => x.id === id);
  if (g) { g.pos = pos; emit('doc'); }
}
export function removeGuide(id) {
  state.doc.guides = state.doc.guides.filter((g) => g.id !== id);
  emit('doc');
}
export function clearGuides() { state.doc.guides = []; emit('doc'); }

/** Lines an element may snap to: page edges/center, guides, other elements. */
export function snapTargets(excludeId) {
  const p = currentPage();
  const xs = [0, p.w / 2, p.w], ys = [0, p.h / 2, p.h];
  if (state.ui.showGuides) for (const g of state.doc.guides) (g.axis === 'v' ? xs : ys).push(g.pos);
  for (const e of p.elements) {
    if (e.id === excludeId) continue;
    const b = boundingBox(e, e.rotation);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

// ------------------------------------------------------------------ scan processing

export function setScan(id, settings, key = 'scan') {
  checkpointCoalesced(`${key}-${id}`);
  updateElement(id, (e) => { e.scan = { ...settings }; });
}

/** Sets (or clears) the perspective quad, then matches the frame to the un-warped aspect. */
export async function applyPerspective(id, quad) {
  const f = findElement(id);
  if (!f || f.el.kind !== 'image') return;
  checkpoint();
  f.el.quad = isFullQuad(quad) ? null : quad;
  emit('doc');
  await fixAspect(id);
}

async function fixAspect(id) {
  const f = findElement(id);
  if (!f) return;
  const key = displayKey(f.el);
  try {
    const d = await whenDisplay(f.el);
    const g = findElement(id);
    if (!g || displayKey(g.el) !== key || !d.w) return;
    g.el.h = g.el.w * (d.h / d.w);
    emit('doc');
  } catch (e) { console.warn(e); }
}

/**
 * One-tap "Scan Enhance": detect the page edges, unwarp, apply the color-scan preset, then fit the
 * result to the current page with the regular Fit to Page rules (keep proportions when the aspect
 * ratio is locked, fill the page when it isn't; fit margin respected). One undo reverts it all.
 */
export async function scanEnhance(id = state.ui.selId) {
  const f = id && findElement(id);
  if (!f || f.el.kind !== 'image') { hooks.alert('Select a photo on the page first, then choose Scan Enhance.'); return; }
  busy(true);
  let quad = null;
  try { quad = await detectDocument(f.el.asset); } catch (e) { console.warn(e); }
  busy(false);
  const g = findElement(id);
  if (!g) return;
  checkpoint();
  if (quad) g.el.quad = quad;
  g.el.scan = { ...SCAN_PRESETS.colorScan };
  state.ui.inspectorTab = 'scan';
  emit('doc', 'sel');
  if (quad) await fixAspect(id);
  else hooks.toast("Couldn't find the page edges — use Edit Corners to place them.");
  fitElementToPage(id, null, { undoable: false });
}

// Re-render when processed previews / PDF pages arrive.
onDisplayReady(() => emit('render'));
onPreviewReady(() => emit('render'));

export { assets, persistable };
