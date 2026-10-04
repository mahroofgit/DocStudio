// DocPrint Studio for iPhone — entry point.

import { initCanvas } from './canvas.js';
import { initUI } from './ui.js';
import { loadSaved, saveNow } from './model.js';
import { store } from './store.js';

async function start() {
  initUI();
  initCanvas();
  await loadSaved();
  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    // A new version took over: reload once so every file comes from the same release.
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!hadController || reloading) return;
      reloading = true;
      await saveNow();
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      // Check for a new release whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch((e) => console.warn('service worker', e));
  }
}

start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:fixed;inset:auto 16px 40% 16px;padding:16px;background:#fff;color:#000;border-radius:12px;z-index:99">DocPrint Studio couldn't start: ${String(e.message || e)}</p>`);
});
