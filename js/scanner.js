// Camera scanner: live viewfinder with the paper outlined as you aim,
// Single or Batch capture, import from Photos or Files, then the page-by-page review.

import * as M from './model.js';
import { SCAN_PRESETS } from './model.js';
import { importImageFile, detectDocument, detectFrame, forgetAsset } from './imaging.js';
import { store } from './store.js';
import { icon } from './icons.js';
import { confirmDialog, alertDialog } from './ui.js';
import { openReview } from './review.js';

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ scan session

/** A scan session collects captured / imported pages until they're reviewed and placed. */
export function newSession(mode) {
  return { mode, pages: [] };
}

/** Turns a photo file into a session page: stored image + detected corners + Scan Enhance look. */
export async function addCapture(session, file, at = session.pages.length) {
  const asset = await importImageFile(file);
  const page = { asset: asset.id, quad: null, scan: { ...SCAN_PRESETS.colorScan }, rotation: 0, name: asset.name };
  page.ready = detectDocument(asset.id).then((q) => { if (q && !page.userQuad) page.quad = q; }).catch(() => {});
  session.pages.splice(at, 0, page);
  return page;
}

/** Throws away a session's images (cancel). */
export function discardSession(session) {
  const ids = session.pages.map((p) => p.asset);
  ids.forEach(forgetAsset);
  store.deleteAssets(ids);
  session.pages = [];
}

/** Starts a scan: camera first. mode 'new' = new document, 'append' = add to the open one. */
export function startScan({ mode }) {
  const session = newSession(mode);
  openCamera(session, { onDone: () => openReview(session), onCancel: () => discardSession(session) });
}

/** Photos / files chosen outside the camera go straight to the review. */
export async function importToReview(files, { mode, session = null }) {
  const s = session || newSession(mode);
  M.busy(true);
  try {
    for (const f of files) {
      try { await addCapture(s, f); }
      catch { alertDialog(`“${f.name || 'That file'}” isn't an image DocPrint Studio can open.`); }
    }
  } finally { M.busy(false); }
  if (s.pages.length) openReview(s);
}

// ------------------------------------------------------------------ camera screen

const LS_BATCH = 'scan.batch', LS_GRID = 'scan.grid';

/**
 * Opens the camera for a session.
 * opts.single forces one capture (retake); opts.onDone / opts.onCancel are called on close.
 */
export function openCamera(session, opts = {}) {
  let batch = opts.single ? false : localStorage.getItem(LS_BATCH) === '1';
  let grid = localStorage.getItem(LS_GRID) !== '0';
  let stream = null, track = null, torch = false, closed = false, busy = false;
  let liveQuad = null, shown = null, misses = 0, lastDetect = 0, detecting = false;
  const startCount = session.pages.length;
  const captured = [];      // pages captured in this camera visit (for undo / count)

  // A fresh element each time, so listeners from an earlier session can't fire again.
  const prev = $('#scanner');
  const root = prev.cloneNode(false);
  prev.replaceWith(root);
  root.innerHTML = `
    <header>
      <button class="cam-btn" data-a="close" aria-label="Close">${icon('close')}</button>
      <span class="grow"></span>
      <button class="cam-btn" data-a="torch" aria-label="Flash" hidden>${icon('flash')}</button>
      <button class="cam-btn" data-a="grid" aria-label="Grid">${icon('grid')}</button>
    </header>
    <div class="viewfinder">
      <video playsinline muted autoplay></video>
      <canvas class="vf-overlay"></canvas>
      <div class="vf-flash"></div>
      <div class="vf-msg" hidden></div>
      <div class="mode-seg" ${opts.single ? 'hidden' : ''}>
        <button data-mode="single">Single</button><button data-mode="batch">Batch</button>
      </div>
    </div>
    <div class="cam-label">${opts.single ? 'Retake' : 'Scan'}</div>
    <footer>
      <div class="cam-left"></div>
      <button class="shutter" aria-label="Take photo"><span></span></button>
      <div class="cam-right"></div>
    </footer>
    <input type="file" class="pick-photos" accept="image/*" ${opts.single ? '' : 'multiple'} hidden>
    <input type="file" class="pick-files" accept="image/*,.heic,.heif,.jpg,.jpeg,.png,.tif,.tiff" ${opts.single ? '' : 'multiple'} hidden>
    <input type="file" class="pick-camera" accept="image/*" capture="environment" hidden>`;
  root.hidden = false;
  document.body.classList.add('modal-open');

  const video = root.querySelector('video');
  const overlay = root.querySelector('.vf-overlay');
  const msg = root.querySelector('.vf-msg');
  const vf = root.querySelector('.viewfinder');
  const left = root.querySelector('.cam-left'), right = root.querySelector('.cam-right');

  // ---- camera
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fallback('This browser can’t show a live camera here.'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } },
      });
      if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      root.querySelector('[data-a=torch]').hidden = !caps.torch;
      requestAnimationFrame(loop);
    } catch (e) {
      fallback(e && e.name === 'NotAllowedError'
        ? 'Camera access is off. Allow it in Settings → Safari → Camera (or for the Home Screen app), or use the iPhone camera below.'
        : 'The camera isn’t available right now.');
    }
  }
  function fallback(text) {
    msg.hidden = false;
    msg.innerHTML = `<p>${text}</p><div class="vf-msg-actions">
      <button class="btn primary" data-a="native">${icon('camera')}Use iPhone Camera</button>
      <button class="btn" data-a="photos">${icon('photo')}Photos</button></div>`;
  }
  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null;
  }

  // ---- live paper outline
  const small = document.createElement('canvas');
  async function loop(t) {
    if (closed) return;
    requestAnimationFrame(loop);
    if (!detecting && video.videoWidth && t - lastDetect > 220) {
      lastDetect = t; detecting = true;
      const k = 300 / Math.max(video.videoWidth, video.videoHeight);
      small.width = Math.round(video.videoWidth * k); small.height = Math.round(video.videoHeight * k);
      const ctx = small.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, small.width, small.height);
      detectFrame(ctx.getImageData(0, 0, small.width, small.height))
        .then((q) => { liveQuad = q; misses = q ? 0 : misses + 1; })
        .catch(() => {})
        .finally(() => { detecting = false; });
    }
    drawOverlay();
  }

  function videoRect() {
    // The video is shown with object-fit: cover; map video coordinates into the element.
    const W = vf.clientWidth, H = vf.clientHeight, vw = video.videoWidth || 4, vh = video.videoHeight || 3;
    const s = Math.max(W / vw, H / vh);
    return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s, W, H };
  }

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const r = videoRect();
    if (overlay.width !== Math.round(r.W * dpr) || overlay.height !== Math.round(r.H * dpr)) {
      overlay.width = Math.round(r.W * dpr); overlay.height = Math.round(r.H * dpr);
    }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.W, r.H);
    if (grid) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo((r.W * i) / 3, 0); ctx.lineTo((r.W * i) / 3, r.H);
        ctx.moveTo(0, (r.H * i) / 3); ctx.lineTo(r.W, (r.H * i) / 3);
      }
      ctx.stroke();
    }
    // Ease the outline toward the latest detection so it doesn't jitter.
    if (liveQuad) {
      const target = liveQuad.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]);
      shown = shown ? shown.map((p, i) => [p[0] + (target[i][0] - p[0]) * 0.35, p[1] + (target[i][1] - p[1]) * 0.35]) : target;
    } else if (misses > 2) shown = null;
    if (shown) {
      ctx.beginPath();
      shown.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(108,192,255,.2)'; ctx.fill();
      ctx.strokeStyle = '#6cc0ff'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
    }
  }

  // ---- capture
  async function shoot() {
    if (busy || !video.videoWidth) return;
    busy = true;
    vf.classList.remove('flash'); void vf.offsetWidth; vf.classList.add('flash');
    navigator.vibrate?.(8);
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      c.width = c.height = 0;
      const d = new Date();
      const file = new File([blob], `Scan ${d.toTimeString().slice(0, 8).replace(/:/g, '.')}.jpg`, { type: 'image/jpeg' });
      await take(file);
    } catch (e) { console.error(e); alertDialog('Couldn’t take the photo.'); }
    busy = false;
  }

  async function take(file) {
    const at = opts.single && opts.replaceAt != null ? opts.replaceAt : session.pages.length;
    const page = await addCapture(session, file, at);
    captured.push(page);
    if (page.thumbUrl == null) page.thumbUrl = URL.createObjectURL(file);
    if (opts.single || !batch) { finish(); return; }
    renderControls();
  }

  async function takeFiles(files) {
    if (!files.length) return;
    M.busy(true);
    try {
      for (const f of files) {
        try { await take(f); } catch { alertDialog(`“${f.name || 'That file'}” isn't an image DocPrint Studio can open.`); }
        if (closed) break;
      }
    } finally { M.busy(false); }
    // Several imported photos always go to the review together.
    if (!closed && files.length > 1) finish();
  }

  function undoLast() {
    const p = captured.pop();
    if (!p) return;
    const i = session.pages.indexOf(p);
    if (i >= 0) session.pages.splice(i, 1);
    forgetAsset(p.asset); store.deleteAssets([p.asset]);
    renderControls();
  }

  function close() {
    closed = true;
    stopCamera();
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('modal-open');
  }
  function finish() { close(); opts.onDone && opts.onDone(); }
  function cancel() {
    const fresh = session.pages.length - startCount;
    if (fresh > 0 && !opts.single) {
      confirmDialog(`Discard ${fresh} scanned page${fresh === 1 ? '' : 's'}?`, 'Discard', () => {
        captured.forEach((p) => { const i = session.pages.indexOf(p); if (i >= 0) session.pages.splice(i, 1); forgetAsset(p.asset); store.deleteAssets([p.asset]); });
        close(); (opts.onCancel || (() => {}))();
      }, true);
      return;
    }
    close();
    (opts.onCancel || (() => {}))();
  }

  // ---- controls
  function renderControls() {
    root.querySelectorAll('.mode-seg button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'batch') === batch));
    root.querySelector('[data-a=grid]').classList.toggle('on', grid);
    const n = captured.length;
    if (batch && n) {
      const last = captured[n - 1];
      left.innerHTML = `<button class="cam-btn" data-a="undo" aria-label="Undo last">${icon('undo')}</button>`;
      right.innerHTML = `<button class="stack" data-a="done" aria-label="Review ${n} pages"><img src="${last.thumbUrl}" alt=""><b>${n}</b></button>
        <button class="btn primary done" data-a="done">Done</button>`;
    } else {
      left.innerHTML = `<button class="cam-btn" data-a="files" aria-label="Import from Files">${icon('file')}<small>Files</small></button>`;
      right.innerHTML = `<button class="cam-btn" data-a="photos" aria-label="Import from Photos">${icon('photo')}<small>Photos</small></button>`;
    }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a],[data-mode]');
    if (!b) return;
    if (b.dataset.mode) { batch = b.dataset.mode === 'batch'; localStorage.setItem(LS_BATCH, batch ? '1' : '0'); renderControls(); return; }
    const a = b.dataset.a;
    if (a === 'close') cancel();
    if (a === 'grid') { grid = !grid; localStorage.setItem(LS_GRID, grid ? '1' : '0'); renderControls(); }
    if (a === 'torch' && track) { torch = !torch; track.applyConstraints({ advanced: [{ torch }] }).catch(() => {}); b.classList.toggle('on', torch); }
    if (a === 'undo') undoLast();
    if (a === 'done') finish();
    if (a === 'photos') root.querySelector('.pick-photos').click();
    if (a === 'files') root.querySelector('.pick-files').click();
    if (a === 'native') root.querySelector('.pick-camera').click();
  });
  root.querySelector('.shutter').addEventListener('click', () => (stream ? shoot() : root.querySelector('.pick-camera').click()));
  for (const sel of ['.pick-photos', '.pick-files', '.pick-camera']) {
    root.querySelector(sel).addEventListener('change', (e) => {
      const files = [...e.target.files]; e.target.value = '';
      takeFiles(files);
    });
  }

  renderControls();
  startCamera();
}
