// linear-cache.mjs — in-process TTL cache for single-ticket Linear reads
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
//
// CTL-784: two stores in one instance.
//   1. `entries` — string STATE keyed by identifier (the original CTL-634 cache).
//      Written-through by the monitor on every state_changed; read by
//      fetchTicketState. The `get`/`set`/`invalidate`/`stats` contract is
//      UNCHANGED — `set` stores only a string and has no side effect on the
//      relations store, so a setRelations() priming a state never trips an
//      invalidation, and the monitor write-through stays byte-for-byte.
//   2. `relationsEntries` — the FULL relation descriptor
//      ({ state, parent, relations, inverseRelations, priority, labels }) keyed by
//      identifier, with its own TTL. This is the read-through store
//      fetchTicketsBatch / fetchTicketRelations populate and consult so the
//      admission pool's per-tick relation reads collapse to one batched query
//      per TTL window. getRelations OVERLAYS the freshest state from `entries`
//      (the monitor keeps it current) onto the cached descriptor, so a cached
//      edge set is returned with up-to-date state even when only the state
//      changed — edges (rarely-changing) carry the ≤TTL staleness, state does
//      not. Storing the descriptor in a SEPARATE map is required: writing an
//      object under an `entries` key would return an object to fetchTicketState's
//      string-typed terminal-state checks and silently corrupt them.

// Default 60 s TTL; env-overridable to match the SCHEDULER_*_MS env idiom.
const DEFAULT_TTL_MS = Number(process.env.LINEAR_STATE_CACHE_TTL_MS) || 60_000;
// CTL-1436 (A4): the NEGATIVE-cache TTL — how long a probeBackoff caller (the
// terminal-probe / GC census) backs off from re-reading a ticket live after a
// FAILED live read (429 / timeout / unparseable). Longer than the positive TTL:
// these are old parked tickets the replica doesn't track, so a failed live probe
// need not retry every tick. This store is CONSULTED ONLY on probeBackoff calls,
// so the blocker-hydration path keeps the CTL-634 "a null read re-reads promptly"
// invariant untouched.
const DEFAULT_NEG_TTL_MS = Number(process.env.LINEAR_STATE_NEG_TTL_MS) || 5 * 60_000;

export function createTicketStateCache({ now = Date.now, ttlMs = DEFAULT_TTL_MS, negTtlMs = DEFAULT_NEG_TTL_MS } = {}) {
  const entries = new Map(); // identifier -> { state, expiresAt }
  const relationsEntries = new Map(); // identifier -> { desc, expiresAt } (CTL-784)
  const negativeEntries = new Map(); // identifier -> expiresAt (CTL-1436 A4)
  let hits = 0;
  let misses = 0;
  let relHits = 0;
  let relMisses = 0;

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
    negativeEntries.delete(identifier); // CTL-1436: a fresh success clears any backoff
  }

  // CTL-1436 (A4): negative-cache read/write — a SHORT backoff for probeBackoff
  // callers (terminal-probe / GC census) so a ticket whose live read just FAILED
  // (or found nothing) is not re-hammered against live Linear every tick. Kept
  // entirely separate from the positive `entries` store and consulted ONLY when a
  // caller opts in via fetchTicketState({ probeBackoff:true }), so the CTL-634
  // never-cache-null invariant for blocker hydration is preserved.
  function isNegativelyCached(identifier) {
    const exp = negativeEntries.get(identifier);
    if (exp && exp > now()) return true;
    if (exp) negativeEntries.delete(identifier); // expired — drop eagerly
    return false;
  }
  function setNegative(identifier) {
    negativeEntries.set(identifier, now() + negTtlMs);
  }

  // getRelations — CTL-784 read-through for the full relation descriptor. TTL is
  // governed by the relations entry (the edges); the state field is OVERLAID
  // from the live state cache when present (the monitor write-through keeps it
  // fresh) so a cached descriptor never returns a stale state. Returns undefined
  // on a cold/expired miss so fetchTicketsBatch treats it as a fetch.
  function getRelations(identifier) {
    const entry = relationsEntries.get(identifier);
    if (entry && entry.expiresAt > now()) {
      relHits += 1;
      const stateEntry = entries.get(identifier);
      const freshState =
        stateEntry && stateEntry.expiresAt > now() ? stateEntry.state : entry.desc.state;
      return { ...entry.desc, state: freshState };
    }
    if (entry) relationsEntries.delete(identifier); // expired — drop eagerly
    relMisses += 1;
    return undefined;
  }

  // setRelations — CTL-784. Store the full descriptor (edges + state + priority +
  // labels) AND prime the string-state cache via set() so a subsequent
  // fetchTicketState(id, { cache }) is a hit. set() has no side effect on
  // relationsEntries, so priming the state never evicts the descriptor we just
  // wrote. A null descriptor is never cached (fail-safe, mirrors set()).
  function setRelations(identifier, desc) {
    if (desc == null) return;
    relationsEntries.set(identifier, { desc, expiresAt: now() + ttlMs });
    set(identifier, desc.state); // prime state (set() null-guards desc.state)
  }

  function invalidate(identifier) {
    entries.delete(identifier);
    relationsEntries.delete(identifier);
    negativeEntries.delete(identifier); // CTL-1436: clear backoff on explicit invalidation
  }

  function stats() {
    const total = hits + misses;
    return { hits, misses, hitRate: total === 0 ? 0 : hits / total };
  }

  // relationsStats — CTL-784 per-tick observability for the relation read-through
  // store, kept separate from stats() so the CTL-634 stats() contract (and its
  // tests) stay byte-identical.
  function relationsStats() {
    const total = relHits + relMisses;
    return { hits: relHits, misses: relMisses, hitRate: total === 0 ? 0 : relHits / total };
  }

  return { get, set, isNegativelyCached, setNegative, getRelations, setRelations, invalidate, stats, relationsStats };
}
