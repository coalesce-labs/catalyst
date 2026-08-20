// cluster-heartbeat-publisher.mjs — periodic cross-host liveness publisher
// (CTL-1090, Phase 4).
//
// startLivenessPublisher mirrors startHeartbeat() in heartbeat-event.mjs:
// immediate tick + setInterval + unref + { stop } handle. The difference:
//   • single-host (roster<=1) → inert { stop(){} } handle (no-op), unconditionally.
//   • multi-host: the anchor requirement and the Linear publish are both gated
//     on the ACTIVE read source (CTL-1420 #17 / CTL-1628), not on anchor
//     presence alone:
//       - readSource "linear" + no anchor configured → inert { stop(){} }
//         handle (the legacy no-op path).
//       - readSource "linear" + anchor configured → armed; each tick publishes
//         { anchorIssue, host: self, inFlightTickets: ownedTickets() } via
//         publishHeartbeatSync (fail-open — a publish error is swallowed),
//         AFTER the Linear-free fence re-emit below.
//       - readSource "loki" (anchor configured or not) → armed, but the Linear
//         anchor publish is skipped every tick (retired in this mode); only
//         the Linear-free CTL-863 fence re-emit runs.
//
// The `ownedTickets` default reads in-flight tickets for `self` from the LOCAL
// signal directory (same predicate defaultOwnedTicketsForHost uses for the
// fallback path), avoiding a circular dependency on recovery.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeLastPhaseAdvanceTs, countYieldedOccupancy as defaultCountYieldedOccupancy, readAllPhaseSignals, readWorkerSignals, TERMINAL } from "./signal-reader.mjs";
import { countBackgroundAgents as defaultCountBackgroundAgents } from "./claude-agents.mjs";
import {
  // CTL-1785: publishing this host's liveness heartbeat is EXISTENCE (observability
  // that must survive an entitlement/authority outage — the Desired End State keeps
  // a shed host's `catalyst cluster status` visible). The roster here is only a
  // single-host `.length <= 1` no-op gate, a topology fact, never a work-ownership
  // decision. `off` mode: getExistenceHosts() === getClusterHosts().
  getExistenceHosts,
  getHostName,
  getLivenessAnchorIssue,
  getLivenessReadSource, // CTL-1420 (#17): gate the Linear anchor publish on the active source
  LIVENESS_PUBLISH_INTERVAL_MS,
  getEntitlementMode, // CTL-1785: entitlement rollout mode (off default)
  defaultEntitlementProvider, // CTL-1785: local provider (self ∈ roster → entitled)
  log,
} from "./config.mjs";
import { publishHeartbeatSync } from "./cluster-heartbeat-sync.mjs";
import { linearBreaker } from "./linear-breaker.mjs"; // CTL-1420 follow-up: share the CTL-679 breaker
import { isRateClassLinearError } from "./cluster-heartbeat.mjs"; // rate-class discriminator (pure)
import { emitFenceClaimed } from "./fence-event.mjs"; // CTL-863: Linear-free fence re-emit
import { revokeLeasesOnEntitlementLoss } from "./entitlement-revoke.mjs"; // CTL-1785: revoke-on-loss teeth
import { YIELDED_STATUS } from "../lib/phase-yield.mjs"; // CTL-1854: the declared bounded wait

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

// Signal statuses that OCCUPY a dispatch slot. in_flight (above) is the
// OWNERSHIP set — it also counts parked (needs-human) dirs a host must reclaim
// after death, which hold no slot (the scheduler's own slot accounting agrees).
// Conflating the two made the Workers header count slots the deck correctly
// rendered as Open (CTL-1581). needs-input IS included: the scheduler leaves a
// needs-input worker's job running and keeps counting it against maxParallel
// until it is actually stopped, and the local board renders it as occupying —
// peers must agree.
// CTL-1854: awaiting-work is included for exactly the reason needs-input is. A
// declared bounded wait HOLDS its slot (isTicketInFlight frees a slot only for
// failed|stalled|aborted) and is counted as occupancy locally
// (signal-reader's SDK_INFLIGHT_STATUSES), so a peer that omitted it would
// believe this host had a free slot the local scheduler knows it does not — the
// cross-host version of the same disagreement CTL-1581 fixed here.
// CTL-1864: localActiveSlotCount is the SLOT-based twin of localActiveTickets —
// published as catalyst.node.active_count (decoupled from the deduped ticket-ID
// list). See localActiveSlotCount() below. localActiveTickets stays unchanged
// (the identity list for ownership/reclaim); active_tickets still carries it.
const ACTIVE_STATUSES = new Set(["running", "dispatched", "needs-input", YIELDED_STATUS]);

// localActiveTickets — the slot-OCCUPYING subset of localInFlightTickets on
// this host. Triage-phase signals are carved out to match the deck/capacity
// predicates (queue-model.ts / board-data.mjs): triage is intake and does not
// consume maxParallel, so a peer must not render it in a remote slot the local
// monitor omits.
export function localActiveTickets(hostName, { orchDir } = {}) {
  if (!orchDir) return [];
  try {
    const signals = readWorkerSignals(orchDir);
    const tickets = new Set();
    for (const sig of signals) {
      if (!sig.raw?.host?.name || sig.raw.host.name !== hostName) continue;
      if (!ACTIVE_STATUSES.has(sig.status)) continue;
      if (sig.phase === "triage") continue;
      // A held-STOPPED needs-input worker (idle job stopped by the hold sweep,
      // status kept + stoppedForHold:true — scheduler.mjs slot accounting's own
      // carve-out) has released its process and its slot.
      if (sig.status === "needs-input" && sig.raw?.stoppedForHold === true) continue;
      tickets.add(sig.ticket);
    }
    return [...tickets];
  } catch {
    return []; // fail-open
  }
}

// localActiveSlotCount — CTL-1864: the SLOT-based occupancy this host actually holds.
// Published as catalyst.node.active_count so a peer's freeSlots never exceeds the local
// scheduler's. Reuses the SAME two functions the scheduler's occupancy uses
// (countBackgroundAgents + countYieldedOccupancy), so it cannot drift into a third counter.
// Fail-open on the live-count probe; fail-closed on the yield scan (never under-reports
// occupancy on a scan error — mirrors the scheduler's own posture).
export function localActiveSlotCount(
  _hostName,
  { orchDir, liveCountFn = defaultCountBackgroundAgents, countYieldedOccupancyFn = defaultCountYieldedOccupancy } = {},
) {
  if (!orchDir) return 0;
  let live = 0;
  try {
    const n = liveCountFn();
    live = Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    live = 0;
  }
  let yielded = 0;
  try {
    const y = countYieldedOccupancyFn(orchDir);
    yielded = y && Number.isInteger(y.count) && y.count >= 0 ? y.count : 0;
    // fail-closed: an unreadable workers/ dir must not silently read as zero slots.
    if (y && y.ok === false) return Math.max(live + yielded, live);
  } catch {
    // fail-open on the yield probe: fall through to live-only count
  }
  return live + yielded;
}

// startLivenessPublisher — arm a periodic cross-host liveness publisher.
// Fires one publish immediately, then every intervalMs. Returns a stop handle
// ({ stop() }) so the daemon can tear it down symmetrically with _heartbeat.
//
// Single-host install (roster.length <= 1) → exact no-op: inert handle returned
// immediately, regardless of anchor/read-source. Missing anchor → the anchor
// is a "linear" read-source concept only (CTL-1628): multi-host + "linear" mode
// + no anchor configured logs a one-time warning and returns an inert handle,
// exactly as before. Multi-host + "loki" mode arms the publisher even with no
// anchor configured — the Linear anchor publish is already retired in that mode
// (see tick() below), but the Linear-free CTL-863 fence re-emit must still run.
//
// All collaborators are injectable for unit tests.
export function startLivenessPublisher({
  intervalMs = LIVENESS_PUBLISH_INTERVAL_MS,
  roster = getExistenceHosts(),
  self = getHostName(),
  anchorIssue = getLivenessAnchorIssue(),
  orchDir,
  ownedTickets = () => localInFlightTickets(self, { orchDir }),
  // CTL-1092: this host's live slot count, published with each heartbeat so the
  // monitor cluster view can show per-host capacity. Injectable for tests.
  currentMaxParallel = () => readLocalMaxParallel(orchDir),
  lastAdvanceAt = () => computeLastPhaseAdvanceTs(readAllPhaseSignals(orchDir), { self }),
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
  // CTL-1785: entitlement revoke-on-loss seams. `entitlementMode` re-reads the
  // rollout mode per tick (off default → no-op); `entitlementProvider` defaults to
  // the local provider (self ∈ its own roster → always entitled → no-op today);
  // `revoke` is the ordering-constraint teeth. All injectable for tests.
  entitlementMode = getEntitlementMode,
  entitlementProvider = defaultEntitlementProvider,
  revoke = revokeLeasesOnEntitlementLoss,
} = {}) {
  // Single-host no-op (no network, no publish, zero cost).
  if (!Array.isArray(roster) || roster.length <= 1) {
    return { stop() {} };
  }

  // CTL-1628: resolve the active read source BEFORE gating on the anchor. The
  // anchor is a "linear" read-source concept only — retiring the Linear anchor
  // publish (readSource === "loki") must not also retire the Linear-free
  // CTL-863 fence re-emit below, so an anchor-less "loki" host must still arm
  // the publisher. Only "linear" mode needs the anchor to do anything.
  const effectiveSource = readSource();

  // Multi-host + "linear" mode + no anchor configured: warn once, return inert
  // handle (unchanged from pre-CTL-1628 behavior). "loki" mode falls through
  // even with no anchor — tick() below already skips the Linear publish itself
  // once readSource() !== "linear".
  if (effectiveSource === "linear" && !anchorIssue) {
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
    // CTL-1785: entitlement revoke-on-loss — the single daemon call site for the
    // ordering-constraint teeth. If this host's entitlement has lapsed under an
    // enforce-mode authority, release its held work leases (fence.released) so a
    // reclaiming host can enumerate them. Off by default; under the local provider
    // self is always entitled (self ∈ roster), so this is a guaranteed no-op until
    // W12's authority provider is injected. Best-effort — a throw here never aborts
    // the fence re-emit or liveness publish below.
    try {
      const eMode = entitlementMode();
      if (eMode === "enforce") {
        revoke({ self, ownedTickets: owned, provider: entitlementProvider(), mode: eMode, roster });
      }
    } catch {
      /* best-effort — never block the tick on the entitlement check */
    }
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
      let advance = null;
      try {
        advance = lastAdvanceAt();
      } catch {
        // Productivity is additive; its read must never interrupt liveness.
      }
      const result = publish({
        anchorIssue,
        host: self,
        inFlightTickets: owned,
        maxParallel: currentMaxParallel(),
        lastAdvanceAt: advance,
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
