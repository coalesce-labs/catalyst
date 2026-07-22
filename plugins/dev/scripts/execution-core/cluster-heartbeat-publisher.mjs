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
  getLivenessReadSource, // CTL-1420 (#17): gate the Linear anchor publish on the active source
  LIVENESS_PUBLISH_INTERVAL_MS,
  log,
} from "./config.mjs";
import { publishHeartbeatSync } from "./cluster-heartbeat-sync.mjs";
import { linearBreaker } from "./linear-breaker.mjs"; // CTL-1420 follow-up: share the CTL-679 breaker
import { isRateClassLinearError } from "./cluster-heartbeat.mjs"; // rate-class discriminator (pure)
import { emitFenceClaimed } from "./fence-event.mjs"; // CTL-863: Linear-free fence re-emit

// localClusterGeneration — read this host's won fence generation for `ticket`
// from workers/<ticket>/cluster-generation.json (the file writeClusterGeneration
// persists). Read directly rather than importing scheduler.mjs — that would pull
// the whole dispatch graph and risk a cycle (same rationale as readLocalMaxParallel).
// Fail-open: any miss → null.
function localClusterGeneration(orchDir, ticket) {
  if (!orchDir || !ticket) return null;
  try {
    const g = JSON.parse(readFileSync(join(orchDir, "workers", ticket, "cluster-generation.json"), "utf8"));
    return Number.isFinite(g?.generation) ? g.generation : null;
  } catch {
    return null;
  }
}

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
export function localInFlightTickets(hostName, { orchDir } = {}) {
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
  // CTL-863: heartbeat-cadence fence re-emit. Linear-FREE (a local event-log
  // append) — it MUST NOT be gated behind the Linear breaker-skip below (doing so
  // would re-create the CTL-1420 admission freeze on the fence path). Refreshes
  // claimed_at for each owned ticket so the multi-host guard's isFresh gate keeps
  // trusting the reconciled projection instead of escalating to Linear. Injectable.
  emitFence = (args) => emitFenceClaimed(args),
  readGeneration = (ticket) => localClusterGeneration(orchDir, ticket),
  logger = log, // CTL-1251: injectable so tests can assert publish-outcome logging
  // CTL-1420 follow-up: the shared CTL-679 breaker. The heartbeat is a ~2min
  // Linear WRITE on the same app-actor bucket as reads/writes, so it must (1)
  // SKIP publishing while the breaker is open (don't add to a storm), and (2)
  // FEED the breaker on a rate-class rejection. Injectable for tests.
  breaker = linearBreaker,
  // CTL-1420 (#17): the active cross-host liveness source. Injectable seam so tests
  // can force loki|linear; defaults to the env-driven getLivenessReadSource().
  readSource = getLivenessReadSource,
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
    // Snapshot the owned tickets ONCE per tick so the fence re-emit and the
    // liveness publish observe the same set (and ownedTickets is invoked exactly
    // once per tick, as before this fence re-emit was added).
    const owned = ownedTickets();
    // CTL-863: re-emit fence.claimed for each owned ticket FIRST, unconditionally
    // — BEFORE the breaker check below. This is a local, Linear-free event-log
    // append (zero app-actor traffic), so it must never be suppressed by the
    // Linear breaker. Its own try/catch keeps a fence-log hiccup from ever
    // aborting the liveness publish. Runs only multi-host (this publisher is inert
    // at roster<=1), which is exactly when the fence projection is read.
    try {
      for (const ticket of owned) {
        const generation = readGeneration(ticket);
        if (!Number.isFinite(generation)) continue; // no won token → nothing to refresh
        emitFence({ ticket, owner_host: self, generation });
      }
    } catch {
      /* fence re-emit is best-effort; never blocks or crashes the liveness tick */
    }
    // CTL-1420 (#17): in "loki" mode the cross-host liveness READ comes from Loki
    // (node.heartbeat → event log → Loki), so the Linear anchor publish is RETIRED —
    // skip it entirely. This is the ~120/hr shared-app-actor-bucket write that flaps
    // the CTL-679 breaker; removing it is the burn win. The Linear-FREE fence re-emit
    // above still runs every tick. "linear" mode keeps the legacy publish (safe-rollout
    // default; the fleet sets CATALYST_LIVENESS_READ_SOURCE=loki after validation).
    if (readSource() !== "linear") return;
    try {
      // CTL-1420 follow-up: if the shared CTL-679 breaker is OPEN (a rate-class
      // 429/RATELIMITED from ANY daemon Linear path tripped it), SKIP this publish
      // — spawning it would just add another ~2min-cadence write to the storm and
      // draw the exhausted app-actor bucket. Peers tolerate a brief stale window
      // (the 10-min grace); the breaker closes when the bucket recovers and
      // publishing resumes on the next tick. Counted as a failure for the throttle.
      if (breaker?.isOpen?.()) {
        if (consecutiveFailures === 0) {
          logger.warn(
            { host: self, anchorIssue },
            "cluster-heartbeat-publisher: SKIPPED publish — Linear breaker open (backing off the shared app-actor bucket)",
          );
        }
        consecutiveFailures += 1;
        return;
      }
      const result = publish({
        anchorIssue,
        host: self,
        inFlightTickets: owned,
        maxParallel: currentMaxParallel(),
      });
      if (result && result.ok === false) {
        // CTL-1420 follow-up: a RATE-class failure (429 or the RATELIMITED-tagged
        // 400 defaultPost now surfaces) feeds the breaker so the whole daemon backs
        // off the shared bucket. A NON-rate failure (a genuine query/schema 400, an
        // outage) does NOT feed the breaker — it's logged loud instead so a real
        // bug surfaces rather than being masked as "rate limited". We never call
        // recordSuccess here: a light heartbeat success must not force-close the
        // breaker while heavier reads are still being rate-limited.
        // CTL-1430: attribute this trip to the heartbeat publisher (a rate-class
        // failure = 429-class) so the durable linear.ratelimit.breaker event names
        // the caller — the WS-A diagnosis needs to know how much of the flap is
        // this ~2min anchor write vs. the read paths.
        if (isRateClassLinearError(result.error)) {
          breaker?.recordRateLimited?.(undefined, {
            reason: "429",
            caller: "cluster-heartbeat-publisher",
          });
        }
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
