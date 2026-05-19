/**
 * IndexedDB-backed store for ExpeditionOutcome records.
 *
 * Separate from the kv store in indexed_db.ts (DB "ogamex"); this uses
 * DB "ogamex_expeditions" with an object store "expeditions" keyed by
 * expedition_id and three indexes for galaxy/template/returned_at queries.
 */

import type { ExpeditionOutcome } from "@ogamex/shared";

const DB_NAME = "ogamex_expeditions";
const STORE = "expeditions";
const VERSION = 1;

const IDX_BY_GALAXY = "by_galaxy";
const IDX_BY_TEMPLATE = "by_template";
const IDX_BY_RETURNED = "by_returned";

export interface ExpeditionStoreOptions {
  factory?: IDBFactory;
}

function openDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error("IndexedDB not available"));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "expedition_id" });
        store.createIndex(IDX_BY_GALAXY, "target_galaxy", { unique: false });
        store.createIndex(IDX_BY_TEMPLATE, "template_id", { unique: false });
        store.createIndex(IDX_BY_RETURNED, "returned_at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export class ExpeditionStore {
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(opts: ExpeditionStoreOptions = {}) {
    this.dbPromise = openDb(opts.factory);
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.dbPromise;
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

  put(outcome: ExpeditionOutcome): Promise<void> {
    return this.withStore<void>("readwrite", (s) =>
      new Promise<void>((res, rej) => {
        const r = s.put(outcome);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      }),
    );
  }

  /**
   * Returns outcomes where target_galaxy === galaxy and returned_at >= sinceTs.
   * Implemented by opening a cursor on the by_galaxy index keyed exactly to `galaxy`,
   * then filtering by `returned_at`.
   */
  queryByGalaxy(galaxy: number, sinceTs: number): Promise<ExpeditionOutcome[]> {
    return this.queryByIndex(IDX_BY_GALAXY, galaxy, sinceTs);
  }

  queryByTemplate(templateId: string, sinceTs: number): Promise<ExpeditionOutcome[]> {
    return this.queryByIndex(IDX_BY_TEMPLATE, templateId, sinceTs);
  }

  private queryByIndex(
    indexName: string,
    key: IDBValidKey,
    sinceTs: number,
  ): Promise<ExpeditionOutcome[]> {
    return this.withStore<ExpeditionOutcome[]>("readonly", (s) =>
      new Promise<ExpeditionOutcome[]>((res, rej) => {
        const out: ExpeditionOutcome[] = [];
        const idx = s.index(indexName);
        // openCursor accepts a bare IDBValidKey (treated as IDBKeyRange.only),
        // avoiding a hard dep on a globally-available IDBKeyRange (which is
        // missing when callers inject their own IDBFactory in tests).
        const req = idx.openCursor(key);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const value = cursor.value as ExpeditionOutcome;
            if (value.returned_at >= sinceTs) out.push(value);
            cursor.continue();
          } else {
            res(out);
          }
        };
        req.onerror = () => rej(req.error);
      }),
    );
  }

  /**
   * Returns up to n most-recent outcomes by returned_at (DESC).
   * Iterates the by_returned index in reverse.
   */
  recent(n: number): Promise<ExpeditionOutcome[]> {
    return this.withStore<ExpeditionOutcome[]>("readonly", (s) =>
      new Promise<ExpeditionOutcome[]>((res, rej) => {
        if (n <= 0) {
          res([]);
          return;
        }
        const out: ExpeditionOutcome[] = [];
        const idx = s.index(IDX_BY_RETURNED);
        const req = idx.openCursor(null, "prev");
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor && out.length < n) {
            out.push(cursor.value as ExpeditionOutcome);
            cursor.continue();
          } else {
            res(out);
          }
        };
        req.onerror = () => rej(req.error);
      }),
    );
  }

  clear(): Promise<void> {
    return this.withStore<void>("readwrite", (s) =>
      new Promise<void>((res, rej) => {
        const r = s.clear();
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      }),
    );
  }
}
