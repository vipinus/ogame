/**
 * Minimal Promise-based IndexedDB key-value wrapper for OgameX state persistence.
 * Single database "ogamex" with single object-store "kv".
 */

const DB_NAME = "ogamex";
const STORE = "kv";
const VERSION = 1;

function openDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error("IndexedDB not available"));
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export interface IndexedKv {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createIndexedKv(factory?: IDBFactory): IndexedKv {
  const dbPromise = openDb(factory);

  async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await dbPromise;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      Promise.resolve(fn(store)).then((value) => {
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      }, reject);
    });
  }

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return withStore<T | undefined>("readonly", (s) =>
        new Promise<T | undefined>((res, rej) => {
          const r = s.get(key);
          r.onsuccess = () => res(r.result as T | undefined);
          r.onerror = () => rej(r.error);
        }),
      );
    },
    put(key: string, value: unknown): Promise<void> {
      return withStore<void>("readwrite", (s) =>
        new Promise<void>((res, rej) => {
          const r = s.put(value, key);
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        }),
      );
    },
    remove(key: string): Promise<void> {
      return withStore<void>("readwrite", (s) =>
        new Promise<void>((res, rej) => {
          const r = s.delete(key);
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        }),
      );
    },
    clear(): Promise<void> {
      return withStore<void>("readwrite", (s) =>
        new Promise<void>((res, rej) => {
          const r = s.clear();
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        }),
      );
    },
  };
}
