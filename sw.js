// Offline support and updates.
//
// App code (HTML / JS / CSS) is network-first: every launch with a connection gets the newest
// version, and the cached copy is only used offline. Large vendor files and icons never change
// for a given path, so they're cache-first. This works the same whether the site is published
// by the Actions workflow or by GitHub's branch build.
const VERSION = '1.2.1';
const CACHE = `docprint-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/ui.js', 'js/canvas.js', 'js/model.js', 'js/geometry.js', 'js/imaging.js',
  'js/pdfsupport.js', 'js/render.js', 'js/export.js', 'js/exportui.js', 'js/zip.js', 'js/store.js',
  'js/icons.js', 'js/perspective.js', 'js/scan-worker.js', 'js/png.js', 'js/pdfcrypt.js', 'js/ocr.js',
  'js/markup.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
];
const IMMUTABLE = /\/(vendor|icons)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'no-cache' }).then((r) => r.ok && c.put(u, r)).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
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
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (IMMUTABLE.test(url.pathname)) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
