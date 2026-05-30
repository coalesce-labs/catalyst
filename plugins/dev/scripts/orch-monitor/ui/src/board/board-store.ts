// board-store.ts — best-effort IndexedDB cache of the last board snapshot
// (CTL-733 PR-2b). Lets a cold tab paint instantly from the previous session
// instead of showing "Connecting to execution-core…" while the live stream
// warms up. EVERY operation is wrapped so a failure (private mode, storage
// disabled, quota, blocked upgrade) degrades to "no cache" — never throws.
//
// Used from two contexts that share the same origin DB: the main thread reads
// (getCached at boot) and the SharedWorker writes (putCached on each frame).
import type { BoardPayload } from "./types";

const DB_NAME = "catalyst-board";
const STORE = "snapshot";
const KEY = "latest";

function openDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Read the cached snapshot, or null if absent/unavailable. Never throws. */
export async function getCached(): Promise<BoardPayload | null> {
  try {
    const db = await openDB();
    if (!db) return null;
    return await new Promise<BoardPayload | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as BoardPayload | undefined) ?? null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Persist the latest snapshot (overwrites). Best-effort; never throws. */
export async function putCached(payload: BoardPayload): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(payload, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // best-effort: caching is an optimization, not a requirement
  }
}
