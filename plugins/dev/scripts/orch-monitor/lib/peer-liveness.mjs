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
    return { peers: null, source: "none" }; // no transport configured
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
export function foldPeerSnapshot({ prevHeartbeats = {}, prevCapacity = {}, peers = {} } = {}) {
  const nextHb = {};
  const nextCap = {};
  for (const [host, rec] of Object.entries(peers ?? {})) {
    if (!rec) continue;
    const hasTs = typeof rec.last_seen === "string" && rec.last_seen.length > 0;
    const newTs = hasTs ? Date.parse(rec.last_seen) : NaN;
    const prevTs = Date.parse(prevHeartbeats?.[host] ?? "");
    const fresher = Number.isFinite(newTs) && (!Number.isFinite(prevTs) || newTs >= prevTs);
    if (hasTs && fresher) nextHb[host] = rec.last_seen;
    const hasCapacity = rec.max_parallel != null || rec.in_flight_count != null;
    if (hasCapacity && fresher) {
      nextCap[host] = {
        maxParallel: typeof rec.max_parallel === "number" ? rec.max_parallel : 0,
        inFlightCount: typeof rec.in_flight_count === "number" ? rec.in_flight_count : 0,
      };
    }
  }
  return {
    heartbeats: retainMissingEntries(prevHeartbeats, nextHb),
    capacity: retainMissingEntries(prevCapacity, nextCap),
  };
}
