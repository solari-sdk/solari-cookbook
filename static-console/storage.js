const DB_NAME = 'solari-static-osint';
const DB_VERSION = 2;
export const STORES = ['cases','events','entities','relationships','evidence','saved_views','source_state','notes','watchlists','layouts','preferences','artifacts'];
let privacyMode = false;
const memory = new Map(STORES.map((name) => [name, new Map()]));

function keyFor(storeName, value) {
  if (value?.id) return value.id;
  if (value?.key) return value.key;
  if (storeName === 'preferences' && value?.name) return value.name;
  throw new Error(`Record for ${storeName} requires id or key.`);
}

export function setPrivacyMode(enabled) { privacyMode = Boolean(enabled); }
export function isPrivacyMode() { return privacyMode; }

export function openDb() {
  if (privacyMode) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'preferences' ? 'key' : 'id' });
      }
      if (db.objectStoreNames.contains('meta')) db.deleteObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putMany(storeName, records) {
  if (!STORES.includes(storeName)) throw new Error(`Unknown store: ${storeName}`);
  if (privacyMode) {
    const store = memory.get(storeName);
    for (const item of records) store.set(keyFor(storeName, item), structuredClone(item));
    return;
  }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const item of records) store.put(item);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getAll(storeName) {
  if (!STORES.includes(storeName)) throw new Error(`Unknown store: ${storeName}`);
  if (privacyMode) return [...memory.get(storeName).values()].map(structuredClone);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function clearStore(storeName) {
  if (privacyMode) { memory.get(storeName).clear(); return; }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function purgeWorkspace() {
  for (const store of memory.values()) store.clear();
  if ('indexedDB' in window) await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  if ('caches' in window) for (const name of await caches.keys()) await caches.delete(name);
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return { supported: false, usage: null, quota: null, percent: null };
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { supported: true, usage, quota, percent: quota ? usage / quota * 100 : 0 };
}
