// Mobile UI: top bar, toolbar, the in-flow panel (Edit / Scan / Pages — a port of the
// macOS inspector and thumbnail sidebar) and modal sheets (Add, Export, View, Menu).

import * as M from './model.js';
import { state, SCAN_PRESETS, DEFAULT_SCAN } from './model.js';
import {
  UNITS, UNIT_ORDER, PAPERS, SIZE_PRESETS, FONTS, toPoints, fromPoints, fmtUnit, paperName, isFullQuad,
} from './geometry.js';
import { icon } from './icons.js';
import { view, setZoomMode, zoomBy, zoomPercent, actualScale, cssPxPerInch, calibration, canvasHooks } from './canvas.js';
import { assets, ensureImageReady } from './imaging.js';
import { renderPage } from './render.js';
import { openExporter } from './exportui.js';
import { openCornerEditor } from './perspective.js';
import { TOOLS, PALETTE, tool as toolInfo, isMarkup } from './markup.js';
import { pointerPos } from './canvas.js';

export const APP_VERSION = '1.2.1';
const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ DOM helpers

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
const btn = (label, onclick, cls = 'btn', title) => h('button', { class: cls, onclick, 'aria-label': title || null, title: title || null, html: label });
const section = (title, ...kids) => h('div', { class: 'section' }, title ? h('h3', {}, title) : null, ...kids);
const row = (...kids) => h('div', { class: 'row' }, ...kids);

// Controls register "refreshers" that re-read the model after every change. Panel controls
// live in panelRefreshers; controls inside an open modal sheet live in that sheet's scope.
let panelRefreshers = [];
const sheetScopes = new Set();
let scope = null;
const refresh = (fn) => { (scope || panelRefreshers).push(fn); fn(); };
function scoped(build) {
  const sc = [];
  scope = sc;
  try { return [build(), sc]; } finally { scope = null; }
}
const focused = (input) => document.activeElement === input;

const parseNum = (s) => {
  const v = parseFloat(String(s).replace(',', '.').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(v) ? v : null;
};

/** Length field in the active unit (value stored in points). */
function unitField(label, get, set, { narrow = false } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off' });
  const unit = h('span', { class: 'unit' });
  const commit = () => { const v = parseNum(input.value); if (v != null) set(toPoints(v, state.ui.unit)); };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('focus', () => input.select());
  refresh(() => {
    unit.textContent = UNITS[state.ui.unit].symbol;
    if (!focused(input)) { const v = get(); input.value = v == null ? '' : fmtUnit(v, state.ui.unit, false); }
  });
  return h('div', { class: 'field' + (narrow ? ' narrow' : '') }, h('label', {}, label), input, unit);
}

function numField(label, get, set, suffix, { narrow = true, digits = 1 } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off' });
  input.addEventListener('change', () => { const v = parseNum(input.value); if (v != null) set(v); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('focus', () => input.select());
  refresh(() => { if (!focused(input)) input.value = (+get().toFixed(digits)).toString(); });
  return h('div', { class: 'field' + (narrow ? ' narrow' : '') }, label ? h('label', {}, label) : null, input, suffix ? h('span', { class: 'unit' }, suffix) : null);
}

function slider({ label, min, max, step, get, set, neutral, fmt = (v) => v.toFixed(2) }) {
  const input = h('input', { type: 'range', min, max, step });
  const val = h('span', { class: 'val' });
  input.addEventListener('input', () => set(parseFloat(input.value)));
  // Reset button appears when the value differs from neutral (like the Mac inspector).
  const reset = h('button', { class: 'reset', 'aria-label': `Reset ${label}`, title: 'Reset', html: icon('undo'), onclick: () => set(neutral) });
  const lbl = h('span', { class: 'lbl', ondblclick: () => neutral != null && set(neutral) }, label);
  refresh(() => {
    const v = get();
    if (!focused(input)) input.value = v;
    val.textContent = fmt(v);
    const changed = neutral != null && Math.abs(v - neutral) > 1e-6;
    val.classList.toggle('changed', changed);
    reset.hidden = !changed;
  });
  return h('div', { class: 'slider-row' }, lbl, input, h('span', { class: 'val-wrap' }, val, reset));
}

/** Colour swatches (macOS Markup palette) + a custom colour well; `allowNone` adds "no fill". */
function colorRow(get, set, allowNone = false) {
  const wrap = h('div', { class: 'swatches' });
  const items = [];
  const add = (c) => {
    const b = h('button', { class: 'swatch' + (c ? '' : ' none'), style: c ? { background: c } : {}, 'aria-label': c || 'No fill', onclick: () => set(c) });
    wrap.append(b); items.push([c, b]);
  };
  if (allowNone) add(null);
  PALETTE.forEach(add);
  const well = h('input', { type: 'color', class: 'well', 'aria-label': 'Custom colour' });
  well.addEventListener('input', () => set(well.value));
  wrap.append(well);
  refresh(() => {
    const cur = get();
    items.forEach(([c, b]) => b.classList.toggle('on', (c || null) === (cur ? cur.toLowerCase() : null)));
    if (!focused(well) && cur) well.value = cur;
  });
  return wrap;
}

function toggle(label, get, set) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.addEventListener('change', () => set(input.checked));
  refresh(() => { input.checked = !!get(); });
  return h('label', { class: 'switch' }, h('span', {}, label), input);
}

function segmented(options, get, set) {
  const wrap = h('div', { class: 'seg' });
  const buttons = options.map((o) => {
    const b = h('button', { html: (o.icon ? icon(o.icon) : '') + (o.label ? `<span>${o.label}</span>` : ''), 'aria-label': o.title || o.label, title: o.title || null, onclick: () => set(o.value) });
    wrap.append(b);
    return [o.value, b];
  });
  refresh(() => { const v = get(); buttons.forEach(([val, b]) => b.classList.toggle('on', val === v)); });
  return wrap;
}

// ------------------------------------------------------------------ toast / dialogs / sheets

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function sheet(title, body, { center = false, onClose, refreshScope } = {}) {
  const root = $('#sheet-root');
  const back = h('div', { class: 'backdrop' });
  const card = h('div', { class: 'sheet' + (center ? ' center' : ''), role: 'dialog', 'aria-modal': 'true' },
    center ? null : h('div', { class: 'grip' }), title ? h('h2', {}, title) : null, body);
  if (refreshScope) sheetScopes.add(refreshScope);
  const close = () => { back.remove(); card.remove(); if (refreshScope) sheetScopes.delete(refreshScope); onClose && onClose(); };
  back.addEventListener('click', close);
  // Swipe down on the grip area to dismiss.
  let y0 = null;
  card.addEventListener('touchstart', (e) => { y0 = card.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (y0 == null || center) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0) card.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  card.addEventListener('touchend', (e) => {
    if (y0 == null || center) return;
    const dy = e.changedTouches[0].clientY - y0;
    card.style.transform = '';
    if (dy > 90) close();
    y0 = null;
  });
  root.append(back, card);
  return { close, card };
}

function sheetItem(ic, title, sub, onclick, danger = false) {
  return h('button', { class: 'sheet-item' + (danger ? ' danger' : ''), onclick },
    h('span', { class: 'ic', html: icon(ic) }), h('span', { class: 'tx' }, h('b', {}, title), sub ? h('small', {}, sub) : null));
}

export function alertDialog(msg) {
  const s = sheet(null, h('div', {}, h('p', {}, msg), h('div', { class: 'sheet-actions' }, btn('OK', () => s.close(), 'btn primary'))), { center: true });
}

function confirmDialog(msg, okLabel, onOK, danger = false) {
  const s = sheet(null, h('div', {}, h('p', {}, msg), h('div', { class: 'sheet-actions' },
    btn('Cancel', () => s.close()), btn(okLabel, () => { s.close(); onOK(); }, danger ? 'btn danger' : 'btn primary'))), { center: true });
}

function promptDialog(title, value, onOK, { inputmode = 'text' } = {}) {
  const input = h('input', { class: 'text-input', value, inputmode, enterkeyhint: 'done', autocomplete: 'off' });
  const ok = () => { s.close(); onOK(input.value); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  const s = sheet(title, h('div', {}, input, h('div', { class: 'sheet-actions' }, btn('Cancel', () => s.close()), btn('OK', ok, 'btn primary'))), { center: true });
  setTimeout(() => { input.focus(); input.select(); }, 60);
}

// ------------------------------------------------------------------ top bar & toolbar

function initChrome() {
  $('#btn-menu').innerHTML = icon('menu');
  $('#btn-undo').innerHTML = icon('undo');
  $('#btn-redo').innerHTML = icon('redo');
  $('#btn-export').innerHTML = icon('share');
  $('#panel-close').innerHTML = icon('close');
  const tb = { add: 'add', pages: 'pages', edit: 'edit', markup: 'markup', scan: 'scan', view: 'view' };
  $('#tool-pill').addEventListener('click', (e) => { if (e.target.closest('[data-done]')) M.setTool('select'); else openPanel('markup'); });
  // iOS can leave the page scrolled after the keyboard closes; put it back.
  document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) window.scrollTo(0, 0); }, 50));
  document.querySelectorAll('#toolbar button').forEach((b) => { b.querySelector('i').innerHTML = icon(tb[b.dataset.tool]); });

  $('#btn-undo').addEventListener('click', () => M.undo());
  $('#btn-redo').addEventListener('click', () => M.redo());
  $('#btn-export').addEventListener('click', () => openExporter());
  $('#btn-menu').addEventListener('click', openMenuSheet);
  $('#title-wrap').addEventListener('click', () => promptDialog('Document name', state.doc.title, (v) => M.rename(v)));
  $('#panel-close').addEventListener('click', closePanel);
  document.querySelectorAll('#toolbar button').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (t === 'add') openAddSheet();
    else if (t === 'view') openViewSheet();
    else togglePanel(t);
  }));
}

function updateChrome() {
  $('#doc-title').textContent = state.doc.title;
  const P = state.doc.pages, i = M.currentPageIndex(), p = P[i];
  const u = state.ui.unit;
  $('#doc-sub').textContent = `Page ${i + 1} of ${P.length} · ${fmtUnit(p.w, u, false)} × ${fmtUnit(p.h, u)}`;
  updateStatus();
  const t = state.ui.tool;
  const pill = $('#tool-pill');
  pill.hidden = t === 'select';
  if (t !== 'select') {
    const info = toolInfo(t);
    pill.innerHTML = `${icon(info.icon)}<span>${info.label}</span><button class="done" data-done>Done</button>`;
  }
  $('#btn-undo').disabled = !M.canUndo();
  $('#btn-redo').disabled = !M.canRedo();
  $('#empty-hint').hidden = !(P.length === 1 && p.elements.length === 0);
  document.querySelectorAll('#toolbar button').forEach((b) => b.classList.toggle('on', b.dataset.tool === panelName));
}

/** Status bar: pointer position, selection size and zoom (like the Mac window's bottom bar). */
function updateStatus() {
  const u = state.ui.unit, parts = [];
  if (pointerPos.x != null) parts.push(`X ${fmtUnit(pointerPos.x, u)}   Y ${fmtUnit(pointerPos.y, u)}`);
  const el = M.selected();
  if (el) parts.push(`${el.name}: ${fmtUnit(el.w, u, false)} × ${fmtUnit(el.h, u)}`);
  const sb = $('#statusbar');
  sb.replaceChildren(h('span', { class: 'grow' }, parts.join('   ·   ')), h('span', {}, `${zoomPercent()}%`));
}

// ------------------------------------------------------------------ in-flow panel

let panelName = null, panelSig = null;
let thumbTimer = null;

function togglePanel(name) {
  if (panelName === name) { closePanel(); return; }
  openPanel(name);
}
export function openPanel(name) {
  panelName = name; panelSig = null;
  if (name === 'scan') state.ui.inspectorTab = 'scan';
  if (name === 'edit') state.ui.inspectorTab = 'transform';
  $('#panel').hidden = false;
  updatePanel();
  updateChrome();
}
function closePanel() {
  panelName = null;
  $('#panel').hidden = true;
  updateChrome();
}

function signature() {
  const el = M.selected();
  const guides = state.doc.guides.map((g) => g.id).join();
  if (panelName === 'pages') return 'pages';
  if (panelName === 'scan') return `scan|${el?.id}|${el?.kind}|${el?.scan?.mode}|${state.ui.unit}`;
  if (panelName === 'markup') return `markup|${el?.id}|${el?.kind}|${state.ui.tool}|${el?.shape?.kind}`;
  return `edit|${el?.id}|${el?.kind}|${state.ui.unit}|${guides}|${state.ui.tool}|${el?.shape?.kind}`;
}

function updatePanel(flags) {
  if (!panelName) return;
  const sig = signature();
  if (sig !== panelSig) {
    const sameSubject = panelSig && sig.split('|').slice(0, 2).join() === panelSig.split('|').slice(0, 2).join();
    panelSig = sig;
    panelRefreshers = [];
    const body = $('#panel-body');
    const keepScroll = body.scrollTop;
    body.replaceChildren();
    const title = $('#panel-title');
    title.replaceChildren();
    if (panelName === 'pages') buildPagesPanel(body, title);
    else if (panelName === 'scan') buildScanPanel(body, title);
    else if (panelName === 'markup') buildMarkupPanel(body, title);
    else buildEditPanel(body, title);
    body.scrollTop = sameSubject ? keepScroll : 0;
  } else {
    panelRefreshers.forEach((f) => f(flags));
  }
}

// ---- Edit panel (Transform inspector; Page + Guides when nothing is selected)

function elementIcon(el) {
  if (el.kind === 'text') return 'text';
  if (el.kind === 'pdf') return 'file';
  if (el.kind === 'shape') return { rectangle: 'rect', ellipse: 'oval', line: 'line', arrow: 'arrow' }[el.shape.kind];
  if (el.kind === 'ink') return el.ink.highlighter ? 'highlighter' : 'pen';
  return 'photo';
}

function buildEditPanel(body, title) {
  const el0 = M.selected();
  markupStyleSection(body);
  if (!el0) { buildPageInspector(body, title); return; }
  const id = el0.id;
  const cur = () => M.findElement(id)?.el;
  const kindIcon = elementIcon(el0);
  const name = h('span');
  refresh(() => { name.textContent = cur()?.name || ''; });
  title.append(h('div', { class: 'row nowrap', style: { marginBottom: 0 } },
    h('div', { class: 'sel-name grow', html: icon(kindIcon) }, name),
    btn(icon('duplicate'), () => M.duplicateSelected(), 'btn icon', 'Duplicate'),
    btn(icon('trash'), () => M.deleteSelected(), 'btn icon danger', 'Delete')));
  title.querySelector('.sel-name').append(name);

  if (el0.kind === 'text') {
    const ta = h('textarea', { class: 'text-edit', rows: 3, 'aria-label': 'Text' });
    ta.addEventListener('input', () => M.updateText(id, { text: ta.value }));
    refresh(() => { if (!focused(ta)) ta.value = cur()?.text ?? ''; });
    const font = h('select', { class: 'select', 'aria-label': 'Font' }, ...FONTS.map((f) => h('option', { value: f.id }, f.id)));
    font.addEventListener('change', () => M.updateText(id, { font: font.value }));
    refresh(() => { font.value = cur()?.font; });
    const color = h('input', { type: 'color', 'aria-label': 'Text color' });
    color.addEventListener('input', () => M.updateText(id, { color: color.value }));
    refresh(() => { if (!focused(color)) color.value = cur()?.color || '#000000'; });
    body.append(section('Text', ta,
      h('div', { class: 'row', style: { marginTop: '8px' } }, font, numField('', () => cur()?.size ?? 18, (v) => M.updateText(id, { size: Math.max(1, v) }), 'pt')),
      row(color, h('div', { class: 'grow' }, segmented([
        { value: 'left', icon: 'alLeft', title: 'Align left' }, { value: 'center', icon: 'alCenterH', title: 'Center' }, { value: 'right', icon: 'alRight', title: 'Align right' },
      ], () => cur()?.align, (v) => M.updateText(id, { align: v }))))));
  }

  body.append(section('Position',
    row(unitField('X', () => cur()?.x, (v) => M.setFrame(id, { x: v }, 'x')), unitField('Y', () => cur()?.y, (v) => M.setFrame(id, { y: v }, 'y')))));

  const lockBtn = btn('', () => M.toggleAspectLock(), 'btn icon', 'Aspect ratio lock');
  refresh(() => { const e = cur(); lockBtn.innerHTML = icon(e?.aspectLocked ? 'lock' : 'unlock'); lockBtn.classList.toggle('on', !!e?.aspectLocked); });
  const presets = h('select', { class: 'select', 'aria-label': 'Size presets' },
    h('option', { value: '' }, 'Size presets…'),
    ...SIZE_PRESETS.map((p, i) => h('option', { value: 'p' + i }, p.label)),
    el0.kind === 'image' ? h('option', { value: 'dpi300' }, 'Original pixel size @ 300 dpi') : null);
  presets.addEventListener('change', () => {
    const v = presets.value; presets.value = '';
    if (v.startsWith('p')) { const p = SIZE_PRESETS[+v.slice(1)]; M.resizeFree(p.w, p.h); }
    if (v === 'dpi300') M.setSelectedAtDPI(300);
  });
  body.append(section('Size',
    h('div', { class: 'row nowrap' }, unitField('W', () => cur()?.w, (v) => M.resizeSelected({ w: v })), unitField('H', () => cur()?.h, (v) => M.resizeSelected({ h: v })), lockBtn),
    row(presets)));

  // Fit to Page: keep proportions (aspect lock on) or fill the page exactly (lock off).
  const pageName = () => { const pg = M.currentPage(), n = paperName(pg.w, pg.h); return n === 'Custom' ? 'the page' : n.replace(' landscape', ''); };
  const fitBtn = btn('', () => M.fitSelectedToPage(), 'btn primary');
  const restoreBtn = btn('Restore Proportions', () => M.restoreProportions(), 'btn');
  const fitInfo = h('p', { class: 'muted', style: { margin: '0 0 6px' } });
  refresh(() => {
    const e = cur(); if (!e) return;
    fitBtn.innerHTML = icon('fit') + `Fit to ${pageName()}`;
    restoreBtn.hidden = !M.isStretched(e);
    fitInfo.textContent = e.aspectLocked
      ? `Scales to fit inside ${pageName()}, keeping the original aspect ratio and centering it.`
      : `Stretches to fill ${pageName()} edge to edge (minus the margin). Proportions may change.`;
  });
  body.append(section('Fit to Page',
    h('div', { style: { marginBottom: '8px' } }, segmented([
      { value: true, label: 'Keep proportions' }, { value: false, label: 'Fill page' },
    ], () => !!cur()?.aspectLocked, (v) => M.setAspectLocked(id, v))),
    row(unitField('Margin', () => state.ui.fitMargin, (v) => M.setPref('fitMargin', Math.max(0, v)))),
    h('div', { class: 'btn-group', style: { marginBottom: '8px' } }, fitBtn, restoreBtn),
    fitInfo));

  const stepLbl = h('span', { class: 'muted' });
  refresh(() => { const u = state.ui.unit; stepLbl.textContent = `Nudge ${u === 'in' ? '1/16 in' : '1 mm'} per tap`; });
  const nudge = (dx, dy) => () => { const s = UNITS[state.ui.unit].nudge; M.nudgeSelected(dx * s, dy * s); };
  const pad = h('div', { class: 'nudge' },
    btn(icon('up'), nudge(0, -1), 'btn up', 'Nudge up'), btn(icon('left'), nudge(-1, 0), 'btn left', 'Nudge left'),
    btn(icon('down'), nudge(0, 1), 'btn down', 'Nudge down'), btn(icon('right'), nudge(1, 0), 'btn right', 'Nudge right'));
  body.append(section('Move', h('div', { class: 'row nowrap' }, pad, h('div', { class: 'grow' }, stepLbl))));

  body.append(section('Rotation',
    h('div', { class: 'row nowrap' },
      numField('', () => cur()?.rotation ?? 0, (v) => M.setRotation(id, v, 'rotfield'), '°'),
      h('div', { class: 'grow' }),
      btn(icon('rotL'), () => M.rotateSelected(-90), 'btn icon', 'Rotate 90° left'),
      btn(icon('rotR'), () => M.rotateSelected(90), 'btn icon', 'Rotate 90° right')),
    slider({ label: 'Angle', min: -180, max: 180, step: 1, neutral: 0, get: () => cur()?.rotation ?? 0, set: (v) => M.setRotation(id, Math.round(v)), fmt: (v) => `${Math.round(v)}°` })));

  body.append(section('Opacity',
    slider({ label: 'Opacity', min: 0, max: 1, step: 0.01, neutral: 1, get: () => cur()?.opacity ?? 1, set: (v) => M.setOpacity(id, v), fmt: (v) => `${Math.round(v * 100)}%` })));

  body.append(section('Arrange',
    h('div', { class: 'btn-group', style: { marginBottom: '8px' } },
      btn('To Back', () => M.reorderSelected('back')), btn('Backward', () => M.reorderSelected('backward')),
      btn('Forward', () => M.reorderSelected('forward')), btn('To Front', () => M.reorderSelected('front'))),
    h('div', { class: 'btn-group', style: { marginBottom: '8px' } },
      ...[['alLeft', 'left', 'Align left edge'], ['alCenterH', 'centerH', 'Center horizontally'], ['alRight', 'right', 'Align right edge'],
        ['alTop', 'top', 'Align top edge'], ['alCenterV', 'centerV', 'Center vertically'], ['alBottom', 'bottom', 'Align bottom edge']]
        .map(([ic, a, t]) => btn(icon(ic), () => M.align(a), 'btn icon', t))),
    h('div', { class: 'btn-group', style: { marginBottom: '8px' } },
      btn(icon('center') + 'Center on Page', () => { M.align('centerH'); M.align('centerV'); }, 'btn')),
    toggle('Snap to guides, edges & centers', () => state.ui.snap, (v) => M.setPref('snap', v))));

  pageAndGuides(body);
}

function buildPageInspector(body, title) {
  title.append(h('div', { class: 'sel-name', html: icon('doc') }, h('span', {}, 'Page & Guides')));
  pageAndGuides(body);
}

/** Page and Guides sections (always at the bottom of the Edit panel, like the Mac inspector). */
function pageAndGuides(body) {
  const p = () => M.currentPage();
  const info = h('div', { class: 'muted' });
  refresh(() => { const pg = p(); info.textContent = `${paperName(pg.w, pg.h)} · ${pg.elements.length} object(s)`; });
  body.append(section('Page',
    row(unitField('W', () => p().w, (v) => M.setPageSize(v, p().h)), unitField('H', () => p().h, (v) => M.setPageSize(p().w, v))),
    paperChips(), info));

  const list = h('div');
  const guides = state.doc.guides;
  if (!guides.length) list.append(h('p', { class: 'muted', style: { margin: '0 0 8px' } }, 'Drag from the top ruler for a horizontal guide, or the left ruler for a vertical one. Drag a guide off the page to delete it.'));
  for (const g of guides) {
    list.append(h('div', { class: 'row nowrap' },
      h('span', { class: 'guide-ic', html: g.axis === 'v' ? '↔︎' : '↕︎' }),
      unitField(g.axis === 'v' ? 'X' : 'Y', () => state.doc.guides.find((q) => q.id === g.id)?.pos, (v) => M.moveGuide(g.id, v)),
      btn(icon('close'), () => M.removeGuide(g.id), 'btn icon', 'Remove guide')));
  }
  body.append(section('Guides',
    toggle('Show guides', () => state.ui.showGuides, (v) => M.setPref('showGuides', v)),
    toggle('Snap to guides, edges & centers', () => state.ui.snap, (v) => M.setPref('snap', v)),
    list, guides.length ? row(btn('Clear All Guides', () => M.clearGuides(), 'btn danger')) : null));
}

function paperChips() {
  const wrap = h('div', { class: 'chips', style: { marginBottom: '8px' } });
  const chips = PAPERS.map((paper) => {
    const c = h('button', { class: 'chip', onclick: () => M.setPaper(paper) }, paper.name);
    wrap.append(c);
    return [paper, c];
  });
  const orient = h('button', { class: 'chip', onclick: () => M.toggleOrientation() });
  wrap.append(orient);
  refresh(() => {
    const pg = M.currentPage();
    chips.forEach(([paper, c]) => {
      const on = (Math.abs(paper.w - pg.w) < 1 && Math.abs(paper.h - pg.h) < 1) || (Math.abs(paper.w - pg.h) < 1 && Math.abs(paper.h - pg.w) < 1);
      c.classList.toggle('on', on);
    });
    orient.textContent = pg.w > pg.h ? '↻ Landscape' : '↻ Portrait';
  });
  return wrap;
}

// ---- Markup panel (macOS Markup toolbar + style inspector)

function buildMarkupPanel(body, title) {
  title.append(h('div', { class: 'sel-name', html: icon('markup') }, h('span', {}, 'Markup')));
  const strip = h('div', { class: 'tools' });
  const buttons = TOOLS.map((t) => {
    const b = h('button', {
      class: 'tool', 'aria-label': t.label, title: `${t.label} (${t.key.toUpperCase()})`, html: icon(t.icon) + `<span>${t.label}</span>`,
      onclick: () => M.setTool(state.ui.tool === t.id && t.id !== 'select' ? 'select' : t.id),
    });
    strip.append(b);
    return [t.id, b];
  });
  refresh(() => buttons.forEach(([id, b]) => b.classList.toggle('on', state.ui.tool === id)));
  body.append(section(null, strip,
    toggle('Perfect shapes (squares, circles, 45° lines)', () => state.ui.constrain, (v) => { state.ui.constrain = v; M.setPref('constrain', v); })));
  if (!markupStyleSection(body)) {
    body.append(section(null, h('p', { class: 'muted' }, state.ui.tool === 'text'
      ? 'Tap the page to add a text box, or drag to draw its frame.'
      : 'Pick a tool, then drag on the page to draw. Select a shape or drawing to restyle it. Shapes and text return to Select when placed; the pen and highlighter stay on until you tap Done.')));
  }
}

/**
 * Style controls for a selected shape / drawing, or for the active tool when nothing is selected.
 * Returns whether anything was added.
 */
function markupStyleSection(body) {
  const el0 = M.selected();
  const st = () => state.ui.markupStyle;
  if (el0 && el0.kind === 'shape') {
    const id = el0.id;
    const S = () => M.findElement(id)?.el.shape || el0.shape;
    const kids = [h('div', { class: 'cap' }, 'Stroke'), colorRow(() => S().stroke, (c) => { if (!c) return; M.updateShape(id, { stroke: c }); M.setMarkupStyle({ color: c }); })];
    if (el0.shape.kind === 'rectangle' || el0.shape.kind === 'ellipse') {
      kids.push(h('div', { class: 'cap' }, 'Fill'), colorRow(() => S().fill, (c) => { M.updateShape(id, { fill: c }); M.setMarkupStyle({ fill: c }); }, true));
    }
    kids.push(slider({ label: 'Line width', min: 0.5, max: 20, step: 0.5, get: () => S().lineWidth, set: (v) => { M.updateShape(id, { lineWidth: v }); M.setMarkupStyle({ lineWidth: v }); }, fmt: (v) => `${v.toFixed(1)} pt` }));
    if (el0.shape.kind === 'rectangle') {
      kids.push(slider({ label: 'Corner radius', min: 0, max: 60, step: 1, neutral: 0, get: () => S().cornerRadius || 0, set: (v) => M.updateShape(id, { cornerRadius: v }), fmt: (v) => `${Math.round(v)} pt` }));
    }
    if (el0.shape.kind === 'arrow') {
      kids.push(toggle('Head at start', () => S().arrowAtStart, (v) => M.updateShape(id, { arrowAtStart: v })),
        toggle('Head at end', () => S().arrowAtEnd, (v) => M.updateShape(id, { arrowAtEnd: v })));
    }
    body.append(section('Style', ...kids));
    return true;
  }
  if (el0 && el0.kind === 'ink') {
    const id = el0.id, hl = el0.ink.highlighter;
    const I = () => M.findElement(id)?.el.ink || el0.ink;
    body.append(section(hl ? 'Highlighter' : 'Pen',
      colorRow(() => I().color, (c) => { if (!c) return; M.updateInk(id, { color: c }); M.setMarkupStyle(hl ? { highlighterColor: c } : { color: c }); }),
      slider({ label: 'Width', min: hl ? 4 : 0.5, max: hl ? 40 : 20, step: 0.5, get: () => I().lineWidth, set: (v) => { M.updateInk(id, { lineWidth: v }); M.setMarkupStyle(hl ? { highlighterWidth: v } : { penWidth: v }); }, fmt: (v) => `${v.toFixed(1)} pt` })));
    return true;
  }
  const t = state.ui.tool;
  if (el0 || t === 'select' || t === 'text') return false;
  const kids = [];
  if (t === 'highlighter') {
    kids.push(colorRow(() => st().highlighterColor, (c) => c && M.setMarkupStyle({ highlighterColor: c })),
      slider({ label: 'Width', min: 4, max: 40, step: 0.5, get: () => st().highlighterWidth, set: (v) => M.setMarkupStyle({ highlighterWidth: v }), fmt: (v) => `${v.toFixed(1)} pt` }));
  } else if (t === 'pen') {
    kids.push(colorRow(() => st().color, (c) => c && M.setMarkupStyle({ color: c })),
      slider({ label: 'Width', min: 0.5, max: 20, step: 0.5, get: () => st().penWidth, set: (v) => M.setMarkupStyle({ penWidth: v }), fmt: (v) => `${v.toFixed(1)} pt` }));
  } else {
    kids.push(h('div', { class: 'cap' }, 'Stroke'), colorRow(() => st().color, (c) => c && M.setMarkupStyle({ color: c })));
    if (t === 'rectangle' || t === 'ellipse') kids.push(h('div', { class: 'cap' }, 'Fill'), colorRow(() => st().fill, (c) => M.setMarkupStyle({ fill: c }), true));
    kids.push(slider({ label: 'Line width', min: 0.5, max: 20, step: 0.5, get: () => st().lineWidth, set: (v) => M.setMarkupStyle({ lineWidth: v }), fmt: (v) => `${v.toFixed(1)} pt` }));
  }
  kids.push(h('p', { class: 'muted', style: { margin: '4px 0' } }, toolInfo(t).freehand
    ? 'Drag on the page to draw. The tool stays active; tap Done (or press Esc / V) to stop.'
    : 'Drag on the page to draw. Turn on Perfect shapes (or hold ⇧) for squares, circles and 45° lines.'));
  body.append(section(`${toolInfo(t).label} Style`, ...kids));
  return true;
}

/** Long-press menu on an element (the Mac's right-click menu). */
function openElementMenu(id) {
  const f = M.findElement(id);
  if (!f) return;
  M.select(id);
  const el = f.el;
  const s = sheet(el.name, h('div', { class: 'sheet-list' },
    sheetItem('duplicate', 'Duplicate', null, () => { s.close(); M.duplicateSelected(); }),
    sheetItem('alTop', 'Bring to Front', null, () => { s.close(); M.reorderSelected('front'); }),
    sheetItem('alBottom', 'Send to Back', null, () => { s.close(); M.reorderSelected('back'); }),
    sheetItem('fit', 'Fit to Page (Keep Proportions)', null, () => { s.close(); M.fitSelectedToPage(false); }),
    sheetItem('fitW', 'Stretch to Fill Page', null, () => { s.close(); M.fitSelectedToPage(true); }),
    el.kind === 'image' ? sheetItem('corners', 'Corner Unwarp…', null, () => { s.close(); openCornerEditor(id); }) : null,
    el.kind === 'image' ? sheetItem('wand', 'Scan Enhance', null, () => { s.close(); M.scanEnhance(id); openPanel('scan'); }) : null,
    el.kind === 'text' ? sheetItem('text', 'Edit Text', null, () => { s.close(); openPanel('edit'); focusText(); }) : null,
    sheetItem('trash', 'Delete', null, () => { s.close(); M.deleteSelected(); }, true)));
}

// ---- Scan panel (Document Scan inspector)

const MODE_INFO = {
  original: 'No document processing — adjustments only.',
  colorScan: 'Evens out shadows and paper yellowing. Levels are set automatically from this photo; logos and photos keep their color.',
  blackWhite: 'Paper goes pure white and ink goes black, judged locally so faint and thin strokes are kept.',
  grayscale: 'Neutral gray scan with even lighting and automatic levels. Shaded form areas keep their tone.',
};

function buildScanPanel(body, title) {
  const el0 = M.selected();
  title.append(h('div', { class: 'sel-name', html: icon('scan') }, h('span', {}, 'Document Scan')));
  if (!el0 || el0.kind !== 'image') {
    body.append(section(null,
      h('p', { class: 'muted' }, 'Select a photo on the page, or scan a new document. Scan Enhance finds the page edges, straightens the paper, cleans up the lighting and fits it to the page.'),
      h('div', { class: 'btn-group' },
        btn(icon('camera') + 'Scan Document', () => pickFiles('camera', true), 'btn primary'),
        btn(icon('photo') + 'From Photos', () => pickFiles('photos', true), 'btn'))));
    return;
  }
  const id = el0.id;
  const cur = () => M.findElement(id)?.el;
  const S = () => ({ ...DEFAULT_SCAN, ...(cur()?.scan || {}) });
  const set = (patch, key) => M.setScan(id, { ...S(), ...patch }, key);

  // Keystone / corners preview
  const cv = h('canvas', { class: 'quad-preview' });
  const asset = assets.get(el0.asset);
  let img = null;
  ensureImageReady(asset).then(() => { img = new Image(); img.onload = draw; img.src = asset.proxyUrl; });
  function draw() {
    const e = cur(); if (!e || !img || !img.complete) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = cv.clientHeight || 150;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const k = Math.min((W - 16) / img.naturalWidth, (H - 16) / img.naturalHeight);
    const iw = img.naturalWidth * k, ih = img.naturalHeight * k, ox = (W - iw) / 2, oy = (H - ih) / 2;
    ctx.drawImage(img, ox, oy, iw, ih);
    const q = e.quad || [[0, 0], [1, 0], [1, 1], [0, 1]];
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ox + x * iw, oy + y * ih));
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,166,35,.15)'; ctx.fill();
    ctx.strokeStyle = '#f5a623'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke();
    ctx.setLineDash([]);
    q.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(ox + x * iw, oy + y * ih, 4.5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); });
  }
  let lastQuad = '';
  refresh(() => { const q = JSON.stringify(cur()?.quad || null); if (q !== lastQuad) { lastQuad = q; draw(); } });
  const resetBtn = btn('Reset', () => M.applyPerspective(id, null), 'btn');
  refresh(() => { resetBtn.hidden = isFullQuad(cur()?.quad); });
  body.append(section('Keystone / Corners', cv,
    h('div', { class: 'btn-group', style: { marginTop: '8px' } },
      btn(icon('wand') + 'Scan Enhance', () => M.scanEnhance(id), 'btn primary'),
      btn(icon('corners') + 'Edit Corners', () => openCornerEditor(id), 'btn'),
      resetBtn)));

  const desc = h('p', { class: 'muted', style: { margin: '8px 0 4px' } });
  refresh(() => { desc.textContent = MODE_INFO[S().mode]; });
  body.append(section('Scan Mode',
    segmented([
      { value: 'original', label: 'Original' }, { value: 'colorScan', label: 'Color' },
      { value: 'blackWhite', label: 'B&W' }, { value: 'grayscale', label: 'Gray' },
    ], () => S().mode, (mode) => M.setScan(id, SCAN_PRESETS[mode], 'mode')),
    desc));

  if (el0.scan?.mode === 'blackWhite') {
    body.append(section('Black & White',
      toggle('Hard threshold (1-bit)', () => S().hardThreshold, (v) => set({ hardThreshold: v }, 'hard')),
      slider({ label: 'Ink', min: 0, max: 1, step: 0.01, neutral: 0.5, get: () => S().inkSensitivity, set: (v) => set({ inkSensitivity: v }, 'sensitivity'), fmt: (v) => `${Math.round(v * 100)}%` }),
      h('p', { class: 'muted', style: { margin: '2px 0 6px' } }, 'Ink sensitivity: raise to keep faint or thin strokes; lower to remove speckles and paper texture.')));
  }

  const resetAll = btn('Reset All Adjustments', () => M.setScan(id, { ...DEFAULT_SCAN, mode: S().mode }, 'reset'), 'btn');
  refresh(() => { const s = S(); resetAll.disabled = M.isIdentitySettings({ ...s, mode: 'original' }); });
  body.append(section('Adjustments',
    slider({ label: 'Exposure', min: -2, max: 2, step: 0.05, neutral: 0, get: () => S().exposure, set: (v) => set({ exposure: v }, 'exposure'), fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV` }),
    slider({ label: 'Contrast', min: 0.5, max: 2, step: 0.01, neutral: 1, get: () => S().contrast, set: (v) => set({ contrast: v }, 'contrast') }),
    slider({ label: 'Saturation', min: 0, max: 2, step: 0.01, neutral: 1, get: () => S().saturation, set: (v) => set({ saturation: v }, 'saturation') }),
    slider({ label: 'Gamma', min: 0.3, max: 3, step: 0.01, neutral: 1, get: () => S().gamma, set: (v) => set({ gamma: v }, 'gamma') }),
    slider({ label: 'Sharpness', min: 0, max: 2, step: 0.01, neutral: 0, get: () => S().sharpness, set: (v) => set({ sharpness: v }, 'sharpness') }),
    row(resetAll)));
}

// ---- Pages panel (thumbnail sidebar + page setup)

const thumbCache = new Map();   // page id → { sig, canvas }
let renderEpoch = 0;

function buildPagesPanel(body, title) {
  title.append(h('div', { class: 'sel-name', html: icon('pages') }, h('span', {}, 'Pages')));
  const strip = h('div', { class: 'thumbs' });
  const pid = () => state.ui.pageId;
  const actions = h('div', { class: 'btn-group', style: { marginBottom: '6px' } },
    btn(icon('pageAdd'), () => M.addPage(pid()), 'btn icon', 'Insert page after current'),
    btn(icon('duplicate'), () => M.duplicatePage(pid()), 'btn icon', 'Duplicate page'),
    btn(icon('rotL'), () => M.rotatePage(pid(), false), 'btn icon', 'Rotate page left'),
    btn(icon('rotR'), () => M.rotatePage(pid(), true), 'btn icon', 'Rotate page right'),
    btn(icon('left'), () => M.movePage(pid(), -1), 'btn icon', 'Move page earlier'),
    btn(icon('right'), () => M.movePage(pid(), 1), 'btn icon', 'Move page later'),
    btn(icon('trash'), () => confirmDialog('Delete this page?', 'Delete', () => M.deletePage(pid()), true), 'btn icon danger', 'Delete page'));
  const p = () => M.currentPage();
  body.append(section(null, strip, actions));
  body.append(section('Page Size', paperChips(),
    row(unitField('W', () => p().w, (v) => M.setPageSize(v, p().h)), unitField('H', () => p().h, (v) => M.setPageSize(p().w, v)))));

  let lastOrder = '';
  refresh((flags) => {
    const order = state.doc.pages.map((q) => q.id).join() + '|' + pid();
    if (order !== lastOrder) { lastOrder = order; rebuildStrip(strip); }
    if (!flags || flags.has('doc') || flags.has('render')) {
      if (flags && flags.has('render')) renderEpoch++;
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => updateThumbs(strip), 250);
    }
  });
}

function rebuildStrip(strip) {
  strip.replaceChildren();
  state.doc.pages.forEach((pg, i) => {
    const th = 104, tw = Math.round(th * pg.w / pg.h);
    let c = thumbCache.get(pg.id)?.canvas;
    if (!c) { c = h('canvas'); thumbCache.set(pg.id, { sig: null, canvas: c }); }
    c.style.width = `${tw}px`; c.style.height = `${th}px`;
    const paper = paperName(pg.w, pg.h).replace(' landscape', '');
    const t = h('button', { class: 'thumb' + (pg.id === state.ui.pageId ? ' on' : ''), 'aria-label': `Page ${i + 1}` },
      c, h('span', {}, String(i + 1)), h('small', {}, paper));
    thumbGestures(t, pg.id, strip);
    strip.append(t);
    if (pg.id === state.ui.pageId) requestAnimationFrame(() => t.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
  });
  updateThumbs(strip);
}

/** Tap = select; long-press = page menu; long-press and drag sideways = reorder. */
function thumbGestures(t, id, strip) {
  let timer = null, start = null, dragging = false, held = false, ghostX = 0;
  t.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    held = false; dragging = false;
    timer = setTimeout(() => { held = true; t.classList.add('lifted'); navigator.vibrate?.(10); }, 380);
  });
  t.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!held) { if (Math.hypot(dx, dy) > 8) { clearTimeout(timer); start = null; } return; }
    if (!dragging && Math.abs(dx) > 6) { dragging = true; try { t.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    if (dragging) { ghostX = dx; t.style.transform = `translateX(${dx}px) scale(1.05)`; e.preventDefault(); }
  });
  const end = (e) => {
    clearTimeout(timer);
    if (!start) return;
    start = null;
    t.classList.remove('lifted');
    t.style.transform = '';
    if (dragging) {
      // Drop position: count thumbnails whose centre is left of the dragged thumb's centre.
      const r = t.getBoundingClientRect(), cx = r.left + r.width / 2 + ghostX;
      const others = [...strip.children].filter((x) => x !== t);
      const index = others.filter((x) => { const b = x.getBoundingClientRect(); return b.left + b.width / 2 < cx; }).length;
      M.movePageTo(id, index);
    } else if (held) {
      openPageMenu(id);
    } else if (e.type === 'pointerup') {
      M.selectPage(id);
    }
    dragging = false; held = false;
  };
  t.addEventListener('pointerup', end);
  t.addEventListener('pointercancel', end);
  t.addEventListener('contextmenu', (e) => e.preventDefault());
}

function openPageMenu(id) {
  const n = state.doc.pages.findIndex((p) => p.id === id) + 1;
  const s = sheet(`Page ${n}`, h('div', { class: 'sheet-list' },
    sheetItem('pageAdd', 'Insert Page After', null, () => { s.close(); M.addPage(id); }),
    sheetItem('duplicate', 'Duplicate Page', null, () => { s.close(); M.duplicatePage(id); }),
    sheetItem('rotL', 'Rotate Left', null, () => { s.close(); M.rotatePage(id, false); }),
    sheetItem('rotR', 'Rotate Right', null, () => { s.close(); M.rotatePage(id, true); }),
    sheetItem('trash', 'Delete Page', null, () => { s.close(); M.deletePage(id); }, true)));
}

let thumbBusy = false;
async function updateThumbs() {
  if (thumbBusy) { clearTimeout(thumbTimer); thumbTimer = setTimeout(updateThumbs, 300); return; }
  thumbBusy = true;
  try {
    for (const pg of state.doc.pages) {
      if (panelName !== 'pages') break;
      const entry = thumbCache.get(pg.id);
      if (!entry) continue;
      const sig = JSON.stringify(pg) + renderEpoch;
      if (entry.sig === sig) continue;
      entry.sig = sig;
      const dpr = window.devicePixelRatio || 1;
      const scale = (104 * dpr) / pg.h;
      const src = await renderPage(pg, scale);
      entry.canvas.width = src.width; entry.canvas.height = src.height;
      entry.canvas.getContext('2d').drawImage(src, 0, 0);
    }
  } finally { thumbBusy = false; }
}

// ------------------------------------------------------------------ Add sheet & file pickers

let pickOpts = {};
export function pickFiles(kind, autoScan = false) {
  pickOpts = { autoScan };
  $({ camera: '#pick-camera', photos: '#pick-photos', files: '#pick-files' }[kind]).click();
}
function initPickers() {
  for (const id of ['#pick-camera', '#pick-photos', '#pick-files']) {
    const input = $(id);
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      await M.importFiles(files, pickOpts);
      if (pickOpts.autoScan && M.selected()?.kind === 'image') openPanel('scan');
    });
  }
}

function openAddSheet() {
  const s = sheet('Add', h('div', { class: 'sheet-list' },
    sheetItem('scan', 'Scan Document', 'Take a photo — edges, perspective and lighting are fixed, and it fits the page', () => { s.close(); pickFiles('camera', true); }),
    sheetItem('camera', 'Take Photo', 'Place a photo as-is', () => { s.close(); pickFiles('camera'); }),
    sheetItem('photo', 'Photo Library', 'Choose one or more photos', () => { s.close(); pickFiles('photos'); }),
    sheetItem('file', 'Files', 'Images or PDF documents (each PDF page becomes a page)', () => { s.close(); pickFiles('files'); }),
    sheetItem('text', 'Text Box', 'Add a line of text', () => { s.close(); M.addText(); openPanel('edit'); focusText(); }),
    sheetItem('markup', 'Markup', 'Shapes, arrows, highlighter and pen', () => { s.close(); openPanel('markup'); }),
    sheetItem('pageAdd', 'New Page', 'Blank page after the current one', () => { s.close(); M.addPage(); })));
}

function focusText() {
  setTimeout(() => { const ta = document.querySelector('#panel-body textarea'); if (ta) { ta.focus(); ta.select(); } }, 80);
}

// ------------------------------------------------------------------ View sheet

function openViewSheet() {
  const mark = (m, pct) => (view.mode === m && (pct == null || view.percent === pct) ? ' ✓' : '');
  const s = sheet(`Zoom · ${zoomPercent()}%`, h('div', { class: 'sheet-list' },
    sheetItem('fitW', 'Fit Width' + mark('fitWidth'), null, () => { s.close(); setZoomMode('fitWidth'); }),
    sheetItem('fit', 'Fit Page' + mark('fitPage'), null, () => { s.close(); setZoomMode('fitPage'); }),
    sheetItem('actual', '100% — Actual Size' + mark('actual'), 'One inch on screen = one real inch', () => { s.close(); setZoomMode('actual'); }),
    h('div', { class: 'btn-group', style: { padding: '6px 10px' } },
      ...[50, 75, 150, 200, 400].map((p) => btn(`${p}%`, () => { s.close(); setZoomMode('percent', p); })),
      btn(icon('zoomOut'), () => { zoomBy(0.8); s.close(); }, 'btn icon', 'Zoom out'),
      btn(icon('zoomIn'), () => { zoomBy(1.25); s.close(); }, 'btn icon', 'Zoom in')),
    sheetItem('ruler', 'Calibrate Actual Size…', 'Match the screen to a real card or ruler', () => { s.close(); openCalibration(); })));
}

function openCalibration() {
  let k = calibration();
  // A phone screen is narrower than a bank card, so the card stands upright (54 × 85.6 mm)
  // and the ruler bar is 50 mm (100 mm on wider screens, like the Mac's).
  const card = h('div', { class: 'calib-card' });
  const bar = h('div', { class: 'calib-bar' });
  const val = h('span', { class: 'val' });
  const stage = h('div', { class: 'calib-stage' }, card, bar);
  const resize = () => {
    const sc = (cssPxPerInch() / 72) * k;
    const room = Math.max(200, Math.min(window.innerWidth, 560) - 48);
    const upright = toPoints(85.6, 'mm') * sc > room;
    card.style.width = `${toPoints(upright ? 53.98 : 85.6, 'mm') * sc}px`;
    card.style.height = `${toPoints(upright ? 85.6 : 53.98, 'mm') * sc}px`;
    const mm = toPoints(100, 'mm') * sc <= room ? 100 : 50;
    const len = toPoints(mm, 'mm') * sc;
    bar.style.width = `${len}px`;
    bar.innerHTML = Array.from({ length: mm / 5 + 1 }, (_, i) => `<i style="left:${(i * len) / (mm / 5)}px;height:${i % 2 ? 9 : 16}px"></i>`).join('') + `<b>${mm} mm</b>`;
    val.textContent = `${k >= 1 ? '+' : ''}${((k - 1) * 100).toFixed(1)}%`;
  };
  const range = h('input', { type: 'range', min: 0.8, max: 1.2, step: 0.001, value: k });
  range.addEventListener('input', () => { k = parseFloat(range.value); resize(); });
  const dpr = window.devicePixelRatio || 1;
  const s = sheet('Calibrate Actual Size', h('div', {},
    h('p', { class: 'muted' }, 'Hold a bank card (or any ID-1 card) against the outline, or a ruler against the bar, and adjust until they match exactly.'),
    stage,
    h('div', { class: 'slider-row' }, h('span', { class: 'lbl' }, 'Correction'), range, val),
    h('p', { class: 'muted small', style: { textAlign: 'center' } }, `${screen.width} × ${screen.height} pt · ${Math.round(cssPxPerInch() * dpr)} px/in · @${dpr}x`),
    h('div', { class: 'sheet-actions' },
      btn('Reset', () => { k = 1; range.value = 1; resize(); }),
      btn('Save', () => { localStorage.setItem('calibration', String(k)); s.close(); setZoomMode('actual'); toast('Saved — 100% now matches real size.'); }, 'btn primary'))));
  resize();
}

// ------------------------------------------------------------------ Menu sheet

function openMenuSheet() {
  let s;
  const [content, sc] = scoped(() => h('div', {},
    h('div', { class: 'sheet-list' },
      sheetItem('doc', 'Rename Document', state.doc.title, () => { s.close(); promptDialog('Document name', state.doc.title, (v) => M.rename(v)); }),
      sheetItem('pageAdd', 'New Document', 'Start over with a blank page', () => {
        s.close();
        confirmDialog('Start a new document? The current one will be cleared — export it first if you need it.', 'New Document', () => M.newDocument(), true);
      }),
      sheetItem('ruler', 'Calibrate Actual Size', 'Make 100% zoom match real paper', () => { s.close(); openCalibration(); }),
      sheetItem('home', 'Install on iPhone', 'Add to Home Screen for a full-screen app that works offline', () => { s.close(); openInstallHelp(); })),
    section('Units', segmented(UNIT_ORDER.map((u) => ({ value: u, label: u })), () => state.ui.unit, (u) => M.setPref('unit', u))),
    section(null,
      toggle('Snap to guides, edges & centers', () => state.ui.snap, (v) => M.setPref('snap', v)),
      toggle('Show guides', () => state.ui.showGuides, (v) => M.setPref('showGuides', v))),
    h('p', { class: 'muted', style: { textAlign: 'center', marginTop: '10px' } },
      `DocPrint Studio for iPhone · v${APP_VERSION} · your work is saved on this device automatically`)));
  s = sheet('DocPrint Studio', content, { refreshScope: sc });
}

function openInstallHelp() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  sheet('Install on iPhone', h('div', {},
    standalone
      ? h('p', {}, 'You are already running DocPrint Studio from your Home Screen. ✓')
      : h('div', {},
        h('p', {}, '1. Open this page in Safari.'),
        h('p', {}, '2. Tap the Share button (square with an arrow).'),
        h('p', {}, '3. Choose “Add to Home Screen”, then “Add”.')),
    h('p', { class: 'muted' }, 'The app then opens full-screen, works offline and keeps your document between launches.')));
}

// ------------------------------------------------------------------ wiring

export function initUI() {
  initChrome();
  initPickers();
  M.hooks.toast = toast;
  M.hooks.alert = alertDialog;
  M.hooks.busy = (on) => { $('#busy').hidden = !on; };
  canvasHooks.editText = (id) => { M.select(id); openPanel('edit'); focusText(); };
  canvasHooks.contextMenu = openElementMenu;
  canvasHooks.changed = (flags) => {
    if (flags.has('pointer') && flags.size === 1) { updateStatus(); return; }
    updateChrome();
    updatePanel(flags);
    sheetScopes.forEach((sc) => sc.forEach((f) => f(flags)));
  };
  updateChrome();
}
