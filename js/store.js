// IndexedDB storage: the document library (one record per document), shared binary assets
// (images, PDFs) and a small key-value store. Safari can evict a background tab at any time,
// so documents are saved continuously.

const DB_NAME = 'docprint-studio';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const s = t.objectStore(storeName);
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
  async del(key) {
    try { await tx('kv', 'readwrite', (s) => { s.delete(key); }); } catch { /* ignore */ }
  },

  // ---- documents
  async putDoc(rec) {
    try { await tx('docs', 'readwrite', (s) => { s.put(rec); }); } catch (e) { console.warn('document save failed', e); throw e; }
  },
  async getDoc(id) {
    try { return await tx('docs', 'readonly', (s) => wrap(s.get(id))); } catch { return undefined; }
  },
  async allDocs() {
    try { return await tx('docs', 'readonly', (s) => wrap(s.getAll())); } catch { return []; }
  },
  async deleteDoc(id) {
    try { await tx('docs', 'readwrite', (s) => { s.delete(id); }); } catch { /* ignore */ }
  },

  // ---- assets
  async putAsset(rec) {
    try { await tx('assets', 'readwrite', (s) => { s.put(rec); }); } catch (e) { console.warn('asset save failed', e); }
  },
  async getAssets(ids) {
    try { return await tx('assets', 'readonly', (s) => Promise.all(ids.map((id) => wrap(s.get(id))))); } catch { return []; }
  },
  async assetIds() {
    try { return await tx('assets', 'readonly', (s) => wrap(s.getAllKeys())); } catch { return []; }
  },
  async deleteAssets(ids) {
    if (!ids.length) return;
    try { await tx('assets', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }); } catch { /* ignore */ }
  },
  async persist() {
    // Ask the browser not to evict our storage (honoured for home-screen apps).
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  },
};
