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
