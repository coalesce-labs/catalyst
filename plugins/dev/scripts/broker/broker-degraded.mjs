// broker-degraded.mjs — CTL-1523. The broker's own "is my interest table empty while
// the fleet is working?" detector: the pure classifier/latch machine behind
// `broker.daemon.degraded` and its new paired `broker.daemon.recovered`, plus the
// DURABLE latch that survives a restart. (NOT a dead-broker detector — it runs inside
// the broker; see "THIS IS NOT A DEAD-BROKER DETECTOR" below.)
//
// WHY THIS EXISTS (the bug it fixes). CTL-352's gate consulted only
// `interests.size === 0` and uptime, so it could not distinguish a SILENTLY-DEAD
// broker (its intent) from a GENUINELY-IDLE fleet. On an EXECUTION-CORE host no
// component registers interests at all (see the scoping note below), so an empty
// interest table is the CORRECT steady state and the gate fired on every quiet
// fleet. Worse, the one-shot guard (`degradedEmittedAt`) lived only in module
// memory and was never persisted, so every broker restart (~5/day from
// merge-triggered stack reloads) re-armed it: all 104 July emissions on mini fired
// at uptimeMs ∈ [300s, 343s] — the FIRST watchdog tick past the 5-minute grace
// after a fresh start. Zero fired later. It was a restart counter, not a detector.
//
// THE FIX — two changes, mirroring the CTL-1503 fleet-health-probe idiom:
//
//  1. A DISCRIMINATOR. The trip now requires the fleet to be ACTIVE
//     (hasActiveWorkers, via the router's tri-state fleetActivity wrapper): no
//     interests WHILE work is in flight is the anomaly; no interests while nothing
//     is running is Tuesday. Plus a sustained-tick debounce. Deliberately NO second
//     "is the broker ingesting" probe — a stalled tailer already surfaces through
//     the CTL-1122 checkSourceRecency path (catalyst.ingestion.stale →
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
// A PROVEN-IDLE fleet CLEARS a latched episode (paired `recovered`, reason "fleet
// idle") rather than holding it — same ledger-balancing choice checkSourceRecency
// makes for its gated sources, so every degraded has exactly one recovered.
//
// UNKNOWN ACTIVITY HOLDS THE LATCH (review F2). The activity reading is TRI-STATE:
// true / false (proven idle) / null (the worker-table read failed — we know nothing).
// `null` neither trips nor clears. Collapsing it into `false` was a real defect: a
// transient SQLite failure emitted a FALSE `recovered` (reason "fleet idle") and
// persisted the cleared latch, so when the DB came back the still-anomalous condition
// re-tripped after the debounce — one uninterrupted episode reported as two.
//
// READING A `recovered` — the two reasons are NOT equally informative:
//
//   • reason: "interests registered" — AFFIRMATIVE proof of life. The broker
//     demonstrably processed a registration, so it is not silently dead.
//   • reason: "fleet idle" — INCONCLUSIVE. It means only that the DISCRIMINATOR went
//     dark: with no work in flight there is nothing left to distinguish a dead broker
//     from a correctly-quiet one, so the episode is closed to keep the ledger
//     balanced. It is NOT evidence the broker recovered. On the legacy-wave hosts
//     where this detector is enabled, hasActiveWorkers ages rows out at 30 minutes,
//     so a genuinely DEAD broker will auto-"recover" this way once the fleet
//     quiesces. Never treat a "fleet idle" recovered as an all-clear.
//
// THIS IS NOT A DEAD-BROKER DETECTOR, AND NEITHER IS checkSourceRecency. Both run
// INSIDE the broker process, so neither can emit anything once that process is gone —
// watching either as a death signal means watching a series that disappears with the
// thing it was meant to report on. checkSourceRecency detects an ingestion STALL
// (monitor/GitHub sources gone silent) while the broker is ALIVE. Detecting a fully
// dead broker requires an EXTERNAL, absence-based check on the broker's own
// heartbeat/log series — e.g. a Loki `absent_over_time` alert on
// `broker.daemon.heartbeat` or the broker `.log` stream. (Absence, not
// `count_over_time == 0`: a fully-dead daemon is a MISSING series, which a count
// cannot assert — see AGENTS.md → Observability.)
//
// DORMANT BY DEFAULT (see isBrokerDegradedDetectorEnabled in config.mjs). The
// detector is OPT-IN via FILTER_BROKER_DEGRADED_ENABLED=1 and evaluates nothing when
// unset.
//
// SCOPING — the permanently-empty interest table is a property of EXECUTION-CORE
// DISPATCH, not of every configuration named `phase-agents` (review F5). The
// execution-core daemon runs no `filter.register` producer at all, so on such a host
// `interests.size === 0` can never be false and the gate degenerates to "the fleet
// has been busy for N ticks". By contrast, a LEGACY-WAVE host — one running the
// `/catalyst-legacy:orchestrate` skill, which invoked
// plugins/dev/scripts/orchestrate-register-interests.sh — USED TO register
// interests: that script emitted the three deterministic interests (pr_lifecycle,
// ticket_lifecycle, comms_lifecycle) UNCONDITIONALLY, plus a per-ticket
// phase_lifecycle interest when `dispatchMode` was `phase-agents`. On those hosts an
// empty table WAS anomalous and the conjunct genuinely discriminated — but that
// deployment no longer exists (the wave orchestrator was removed along with the
// `catalyst-legacy` plugin, CTL-2241), so there is currently no host on which
// FILTER_BROKER_DEGRADED_ENABLED=1 belongs.
//
// This module is a near-leaf: it imports only config.mjs (knobs + logger). The
// activity reading and the event append are INJECTED by the router, so the whole
// machine is unit-testable with no DB, no clock, and no event log.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
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
 * fleet is actively working. `fleetActive` is TRI-STATE (true / false / null) and
 * this is a strict-true check, so `null` (reader unavailable) and `undefined` never
 * trip — the no-false-alarm default. Only a POSITIVE activity reading is evidence of
 * an anomaly.
 *
 * @param {object} readings { interestCount, uptimeMs, fleetActive } fleetActive: true|false|null
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
 * two live inputs: interests came back, OR the fleet is PROVEN idle. Uptime plays no
 * part (it only ever grows). `reason` names WHICH condition cleared it, for the
 * recovered event's detail; interests-came-back wins when both hold, since it is the
 * affirmative proof that the broker is not dead.
 *
 * TRI-STATE CONTRACT (review F2). Both edges demand POSITIVE evidence, so an UNKNOWN
 * activity reading (`null`/`undefined` — the worker-table read failed) can do neither:
 *
 *   fleetActive === true   → neither (the anomaly, if any, persists) — trip side owns it
 *   fleetActive === false  → CLEAR, reason "fleet idle" (proven idle)
 *   fleetActive == null    → NEITHER trip nor clear; a latched episode HOLDS
 *
 * The old `!== true` test collapsed unknown into idle, so one transient SQLite failure
 * produced a false `recovered` and a duplicate degraded edge when the DB came back.
 *
 * @param {object} readings { interestCount, fleetActive } fleetActive: true|false|null
 * @returns {{clear:boolean, reason:("interests registered"|"fleet idle"|null)}}
 */
export function classifyBrokerDegradedClear({ interestCount, fleetActive } = {}) {
  if (interestCount > 0) return { clear: true, reason: "interests registered" };
  if (fleetActive === false) return { clear: true, reason: "fleet idle" };
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
// Codex P2 (#2740): the marker write can fail (e.g. a temporarily unwritable
// CATALYST_DIR) AFTER the event append already succeeded and `_latched` advanced.
// Swallowing that left memory and disk disagreeing with nothing to reconcile them,
// so a later restart hydrated an absent/stale marker and re-emitted a duplicate
// edge for the same episode — defeating the whole point of the durable latch.
// When a write fails we remember it and retry on every subsequent tick until it
// lands. In-memory state stays authoritative meanwhile, so the retry never changes
// what is emitted; it only makes the on-disk copy catch up.
let _persistPending = false;
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
// Never throws.
//
// THE FAILURE TAXONOMY MATTERS (Codex round 3). The original broad catch marked the
// latch hydrated and treated EVERY failure as "no open episode", so a TRANSIENT read
// error (EIO, a momentary permission loss, an obstructed path) on a restart
// PERMANENTLY discarded a REAL open episode: the still-anomalous condition then
// re-earned the debounce and emitted a DUPLICATE `degraded` — precisely the defect
// the durable latch exists to prevent. Absence and corruption are CONFIRMATIONS;
// an unreadable marker is not. So:
//
//   ENOENT (marker absent)   → CONFIRMED unlatched. Hydrated; never retried.
//   read OK, body unparseable→ CONFIRMED unlatched (a marker we cannot trust is no
//                              marker — the existing, tested corrupt-marker
//                              behavior). Hydrated; never retried.
//   ANY OTHER read error     → TRANSIENT / UNKNOWN. Warn, leave `_hydrated` false so
//                              the NEXT tick re-reads, and leave the in-memory latch
//                              untouched — we have learned nothing about the episode.
//
// The un-hydrated state deliberately does NOT gate the tick: a marker that is
// unreadable forever must not disable the detector forever. The retry runs on every
// tick, so with the sustained-tick debounce hydration gets several chances before any
// edge can fire; and once an edge DOES advance the latch, checkBrokerDegraded pins
// `_hydrated = true` so a later successful read cannot clobber authoritative memory.
function hydrateLatch() {
  if (_hydrated) return;
  let raw;
  try {
    raw = readFileSync(getBrokerDegradedLatchPath(), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      _hydrated = true; // CONFIRMED: there is no episode on disk
      _latched = false;
      _latchedAtMs = null;
      return;
    }
    // Transient: stay un-hydrated so the next tick retries, and touch nothing.
    log.warn?.(
      { err: err?.message, code: err?.code },
      "broker-degraded: latch hydrate failed (transient — will retry)"
    );
    return;
  }
  // The read succeeded, so whatever is on disk IS the marker — a body we cannot
  // parse is a confirmed-unusable marker, not an unknown one.
  _hydrated = true;
  try {
    const m = JSON.parse(raw);
    _latched = m?.latched === true;
    _latchedAtMs = Number.isFinite(m?.latchedAtMs) ? m.latchedAtMs : null;
  } catch {
    _latched = false; // malformed → unlatched
    _latchedAtMs = null;
  }
}

// persistLatch — atomic tmp + rename write of the episode state. Best-effort; a
// failure is warned and the detector continues (the in-memory latch still holds
// for this process's lifetime).
function persistLatch({ latched, latchedAtMs }) {
  // Hoisted out of the try so the catch can clean it up (Codex round 3). The tmp
  // name is per-call random, so an orphan is never overwritten by the next attempt:
  // with the round-2 retry re-calling this on EVERY watchdog tick, a PERSISTENT
  // obstruction (a directory at the marker path, EPERM on the rename, …) leaked one
  // hidden tmp file per minute forever → inode/disk exhaustion.
  let tmp = null;
  try {
    const path = getBrokerDegradedLatchPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    // Same directory as the marker (rename must stay intra-filesystem), but the tmp
    // BASENAME is dot-prefixed (mirrors fleet-health-probe.mjs) so a crash landing
    // between write and rename leaves a HIDDEN orphan rather than a visible piece of
    // debris in the operator-facing ~/catalyst root.
    tmp = join(dir, `.broker-degraded-latch.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify({ latched, latchedAtMs, ts: Date.now() }));
    renameSync(tmp, path);
    return true;
  } catch (err) {
    if (tmp !== null) {
      // Nested + swallowed: cleanup must NEVER turn a best-effort persist failure
      // into a throw that escapes runWatchdogTick. `force` already tolerates an
      // absent file (the write itself may be what failed).
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing further to do — the retry next tick uses a fresh name */
      }
    }
    log.warn?.({ err: err?.message }, "broker-degraded: latch persist failed (will retry)");
    return false;
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
  _persistPending = false;
}

export function __getBrokerDegradedLatchForTest() {
  return {
    latched: _latched,
    latchedAtMs: _latchedAtMs,
    sustained: _sustained,
    tripRunLength: _tripRunLength,
    hydrated: _hydrated,
    persistPending: _persistPending,
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
  if (!isBrokerDegradedDetectorEnabled()) {
    // Review F4: DISCARD any unfinished debounce run while disabled. The knob is
    // read at call time, so it can flip mid-run; leaving the counters standing let
    // pre-disable observations count toward a POST-re-enable alarm (4 anomalous
    // ticks → disable → conditions clear → re-enable during a NEW anomaly → the
    // first new tick crosses a threshold of 5 after ONE tick of the new condition).
    // A debounce run must be contiguous AND wholly observed while armed.
    _sustained = 0;
    _tripRunLength = null;
    // Deliberately NOT touched: the durable latch (_latched/_latchedAtMs) and the
    // hydration flag. An OPEN episode must survive the switch so it can still be
    // paired with its `recovered` — that is existing intended behavior.
    return null;
  }

  const { anomalous } = classifyBrokerDegraded({ interestCount, uptimeMs, fleetActive }, { graceMs });
  const { clear, reason: clearReason } = classifyBrokerDegradedClear({ interestCount, fleetActive });

  hydrateLatch();

  // Codex P2 (#2740): reconcile a previously-failed marker write before doing
  // anything else. Until this lands, disk disagrees with memory and a restart
  // would re-emit an edge we already emitted. Runs after hydrateLatch so it can
  // never clobber the on-disk episode with un-hydrated defaults.
  if (_persistPending) {
    _persistPending = !persistLatch({ latched: _latched, latchedAtMs: _latchedAtMs });
  }

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
  // An edge has been emitted, so the IN-MEMORY episode is now authoritative. Pin
  // hydration closed (it may still be un-hydrated after a transient read failure —
  // see hydrateLatch) so a later successful read of a stale/absent marker can never
  // clobber the state we just committed to the event log.
  _hydrated = true;
  _persistPending = !persistLatch({ latched: _latched, latchedAtMs: _latchedAtMs });
  return edge;
}

/**
 * isBrokerDegradedLatchOpen — is there an OPEN episode owing a `recovered`?
 *
 * Codex P2 round 4 (#2740): the router's cross-tick interest-registration edge is
 * the only evidence that makes the clear verdict true for a one-shot interest. If
 * it is consumed unconditionally and the `recovered` append then FAILS, that
 * evidence is gone: the latch stays open and no later active/empty tick can retry
 * the recovery, so the episode suppresses every subsequent degraded until an
 * unrelated registration or an idle fleet happens along. The router therefore
 * retains the edge while an episode is still open — same emit-then-advance
 * discipline the latch itself uses. Reads in-memory state only; never throws.
 */
export function isBrokerDegradedLatchOpen() {
  return _latched === true;
}
