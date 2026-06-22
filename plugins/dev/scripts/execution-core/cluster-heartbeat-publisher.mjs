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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkerSignals, TERMINAL } from "./signal-reader.mjs";
import {
  getClusterHosts,
  getHostName,
  getLivenessAnchorIssue,
  LIVENESS_PUBLISH_INTERVAL_MS,
  log,
} from "./config.mjs";
import { publishHeartbeatSync } from "./cluster-heartbeat-sync.mjs";

// readLocalMaxParallel — this host's live parallel-slot count from state.json
// (the autotuned value the scheduler reads via readMaxParallel). CTL-1092: the
// heartbeat carries it so the monitor's cluster view can show per-host capacity.
// Read directly (not via scheduler.mjs) to keep this publisher a leaf module —
// importing the scheduler would pull its whole dispatch/recovery graph and risk
// a cycle. Fail-open: any miss → null, so the heartbeat still publishes liveness
// without claiming a slot count it can't prove (the monitor treats null as "no
// data", never an error).
function readLocalMaxParallel(orchDir) {
  if (!orchDir) return null;
  try {
    const n = JSON.parse(readFileSync(join(orchDir, "state.json"), "utf8"))?.maxParallel;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

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
  // CTL-1092: this host's live slot count, published with each heartbeat so the
  // monitor cluster view can show per-host capacity. Injectable for tests.
  currentMaxParallel = () => readLocalMaxParallel(orchDir),
  publish = (args) => publishHeartbeatSync(args),
  logger = log, // CTL-1251: injectable so tests can assert publish-outcome logging
} = {}) {
  // Single-host no-op (no network, no publish, zero cost).
  if (!Array.isArray(roster) || roster.length <= 1) {
    return { stop() {} };
  }

  // Multi-host but no anchor configured: warn once, return inert handle.
  if (!anchorIssue) {
    logger.warn(
      { roster },
      "cluster-heartbeat-publisher: CATALYST_LIVENESS_ANCHOR_ISSUE not configured — " +
        "cross-host liveness channel is disabled. Set catalyst.cluster.livenessAnchorIssue " +
        "in the Layer-2 config to enable peer liveness visibility.",
    );
    return { stop() {} };
  }

  // CTL-1251: a publish failure used to vanish into fail-open silence, so a
  // multi-host daemon that "isn't publishing" gave no diagnostic. We now LOG the
  // outcome: warn on failure (with the reason from publishHeartbeatSync), but
  // throttle to once-per-CONSECUTIVE-failure-run so a sustained Linear outage
  // doesn't spam the log every interval. The first success after failures logs
  // an info recovery line. Still fail-open — logging never throws.
  let consecutiveFailures = 0;
  const tick = () => {
    try {
      const result = publish({
        anchorIssue,
        host: self,
        inFlightTickets: ownedTickets(),
        maxParallel: currentMaxParallel(),
      });
      if (result && result.ok === false) {
        if (consecutiveFailures === 0) {
          logger.warn(
            { host: self, anchorIssue, error: result.error },
            "cluster-heartbeat-publisher: publish to liveness anchor FAILED — peers will look stale",
          );
        }
        consecutiveFailures += 1;
      } else {
        if (consecutiveFailures > 0) {
          logger.info(
            { host: self, anchorIssue, afterFailures: consecutiveFailures },
            "cluster-heartbeat-publisher: publish recovered",
          );
        }
        consecutiveFailures = 0;
      }
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
