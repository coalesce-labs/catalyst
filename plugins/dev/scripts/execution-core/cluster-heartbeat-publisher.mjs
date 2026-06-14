// cluster-heartbeat-publisher.mjs — periodic cross-host liveness publisher
// (CTL-1090, Phase 4).
//
// startLivenessPublisher mirrors startHeartbeat() in heartbeat-event.mjs:
// immediate tick + setInterval + unref + { stop } handle. The difference:
//   • single-host (roster<=1) or missing anchor → inert { stop(){} } handle (no-op)
//   • each tick publishes { anchorIssue, host: self, inFlightTickets: ownedTickets() }
//     via publishHeartbeatSync (fail-open — a publish error is swallowed)
//
// The `ownedTickets` default reads in-flight tickets for `self` from the LOCAL
// signal directory (same predicate defaultOwnedTicketsForHost uses for the
// fallback path), avoiding a circular dependency on recovery.mjs.

import { readWorkerSignals, TERMINAL } from "./signal-reader.mjs";
import {
  getClusterHosts,
  getHostName,
  getLivenessAnchorIssue,
  LIVENESS_PUBLISH_INTERVAL_MS,
  log,
} from "./config.mjs";
import { publishHeartbeatSync } from "./cluster-heartbeat-sync.mjs";

// localInFlightTickets — return the in-flight ticket IDs for `hostName` from
// the local worker signal directory. This is the same predicate as the fallback
// in defaultOwnedTicketsForHost (recovery.mjs) — factored here so the publisher
// and the recovery fallback share the logic without importing recovery.mjs (which
// would create a circular dependency once recovery imports this module's outputs).
function localInFlightTickets(hostName, { orchDir } = {}) {
  if (!orchDir) return [];
  try {
    const signals = readWorkerSignals(orchDir);
    const tickets = new Set();
    for (const sig of signals) {
      if (!sig.raw?.host?.name || sig.raw.host.name !== hostName) continue;
      if (TERMINAL.has(sig.status)) continue;
      tickets.add(sig.ticket);
    }
    return [...tickets];
  } catch {
    return []; // fail-open
  }
}

// startLivenessPublisher — arm a periodic cross-host liveness publisher.
// Fires one publish immediately, then every intervalMs. Returns a stop handle
// ({ stop() }) so the daemon can tear it down symmetrically with _heartbeat.
//
// Single-host install (roster.length <= 1) → exact no-op: inert handle returned
// immediately. Missing anchor → multi-host but no anchor configured: logs a
// one-time warning and returns an inert handle.
//
// All collaborators are injectable for unit tests.
export function startLivenessPublisher({
  intervalMs = LIVENESS_PUBLISH_INTERVAL_MS,
  roster = getClusterHosts(),
  self = getHostName(),
  anchorIssue = getLivenessAnchorIssue(),
  orchDir,
  ownedTickets = () => localInFlightTickets(self, { orchDir }),
  publish = (args) => publishHeartbeatSync(args),
} = {}) {
  // Single-host no-op (no network, no publish, zero cost).
  if (!Array.isArray(roster) || roster.length <= 1) {
    return { stop() {} };
  }

  // Multi-host but no anchor configured: warn once, return inert handle.
  if (!anchorIssue) {
    log.warn(
      { roster },
      "cluster-heartbeat-publisher: CATALYST_LIVENESS_ANCHOR_ISSUE not configured — " +
        "cross-host liveness channel is disabled. Set catalyst.cluster.livenessAnchorIssue " +
        "in the Layer-2 config to enable peer liveness visibility.",
    );
    return { stop() {} };
  }

  const tick = () => {
    try {
      publish({ anchorIssue, host: self, inFlightTickets: ownedTickets() });
    } catch {
      // fail-open: a Linear hiccup must never crash the daemon
    }
  };

  tick(); // publish once at start so liveness is visible immediately
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never hold the process open

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
