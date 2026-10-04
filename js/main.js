// DocPrint Studio for iPhone — entry point.

import { initCanvas } from './canvas.js';
import { initUI } from './ui.js';
import { loadSaved } from './model.js';
import { store } from './store.js';

async function start() {
  initUI();
  initCanvas();
  await loadSaved();
  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  }
}

start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:fixed;inset:auto 16px 40% 16px;padding:16px;background:#fff;color:#000;border-radius:12px;z-index:99">DocPrint Studio couldn't start: ${String(e.message || e)}</p>`);
});
