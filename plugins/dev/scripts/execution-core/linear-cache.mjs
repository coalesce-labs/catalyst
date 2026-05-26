// linear-cache.mjs — in-process TTL cache for single-ticket Linear state reads
// (CTL-634 Tier 1). One instance is created by startDaemon and shared by the
// scheduler's out-of-set blocker hydration (read path) and the monitor's
// state_changed handler (write-through). Cuts `linearis issues read` calls the
// scheduler would otherwise re-issue every tick for the same blocker.
//
// Per-instance state (no module globals) so unit tests need no reset hook.
// `now` and `ttlMs` are injected; the daemon uses the defaults. NEVER caches a
// null/undefined value — a failed `linearis issues read` must stay un-cached so
// the D5 fail-safe sentinel (UNFETCHED_BLOCKER_STATE) is never poisoned and a
// recovered blocker is re-read promptly.

// Default 60 s TTL; env-overridable to match the SCHEDULER_*_MS env idiom.
const DEFAULT_TTL_MS = Number(process.env.LINEAR_STATE_CACHE_TTL_MS) || 60_000;

export function createTicketStateCache({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const entries = new Map(); // identifier -> { state, expiresAt }
  let hits = 0;
  let misses = 0;

  function get(identifier) {
    const entry = entries.get(identifier);
    if (entry && entry.expiresAt > now()) {
      hits += 1;
      return entry.state;
    }
    if (entry) entries.delete(identifier); // expired — drop eagerly
    misses += 1;
    return undefined;
  }

  function set(identifier, state) {
    // Fail-safe: never cache a missing state. A null fetch must re-read.
    if (state == null) return;
    entries.set(identifier, { state, expiresAt: now() + ttlMs });
  }

  function invalidate(identifier) {
    entries.delete(identifier);
  }

  function stats() {
    const total = hits + misses;
    return { hits, misses, hitRate: total === 0 ? 0 : hits / total };
  }

  return { get, set, invalidate, stats };
}
