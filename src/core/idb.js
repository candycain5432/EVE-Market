// Minimal IndexedDB key/value store with TTL. Falls back to an in-memory map
// when IndexedDB is unavailable (private windows, exotic browsers).

const DB_NAME = 'capsuleer-market';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;
const memory = new Map();
let useMemory = false;

function openDb() {
  if (useMemory) return Promise.reject(new Error('idb unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      useMemory = true;
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { useMemory = true; reject(req.error); };
    req.onblocked = () => { useMemory = true; reject(new Error('idb blocked')); };
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let req;
    try { req = fn(store); } catch (err) { reject(err); return; }

    // Read the value off the request itself: a miss leaves `result` undefined,
    // and returning the request object instead would look like a cache hit.
    let value;
    if (req && typeof req.addEventListener === 'function') {
      req.onsuccess = () => { value = req.result; };
    }
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('idb aborted'));
  }));
}

/** Store `value` under `key`. `ttlMs` of 0/undefined means "never expires". */
export async function idbSet(key, value, ttlMs = 0) {
  const record = { v: value, t: Date.now(), e: ttlMs ? Date.now() + ttlMs : 0 };
  try {
    await tx('readwrite', (s) => s.put(record, key));
  } catch {
    memory.set(key, record);
  }
}

/** Returns `{ value, storedAt }` or null when missing/expired. */
export async function idbGet(key) {
  let record;
  try {
    record = await tx('readonly', (s) => s.get(key));
  } catch {
    record = memory.get(key);
  }
  if (!record) return null;
  if (record.e && Date.now() > record.e) {
    idbDel(key).catch(() => {});
    return null;
  }
  return { value: record.v, storedAt: record.t };
}

export async function idbDel(key) {
  try {
    await tx('readwrite', (s) => s.delete(key));
  } catch {
    memory.delete(key);
  }
}

/** Delete every key that starts with `prefix` (or everything when omitted). */
export async function idbClear(prefix = '') {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    const doomed = (keys || []).filter((k) => String(k).startsWith(prefix));
    await tx('readwrite', (s) => { doomed.forEach((k) => s.delete(k)); });
  } catch {
    for (const k of [...memory.keys()]) if (String(k).startsWith(prefix)) memory.delete(k);
  }
}

/** Rough footprint report for the settings page. */
export async function idbStats() {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    let estimate = null;
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      estimate = e.usage || null;
    }
    return { keys: (keys || []).length, bytes: estimate, backend: 'indexeddb' };
  } catch {
    return { keys: memory.size, bytes: null, backend: 'memory' };
  }
}
