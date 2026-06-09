// read-model.mjs — the single cache-backed read-model core (CTL-883).
//
// Generalizes the proven board-snapshot push model (CTL-733
// createBoardSnapshotManager: compute-once, debounced reactive recompute,
// subscriber fan-out, subscriber-gated zero-idle-cost) from BOARD-ONLY into a
// multi-entity read-model that assembles tickets/workers/queue/run-records once
// and fans the result out to EVERY client (web tab + iPad + terminal HUD + the
// team channel) over a single SSE push — adding a client never multiplies the
// assemble cost.
//
// It reads EXCLUSIVELY from durable caches (filter-state.db via the broker, the
// PR cache, catalyst.db, the on-disk phase signals, the unified event log) and
// NEVER does a synchronous pass-through to Linear or GitHub per request — the
// live `linearis issues list` bypass is gone (see board-data.mjs::linearInfo →
// linear-cache-reader.mjs). The Linear circuit breaker is honored by
// construction: enrichment spawns nothing, so an open breaker just means the
// last cached value is served, never a block.
//
// CLEAN INTERFACE / PROCESS-SPLIT-READY: the model is a plain object with a
// small, transport-agnostic surface — `getSnapshot()`, `getEntity(name)`,
// `subscribe(cb)`, `stop()`. A future task can lift this whole module into a
// standalone `catalyst-readmodel` process under catalyst-stack and put an
// HTTP/SSE shim in front of `subscribe`/`getSnapshot` WITHOUT any UI route code
// changing, because routes consume the interface, not the internals. The same
// reason lets the terminal HUD `import { createReadModel }` and consume the
// identical assembled source instead of re-scanning raw files itself.

import { watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { assembleBoard } from "./board-data.mjs";

const WORKERS_DIR = join(homedir(), "catalyst", "execution-core", "workers");

// The default entity set the read-model serves. Each entity has an `assemble()`
// that reads durable caches only. The BOARD payload is today's superset (it
// already carries tickets/workers/queue), so the default model assembles it once
// and projects the named slices off it — one compute, many views. New P2-P12
// entities (run-records, ticket-detail, …) register here as their own assemblers
// or as projections, with zero churn to the push/fan-out machinery below.
function defaultEntities(assemble) {
  return {
    // The whole board payload (back-compat: identical shape to the old snapshot).
    board: { assemble, project: (snap) => snap },
    tickets: { project: (snap) => snap.tickets ?? [] },
    workers: { project: (snap) => snap.workers ?? [] },
    queue: { project: (snap) => snap.queue ?? [] },
  };
}

// createReadModel — the generalized push model. `assemble` is the single
// durable-cache assembler (defaults to assembleBoard). All timers/dirs are
// injectable so the unit tests drive it without fs/subprocess/server.
export function createReadModel({
  debounceMs = 1000,
  pollMs = 3000,
  onDemandTtlMs = 2000,
  assemble = assembleBoard,
  workersDir = WORKERS_DIR,
  entities = defaultEntities(assemble),
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

  // compute() runs the assembler ONCE per recompute and fans the SAME snapshot
  // out to every subscriber — adding a client does not multiply the assemble
  // cost (the load-bearing "assemble once, fan out to many" guarantee).
  async function compute() {
    const snap = await assemble();
    latest = snap;
    latestTs = Date.now();
    for (const cb of subscribers) {
      try {
        cb(snap);
      } catch {
        /* a subscriber threw — don't let it kill the loop */
      }
    }
    return snap;
  }

  // De-dupe concurrent recomputes; if a trigger lands mid-compute, run once more.
  function recompute() {
    if (computing) {
      dirty = true;
      return computing;
    }
    computing = compute().finally(() => {
      computing = null;
      if (dirty) {
        dirty = false;
        schedule();
      }
    });
    return computing;
  }

  function schedule() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void recompute();
    }, debounceMs);
  }

  function startReactive() {
    if (reactive) return;
    reactive = true;
    void recompute(); // immediate refresh for the first subscriber
    try {
      watcher = watch(workersDir, { recursive: true }, () => schedule());
    } catch {
      /* dir absent or recursive watch unsupported — the poll still drives updates */
    }
    pollTimer = setInterval(() => schedule(), pollMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function stopReactive() {
    reactive = false;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // subscribe(cb) — register a client. Starts the reactive loop on the FIRST
  // subscriber and stops it when the LAST one leaves (zero host cost when no
  // client is connected). Returns an unsubscribe fn.
  function subscribe(cb) {
    subscribers.add(cb);
    if (subscribers.size === 1) startReactive();
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0) stopReactive();
    };
  }

  // getSnapshot() — one-shot read of the full payload. Returns the shared
  // snapshot if the reactive loop keeps it fresh, else recomputes (TTL-bounded
  // so residual one-shot readers don't each trigger a compute).
  async function getSnapshot() {
    if (reactive && latest) return latest;
    if (latest && Date.now() - latestTs < onDemandTtlMs) return latest;
    return computing ? computing : recompute();
  }

  // getEntity(name) — one-shot read of a single named slice (tickets / workers /
  // queue / board / …), projected off the SAME assembled snapshot. Unknown
  // entity name throws so a typo surfaces instead of silently returning null.
  async function getEntity(name) {
    const entity = entities[name];
    if (!entity) {
      throw new Error(`read-model: unknown entity "${name}"`);
    }
    const snap = await getSnapshot();
    return entity.project ? entity.project(snap) : snap;
  }

  return {
    subscribe,
    getSnapshot,
    getEntity,
    stop: stopReactive,
    get entityNames() {
      return Object.keys(entities);
    },
    get subscriberCount() {
      return subscribers.size;
    },
  };
}
