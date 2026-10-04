// Corner Unwarp editor (port of PerspectiveCorrectionView.swift): four draggable corner
// pins with a magnifying loupe, auto-detect, reset and a live un-warped result.

import * as M from './model.js';
import { assets, ensureImageReady, detectDocument, previewQuad } from './imaging.js';
import { FULL_QUAD, isFullQuad, quadOutputSize } from './geometry.js';

const $ = (s) => document.querySelector(s);
const LOUPE = 124, ZOOM = 3;

export async function openCornerEditor(id) {
  const f = M.findElement(id);
  if (!f || f.el.kind !== 'image') { M.hooks.alert('Select a photo on the page first, then choose Edit Corners.'); return; }
  const asset = assets.get(f.el.asset);
  M.busy(true);
  try { await ensureImageReady(asset); } finally { M.busy(false); }

  let quad = (f.el.quad || FULL_QUAD).map((p) => [...p]);
  let showResult = true;          // the Mac editor always shows the result beside the photo
  let resultGen = 0;

  const root = $('#persp');
  root.innerHTML = `
    <header>
      <button class="btn" data-a="cancel">Cancel</button>
      <h2>Edit Corners</h2>
      <button class="btn primary" data-a="apply">Apply</button>
    </header>
    <div class="stage">
      <img alt="">
      <svg><path class="dim" fill-rule="evenodd"/><polygon class="quad"/></svg>
      <canvas class="loupe" hidden></canvas>
      <img class="result" alt="Un-warped result" hidden>
    </div>
    <div>
      <div class="hint"><span class="readout"></span> · Drag the four corners onto the edges of the paper.</div>
      <footer>
        <button class="btn" data-a="auto">Auto Detect</button>
        <button class="btn" data-a="reset">Reset</button>
        <button class="btn on" data-a="preview">Result</button>
        <button class="btn" data-a="remove">Remove Correction</button>
      </footer>
    </div>`;
  root.hidden = false;

  const stage = root.querySelector('.stage');
  const img = root.querySelector('.stage img');
  const svg = root.querySelector('svg');
  const poly = root.querySelector('.quad');
  const dim = root.querySelector('.dim');
  const readout = root.querySelector('.readout');
  const loupe = root.querySelector('.loupe');
  const result = root.querySelector('.result');
  const circles = quad.map(() => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'corner'); c.setAttribute('r', 15);
    svg.append(c);
    return c;
  });

  img.src = asset.proxyUrl;
  await img.decode().catch(() => {});
  let box = { x: 0, y: 0, w: 1, h: 1 };

  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight, m = 30;
    const k = Math.min((W - 2 * m) / img.naturalWidth, (H - 2 * m) / img.naturalHeight);
    box = { w: img.naturalWidth * k, h: img.naturalHeight * k };
    box.x = (W - box.w) / 2; box.y = (H - box.h) / 2;
    Object.assign(img.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    draw();
  }
  const toScreen = ([x, y]) => [box.x + x * box.w, box.y + y * box.h];

  function draw(active = -1) {
    const pts = quad.map(toScreen);
    poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    // Dim everything outside the quad.
    dim.setAttribute('d', `M${box.x},${box.y}h${box.w}v${box.h}h${-box.w}Z M${pts.map((p) => p.join(',')).join(' L')}Z`);
    const o = quadOutputSize(quad, img.naturalWidth, img.naturalHeight);
    readout.textContent = `Output aspect ${(o.w / Math.max(1e-6, o.h)).toFixed(3)} : 1`;
    circles.forEach((c, i) => {
      c.setAttribute('cx', pts[i][0]); c.setAttribute('cy', pts[i][1]);
      c.classList.toggle('active', i === active);
    });
  }

  function drawLoupe(i, fingerX, fingerY) {
    const dpr = window.devicePixelRatio || 1;
    loupe.width = LOUPE * dpr; loupe.height = LOUPE * dpr;
    const ctx = loupe.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nx = quad[i][0] * img.naturalWidth, ny = quad[i][1] * img.naturalHeight;
    const scale = (box.w / img.naturalWidth) * ZOOM;          // loupe px per image px
    const half = LOUPE / 2 / scale;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, LOUPE, LOUPE);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, nx - half, ny - half, half * 2, half * 2, 0, 0, LOUPE, LOUPE);
    // Quad edges through the loupe.
    const L = ([x, y]) => [(x * img.naturalWidth - (nx - half)) * scale, (y * img.naturalHeight - (ny - half)) * scale];
    ctx.strokeStyle = '#f5a623'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    quad.forEach((p, k) => { const [x, y] = L(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, LOUPE / 2 - 12); ctx.lineTo(LOUPE / 2, LOUPE / 2 + 12);
    ctx.moveTo(LOUPE / 2 - 12, LOUPE / 2); ctx.lineTo(LOUPE / 2 + 12, LOUPE / 2);
    ctx.stroke();
    // Place above the finger, or below when there's no room.
    let lx = fingerX - LOUPE / 2, ly = fingerY - LOUPE - 56;
    if (ly < 4) ly = fingerY + 56;
    lx = Math.max(4, Math.min(stage.clientWidth - LOUPE - 4, lx));
    Object.assign(loupe.style, { left: `${lx}px`, top: `${ly}px`, width: `${LOUPE}px`, height: `${LOUPE}px` });
    loupe.hidden = false;
  }

  async function updateResult() {
    if (!showResult) { result.hidden = true; return; }
    const gen = ++resultGen;
    try {
      const r = await previewQuad(asset.id, quad);
      if (gen !== resultGen || !showResult) return;
      result.src = r.url;
      result.hidden = false;
    } catch (e) { console.warn(e); }
  }

  // Dragging: pins move by the finger's delta, so the finger never hides the corner.
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bd = 48;
    quad.map(toScreen).forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    stage.setPointerCapture(e.pointerId);
    drag = { i: best, x0: x, y0: y, q0: [...quad[best]], id: e.pointerId };
    draw(best);
    drawLoupe(best, x, y);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    quad[drag.i] = [
      Math.min(1, Math.max(0, drag.q0[0] + (x - drag.x0) / box.w)),
      Math.min(1, Math.max(0, drag.q0[1] + (y - drag.y0) / box.h)),
    ];
    draw(drag.i);
    drawLoupe(drag.i, x, y);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    loupe.hidden = true;
    draw();
    updateResult();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  const close = () => { window.removeEventListener('resize', onResize); root.hidden = true; root.innerHTML = ''; };

  root.querySelector('header').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'cancel') close();
    if (a === 'apply') {
      if (!isConvex(quad)) { M.hooks.alert('The corners cross over each other. Place them in order around the page: top-left, top-right, bottom-right, bottom-left.'); return; }
      close();
      await M.applyPerspective(id, quad);
    }
  });
  root.querySelector('footer').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    const a = b?.dataset.a;
    if (a === 'auto') {
      b.textContent = 'Detecting…'; b.disabled = true;
      const q = await detectDocument(asset.id).catch(() => null);
      b.textContent = 'Auto Detect'; b.disabled = false;
      if (q) { quad = q; draw(); updateResult(); } else M.hooks.toast("Couldn't find the page edges automatically.");
    }
    if (a === 'reset') { quad = FULL_QUAD.map((p) => [...p]); draw(); updateResult(); }
    if (a === 'preview') { showResult = !showResult; b.classList.toggle('on', showResult); updateResult(); }
    if (a === 'remove') { close(); await M.applyPerspective(id, null); }
  });

  requestAnimationFrame(() => { layout(); updateResult(); });
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}
