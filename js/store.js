// IndexedDB autosave: the document (JSON) and its binary assets (images, PDFs).
// Safari can evict a background tab at any time, so everything is saved continuously.

const DB_NAME = 'docprint-studio';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const store = {
  async get(key) {
    try { return await tx('kv', 'readonly', (s) => wrap(s.get(key))); } catch { return undefined; }
  },
  async set(key, value) {
    try { await tx('kv', 'readwrite', (s) => { s.put(value, key); }); } catch (e) { console.warn('save failed', e); }
  },
  async putAsset(rec) {
    try { await tx('assets', 'readwrite', (s) => { s.put(rec); }); } catch (e) { console.warn('asset save failed', e); }
  },
  async allAssets() {
    try { return await tx('assets', 'readonly', (s) => wrap(s.getAll())); } catch { return []; }
  },
  async deleteAssets(ids) {
    if (!ids.length) return;
    try { await tx('assets', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }); } catch { /* ignore */ }
  },
  async clearAssets() {
    try { await tx('assets', 'readwrite', (s) => { s.clear(); }); } catch { /* ignore */ }
  },
  async persist() {
    // Ask the browser not to evict our storage (honoured for home-screen apps).
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  },
};
