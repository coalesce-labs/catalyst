// peer-liveness.mjs — CTL-1551. Pure selection of the cross-host peer-liveness
// transport for the monitor's background peer poll.
//
// Since CTL-1420 (#17) the daemons publish cross-host liveness to the unified
// event log → Loki, and the Linear-anchor publish is RETIRED in loki mode — so on
// a loki fleet the anchor (CTL-1217) is permanently stale and reading it painted
// every peer "offline" with weeks-old capacity (the CTL-1551 dashboard bug).
//
// Selection contract (mirrors recovery.mjs's defaultReadPeers, plus an AUTO tier
// because the monitor's launchd env usually carries no source var):
//   rawSource === "linear" → anchor only (legacy fleets, explicit opt-out).
//   rawSource === "loki"   → Loki only (daemon parity; an empty result is trusted
//                            as "no peers" — fail-open, never a fallback to the
//                            retired anchor).
//   unset / anything else  → AUTO: prefer Loki when a query URL resolves AND it
//                            returns at least one peer; otherwise fall back to
//                            the anchor when one is configured.
//
// Error semantics (deliberate, mirrors the prior inline code):
//   - a THROWING Loki read is swallowed here → falls through to the anchor tier
//     (Loki being down must not blank the display when the anchor still works);
//   - a THROWING anchor read propagates to the caller, whose outer catch keeps
//     the LAST cache (transient anchor failure must not clear a good cache).
//
// Returns { peers, source }:
//   peers  — the per-host record map ({ last_seen, in_flight_tickets,
//            max_parallel?, in_flight_count? }), or null when NO transport is
//            configured (caller clears its caches — "no peers by construction").
//   source — "loki" | "anchor" | "none" (observability/debug).
export function readPeerRecords({ rawSource, lokiUrl, anchorIssue, readLoki, readAnchor } = {}) {
  const source = String(rawSource ?? "")
    .trim()
    .toLowerCase();

  if (source !== "linear" && typeof lokiUrl === "string" && lokiUrl.length > 0 && typeof readLoki === "function") {
    let lokiPeers;
    try {
      lokiPeers = readLoki({ lokiUrl }) ?? {};
    } catch {
      lokiPeers = {}; // Loki hiccup → AUTO falls through to the anchor tier
    }
    if (Object.keys(lokiPeers).length > 0 || source === "loki") {
      return { peers: lokiPeers, source: "loki" };
    }
  }
  if (source === "loki") {
    // Explicit loki mode with no usable URL/reader: fail-open to "no peers"
    // rather than silently reading the retired anchor.
    return { peers: {}, source: "loki" };
  }
  if (!anchorIssue || typeof readAnchor !== "function") {
    // No anchor tier. `peers: null` (→ caller CLEARS caches) is reserved for
    // "no transport configured AT ALL"; when a Loki transport exists but its
    // read failed/was empty (the fail-open {}), return an EMPTY map instead so
    // the caller's fold RETAINS its caches — a Loki blip on a loki-only AUTO
    // host must not blank the display.
    const lokiConfigured =
      typeof lokiUrl === "string" && lokiUrl.length > 0 && typeof readLoki === "function";
    return lokiConfigured ? { peers: {}, source: "loki" } : { peers: null, source: "none" };
  }
  return { peers: readAnchor({ anchorIssue }) ?? {}, source: "anchor" };
}

// retainMissingEntries — CTL-1551. A successful Loki read can be PARTIAL (eventual
// consistency, bounded result) or EMPTY-on-outage (the sync bridge fail-opens to
// {}), and the poll replaces its caches wholesale — so a host merely MISSING from
// one snapshot would flip offline instantly with zeroed capacity, bypassing the
// liveness grace. Retain the previous entry for any host absent from the new
// snapshot: a genuinely dead host's retained last_seen stops advancing, so the
// node-liveness classifier ages it to offline on the SAME grace it always had —
// retention only prevents the instant blank, never a false "live forever".
export function retainMissingEntries(prev, next) {
  const out = { ...(next ?? {}) };
  for (const [host, entry] of Object.entries(prev ?? {})) {
    if (!(host in out)) out[host] = entry;
  }
  return out;
}

// foldPeerSnapshot — CTL-1551. Fold one peer snapshot into the poll's caches,
// with three guards a naive replace lacks (each was a reviewed failure mode):
//   1. NEWEST-WINS per host (the CTL-1255 principle applied to the caches): an
//      entry only updates when its last_seen is at least as fresh as the cached
//      one — so the AUTO anchor fallback after a Loki blip (same host keys,
//      weeks-old timestamps on a retired-writer anchor) can never regress a
//      fresher cached heartbeat OR pin stale capacity over it.
//   2. CAPACITY ONLY FROM CAPACITY-BEARING RECORDS: a failed capacity
//      enrichment yields max_parallel/in_flight_count = null on every host —
//      those must retain the previous capacity entry, never zero it.
//   3. RETENTION for hosts missing from the snapshot (retainMissingEntries).
// Retained/blocked entries still age to offline via the node-liveness grace —
// these guards only prevent instant regressions, never a false "live forever".
// Returns { heartbeats, capacity } — the new cache maps.
// A cached timestamp more than this far in the FUTURE of the poll's clock is
// untrusted (a clock-skewed publisher poisoned it): monotonic newest-wins would
// otherwise reject every corrected heartbeat until wall time caught up.
const FUTURE_SKEW_TOLERANCE_MS = 2 * 60_000;

export function foldPeerSnapshot({ prevHeartbeats = {}, prevCapacity = {}, peers = {}, nowMs = Date.now() } = {}) {
  const nextHb = {};
  const nextCap = {};
  for (const [host, rec] of Object.entries(peers ?? {})) {
    if (!rec) continue;
    const hasTs = typeof rec.last_seen === "string" && rec.last_seen.length > 0;
    const newTs = hasTs ? Date.parse(rec.last_seen) : NaN;
    const prevTs = Date.parse(prevHeartbeats?.[host] ?? "");
    // A FUTURE-skewed cached ts is not a legitimate freshness bar — without this,
    // one bad publish would block every corrected heartbeat until wall time
    // reached the poisoned value (and retention would preserve it forever).
    const prevTrusted =
      Number.isFinite(prevTs) && prevTs <= nowMs + FUTURE_SKEW_TOLERANCE_MS;
    const fresher = Number.isFinite(newTs) && (!prevTrusted || newTs >= prevTs);
    // CTL-1581 (Codex round 4): occupancy-clearing needs STRICT advancement — a
    // re-fold of the SAME heartbeat (same last_seen, e.g. query D failed on this
    // poll while C succeeded) must not erase enrichment learned from an earlier
    // poll of that same beat. Only a strictly newer beat without active fields
    // clears to null (the rollback/old-daemon case).
    const strictlyNewer = Number.isFinite(newTs) && (!prevTrusted || newTs > prevTs);
    if (hasTs && fresher) nextHb[host] = rec.last_seen;
    const hasCapacity =
      rec.max_parallel != null ||
      rec.in_flight_count != null ||
      // CTL-1581: an occupancy-only record (query C failed, query D succeeded)
      // must still fold — requiring the capacity pair would leave retention
      // serving stale activeCount/activeTickets indefinitely.
      rec.active_count != null ||
      Array.isArray(rec.active_tickets);
    if (hasCapacity && fresher) {
      // Per-FIELD merge: a record can carry one capacity field and not the other
      // (partial structured metadata); the absent field retains its previous
      // value instead of collapsing to zero.
      const prevCap = prevCapacity?.[host];
      nextCap[host] = {
        maxParallel:
          typeof rec.max_parallel === "number" ? rec.max_parallel : (prevCap?.maxParallel ?? 0),
        inFlightCount:
          typeof rec.in_flight_count === "number"
            ? rec.in_flight_count
            : (prevCap?.inFlightCount ?? 0),
        // CTL-1581: slot-OCCUPANCY follows the BEAT — a STRICTLY newer record
        // without active fields (query D failed / old-daemon rollback) clears
        // to null so consumers degrade to the honest inFlightCount fallback;
        // a re-fold of the SAME beat retains what an earlier poll learned.
        activeCount:
          typeof rec.active_count === "number"
            ? rec.active_count
            : strictlyNewer
              ? null
              : (prevCap?.activeCount ?? null),
        activeTickets: Array.isArray(rec.active_tickets)
          ? rec.active_tickets
          : strictlyNewer
            ? null
            : (prevCap?.activeTickets ?? null),
      };
    }
  }
  return {
    heartbeats: retainMissingEntries(prevHeartbeats, nextHb),
    capacity: retainMissingEntries(prevCapacity, nextCap),
  };
}
