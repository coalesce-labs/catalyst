// board-snapshot.mjs — CTL-733 reactive board snapshot manager.
//
// Computes the board payload ONCE for all connected clients and pushes it over
// SSE, instead of each browser tab polling /api/board on its own 4s timer (which
// re-ran the full assembleBoard() per tab and blocked the event loop). One shared
// snapshot, recomputed reactively (debounced) on:
//   • fs.watch(execution-core/workers/) — phase-signal file changes, and
//   • a periodic poll (the shared `claude agents` cadence),
// and only while at least one SSE client is subscribed (zero host cost when idle).
//
// Emits the FULL snapshot on each recompute (the payload is a few KB and board
// state is derived — a delta protocol is a later optimization, per CTL-733).

import { watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { assembleBoard } from "./board-data.mjs";

const WORKERS_DIR = join(homedir(), "catalyst", "execution-core", "workers");

export function createBoardSnapshotManager({
  debounceMs = 1000,
  pollMs = 3000,
  onDemandTtlMs = 2000,
  assemble = assembleBoard,
  workersDir = WORKERS_DIR,
} = {}) {
  let latest = null;
  let latestTs = 0;
  let computing = null; // in-flight recompute promise (de-dupes concurrent runs)
  let dirty = false;
  let debounceTimer = null;
  let pollTimer = null;
  let watcher = null;
  let reactive = false;
  const subscribers = new Set();

  async function compute() {
    const snap = await assemble();
    latest = snap;
    latestTs = Date.now();
    for (const cb of subscribers) {
      try { cb(snap); } catch { /* a subscriber threw — don't let it kill the loop */ }
    }
    return snap;
  }

  // De-dupe concurrent recomputes; if a trigger lands mid-compute, run once more after.
  function recompute() {
    if (computing) { dirty = true; return computing; }
    computing = compute().finally(() => {
      computing = null;
      if (dirty) { dirty = false; schedule(); }
    });
    return computing;
  }

  function schedule() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; void recompute(); }, debounceMs);
  }

  function startReactive() {
    if (reactive) return;
    reactive = true;
    void recompute(); // immediate refresh for the first subscriber
    try {
      watcher = watch(workersDir, { recursive: true }, () => schedule());
    } catch { /* dir absent or recursive watch unsupported — the poll still drives updates */ }
    pollTimer = setInterval(() => schedule(), pollMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function stopReactive() {
    reactive = false;
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  function subscribe(cb) {
    subscribers.add(cb);
    if (subscribers.size === 1) startReactive();
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0) stopReactive();
    };
  }

  // One-shot read (the /api/board route + the SSE bootstrap). Returns the shared
  // snapshot if the reactive loop keeps it fresh, else recomputes (TTL-bounded so
  // any residual pollers don't each trigger a compute).
  async function getLatest() {
    if (reactive && latest) return latest;
    if (latest && Date.now() - latestTs < onDemandTtlMs) return latest;
    return computing ? computing : recompute();
  }

  return {
    subscribe,
    getLatest,
    stop: stopReactive,
    get subscriberCount() { return subscribers.size; },
  };
}
