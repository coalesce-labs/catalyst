// memoize-fresh.mjs — CTL-1257. Tiny dependency-free freshness-bounded memo for
// the full-log readers that run inside the 3s board recompute.
//
// ROOT CAUSE this exists to fix: while any SSE tab is open, lib/read-model.mjs
// recomputes every pollMs (3s) and each recompute drove up to THREE raw
// `readFileSync("utf8")` FULL reads of the ~190MB current-month event log
// (loadRecoveryOutcomes + two readClusterHeartbeats call sites). Each full read
// is a ~1.7GB transient that bun/mimalloc never returns to the OS → the monitor
// RSS ratchets to ~7GB off-heap. The three CTL-1215 ring consumers already avoid
// this; the recovery/cluster readers were added/left out of that migration.
//
// This wraps a read function with: a value+timestamp cache, a hard TTL (ms), an
// injectable `now`, and an explicit `invalidate()` so the event-ring's CTL-1224
// `onAppend` hook can force-refresh the moment a new line actually lands. The
// two readClusterHeartbeats call sites in server.ts SHARE ONE instance keyed on
// the local event-log path so the footer health dot and the cluster view can
// never skew (same input → same cached value). cluster-governance.mjs uses the
// SAME helper internally (TTL-only, no invalidate wiring) to avoid threading the
// ring object across its VITE-GRAPH-GUARD dynamic-import seam.
//
// Pattern + injectable-`now` for hermetic tests mirror bounded-map.mjs (the
// in-repo cache helper the CTL-1215 plan established). No class needed; no deps
// beyond the language.

/**
 * createMemoizedRead — wrap a read function so repeated calls within a TTL (or
 * until an explicit invalidate()) reuse the cached value instead of re-reading.
 *
 * Single-slot by default: the cache holds the most-recent value keyed on the
 * caller-supplied `key(...)`. When the key changes (or none is supplied and the
 * TTL/invalidate window has lapsed) the underlying `read` runs again. This fits
 * the path-fixed heartbeat readers (one event-log path) and the
 * (logPath,roster)-keyed governance reader.
 *
 * @template T
 * @param {object} opts
 * @param {(...args: unknown[]) => T} opts.read       underlying read; its result is cached
 * @param {number} opts.ttlMs                          hard staleness bound in ms (belt-and-suspenders)
 * @param {(...args: unknown[]) => string} [opts.key]  derive a cache key from the get() args (default: single slot)
 * @param {() => number} [opts.now]                    injectable clock (ms epoch) for tests
 * @returns {{ get: (...args: unknown[]) => T, invalidate: () => void }}
 */
export function createMemoizedRead({ read, ttlMs, key, now = () => Date.now() }) {
  if (typeof read !== "function") {
    throw new Error("createMemoizedRead: read must be a function");
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(`createMemoizedRead: ttlMs must be a non-negative number, got ${ttlMs}`);
  }

  /** @type {{ key: string, value: T, ts: number } | null} */
  let cached = null;

  return {
    get(...args) {
      const k = key ? key(...args) : "";
      const t = now();
      if (
        cached !== null &&
        cached.key === k &&
        t - cached.ts < ttlMs
      ) {
        return cached.value;
      }
      const value = read(...args);
      cached = { key: k, value, ts: t };
      return value;
    },
    // Force the next get() to re-read even within TTL. Wired to the event-ring's
    // onAppend hook so a genuine new log line refreshes the cache within ~1 ring
    // tick — well inside the heartbeat interval and the liveness grace.
    invalidate() {
      cached = null;
    },
  };
}
