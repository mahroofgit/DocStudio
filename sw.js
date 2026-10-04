// Offline support: the app shell is cached on install; PDF libraries, fonts and cmaps are
// cached the first time they're used. The deploy workflow stamps BUILD with the commit SHA,
// so every release gets a fresh cache.
const BUILD = '__BUILD__';
const CACHE = `docprint-${BUILD}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js', 'js/ui.js', 'js/canvas.js', 'js/model.js', 'js/geometry.js', 'js/imaging.js',
  'js/pdfsupport.js', 'js/render.js', 'js/export.js', 'js/zip.js', 'js/store.js', 'js/icons.js',
  'js/perspective.js', 'js/scan-worker.js', 'js/exportui.js', 'js/png.js', 'js/pdfcrypt.js', 'js/ocr.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('docprint-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
