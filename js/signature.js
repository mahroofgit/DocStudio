// Signatures: draw one with your finger or type your name in a handwriting font, then place it
// on the page. Saved signatures live on this device and can be reused in any document.
// Signatures are vectors (unit-box geometry, see markup.js) so they stay sharp in every export.

import { store } from './store.js';
import { h, toast } from './ui.js';
import { loadScript } from './pdfsupport.js';
import { drawList, svgPath, smoothPath } from './markup.js';

export const SIG_COLORS = ['#000000', '#1a3fb0', '#0b6e4f', '#b3261e'];
export const SIG_FONTS = [
  { id: 'great-vibes', label: 'Great Vibes', size: 1 },
  { id: 'dancing-script', label: 'Dancing Script', size: 0.9 },
  { id: 'homemade-apple', label: 'Homemade Apple', size: 0.7 },
  { id: 'mr-dafoe', label: 'Mr Dafoe', size: 1 },
];
const KEY = 'signatures';
const MAX_SAVED = 8;
const fontUrl = (id) => `vendor/fonts/${id}.woff`;

// ------------------------------------------------------------------ saved signatures

let saved = null;
const listeners = new Set();
export function onSavedChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export async function savedSignatures() {
  if (!saved) saved = (await store.get(KEY)) || [];
  return saved;
}
export async function saveSignature(rec) {
  const all = await savedSignatures();
  all.unshift(rec);
  saved = all.slice(0, MAX_SAVED);
  await store.set(KEY, saved);
  listeners.forEach((f) => f());
}
export async function deleteSignature(id) {
  saved = (await savedSignatures()).filter((r) => r.id !== id);
  await store.set(KEY, saved);
  listeners.forEach((f) => f());
}

/** Small SVG preview of a signature record. */
export function signatureSVG(rec, height = 34) {
  const hgt = height, w = hgt * rec.aspect;
  const body = drawList({ kind: 'signature', sig: rec.sig }, w, hgt).map((op) => (op.stroke
    ? `<path d="${svgPath(op.path)}" fill="none" stroke="${op.stroke}" stroke-width="${op.width}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${svgPath(op.path)}" fill="${op.fill}"/>`)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${hgt}" viewBox="0 0 ${w.toFixed(1)} ${hgt}" style="overflow:visible">${body}</svg>`;
}

// ------------------------------------------------------------------ geometry builders

/** Finger strokes (pad pixels) → unit-box signature. */
export function fromStrokes(strokes, lineWidth, color) {
  const pts = strokes.flat();
  const pad = lineWidth / 2 + 1;
  const x0 = Math.min(...pts.map((p) => p[0])) - pad, x1 = Math.max(...pts.map((p) => p[0])) + pad;
  const y0 = Math.min(...pts.map((p) => p[1])) - pad, y1 = Math.max(...pts.map((p) => p[1])) + pad;
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
  return {
    aspect: W / H,
    sig: { color, width: lineWidth / H, strokes: strokes.map((s) => s.map(([x, y]) => [round4((x - x0) / W), round4((y - y0) / H)])) },
  };
}
const round4 = (v) => Math.round(v * 10000) / 10000;

let otPromise = null;
const fontCache = new Map();
async function otFont(id) {
  if (!otPromise) otPromise = loadScript('vendor/opentype.min.js').then(() => window.opentype);
  const ot = await otPromise;
  if (!fontCache.has(id)) {
    fontCache.set(id, fetch(fontUrl(id)).then((r) => r.arrayBuffer()).then((b) => ot.parse(b)));
  }
  return fontCache.get(id);
}

/** Typed name → unit-box signature from the font's glyph outlines. */
export async function fromText(text, fontId, color) {
  const font = await otFont(fontId);
  const path = font.getPath(text, 0, 0, 100);
  const bb = path.getBoundingBox();
  const pad = 2;
  const x0 = bb.x1 - pad, y0 = bb.y1 - pad, W = Math.max(1, bb.x2 - bb.x1 + 2 * pad), H = Math.max(1, bb.y2 - bb.y1 + 2 * pad);
  const nx = (x) => round4((x - x0) / W), ny = (y) => round4((y - y0) / H);
  const cmds = path.commands.map((c) => {
    if (c.type === 'M' || c.type === 'L') return [c.type, nx(c.x), ny(c.y)];
    if (c.type === 'Q') return ['Q', nx(c.x1), ny(c.y1), nx(c.x), ny(c.y)];
    if (c.type === 'C') return ['C', nx(c.x1), ny(c.y1), nx(c.x2), ny(c.y2), nx(c.x), ny(c.y)];
    return ['Z'];
  });
  return { aspect: W / H, sig: { color, paths: [cmds] } };
}

/** CSS font faces for the Type tab previews. */
let facesLoaded = false;
function loadFaces() {
  if (facesLoaded || !window.FontFace) return;
  facesLoaded = true;
  for (const f of SIG_FONTS) {
    const face = new FontFace(`sig-${f.id}`, `url(${fontUrl(f.id)})`);
    face.load().then((ff) => document.fonts.add(ff)).catch(() => {});
  }
}

// ------------------------------------------------------------------ create screen

/**
 * Opens the signature pad. Resolves with { id, aspect, sig } (also saved when "Save" is on),
 * or null when cancelled.
 */
export function createSignature() {
  return new Promise((resolve) => {
    loadFaces();
    let mode = localStorage.getItem('sigMode') || 'draw';
    let color = localStorage.getItem('sigColor') || SIG_COLORS[0];
    let fontId = localStorage.getItem('sigFont') || SIG_FONTS[0].id;
    let keep = localStorage.getItem('sigKeep') !== '0';
    const strokes = [];
    let current = null;

    const root = h('div', { id: 'sigpad', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New Signature' });
    const finish = (value) => { window.removeEventListener('resize', sizePad); root.remove(); document.body.classList.remove('modal-open'); resolve(value); };

    // ---- draw
    const pad = h('canvas', { class: 'sig-canvas' });
    const hint = h('div', { class: 'sig-hint' }, 'Sign here');
    const padWrap = h('div', { class: 'sig-pad' }, pad, h('div', { class: 'sig-line' }, h('span', {}, '×')), hint);
    let dpr = 1, lw = 3;
    function sizePad() {
      const r = padWrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
      lw = Math.max(2.4, Math.min(4, r.width / 140));
      redraw();
    }
    function redraw() {
      const ctx = pad.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, pad.width, pad.height);
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of [...strokes, ...(current ? [current] : [])]) {
        const cmds = smoothPath(s);
        ctx.beginPath();
        for (const c of cmds) {
          if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
          else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
          else ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]);
        }
        ctx.stroke();
      }
      hint.hidden = strokes.length > 0 || !!current;
      updateButtons();
    }
    const pt = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    pad.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      pad.setPointerCapture(e.pointerId);
      current = [pt(e)]; redraw();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!current) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const p = pt(ev), l = current[current.length - 1];
        if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 1.2) current.push(p);
      }
      redraw();
    });
    const endStroke = () => {
      if (!current) return;
      if (current.length === 1) current.push([current[0][0] + 0.6, current[0][1]]);
      strokes.push(current); current = null; redraw();
    };
    pad.addEventListener('pointerup', endStroke);
    pad.addEventListener('pointercancel', endStroke);

    const undoBtn = h('button', { class: 'btn', onclick: () => { strokes.pop(); redraw(); } }, 'Undo');
    const clearBtn = h('button', { class: 'btn', onclick: () => { strokes.length = 0; redraw(); } }, 'Clear');
    const drawBox = h('div', { class: 'sig-draw' }, padWrap, h('div', { class: 'row sig-tools' }, colorChips(), h('span', { class: 'grow' }), undoBtn, clearBtn));

    // ---- type
    const nameInput = h('input', { class: 'text-input', type: 'text', placeholder: 'Type your name', autocomplete: 'name', enterkeyhint: 'done', value: localStorage.getItem('sigName') || '' });
    const fontList = h('div', { class: 'sig-fonts' });
    function renderFonts() {
      const txt = nameInput.value.trim() || 'Your Name';
      fontList.replaceChildren(...SIG_FONTS.map((f) => h('button', {
        class: 'sig-font' + (f.id === fontId ? ' on' : ''), 'aria-label': f.label,
        style: { fontFamily: `'sig-${f.id}', cursive`, color, fontSize: `${Math.round(34 * f.size)}px` },
        onclick: () => { fontId = f.id; renderFonts(); },
      }, txt)));
      updateButtons();
    }
    nameInput.addEventListener('input', renderFonts);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    const typeBox = h('div', { class: 'sig-type' }, nameInput, h('div', { class: 'row sig-tools' }, colorChips()), fontList);

    function colorChips() {
      const wrap = h('div', { class: 'sig-colors' });
      SIG_COLORS.forEach((c) => wrap.append(h('button', {
        class: 'swatch', 'data-c': c, 'aria-label': `Colour ${c}`, style: { background: c },
        onclick: () => { color = c; localStorage.setItem('sigColor', c); syncColors(); redraw(); renderFonts(); },
      })));
      return wrap;
    }
    function syncColors() { root.querySelectorAll('.sig-colors .swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === color)); }

    // ---- chrome
    const segBtns = [['draw', 'Draw'], ['type', 'Type']].map(([v, l]) => h('button', { onclick: () => { mode = v; localStorage.setItem('sigMode', v); show(); } }, l));
    const keepInput = h('input', { type: 'checkbox', role: 'switch' });
    keepInput.checked = keep;
    keepInput.addEventListener('change', () => { keep = keepInput.checked; localStorage.setItem('sigKeep', keep ? '1' : '0'); });
    const doneBtn = h('button', { class: 'btn primary', onclick: done }, 'Done');
    root.append(
      h('header', {},
        h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'),
        h('h2', {}, 'New Signature'),
        doneBtn),
      h('div', { class: 'sig-body' },
        h('div', { class: 'seg' }, ...segBtns),
        drawBox, typeBox,
        h('label', { class: 'switch' }, h('span', {}, 'Save for reuse in other documents'), keepInput)));
    document.body.append(root);
    document.body.classList.add('modal-open');

    function updateButtons() {
      const ok = mode === 'draw' ? strokes.length > 0 : !!nameInput.value.trim();
      doneBtn.disabled = !ok || null;
      undoBtn.disabled = !strokes.length || null;
      clearBtn.disabled = !strokes.length || null;
    }
    function show() {
      segBtns.forEach((b, i) => b.classList.toggle('on', (i === 0) === (mode === 'draw')));
      drawBox.hidden = mode !== 'draw'; typeBox.hidden = mode !== 'type';
      if (mode === 'draw') sizePad(); else renderFonts();
      syncColors();
      updateButtons();
    }
    async function done() {
      doneBtn.disabled = true;
      try {
        let made;
        if (mode === 'draw') made = fromStrokes(strokes, lw, color);
        else {
          const text = nameInput.value.trim();
          localStorage.setItem('sigName', text);
          localStorage.setItem('sigFont', fontId);
          made = await fromText(text, fontId, color);
        }
        const rec = { id: `sig-${Date.now().toString(36)}`, created: Date.now(), ...made };
        if (keep) await saveSignature(rec);
        finish(rec);
      } catch (e) {
        console.error(e);
        toast(`Couldn’t make the signature: ${e.message || e}`);
        updateButtons();
      }
    }
    window.addEventListener('resize', sizePad);
    requestAnimationFrame(show);
  });
}

