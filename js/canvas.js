// The editing canvas: page rendering, touch gestures (move / resize / rotate / pan / pinch),
// snapping, rulers and guides, and "100 % = real paper size" zoom.

import * as M from './model.js';
import { state } from './model.js';
import {
  UNITS, UNIT_ORDER, corners, boundingBox, hitTest, snap, resize, rotate, center, HANDLES, fontInfo, normalizedAngle, fmtUnit,
} from './geometry.js';
import { getDisplay } from './imaging.js';
import { pdfPreview } from './pdfsupport.js';

export const view = { s: 1, px: 0, py: 0, mode: 'fitPage', percent: 100 };
export const canvasHooks = { editText: () => {}, changed: () => {} };

let ws, pageEl, overlay, rulerTop, rulerLeft, cornerBtn;
const nodes = new Map();
let op = null;                 // current gesture
const pointers = new Map();
let snapLines = { x: null, y: null };
let lastTap = { time: 0, id: null };
const HIT = 22;                // touch target radius for handles, px

// ------------------------------------------------------------------ real-size zoom

// CSS px per physical inch for common iPhones / iPads (keyed by portrait CSS size and DPR).
const DEVICE_PPI = {
  '320x568@2': 326, '375x667@2': 326, '414x736@3': 401, '375x812@3': 458, '414x896@2': 326,
  '414x896@3': 458, '360x780@3': 476, '390x844@3': 460, '428x926@3': 458, '393x852@3': 460,
  '430x932@3': 460, '402x874@3': 460, '440x956@3': 460, '420x912@3': 460,
  '744x1133@2': 326, '768x1024@2': 264, '810x1080@2': 264, '820x1180@2': 264, '834x1112@2': 264,
  '834x1194@2': 264, '834x1210@2': 264, '1024x1366@2': 264, '1032x1376@2': 264,
};
export function cssPxPerInch() {
  const a = Math.min(screen.width, screen.height), b = Math.max(screen.width, screen.height);
  const dpr = window.devicePixelRatio || 1;
  const ppi = DEVICE_PPI[`${a}x${b}@${dpr}`];
  if (ppi) return ppi / dpr;
  if (/iPhone|iPod/.test(navigator.userAgent)) return 460 / 3;
  if (/iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))) return 132;
  return 96;
}
export const calibration = () => parseFloat(localStorage.getItem('calibration') || '1') || 1;
export const actualScale = () => (cssPxPerInch() / 72) * calibration();
export const zoomPercent = () => Math.round((view.s / actualScale()) * 100);

export function setZoomMode(mode, percent) {
  view.mode = mode;
  if (percent != null) view.percent = percent;
  applyZoomMode();
  render(new Set(['view']));
}

function applyZoomMode() {
  if (!ws) return;
  const W = ws.clientWidth, H = ws.clientHeight, p = M.currentPage(), m = 18;
  if (!W || !H || !p) return;
  let s = view.s;
  if (view.mode === 'fitWidth') s = (W - 2 * m) / p.w;
  else if (view.mode === 'fitPage') s = Math.min((W - 2 * m) / p.w, (H - 2 * m) / p.h);
  else if (view.mode === 'actual') s = actualScale();
  else if (view.mode === 'percent') s = (actualScale() * view.percent) / 100;
  else { clampPan(); return; }
  view.s = Math.max(0.05, s);
  const pw = p.w * view.s, ph = p.h * view.s;
  view.px = pw <= W - 2 * m ? (W - pw) / 2 : m;
  view.py = ph <= H - 2 * m ? (H - ph) / 2 : m;
}

export function zoomBy(factor, cx, cy) {
  if (cx == null) { cx = ws.clientWidth / 2; cy = ws.clientHeight / 2; }
  const ns = Math.min(actualScale() * 16, Math.max(actualScale() * 0.05, view.s * factor));
  const ux = (cx - view.px) / view.s, uy = (cy - view.py) / view.s;
  view.s = ns;
  view.px = cx - ux * ns; view.py = cy - uy * ns;
  view.mode = 'custom';
  clampPan();
  render(new Set(['view']));
}

function clampPan() {
  const p = M.currentPage(), W = ws.clientWidth, H = ws.clientHeight, keep = 60;
  const pw = p.w * view.s, ph = p.h * view.s;
  view.px = Math.min(W - keep, Math.max(keep - pw, view.px));
  view.py = Math.min(H - keep, Math.max(keep - ph, view.py));
}

// ------------------------------------------------------------------ setup

export function initCanvas() {
  ws = document.getElementById('workspace');
  pageEl = document.getElementById('page');
  overlay = document.getElementById('overlay');
  rulerTop = document.getElementById('ruler-top');
  rulerLeft = document.getElementById('ruler-left');
  cornerBtn = document.getElementById('ruler-corner');

  ws.addEventListener('pointerdown', onDown);
  ws.addEventListener('pointermove', onMove);
  ws.addEventListener('pointerup', onUp);
  ws.addEventListener('pointercancel', onUp);
  ws.addEventListener('wheel', onWheel, { passive: false });
  ws.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());

  rulerTop.addEventListener('pointerdown', (e) => startRulerGuide(e, 'h'));
  rulerLeft.addEventListener('pointerdown', (e) => startRulerGuide(e, 'v'));
  for (const r of [rulerTop, rulerLeft]) {
    r.addEventListener('pointermove', onMove);
    r.addEventListener('pointerup', onUp);
    r.addEventListener('pointercancel', onUp);
  }
  cornerBtn.addEventListener('click', () => {
    const i = UNIT_ORDER.indexOf(state.ui.unit);
    M.setPref('unit', UNIT_ORDER[(i + 1) % UNIT_ORDER.length]);
  });

  ws.addEventListener('dragover', (e) => { e.preventDefault(); });
  ws.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) M.importFiles(files, { point: toPage(e.clientX, e.clientY) });
  });

  window.addEventListener('keydown', onKey);
  new ResizeObserver(() => { applyZoomMode(); render(new Set(['view'])); }).observe(ws);
  M.subscribe(render);
  applyZoomMode();
}

function wsPoint(e) {
  const r = ws.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function toPage(clientX, clientY) {
  const r = ws.getBoundingClientRect();
  return [(clientX - r.left - view.px) / view.s, (clientY - r.top - view.py) / view.s];
}
const toScreen = (x, y) => [view.px + x * view.s, view.py + y * view.s];

// ------------------------------------------------------------------ rendering

let lastPageId = null;
export function render(flags) {
  if (!ws) return;
  const page = M.currentPage();
  if (page.id !== lastPageId || flags.has('view') && view.mode !== 'custom') {
    if (page.id !== lastPageId) { lastPageId = page.id; if (view.mode === 'custom') view.mode = 'fitPage'; }
    applyZoomMode();
  }
  const s = view.s;
  pageEl.style.transform = `translate(${view.px}px, ${view.py}px)`;
  pageEl.style.width = `${page.w * s}px`;
  pageEl.style.height = `${page.h * s}px`;

  const alive = new Set();
  page.elements.forEach((el, i) => {
    alive.add(el.id);
    const n = ensureNode(el);
    updateNode(n, el, s);
    if (pageEl.children[i] !== n.root) pageEl.insertBefore(n.root, pageEl.children[i] || null);
  });
  for (const [id, n] of nodes) if (!alive.has(id)) { n.root.remove(); nodes.delete(id); }

  drawOverlay();
  drawRulers();
  cornerBtn.textContent = UNITS[state.ui.unit].symbol;
  canvasHooks.changed(flags);
}

function ensureNode(el) {
  let n = nodes.get(el.id);
  if (n && n.kind === el.kind) return n;
  if (n) n.root.remove();
  const root = document.createElement('div');
  root.className = 'el el-' + el.kind;
  let inner;
  if (el.kind === 'text') {
    inner = document.createElement('div');
    inner.className = 'txt';
  } else {
    inner = document.createElement('img');
    inner.draggable = false;
    inner.alt = '';
  }
  root.appendChild(inner);
  n = { root, inner, kind: el.kind, src: null, key: null };
  nodes.set(el.id, n);
  return n;
}

function updateNode(n, el, s) {
  const st = n.root.style;
  st.left = `${el.x * s}px`; st.top = `${el.y * s}px`;
  st.width = `${el.w * s}px`; st.height = `${el.h * s}px`;
  st.transform = el.rotation ? `rotate(${el.rotation}deg)` : '';
  st.opacity = el.opacity ?? 1;
  if (el.kind === 'text') {
    const f = fontInfo(el.font);
    const key = `${el.text}|${el.font}|${el.size * s}|${el.color}|${el.align}`;
    if (n.key !== key) {
      n.key = key;
      Object.assign(n.inner.style, {
        fontFamily: f.css, fontWeight: f.weight, fontSize: `${el.size * s}px`, color: el.color, textAlign: el.align,
      });
      n.inner.textContent = el.text;
    }
    return;
  }
  let url = null;
  if (el.kind === 'image') { const d = getDisplay(el); url = d && d.url; }
  else url = pdfPreview(el.asset, el.pageIndex);
  n.root.classList.toggle('loading', !url);
  if (url && n.src !== url) { n.src = url; n.inner.src = url; }
}

const svgNS = 'http://www.w3.org/2000/svg';
function drawOverlay() {
  const W = ws.clientWidth, H = ws.clientHeight;
  overlay.setAttribute('width', W); overlay.setAttribute('height', H);
  let h = '';
  if (state.ui.showGuides) {
    for (const g of state.doc.guides) {
      const active = op && op.type === 'guide' && op.id === g.id;
      const cls = 'guide' + (active ? ' active' : '');
      if (g.axis === 'v') { const x = view.px + g.pos * view.s; h += `<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${H}"/>`; }
      else { const y = view.py + g.pos * view.s; h += `<line class="${cls}" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`; }
    }
  }
  if (snapLines.x != null) { const x = view.px + snapLines.x * view.s; h += `<line class="snapline" x1="${x}" y1="0" x2="${x}" y2="${H}"/>`; }
  if (snapLines.y != null) { const y = view.py + snapLines.y * view.s; h += `<line class="snapline" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`; }

  const el = M.selected();
  if (el) {
    const pts = corners(el, el.rotation).map(([x, y]) => toScreen(x, y));
    h += `<polygon class="sel" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
    const hp = handlePoints(el);
    const [tx, ty] = hp.knobBase, [kx, ky] = hp.knob;
    h += `<line class="knobline" x1="${tx}" y1="${ty}" x2="${kx}" y2="${ky}"/>`;
    h += `<circle class="knob" cx="${kx}" cy="${ky}" r="9"/>`;
    for (const [name, [x, y]] of Object.entries(hp.handles)) {
      if (!hp.showEdges && name.length === 1) continue;
      h += name.length === 2
        ? `<circle class="handle" cx="${x}" cy="${y}" r="7.5"/>`
        : `<rect class="handle" x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2"/>`;
    }
    if (op && (op.type === 'move' || op.type === 'resize' || op.type === 'rotate') && op.moved) {
      const label = op.type === 'rotate' ? `${Math.round(el.rotation)}°`
        : `${fmtUnit(el.w, state.ui.unit, false)} × ${fmtUnit(el.h, state.ui.unit)}`;
      const bb = boundingBox(el, el.rotation);
      const [lx, ly] = toScreen(bb.x + bb.w / 2, bb.y + bb.h);
      h += `<g class="badge" transform="translate(${lx},${Math.min(H - 14, ly + 22)})"><rect x="-64" y="-13" width="128" height="24" rx="12"/><text text-anchor="middle" y="4">${label}</text></g>`;
    }
  }
  overlay.innerHTML = h;
}

function handlePoints(el) {
  const [cx, cy] = center(el);
  const handles = {};
  for (const [name, [dx, dy]] of Object.entries(HANDLES)) {
    const [rx, ry] = rotate((dx * el.w) / 2, (dy * el.h) / 2, el.rotation);
    handles[name] = toScreen(cx + rx, cy + ry);
  }
  const [bx, by] = handles.t;
  const [ux, uy] = rotate(0, -1, el.rotation);
  return {
    handles,
    knobBase: [bx, by],
    knob: [bx + ux * 34, by + uy * 34],
    showEdges: el.w * view.s > 56 && el.h * view.s > 56,
  };
}

// ------------------------------------------------------------------ rulers

function niceMajor(pxPerUnit, unit) {
  const c = unit === 'in' ? [1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10, 20, 50, 100] : [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  for (const m of c) if (m * pxPerUnit >= 54) return m;
  return c[c.length - 1];
}
function minorDivs(major, pxPerUnit, unit) {
  const divs = unit === 'in' && major <= 1 ? [16, 8, 4, 2] : [10, 5, 2];
  for (const d of divs) if ((major / d) * pxPerUnit >= 5.5) return d;
  return 1;
}
const fmtLabel = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : String(+v.toFixed(2)));

function drawRulers() {
  const unit = state.ui.unit, ppu = UNITS[unit].ppu, s = view.s;
  const pxPerUnit = ppu * s;
  const major = niceMajor(pxPerUnit, unit), div = minorDivs(major, pxPerUnit, unit);
  const page = M.currentPage();
  const sel = M.selected();
  const bb = sel ? boundingBox(sel, sel.rotation) : null;
  const css = getComputedStyle(document.documentElement);
  const colors = {
    bg: css.getPropertyValue('--ruler-bg').trim(), page: css.getPropertyValue('--ruler-page').trim(),
    tick: css.getPropertyValue('--ruler-tick').trim(), sel: css.getPropertyValue('--ruler-sel').trim(),
  };
  drawRuler(rulerTop, true, view.px, page.w, bb && [bb.x, bb.x + bb.w]);
  drawRuler(rulerLeft, false, view.py, page.h, bb && [bb.y, bb.y + bb.h]);

  function drawRuler(cv, horizontal, origin, extent, selRange) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
    const len = horizontal ? W : H, thick = horizontal ? H : W;
    const a = origin, b = origin + extent * s;
    ctx.fillStyle = colors.page;
    if (horizontal) ctx.fillRect(a, 0, b - a, H); else ctx.fillRect(0, a, W, b - a);
    if (selRange) {
      ctx.fillStyle = colors.sel;
      const s0 = origin + selRange[0] * s, s1 = origin + selRange[1] * s;
      if (horizontal) ctx.fillRect(s0, H - 4, s1 - s0, 4); else ctx.fillRect(W - 4, s0, 4, s1 - s0);
    }
    ctx.strokeStyle = colors.tick; ctx.fillStyle = colors.tick; ctx.lineWidth = 1;
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    const step = major / div;
    const firstU = Math.floor((-origin / s / ppu) / step) * step;
    const lastU = ((len - origin) / s) / ppu;
    ctx.beginPath();
    let k = Math.round(firstU / step);
    for (let u = firstU; u <= lastU + step; u += step, k++) {
      const pos = Math.round(origin + u * ppu * s) + 0.5;
      const isMajor = k % div === 0;
      const isHalf = !isMajor && div % 2 === 0 && k % (div / 2) === 0;
      const tl = isMajor ? thick * 0.55 : isHalf ? thick * 0.35 : thick * 0.2;
      if (horizontal) { ctx.moveTo(pos, H); ctx.lineTo(pos, H - tl); } else { ctx.moveTo(W, pos); ctx.lineTo(W - tl, pos); }
      if (isMajor) {
        const label = fmtLabel(u);
        if (horizontal) ctx.fillText(label, pos + 2, 9);
        else { ctx.save(); ctx.translate(9, pos + 2); ctx.rotate(Math.PI / 2); ctx.fillText(label, 0, 0); ctx.restore(); }
      }
    }
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ gestures

function hitHandle(el, x, y) {
  const hp = handlePoints(el);
  const d = (p) => Math.hypot(p[0] - x, p[1] - y);
  if (d(hp.knob) <= HIT) return { type: 'rotate' };
  let best = null, bd = HIT;
  for (const [name, p] of Object.entries(hp.handles)) {
    if (!hp.showEdges && name.length === 1) continue;
    const dist = d(p) - (name.length === 2 ? 2 : 0);   // corners win ties
    if (dist <= bd) { bd = dist; best = name; }
  }
  return best ? { type: 'resize', handle: best } : null;
}

function hitGuide(x, y) {
  if (!state.ui.showGuides) return null;
  let best = null, bd = 12;
  for (const g of state.doc.guides) {
    const d = g.axis === 'v' ? Math.abs(view.px + g.pos * view.s - x) : Math.abs(view.py + g.pos * view.s - y);
    if (d <= bd) { bd = d; best = g; }
  }
  return best;
}

function hitElement(x, y) {
  const page = M.currentPage();
  const [px, py] = [(x - view.px) / view.s, (y - view.py) / view.s];
  for (let i = page.elements.length - 1; i >= 0; i--) {
    const el = page.elements[i];
    if (hitTest(el, el.rotation, px, py, 4 / view.s)) return el;
  }
  return null;
}

function onDown(e) {
  if (e.button > 0) return;
  ws.setPointerCapture(e.pointerId);
  const [x, y] = wsPoint(e);
  pointers.set(e.pointerId, { x, y });
  if (pointers.size === 2) { cancelOp(); startPinch(); return; }
  if (pointers.size > 2) return;

  const base = { pointerId: e.pointerId, sx: x, sy: y, t: performance.now(), moved: false };
  const sel = M.selected();
  const handle = sel && hitHandle(sel, x, y);
  if (handle) {
    op = { ...base, ...handle, id: sel.id, start: { x: sel.x, y: sel.y, w: sel.w, h: sel.h, rotation: sel.rotation } };
    return;
  }
  const g = hitGuide(x, y);
  const el = hitElement(x, y);
  if (g && !(el && el.id === state.ui.selId)) { op = { ...base, type: 'guide', id: g.id, axis: g.axis }; return; }
  if (el) {
    M.select(el.id);
    op = { ...base, type: 'move', id: el.id, start: { x: el.x, y: el.y } };
    return;
  }
  op = { ...base, type: 'pan', px: view.px, py: view.py };
}

function startRulerGuide(e, axis) {
  if (e.button > 0) return;
  e.currentTarget.setPointerCapture(e.pointerId);
  const [px, py] = toPage(e.clientX, e.clientY);
  const id = M.addGuide(axis, axis === 'v' ? px : py);
  if (!state.ui.showGuides) M.setPref('showGuides', true);
  op = { type: 'guide', id, axis, pointerId: e.pointerId, moved: true, fromRuler: true };
}

function onMove(e) {
  const p = pointers.get(e.pointerId);
  const [x, y] = wsPoint(e);
  if (p) { p.x = x; p.y = y; }
  if (!op) return;
  if (op.type === 'pinch') { pinchMove(); return; }
  if (e.pointerId !== op.pointerId) return;

  if (op.type === 'guide') {
    const [px, py] = toPage(e.clientX, e.clientY);
    let pos = op.axis === 'v' ? px : py;
    const pg = M.currentPage();
    const snapTo = op.axis === 'v' ? [0, pg.w / 2, pg.w] : [0, pg.h / 2, pg.h];
    for (const t of snapTo) if (Math.abs(t - pos) * view.s < 6) pos = t;
    op.moved = true;
    M.moveGuide(op.id, pos);
    return;
  }

  const dxs = x - op.sx, dys = y - op.sy;
  if (!op.moved) {
    if (Math.hypot(dxs, dys) < 5) return;
    op.moved = true;
    if (op.type !== 'pan') M.checkpoint();
  }
  const dx = dxs / view.s, dy = dys / view.s;

  if (op.type === 'pan') {
    view.px = op.px + dxs; view.py = op.py + dys;
    view.mode = 'custom';
    clampPan();
    render(new Set(['view']));
    return;
  }
  const f = M.findElement(op.id);
  if (!f) { op = null; return; }
  const el = f.el;

  if (op.type === 'move') {
    let nx = op.start.x + dx, ny = op.start.y + dy;
    snapLines = { x: null, y: null };
    if (state.ui.snap && !e.metaKey) {
      const t = M.snapTargets(el.id);
      const bb = boundingBox({ x: nx, y: ny, w: el.w, h: el.h }, el.rotation);
      const r = snap(bb, t.xs, t.ys, 8 / view.s);
      nx += r.dx; ny += r.dy;
      snapLines = { x: r.xLine, y: r.yLine };
    }
    el.x = nx; el.y = ny;
  } else if (op.type === 'resize') {
    const locked = el.kind === 'text' ? e.shiftKey : el.aspectLocked !== e.shiftKey;
    Object.assign(el, resize(op.start, op.start.rotation, op.handle, dx, dy, locked));
  } else if (op.type === 'rotate') {
    const [cx, cy] = center(op.start);
    const [px, py] = toPage(e.clientX, e.clientY);
    let deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    else { const near = Math.round(deg / 15) * 15; if (Math.abs(near - deg) < 3.5) deg = near; }
    el.rotation = normalizedAngle(deg);
  }
  M.emit('doc');
}

function onUp(e) {
  pointers.delete(e.pointerId);
  if (!op) return;
  if (op.type === 'pinch') { if (pointers.size < 2) op = null; return; }
  if (e.pointerId !== op.pointerId) return;
  const o = op;
  op = null;
  snapLines = { x: null, y: null };

  if (o.type === 'guide') {
    const g = state.doc.guides.find((q) => q.id === o.id);
    const p = M.currentPage();
    if (g && (g.pos < 0 || g.pos > (g.axis === 'v' ? p.w : p.h))) M.removeGuide(g.id);
    M.emit('doc');
    return;
  }
  if (!o.moved && e.type === 'pointerup') {
    const now = performance.now();
    if (o.type === 'pan') M.select(null);
    if (o.type === 'move') {
      const f = M.findElement(o.id);
      if (f && f.el.kind === 'text' && lastTap.id === o.id && now - lastTap.time < 350) canvasHooks.editText(o.id);
      lastTap = { time: now, id: o.id };
    }
  }
  M.emit('doc');
}

function cancelOp() {
  if (op && op.moved && op.start && (op.type === 'move' || op.type === 'resize' || op.type === 'rotate')) {
    M.updateElement(op.id, (el) => Object.assign(el, op.start));
  }
  snapLines = { x: null, y: null };
  op = null;
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  op = {
    type: 'pinch',
    d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
    m0: [(a.x + b.x) / 2, (a.y + b.y) / 2],
    s0: view.s, px0: view.px, py0: view.py,
  };
}
function pinchMove() {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const m = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  const lo = actualScale() * 0.05, hi = actualScale() * 16;
  const s = Math.min(hi, Math.max(lo, op.s0 * (d / op.d0)));
  const ux = (op.m0[0] - op.px0) / op.s0, uy = (op.m0[1] - op.py0) / op.s0;
  view.s = s;
  view.px = m[0] - ux * s; view.py = m[1] - uy * s;
  view.mode = 'custom';
  clampPan();
  render(new Set(['view']));
}

function onWheel(e) {
  e.preventDefault();
  const [x, y] = wsPoint(e);
  if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), x, y);
  else {
    view.px -= e.deltaX; view.py -= e.deltaY;
    view.mode = 'custom';
    clampPan();
    render(new Set(['view']));
  }
}

function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? M.redo() : M.undo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); M.duplicateSelected(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomBy(0.8); return; }
  if (mod && e.key === '0') { e.preventDefault(); setZoomMode('actual'); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { if (M.selected()) { e.preventDefault(); M.deleteSelected(); } return; }
  if (e.key === 'Escape') { M.select(null); return; }
  const step = UNITS[state.ui.unit].nudge * (e.shiftKey ? 10 : 1);
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d && M.selected()) { e.preventDefault(); M.nudgeSelected(d[0], d[1]); }
}
