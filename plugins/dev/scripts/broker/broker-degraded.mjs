// broker-degraded.mjs — CTL-1523. The broker's own "am I silently dead?" detector:
// the pure classifier/latch machine behind `broker.daemon.degraded` and its new
// paired `broker.daemon.recovered`, plus the DURABLE latch that survives a restart.
//
// WHY THIS EXISTS (the bug it fixes). CTL-352's gate consulted only
// `interests.size === 0` and uptime, so it could not distinguish a SILENTLY-DEAD
// broker (its intent) from a GENUINELY-IDLE fleet. Since the 2026-06-07
// phase-agents cutover, interest registration is legacy-only (every
// `filter.register` producer lives in plugins/legacy/) and correctly dormant — so
// an empty interest table is the CORRECT steady state and the gate fired on every
// quiet fleet. Worse, the one-shot guard (`degradedEmittedAt`) lived only in module
// memory and was never persisted, so every broker restart (~5/day from
// merge-triggered stack reloads) re-armed it: all 104 July emissions on mini fired
// at uptimeMs ∈ [300s, 343s] — the FIRST watchdog tick past the 5-minute grace
// after a fresh start. Zero fired later. It was a restart counter, not a detector.
//
// THE FIX — two changes, mirroring the CTL-1503 fleet-health-probe idiom:
//
//  1. A DISCRIMINATOR. The trip now requires the fleet to be ACTIVE
//     (hasActiveWorkers, via the router's fail-closed fleetIsActive wrapper): no
//     interests WHILE work is in flight is the anomaly; no interests while nothing
//     is running is Tuesday. Plus a sustained-tick debounce. Deliberately NO second
//     "is the broker ingesting" probe — a dead tailer already surfaces through the
//     CTL-1122 checkSourceRecency path (catalyst.ingestion.stale →
//     catalyst.alert.raised(system_down)); duplicating it here would double-page.
//
//  2. An EDGE-TRIGGER + DURABLE LATCH. `degraded` fires ONCE on the healthy→anomalous
//     edge; `recovered` fires ONCE on the way back. The latch is persisted to a
//     DEDICATED marker (NOT broker.state.json, which persistBrokerState rewrites
//     dozens of times per second) and hydrated lazily on the first tick, so a restart
//     mid-episode resumes rather than re-emitting. Emission is EMIT-THEN-ADVANCE: the
//     latch only advances on a SUCCESSFUL append, so a transient log failure retries
//     the same edge next tick instead of swallowing it.
//
// An IDLE fleet CLEARS a latched episode (paired `recovered`, reason "fleet idle")
// rather than holding it — same ledger-balancing choice checkSourceRecency makes for
// its gated sources, so every degraded has exactly one recovered.
//
// READING A `recovered` — the two reasons are NOT equally informative:
//
//   • reason: "interests registered" — AFFIRMATIVE proof of life. The broker
//     demonstrably processed a registration, so it is not silently dead.
//   • reason: "fleet idle" — INCONCLUSIVE. It means only that the DISCRIMINATOR went
//     dark: with no work in flight there is nothing left to distinguish a dead broker
//     from a correctly-quiet one, so the episode is closed to keep the ledger
//     balanced. It is NOT evidence the broker recovered. In the legacy mode where
//     this detector is enabled, hasActiveWorkers ages rows out at 30 minutes, so a
//     genuinely DEAD broker will auto-"recover" this way once the fleet quiesces.
//     Never treat a "fleet idle" recovered as an all-clear — for that, consult the
//     CTL-1122 ingestion-recency signal (catalyst.ingestion.stale /
//     catalyst.alert.raised(system_down)), which observes real ingestion.
//
// DORMANT BY DEFAULT (see isBrokerDegradedDetectorEnabled in config.mjs). The
// detector is OPT-IN via FILTER_BROKER_DEGRADED_ENABLED=1 and evaluates nothing when
// unset: in phase-agents mode the `interests.size === 0` conjunct is permanently true
// (registration is legacy-only), so the gate would degenerate to "the fleet has been
// busy for N ticks". It is retained for legacy wave-orchestration hosts, where
// interests ARE registered and the conjunct genuinely discriminates.
//
// This module is a near-leaf: it imports only config.mjs (knobs + logger). The
// activity reading and the event append are INJECTED by the router, so the whole
// machine is unit-testable with no DB, no clock, and no event log.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  log,
  BROKER_DEGRADED_GRACE_MS,
  BROKER_DEGRADED_SUSTAINED_TICKS,
  isBrokerDegradedDetectorEnabled,
} from "./config.mjs";

// The two event names this detector owns. Both sit inside the `broker.daemon`
// FORBIDDEN_PREFIXES space (namespace-contract.mjs), so shouldSkipEvent already
// drops them from re-ingestion — no filter-wake feedback loop.
export const BROKER_DEGRADED_EVENT = "broker.daemon.degraded";
export const BROKER_RECOVERED_EVENT = "broker.daemon.recovered";

/**
 * classifyBrokerDegraded — PURE per-tick trip classifier. `anomalous` is true only
 * when ALL of: the interest table is empty, the startup grace has elapsed, AND the
 * fleet is actively working. `fleetActive` is a strict-true check so an `undefined`
 * (reader unavailable) never trips — the no-false-alarm default, matching the
 * router's fail-closed fleetIsActive.
 *
 * @param {object} readings { interestCount, uptimeMs, fleetActive }
 * @param {object} [thresholds] { graceMs }
 * @returns {{anomalous:boolean, emptyInterests:boolean, pastGrace:boolean, fleetActive:boolean}}
 */
export function classifyBrokerDegraded(
  { interestCount, uptimeMs, fleetActive } = {},
  { graceMs = BROKER_DEGRADED_GRACE_MS } = {}
) {
  const emptyInterests = interestCount === 0;
  const pastGrace = Number.isFinite(uptimeMs) && uptimeMs > graceMs;
  const active = fleetActive === true;
  return {
    anomalous: emptyInterests && pastGrace && active,
    emptyInterests,
    pastGrace,
    fleetActive: active,
  };
}

/**
 * classifyBrokerDegradedClear — PURE clear-side verdict. The complement of the trip's
 * two live inputs: interests came back, OR the fleet went idle. Uptime plays no part
 * (it only ever grows). `reason` names WHICH condition cleared it, for the recovered
 * event's detail; interests-came-back wins when both hold, since it is the
 * affirmative proof that the broker is not dead.
 *
 * @param {object} readings { interestCount, fleetActive }
 * @returns {{clear:boolean, reason:("interests registered"|"fleet idle"|null)}}
 */
export function classifyBrokerDegradedClear({ interestCount, fleetActive } = {}) {
  if (interestCount > 0) return { clear: true, reason: "interests registered" };
  if (fleetActive !== true) return { clear: true, reason: "fleet idle" };
  return { clear: false, reason: null };
}

/**
 * nextBrokerDegradedSustained — PURE debounce counter. Counts consecutive anomalous
 * ticks; any non-anomalous tick resets it to 0, so the required run must be
 * contiguous.
 *
 * @param {number} prev
 * @param {boolean} anomalous
 * @returns {number}
 */
export function nextBrokerDegradedSustained(prev, anomalous) {
  const n = Number.isFinite(prev) ? prev : 0;
  return anomalous ? n + 1 : 0;
}

/**
 * nextBrokerDegradedLatch — PURE edge state machine (mirrors nextFleetHealthLatch).
 * `trip` is only consulted when NOT latched; once latched only `clear` releases it,
 * so a sustained anomaly never re-emits.
 *
 * @param {boolean} prev  prior latch (true = an episode is open)
 * @param {{trip:boolean, clear:boolean}} verdict
 * @returns {{latched:boolean, emit:("degraded"|"recovered"|null)}}
 */
export function nextBrokerDegradedLatch(prev, { trip, clear } = {}) {
  if (!prev && trip) return { latched: true, emit: "degraded" };
  if (prev && clear) return { latched: false, emit: "recovered" };
  return { latched: prev === true, emit: null };
}

// ─── Durable latch (mirrors fleet-health-probe.mjs) ──────────────────────────
// Module-scoped so the episode persists across ticks; PERSISTED to disk + hydrated
// on the first tick so a broker RESTART mid-episode does not re-emit `degraded`
// with no intervening `recovered` (the exact defect CTL-1523 fixes). Best-effort —
// a hydrate/persist failure never wedges the watchdog.
let _latched = false;
let _latchedAtMs = null; // when the open episode started (for degradedForMs)
let _hydrated = false;
let _sustained = 0; // in-memory only: a restart deliberately re-earns the debounce
// The run length AT THE TICK THE GATE FIRST CROSSED, held across retries. The live
// _sustained counter keeps incrementing while a failed append re-attempts the same
// edge, so reporting it would inflate the degraded event's `sustainedTicks` (6, 8, …
// for a threshold of 5) and misdescribe what actually tripped the gate. Captured on
// the first tripping tick, cleared whenever the run breaks.
let _tripRunLength = null;

// Resolved per call (not a load-time const) so tests can redirect by setting
// CATALYST_DIR — parity with getEventLogPath / getInterestsFile. Prefer
// process.env.HOME over homedir() for the same reason config.mjs does: macOS's
// homedir() ignores HOME, so a test (or a daemon launched with an overridden HOME)
// would otherwise resolve a different root than every other path helper.
export function getBrokerDegradedLatchPath() {
  const home = process.env.HOME ?? homedir();
  const catalystDir = process.env.CATALYST_DIR ?? `${home}/catalyst`;
  return resolve(catalystDir, "broker-degraded-latch.json");
}

// hydrateLatch — lazily load the persisted episode on this process's first tick.
// Absent/malformed marker → unlatched (never throws).
function hydrateLatch() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const m = JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8"));
    _latched = m?.latched === true;
    _latchedAtMs = Number.isFinite(m?.latchedAtMs) ? m.latchedAtMs : null;
  } catch {
    _latched = false; // absent/malformed → unlatched
    _latchedAtMs = null;
  }
}

// persistLatch — atomic tmp + rename write of the episode state. Best-effort; a
// failure is warned and the detector continues (the in-memory latch still holds
// for this process's lifetime).
function persistLatch({ latched, latchedAtMs }) {
  try {
    const path = getBrokerDegradedLatchPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    // Same directory as the marker (rename must stay intra-filesystem), but the tmp
    // BASENAME is dot-prefixed (mirrors fleet-health-probe.mjs) so a crash landing
    // between write and rename leaves a HIDDEN orphan rather than a visible piece of
    // debris in the operator-facing ~/catalyst root.
    const tmp = join(dir, `.broker-degraded-latch.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify({ latched, latchedAtMs, ts: Date.now() }));
    renameSync(tmp, path);
  } catch (err) {
    log.warn?.({ err: err?.message }, "broker-degraded: latch persist failed (continuing)");
  }
}

// __resetBrokerDegradedLatchForTest — test seam (mirrors __resetFleetHealthLatch).
// Clears ONLY the in-memory episode + the hydration flag, so the next tick
// re-reads the CATALYST_DIR-scoped marker — which is exactly how a restart is
// simulated.
export function __resetBrokerDegradedLatchForTest() {
  _latched = false;
  _latchedAtMs = null;
  _hydrated = false;
  _sustained = 0;
  _tripRunLength = null;
}

export function __getBrokerDegradedLatchForTest() {
  return {
    latched: _latched,
    latchedAtMs: _latchedAtMs,
    sustained: _sustained,
    tripRunLength: _tripRunLength,
    hydrated: _hydrated,
  };
}

/**
 * checkBrokerDegraded — one watchdog-tick evaluation. Returns the emitted edge
 * ("degraded" | "recovered") or null. Kill-switched (isBrokerDegradedDetectorEnabled).
 *
 * `emit({action, detail})` MUST return true on a successful append and false
 * otherwise (it must never throw) — the latch advances ONLY on true, so a transient
 * event-log failure re-attempts the same edge next tick rather than swallowing it.
 *
 * @param {object} i
 * @param {number} i.interestCount
 * @param {number} i.uptimeMs
 * @param {string|null} [i.brokerStartedAt]  ISO, forensic passthrough
 * @param {boolean} i.fleetActive
 * @param {number} [i.nowMs]
 * @param {Function} i.emit
 * @param {number} [i.graceMs]
 * @param {number} [i.sustainedTicks]
 * @returns {"degraded"|"recovered"|null}
 */
export function checkBrokerDegraded({
  interestCount,
  uptimeMs,
  brokerStartedAt = null,
  fleetActive,
  nowMs = Date.now(),
  emit,
  graceMs = BROKER_DEGRADED_GRACE_MS,
  sustainedTicks = BROKER_DEGRADED_SUSTAINED_TICKS,
} = {}) {
  if (!isBrokerDegradedDetectorEnabled()) return null;

  const { anomalous } = classifyBrokerDegraded({ interestCount, uptimeMs, fleetActive }, { graceMs });
  const { clear, reason: clearReason } = classifyBrokerDegradedClear({ interestCount, fleetActive });

  hydrateLatch();
  _sustained = nextBrokerDegradedSustained(_sustained, anomalous);

  const trip = anomalous && _sustained >= sustainedTicks;
  // Capture the run length that actually crossed the gate (see _tripRunLength).
  if (!trip) _tripRunLength = null;
  else if (_tripRunLength === null) _tripRunLength = _sustained;

  const { latched, emit: edge } = nextBrokerDegradedLatch(_latched, { trip, clear });
  if (!edge) return null;

  const degraded = edge === "degraded";
  const detail = degraded
    ? {
        reason: "no registered interests while fleet is active",
        uptimeMs,
        brokerStartedAt,
        activeWorkers: true,
        sustainedTicks: _tripRunLength ?? _sustained,
      }
    : {
        reason: clearReason,
        interestCount,
        degradedForMs: _latchedAtMs != null ? Math.max(0, nowMs - _latchedAtMs) : null,
      };

  let ok = false;
  try {
    ok = emit({ action: edge, detail }) !== false;
  } catch (err) {
    // Defensive `?.` for parity with persistLatch: config.mjs's `log` is a real pino
    // instance with no console shim, so a stripped/stubbed logger must never turn a
    // failed emit into a throw that escapes runWatchdogTick.
    log.warn?.({ err: err?.message }, "broker-degraded: emit failed");
    ok = false;
  }
  // EMIT-THEN-ADVANCE: a failed append leaves the latch untouched so the next tick
  // retries this edge (a real silent-death is never reduced to one lost log line).
  if (!ok) return null;

  _latched = latched;
  _latchedAtMs = degraded ? nowMs : null;
  persistLatch({ latched: _latched, latchedAtMs: _latchedAtMs });
  return edge;
}
