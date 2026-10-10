// Shared IndexedDB database for all local-first data. Each feature owns its own object stores;
// records are never merged across features (saved analyses and conversations stay separate).

export const DB_NAME = "autodyn";
/** v1: saved analyses (analyses, payloads) · v2: conversations (chats, chatMessages). */
export const DB_VERSION = 2;

export const STORES = {
  analyses: "analyses",
  payloads: "payloads",
  chats: "chats",
  chatMessages: "chatMessages",
} as const;

const opened = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

export function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const cached = opened.get(factory);
  if (cached) return cached;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    // Another tab holding an older version is asked to close (see onversionchange below); give up
    // only if it doesn't within a few seconds.
    const blocked = setTimeout(() => reject(new DOMException("Database upgrade blocked by another tab", "InvalidStateError")), 6000);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORES.analyses)) {
        const s = db.createObjectStore(STORES.analyses, { keyPath: "id" });
        s.createIndex("fingerprint", "fingerprint", { unique: false });
        s.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.payloads)) db.createObjectStore(STORES.payloads, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.chats)) db.createObjectStore(STORES.chats, { keyPath: "id" }).createIndex("updatedAt", "updatedAt", { unique: false });
      if (!db.objectStoreNames.contains(STORES.chatMessages)) db.createObjectStore(STORES.chatMessages, { keyPath: "id" });
    };
    r.onsuccess = () => {
      clearTimeout(blocked);
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        opened.delete(factory);
      };
      resolve(db);
    };
    r.onerror = () => {
      clearTimeout(blocked);
      reject(r.error);
    };
  });
  opened.set(factory, p);
  p.catch(() => opened.delete(factory));
  return p;
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Runs fn inside one transaction over the given stores and resolves after it commits. */
export async function transact<T>(factory: IDBFactory, stores: string[], mode: IDBTransactionMode, fn: (s: Record<string, IDBObjectStore>) => Promise<T> | T): Promise<T> {
  const db = await openDb(factory);
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
    tx.onerror = () => reject(tx.error);
  });
  done.catch(() => undefined); // observed below; avoids an unhandled rejection if fn throws first
  const handles = Object.fromEntries(stores.map((n) => [n, tx.objectStore(n)]));
  const value = await fn(handles);
  await done;
  return value;
}
