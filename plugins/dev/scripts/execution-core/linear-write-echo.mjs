// linear-write-echo.mjs — CTL-1891 increment 1 / CTL-1889.
//
// A host's record of what IT just wrote to Linear, so it can recognise its own echo
// without asking anyone who wrote it.
//
// ## Why this exists instead of attribution
//
// The obvious design is to attribute every write per host and suppress the ones this host
// made. That is impossible for the writes that matter: Linear's `createAsUser` exists ONLY
// on `CommentCreateInput`. `IssueUpdateInput` (stateId, labelIds, …) has no actor-override
// field and `issueAddLabel` takes bare args, so once host writes are proxied under one
// cloud grant, every state and label write lands as ONE identity with no per-host signal
// Linear itself carries — regardless of what the request sends. Verified against the live
// schema by introspection (CTC, 2026-08-16), not inferred.
//
// ⭐ But the requirement is narrower than attribution. Under CTL-1891 Option A (Ryan's
// decision) another host's deliberate board change SHOULD dispatch — only a host reacting
// to its OWN write must be suppressed. And a host already holds that fact locally, at the
// moment it writes. So no round-trip is needed: record what we wrote, and recognise it
// coming back.
//
// ## Accepted trade-offs, stated rather than discovered later
//
//  1. This is VALUE+TIME matching, not identity. A genuine external change that exactly
//     matches a value this host just wrote, inside the TTL, is suppressed. The window is
//     seconds — the same window Linear's own echo takes — and the value must match exactly.
//  2. A host restarting between the write and its echo loses the ring and dispatches once
//     on its own write. Bounded and self-correcting: one spurious dispatch, never a loop.
//     Deliberately in-memory for that reason — a durable ring would turn a rare
//     single-dispatch into a permanently-wrong suppression if it were ever stale.
//  3. It records nothing about WHICH host changed something. That is an observability
//     loss, not a correctness one, and is tracked separately (mirror-side origin host).
//
// ⛔ THE FAIL DIRECTION IS DELIBERATE. When in doubt this returns "not an echo", so the
// change DISPATCHES. A false suppression is silent and unrecoverable — the fleet ignores a
// real board change and nothing says so. A false dispatch is visible, idempotent at the
// phase layer, and self-correcting. Every ambiguous case below therefore resolves toward
// dispatching.

/** Default lifetime of a recorded write. Seconds, not minutes: long enough to cover the
 *  Linear round-trip (measured ~11s webhook, ~60s feed tick), short enough that a genuine
 *  later change to the same value is not swallowed. */
export const DEFAULT_ECHO_TTL_MS = 180_000;

/** Bounded so a write storm cannot grow this without limit. Oldest entries are evicted
 *  first; eviction can only ever cause a MISSED suppression (→ a dispatch), never a false
 *  one, which is the safe direction. */
export const DEFAULT_MAX_ENTRIES = 512;

/** Fields whose writes are worth remembering. Matches what the write proxy exposes. */
export const ECHO_FIELDS = Object.freeze(["state", "labels", "comment", "assignee", "delegate"]);

/**
 * Normalise a value into a stable comparison key.
 *
 * ⚠️ Label writes carry an ARRAY whose order is not guaranteed across the write and the
 * echo, so it is sorted. Everything else compares as a string. `null`/`undefined` are
 * distinct from the empty string: "cleared the field" and "set it to empty" are different
 * writes, and collapsing them would let one suppress the other.
 */
export function normalizeEchoValue(value) {
  if (value === null) return "~null";
  if (value === undefined) return "~undef";
  // ⛔ JSON, not join(","). A comma-join is NOT one-to-one: ["a,b","c"] and ["a","b,c"]
  // both become "a,b,c", so recording one would suppress an unrelated inbound change to
  // the other — a SILENT suppression, the exact direction this module promises never to
  // fail in. Linear label names may contain commas, so the collision is reachable.
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => String(v)).sort());
  return String(value);
}

/** The identity of a single write: which ticket, which field, which value. */
export function echoKey(ticket, field, value) {
  return `${ticket}${field}${normalizeEchoValue(value)}`;
}

/**
 * Create a host's recently-written ring.
 *
 * `now` is injectable so the TTL is testable without sleeping — a test that waits on a
 * real clock is slow and flaky, and one that cannot advance time cannot test expiry at all.
 */
export function createWriteEchoRing({
  ttlMs = DEFAULT_ECHO_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  /** key → { expiresAt, count }. Insertion order is age order, which makes eviction O(1).
   *  `count` is one token per write: two identical writes issued before either echo
   *  arrives must each be consumable, or the second echo dispatches an event this host
   *  produced. Collapsing them would be safe-direction, but needlessly so — it is cheap
   *  to be right. */
  const entries = new Map();

  const prune = (t) => {
    for (const [k, e] of entries) {
      if (e.expiresAt > t) break; // insertion-ordered: the first live entry ends the sweep
      entries.delete(k);
    }
  };

  return {
    /**
     * Record a write this host just made. Returns the key, or null when the write cannot
     * be identified — an unidentifiable write is simply not remembered, which costs a
     * later dispatch rather than a wrong suppression.
     */
    record(ticket, field, value) {
      if (typeof ticket !== "string" || ticket === "") return null;
      if (typeof field !== "string" || field === "") return null;
      const t = now();
      const key = echoKey(ticket, field, value);
      // Re-recording refreshes the TTL AND the age order, so a repeatedly-written value
      // stays suppressible: delete first so the Map re-appends at the end. The token count
      // CARRIES OVER, so each write keeps its own consumable echo.
      const prior = entries.get(key);
      const carried = prior && prior.expiresAt > t ? prior.count : 0;
      entries.delete(key);
      entries.set(key, { expiresAt: t + ttlMs, count: carried + 1 });
      prune(t);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return key;
    },

    /**
     * Is this inbound change an echo of one of our own writes?
     *
     * ⛔ CONSUMES the entry on a hit. An echo arrives ONCE; leaving the record in place
     * would suppress a genuine later change that happens to set the same value — turning a
     * one-shot guard into a repeating one, which is exactly the silent-suppression failure
     * this file's fail direction exists to avoid.
     */
    isEcho(ticket, field, value) {
      const t = now();
      // ⚠️ Deliberately does NOT prune. Pruning here would delete the expired entry before
      // the check below could reject it, making that check unreachable — dead logic no
      // test can distinguish from a correct one (verified: removing the expiry comparison
      // failed zero tests while prune ran first). Expiry now has ONE authority on the read
      // path, and this is O(1) rather than O(expired). Memory stays bounded by `record`'s
      // own prune plus the hard `maxEntries` cap.
      const key = echoKey(ticket, field, value);
      const e = entries.get(key);
      if (e === undefined || e.expiresAt <= t) return false;
      // Consume ONE token. An echo arrives once per write; leaving the record in place
      // would suppress a genuine later change setting the same value.
      if (e.count > 1) e.count -= 1;
      else entries.delete(key);
      return true;
    },

    /** Observability: how many writes are currently suppressible. */
    size() {
      prune(now());
      return entries.size;
    },

    /** Test/diagnostic seam only. */
    clear() {
      entries.clear();
    },
  };
}
