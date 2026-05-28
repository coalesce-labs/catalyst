// scheduler.mjs — pull-loop scheduler for the execution core (CTL-536).
//
// Replaces wave-based push dispatch with a continuous pull loop: on every tick
// it computes a fresh ready set (eligible ∩ no-open-blocker), priority-ranks
// it, and dispatches the top ticket whenever a worker slot is free. In-flight
// tickets are advanced phase-by-phase through the FSM. Every dispatch is
// idempotent (signal-file existence guard).
//
// Daemon correctness rests on the periodic tick — every action is re-derived
// from filesystem state, so the periodic pass alone guarantees forward
// progress. The event-log watcher is purely a latency optimization.
//
// Composes: lib/dependency-graph.mjs (readiness), scheduler-rank.mjs (ranking),
// lib/phase-fsm.mjs (phase advancement, Phase 4), eligible-set.mjs (candidates).

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  watch,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { analyzeDependencyGraph, referencedBlockerIds } from "../lib/dependency-graph.mjs";
// PHASES is still imported for deriveAdvancement; CTL-565 note: PHASES[0]
// ("triage") is intentionally NO LONGER the new-work entry phase — new work
// enters at NEW_WORK_ENTRY_PHASE ("research"), see schedulerTick.
import {
  PHASES,
  NEXT_PHASE,
  transition,
  isTerminal,
  REMEDIATE_PHASE,
  REMEDIATE_CYCLE_CAP,
} from "../lib/phase-fsm.mjs";
// CTL-653: the verdict-router reads (verify.json verdict + event-counted cycle
// budget) live here. deriveAdvancement stays pure — the impure reads happen in
// the sweep and are injected, so the router itself is unit-testable.
import { readVerifyVerdict } from "./work-done-probes.mjs";
import { countRemediateCycles } from "./event-scan.mjs";
import { rankTickets, compareTickets } from "./scheduler-rank.mjs";
import { defaultDispatch, dispatchTicket, teamOf } from "./dispatch.mjs";
import { fetchTicketState } from "./linear-query.mjs";
import { getProjectConfig, listProjects } from "./registry.mjs";
import { teardownWorktree as defaultTeardownWorktree } from "./worktree.mjs";
import { readWorkerSignals } from "./signal-reader.mjs";
import { countBackgroundAgents } from "./claude-agents.mjs";
import { emitReapIntent } from "./reap-intent.mjs";
// CTL-574: per-tick reclaim of dead-but-work-done phase workers. The default
// is the real recovery-module function; tests inject a fake. See
// reclaimDeadWorkIfPossible in recovery.mjs for the decision tree.
// CTL-611: defaultAppendDispatchFailedEvent — emits phase.dispatch.failed.<T>
// to the unified event log on every dispatch failure (Gap 1 + Gap 2).
// CTL-660: defaultAppendDispatchRequestedEvent/LaunchedEvent — the success-path
// complement, emitted when the scheduler decides to dispatch (requested) and
// after the bg worker is verified live (launched), so pickup→launch latency is
// derivable from the unified event log.
import {
  reclaimDeadWorkIfPossible as defaultReclaimDeadWork,
  defaultAppendDispatchFailedEvent,
  defaultAppendDispatchRequestedEvent,
  defaultAppendDispatchLaunchedEvent,
  defaultAppendYieldFileSkipEvent,
  defaultKillBgJob,
  defaultAppendPreemptedEvent,
  defaultAppendResumedAfterPreemptionEvent,
  resolvePhaseSessionId as defaultResolveSession,
} from "./recovery.mjs";
// CTL-558: the deterministic Linear status/label write seam. The whole module
// is injected as `writeStatus` so tests pass fakes; production uses the real
// module (best-effort — every write swallows its own failures).
import * as linearWrite from "./linear-write.mjs";
// CTL-638: labelOnce moved out of this file into a shared leaf module so the
// recovery-sweep escalation path can use the same once-marker guard. Keeping
// labelOnce here would force recovery.mjs → scheduler.mjs to import it, but
// scheduler.mjs already imports reclaimDeadWorkIfPossible from recovery.mjs —
// a cycle. label-guard.mjs is the leaf module both can import.
import { labelOnce } from "./label-guard.mjs";
import { log, getEligibleDir, getEventLogPath } from "./config.mjs";

// The last pipeline phase — its `done` signal means the whole pipeline
// finished. `done` is otherwise phase-dependent: a `triage: done` signal still
// occupies a slot (the ticket is mid-pipeline), so isTicketInFlight checks the
// phase, not just the status.
const TERMINAL_PHASE = "monitor-deploy";

// New work enters the pipeline at `research`: a Ready ticket has already been
// triaged (the →Triage watcher dispatched its triage agent — monitor.mjs). The
// scheduler never dispatches `triage`. CTL-565 Part B. Deliberately NOT
// PHASES[0] ("triage"); the FSM still owns chaining research → plan → … .
const NEW_WORK_ENTRY_PHASE = "research";

// CTL-705: STAGE_RANK — integer stage index for every pipeline phase + remediate.
// Higher = later in the pipeline = closer to done (shortest-remaining-time-first
// for preemption targeting). Deliberately duplicates PHASES order here rather than
// computing it dynamically, so scheduler-rank.mjs stays a pure leaf (no imports).
// Key ORDER mirrors [...PHASES, "remediate"] (drift guard in scheduler.test.mjs).
// Any reorder to PHASES must update both keys AND values here.
// Values: 0..9 with remediate=4 sitting between implement(3) and verify(5).
export const STAGE_RANK = Object.freeze({
  triage: 0,
  research: 1,
  plan: 2,
  implement: 3,
  verify: 5,
  review: 6,
  pr: 7,
  "monitor-merge": 8,
  "monitor-deploy": 9,
  remediate: 4, // ancillary phase — appended last so Object.keys() == [...PHASES, "remediate"]
});

// TERMINAL_SIGNAL_STATUSES — statuses that indicate a phase is definitively done
// (success or failure). Used by stageRankForTicket to skip phases that no longer
// represent active work. Mirrors the isTicketInFlight notion of terminal, but
// kept separate (isTicketInFlight includes the terminal-pipeline check and must
// not collapse with this set — see the CTL-565 cross-reference comment on
// isTicketInFlight).
const TERMINAL_SIGNAL_STATUSES = new Set(["failed", "stalled", "aborted"]);

// stageRankForTicket — given a {phase: status} map, return the highest STAGE_RANK
// value over all non-terminal phases. Returns -1 when no active phase is found
// (e.g. empty signals or all phases terminal) — this is the same sentinel used for
// queued tickets, placing parked-but-active in-flight workers ahead of the queue.
// A "preempted" signal is non-terminal (the worker is paused, not finished) and
// yields its phase's rank so the preempted ticket keeps its position in the global
// order.
export function stageRankForTicket(signals) {
  const sig = signals ?? {};
  let maxRank = -1;
  for (const [phase, status] of Object.entries(sig)) {
    if (TERMINAL_SIGNAL_STATUSES.has(status)) continue;
    if (phase === TERMINAL_PHASE && (status === "done" || status === "skipped")) continue;
    const rank = STAGE_RANK[phase];
    if (rank !== undefined && rank > maxRank) maxRank = rank;
  }
  return maxRank;
}

// readWorkerPriority — read workers/<T>/priority.json → {priority, createdAt}.
// Missing or unreadable → {priority: 5, createdAt: null} (safe lowest-band
// default). Never throws.
export function readWorkerPriority(orchDir, ticket) {
  try {
    const raw = readFileSync(join(orchDir, "workers", ticket, "priority.json"), "utf8");
    const p = JSON.parse(raw);
    return {
      priority: Number.isInteger(p?.priority) ? p.priority : 5,
      createdAt: typeof p?.createdAt === "string" ? p.createdAt : null,
    };
  } catch {
    return { priority: 5, createdAt: null };
  }
}

// writeWorkerPriority — write workers/<T>/priority.json. Idempotent overwrite via
// tmp+rename. Silently no-ops if the worker dir does not exist (we never create it
// here — the worker's prelude owns the dir). Best-effort: a write failure is
// swallowed so a transient I/O error never blocks the dispatch.
export function writeWorkerPriority(orchDir, ticket, { priority, createdAt }) {
  const p = join(orchDir, "workers", ticket, "priority.json");
  try {
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ priority, createdAt }));
    renameSync(tmp, p);
  } catch {
    // best-effort — missing worker dir or I/O failure; next dispatch retries
  }
}

// buildGlobalRanking — assemble a descriptor array for every in-flight ticket
// AND every eligible-but-not-started queued ticket, sorted by rankTickets.
// Descriptor shape: {identifier, priority, createdAt, stage, inFlight}.
// A ticket present in both eligible and in-flight is listed once, as in-flight.
export function buildGlobalRanking(orchDir, eligible) {
  const inFlight = listInFlightTickets(orchDir);
  const started = listStartedTickets(orchDir);
  const descriptors = [];

  for (const ticket of inFlight) {
    const { priority, createdAt } = readWorkerPriority(orchDir, ticket);
    const signals = readPhaseSignals(orchDir, ticket);
    const stage = stageRankForTicket(signals);
    descriptors.push({ identifier: ticket, priority, createdAt, stage, inFlight: true });
  }

  for (const t of eligible ?? []) {
    if (started.has(t.identifier)) continue; // already in-flight (listed above)
    descriptors.push({
      identifier: t.identifier,
      priority: t.priority,
      createdAt: t.createdAt ?? null,
      stage: -1,
      inFlight: false,
    });
  }

  return rankTickets(descriptors);
}

// CTL-705 Phase 4: preemption constants and module state.

// Phases that must never be preempted: monitor-deploy is a passive observer of
// deployment outcomes; triage runs once at pipeline entry and is brief.
export const NON_PREEMPTABLE_PHASES = new Set(["triage", "monitor-deploy"]);

// Minimum wall-clock seconds a worker must have been running before it becomes
// a preemption candidate — prevents stopping a worker that just started.
const PREEMPT_MIN_RUNTIME_MS = 60_000;

// Quiet-window for implement workers: if phase-implement.json mtime is more
// recent than this, the worker is actively committing — don't interrupt.
const PREEMPT_IMPLEMENT_QUIET_MS = 10_000;

// Hysteresis window: a queued ticket must out-rank its candidate for at least
// this long before preemption fires, preventing thrash on priority fluctuations.
const PREEMPT_HYSTERESIS_MS = 30_000;

// Status value written to the victim's phase signal when preempted.
export const PREEMPTED_STATUS = "preempted";

// rankedAboveSince — module state tracking when each (topQueued,victim) pair
// first became rank-eligible. Keyed by `${topQueuedId}:${victimId}` so the
// hysteresis tracks the specific preemptor→victim relationship.
// Cleared on stopScheduler/__resetForTests (see daemon module state section).
const rankedAboveSince = new Map();

// readPhaseSignals — { phase: status } for one ticket's workers/<T>/phase-*.json.
export function readPhaseSignals(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  const signals = {};
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return signals; // no worker dir yet
  }
  for (const f of files) {
    const m = /^phase-(.+)\.json$/.exec(f);
    if (!m) continue;
    if (m[1].includes("-yield-")) continue; // CTL-702: skip yield tombstones
    try {
      signals[m[1]] = JSON.parse(readFileSync(join(dir, f), "utf8"))?.status ?? null;
    } catch {
      // unreadable / malformed signal — skip; treated as absent
    }
  }
  return signals;
}

// isTicketInFlight — true when a ticket still occupies a worker slot. Pure over
// a phase→status map. In-flight = has ≥1 signal AND is neither pipeline-complete
// (monitor-deploy done) nor failed/stalled/aborted. A ticket mid-advance (plan
// done, no later signal yet) is still in-flight — correct slot accounting
// through the advance window.
//
// CROSS-REFERENCE (CTL-565): the failed/stalled/aborted set here is NOT the
// same as SETTLED_STATUSES in abort-worker.mjs — a non-terminal `done` is
// settled-as-a-signal there but still in-flight here. The divergence is
// intentional; do not collapse the two into one shared constant.
export function isTicketInFlight(signals) {
  const phases = Object.keys(signals ?? {});
  if (phases.length === 0) return false;
  for (const [phase, status] of Object.entries(signals)) {
    if (status === "failed" || status === "stalled" || status === "aborted") return false;
    // CTL-512: monitor-deploy `skipped` is terminal-success — the producer
    // emits it when no deployment_status event arrived before the timeout
    // (phase-monitor-deploy/SKILL.md). Only recognized for TERMINAL_PHASE;
    // a `skipped` on any other phase keeps the slot held so a producer bug
    // can't silently leak it.
    if (phase === TERMINAL_PHASE && (status === "done" || status === "skipped")) return false;
  }
  return true;
}

// listInFlightTickets — Set of ticket ids currently occupying a worker slot.
export function listInFlightTickets(orchDir) {
  const inFlight = new Set();
  let dirs;
  try {
    dirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return inFlight; // no workers dir yet
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (isTicketInFlight(readPhaseSignals(orchDir, d.name))) inFlight.add(d.name);
  }
  return inFlight;
}

// DEFAULT_MAX_PARALLEL — the single hardcoded worker-slot fallback, consulted
// only when neither committed config nor the legacy state.json supplies a valid
// ceiling (CTL-665 Decision 3). Exported so the daemon's literal and this
// reader's literal can't drift.
export const DEFAULT_MAX_PARALLEL = 1;

// readExecutionCoreConcurrency — pull the committed worker-slot concurrency knobs
// out of a project's .catalyst/config.json → catalyst.orchestration.executionCore
// (CTL-665). Returns {} for a null/missing/unparseable file or an absent key, so
// callers fall back to state.json + the hardcoded default. Never throws. Mirrors
// readOrphanReaperConfig (orphan-reaper-timer.mjs:16) — the CTL-649 threading
// precedent. Note: the returned object may also carry the central `eligibleQuery`
// (the project config co-locates it under executionCore); readMaxParallel reads
// only maxParallel/minParallel/maxParallelCeiling from it.
export function readExecutionCoreConcurrency(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "execution-core: concurrency config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.executionCore ?? {};
}

// readExecutionCoreConcurrencyLayer2 — pull the machine-canonical worker-slot
// concurrency knobs from a Layer-2 file (~/.config/catalyst/config.json) at
// catalyst.orchestration.executionCore (CTL-678). Same failure semantics as
// readExecutionCoreConcurrency: returns {} for a null/missing/unparseable file
// or absent key; never throws. The Layer-2 path is host-wide; per-project
// overrides are out of scope today (see CTL-678 plan, Decision 1).
export function readExecutionCoreConcurrencyLayer2(layer2Path) {
  if (!layer2Path) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(layer2Path, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { layer2Path, err: err.message },
        "execution-core: Layer-2 concurrency config unreadable; using Layer-1"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.executionCore ?? {};
}

// mergeExecutionCoreConcurrency — per-field merge of Layer-1 (committed
// .catalyst/config.json seed) and Layer-2 (~/.config/catalyst/config.json
// machine-canonical override). Layer-2 wins per field WHEN the field is a
// positive integer; otherwise the Layer-1 value is preserved (a malformed
// Layer-2 never silently caps a healthy Layer-1). eligibleQuery and any other
// co-located fields on Layer-1 pass through unchanged (Layer-2's executionCore
// block is concurrency-only by convention). The returned object is fed to
// readMaxParallel verbatim — same shape, same precedence-and-clamp semantics
// as CTL-665.
// positiveIntFields — returns a new object containing only the fields from
// `obj` whose values are positive integers. Used by perProject merge + validate.
function positiveIntFields(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of ["maxParallel", "reserve"]) {
    const v = obj[k];
    if (Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

// warnedPerProjectConfigs — dedup set keyed on stable JSON signature of the
// perProject map, so per-tick re-reads don't spam (mirrors observedYieldFiles).
const warnedPerProjectConfigs = new Set();

function warnPerProjectOnce(sig, msg, ctx) {
  if (warnedPerProjectConfigs.has(sig)) return;
  warnedPerProjectConfigs.add(sig);
  log.warn(ctx, msg);
}

export function mergeExecutionCoreConcurrency(layer1 = {}, layer2 = {}) {
  const merged = { ...layer1 };
  for (const key of ["maxParallel", "minParallel", "maxParallelCeiling"]) {
    const v = layer2?.[key];
    if (Number.isInteger(v) && v > 0) merged[key] = v;
  }
  // CTL-706: deep-merge perProject — sub-field level, positive-int guard per field.
  const l1pp = layer1?.perProject;
  const l2pp = layer2?.perProject;
  if (l1pp || l2pp) {
    const allKeys = new Set([...Object.keys(l1pp ?? {}), ...Object.keys(l2pp ?? {})]);
    const mergedPP = {};
    for (const k of allKeys) {
      mergedPP[k] = { ...(l1pp?.[k] ?? {}), ...positiveIntFields(l2pp?.[k]) };
    }
    merged.perProject = mergedPP;
  }
  return validatePerProjectBudgets(merged);
}

// validatePerProjectBudgets — clamps over-subscribed reserves so
// sum(reserve) ≤ maxParallel, warns once per distinct config (CTL-706).
// Never throws; returns input unchanged when perProject is absent/empty.
export function validatePerProjectBudgets(concurrency) {
  const pp = concurrency?.perProject;
  if (!pp || typeof pp !== "object" || Object.keys(pp).length === 0) return concurrency;

  const globalMax =
    Number.isInteger(concurrency.maxParallel) && concurrency.maxParallel > 0
      ? concurrency.maxParallel
      : DEFAULT_MAX_PARALLEL;

  // Coerce each entry to valid non-negative integers.
  const coerced = {};
  for (const [k, v] of Object.entries(pp)) {
    const entry = {};
    if (Number.isInteger(v?.maxParallel) && v.maxParallel > 0) entry.maxParallel = v.maxParallel;
    if (Number.isInteger(v?.reserve) && v.reserve >= 0) entry.reserve = v.reserve;
    coerced[k] = entry;
  }

  // Clamp reserves so sum ≤ globalMax (descending reserve, then key-asc).
  const keysWithReserve = Object.keys(coerced)
    .filter((k) => coerced[k].reserve > 0)
    .sort((a, b) => (coerced[b].reserve ?? 0) - (coerced[a].reserve ?? 0) || a.localeCompare(b));

  const totalReserve = keysWithReserve.reduce((s, k) => s + coerced[k].reserve, 0);
  const sig = JSON.stringify(coerced);

  if (totalReserve > globalMax) {
    warnPerProjectOnce(
      `clamp:${sig}`,
      "execution-core: perProject reserves over-subscribed; clamping to fit maxParallel",
      { totalReserve, globalMax, perProject: coerced },
    );
    let remaining = globalMax;
    for (const k of keysWithReserve) {
      const want = coerced[k].reserve;
      coerced[k] = { ...coerced[k], reserve: Math.min(want, remaining) };
      remaining = Math.max(0, remaining - coerced[k].reserve);
    }
  }

  const configuredCaps = Object.values(coerced)
    .filter((e) => e.maxParallel > 0)
    .reduce((s, e) => s + e.maxParallel, 0);
  if (configuredCaps > 0 && configuredCaps < globalMax) {
    warnPerProjectOnce(
      `under:${sig}`,
      "execution-core: sum(perProject.maxParallel) < globalMax — some slots may be unused",
      { configuredCaps, globalMax },
    );
  }

  return { ...concurrency, perProject: coerced };
}

// clampToBounds — raise `value` to `minParallel` and lower it to
// `maxParallelCeiling`, but only when each bound is a valid integer (CTL-665).
// Bounds bite only when present, so the empty-`concurrency` legacy path stays
// unclamped — every existing state.json-driven test is untouched.
function clampToBounds(value, { minParallel, maxParallelCeiling } = {}) {
  let resolved = value;
  if (Number.isInteger(minParallel) && resolved < minParallel) resolved = minParallel;
  if (Number.isInteger(maxParallelCeiling) && resolved > maxParallelCeiling) {
    resolved = maxParallelCeiling;
  }
  return resolved;
}

// readMaxParallel — the run's worker-slot ceiling, config-first (CTL-665). A
// valid `concurrency.maxParallel` (committed config, threaded from the daemon)
// wins; otherwise the legacy state.json `maxParallel` is the back-compat
// fallback; otherwise the shared DEFAULT_MAX_PARALLEL. The resolved value is then
// clamped into [minParallel, maxParallelCeiling] when those bounds are valid
// integers. The one-arg call `readMaxParallel(orchDir)` (concurrency = {}) is
// byte-for-byte equivalent to the pre-CTL-665 behavior: no config value, no
// bounds, so it falls to state.json or DEFAULT_MAX_PARALLEL with no clamp.
//
// ENOENT on state.json is expected and stays silent; any other read error or a
// JSON parse failure would otherwise silently cap the run, so it is logged
// loudly before the fallback to keep the cause operator-visible.
export function readMaxParallel(orchDir, concurrency = {}) {
  // config-primary: a valid committed maxParallel wins outright.
  const configMax =
    Number.isInteger(concurrency?.maxParallel) && concurrency.maxParallel > 0
      ? concurrency.maxParallel
      : null;

  let stateMax = null;
  let raw;
  try {
    raw = readFileSync(join(orchDir, "state.json"), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.error(
        { err: err.message, code: err.code, orchDir },
        "scheduler: state.json unreadable — defaulting maxParallel"
      );
    }
  }
  if (raw !== undefined) {
    let n;
    let parsed = true;
    try {
      n = JSON.parse(raw)?.maxParallel;
    } catch (err) {
      parsed = false;
      log.error(
        { err: err.message, orchDir },
        "scheduler: state.json is not valid JSON — defaulting maxParallel"
      );
    }
    if (parsed) {
      if (Number.isInteger(n) && n > 0) {
        stateMax = n;
      } else if (configMax === null) {
        // Only warn about a missing state.json ceiling when config can't cover
        // it — a config-present run intentionally ignores state.json.
        log.warn(
          { maxParallel: n, orchDir },
          "scheduler: state.json has no valid maxParallel — defaulting"
        );
      }
    }
  }

  const resolved = configMax ?? stateMax ?? DEFAULT_MAX_PARALLEL;
  return clampToBounds(resolved, concurrency);
}

// computeFreeSlots — never negative (an over-subscribed run yields 0).
export function computeFreeSlots(maxParallel, inFlightCount) {
  return Math.max(0, maxParallel - inFlightCount);
}

// readPhaseSignalRaw — the full parsed phase-<phase>.json for one ticket, or
// null. readPhaseSignals returns only {phase: status}; the predecessor reap
// needs the worker's bg_job_id, which lives in the raw signal.
function readPhaseSignalRaw(orchDir, ticket, phase) {
  try {
    return JSON.parse(
      readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"),
    );
  } catch {
    return null;
  }
}

// predecessorPhaseOf — the completed phase whose happy-path successor is `next`
// (i.e. the worker that just finished and triggered this advance), or null.
// Uses the NEXT_PHASE inversion so it is unambiguous on every LINEAR edge. The
// router-only verify⇄remediate detour (no NEXT_PHASE entry) is resolved
// separately by resolveReapPredecessor (CTL-661) — it is no longer left to the
// periodic orphan reaper as a backstop.
export function predecessorPhaseOf(signals, next) {
  for (const [phase, status] of Object.entries(signals ?? {})) {
    if (status === "done" && NEXT_PHASE[phase] === next) return phase;
  }
  return null;
}

// resolveReapPredecessor — CTL-661 hole #2. Pure resolution of "which just-
// finished worker should be reaped now that `next` is dispatched", covering the
// two verify⇄remediate detour edges that NEXT_PHASE cannot express, then the
// linear edges. Returns `{ phase, reason } | null`.
//   • verify → remediate (next === REMEDIATE_PHASE): the verify worker just
//     produced the fail verdict — reap verify.
//   • remediate → verify (next === "verify" && remediate done): the remediate
//     worker just committed its fix — reap remediate, NOT the long-finished
//     implement the NEXT_PHASE inversion would return.
//   • every linear edge: fall through to the NEXT_PHASE inversion.
// NOTE: on the real remediate→verify re-entry, maybeResetForRemediateCycle has
// already deleted the remediate signal by the time the scheduler advances, so
// the call site passes resolveReapPredecessor the PRE-reset signals (and the
// pre-reset remediate raw) — see the advancement sweep below.
export function resolveReapPredecessor(signals, next) {
  const sig = signals ?? {};
  if (next === REMEDIATE_PHASE) {
    return sig.verify === "done"
      ? { phase: "verify", reason: "ctl-661-remediate-detour" }
      : null;
  }
  if (next === "verify" && sig[REMEDIATE_PHASE] === "done") {
    return { phase: REMEDIATE_PHASE, reason: "ctl-661-remediate-detour" };
  }
  const pred = predecessorPhaseOf(sig, next);
  return pred ? { phase: pred, reason: "ctl-657-scheduler-advance" } : null;
}

// emitPredecessorReap — CTL-657 Bug 2: stop the predecessor worker now that its
// successor is dispatched. orchestrate-phase-advance already does this on the
// shell advance path (CTL-567), but the daemon scheduler's dispatchTicket path
// bypassed that emit, so on a normal scheduler-driven phase switch the just-
// finished worker was never nominated for stopping (only 1 predecessor reap
// ever emitted across 12+ advances). Fire-and-forget — the reaper issues the
// `claude stop`. No-op when the predecessor has no recorded bg_job_id (e.g. the
// new-work entry phase, or a unit-test signal with no bg_job_id) so it never
// shells out or appends to the event log spuriously.
// CTL-661: `remediateRaw` is the remediate phase signal captured BEFORE
// maybeResetForRemediateCycle deletes it — passed in so the remediate→verify
// re-entry can still read the dead remediate worker's bg_job_id.
function emitPredecessorReap(orchDir, ticket, signals, next, { remediateRaw = null } = {}) {
  const pred = resolveReapPredecessor(signals, next);
  if (!pred) return;
  const raw =
    pred.phase === REMEDIATE_PHASE
      ? (remediateRaw ?? readPhaseSignalRaw(orchDir, ticket, pred.phase))
      : readPhaseSignalRaw(orchDir, ticket, pred.phase);
  const bgJobId = raw?.bg_job_id;
  if (!bgJobId) return;
  emitReapIntent("phase.predecessor.reap-requested", {
    ticket,
    phase: pred.phase,
    bgJobId,
    worktreePath: raw?.worktreePath,
    reason: pred.reason,
  }).catch(() => {});
}

// A blocker fetch that failed (or any non-terminal hydrated state) holds the
// dependent back. The sentinel is a deliberately non-terminal placeholder
// state so a failed `linearis issues read` fails safe — the dependent is
// treated as blocked, never silently dispatched. CTL-565 D5.
const UNFETCHED_BLOCKER_STATE = "__unfetched__";

// hydrateOutOfSetBlockers — find every blocker referenced by an eligible
// ticket's blocked-by edge that is NOT itself in the eligible set, fetch its
// live Linear state once, and return a { identifier: stateName } map. A failed
// fetch yields the non-terminal UNFETCHED_BLOCKER_STATE sentinel so the
// dependent is held back — failing safe. CTL-565 D5.
// CTL-634: the opt-in `cache` is threaded into each fetchState call so the
// same out-of-set blocker is read at most once per TTL window across ticks.
// Absent the cache, every tick re-reads (the pre-CTL-634 behavior).
export function hydrateOutOfSetBlockers(
  eligibleTickets,
  { exec, fetchState = fetchTicketState, cache } = {}
) {
  const list = eligibleTickets ?? [];
  const inSet = new Set(list.map((t) => t?.identifier).filter(Boolean));
  const externalBlockers = referencedBlockerIds(list).filter((id) => !inSet.has(id));
  const blockerStates = {};
  for (const id of externalBlockers) {
    const state = fetchState(id, { exec, cache });
    blockerStates[id] = state ?? UNFETCHED_BLOCKER_STATE; // non-terminal → fails safe
  }
  return blockerStates;
}

// computeReadyTickets — eligible tickets with no open blocker, priority-ranked.
// analyzeDependencyGraph returns ready identifier strings; map back to the full
// ticket objects (selection and dispatch need priority/createdAt) and rank.
//
// CTL-565 D5: options.blockerStates is threaded into the readiness filter so a
// dependent blocked by a non-terminal out-of-set blocker is held back.
export function computeReadyTickets(eligibleTickets, { blockerStates } = {}) {
  const list = eligibleTickets ?? [];
  const readyIds = new Set(analyzeDependencyGraph(list, { blockerStates }).ready);
  return rankTickets(list.filter((t) => readyIds.has(t.identifier)));
}

// selectDispatchable — the top `freeSlots` ready tickets not in the given
// exclude set (the tick passes already-started tickets, Phase 4).
export function selectDispatchable(rankedReady, excludeTickets, freeSlots) {
  if (freeSlots <= 0) return [];
  const exclude = excludeTickets ?? new Set();
  return (rankedReady ?? []).filter((t) => !exclude.has(t.identifier)).slice(0, freeSlots);
}

// tallyByProject — counts occurrences of each team prefix in an iterable of
// ticket identifiers. Returns a plain object { "CTL": 2, "ADV": 1, … }.
function tallyByProject(ids) {
  const tally = {};
  for (const id of ids) {
    const p = teamOf(id);
    if (p) tally[p] = (tally[p] ?? 0) + 1;
  }
  return tally;
}

// selectDispatchablePerProject — CTL-706 ranked-walk selector that applies
// per-project cap + reserve guards AFTER the global free-slot ceiling.
//
// Reserve model: work-aware greedy. A project's reserve only protects its
// unmet demand when it has undispatched ready work. A candidate filling its
// OWN reserve (running[P] < reserveP) bypasses the reserve guard — it can
// never starve another project by claiming its own floor.
//
// With no perProject config (or an empty map) this is byte-for-byte
// equivalent to selectDispatchable.
export function selectDispatchablePerProject(
  rankedReady,
  excludeTickets,
  freeSlots,
  { perProject = {}, inFlight = new Set() } = {},
) {
  if (freeSlots <= 0) return [];
  const pp = perProject ?? {};
  if (Object.keys(pp).length === 0) {
    return selectDispatchable(rankedReady, excludeTickets, freeSlots);
  }

  const exclude = excludeTickets ?? new Set();
  const candidates = (rankedReady ?? []).filter((t) => !exclude.has(t.identifier));

  // Seed running counts from in-flight workers.
  const running = tallyByProject(inFlight);

  // Pre-compute per-project ready-remaining counts (work-bounded reserve demand).
  const readyRemaining = tallyByProject(candidates.map((t) => t.identifier));

  const selected = [];

  for (const t of candidates) {
    if (selected.length >= freeSlots) break;
    const P = teamOf(t.identifier) ?? "";

    // Cap guard: skip if this project is at its hard cap.
    const cap = pp[P]?.maxParallel;
    if (Number.isInteger(cap) && cap > 0 && (running[P] ?? 0) >= cap) {
      readyRemaining[P] = Math.max(0, (readyRemaining[P] ?? 0) - 1);
      continue;
    }

    const reserveP = Number.isInteger(pp[P]?.reserve) ? pp[P].reserve : 0;
    const runningP = running[P] ?? 0;

    // Reserve guard: only applies when P is already at or above its own reserve
    // (i.e. this dispatch consumes a *shared* slot, not P's own floor).
    if (runningP >= reserveP) {
      const remainingAfter = freeSlots - selected.length - 1;
      // Sum of unmet, work-bounded reserve demand from every OTHER project.
      let demandOthers = 0;
      for (const [Q, cfg] of Object.entries(pp)) {
        if (Q === P) continue;
        const reserveQ = Number.isInteger(cfg?.reserve) ? cfg.reserve : 0;
        const runningQ = running[Q] ?? 0;
        const unmetQ = Math.max(0, reserveQ - runningQ);
        const waitingQ = readyRemaining[Q] ?? 0;
        demandOthers += Math.min(unmetQ, waitingQ);
      }
      if (remainingAfter < demandOthers) {
        readyRemaining[P] = Math.max(0, (readyRemaining[P] ?? 0) - 1);
        continue;
      }
    }

    selected.push(t);
    running[P] = (running[P] ?? 0) + 1;
    readyRemaining[P] = Math.max(0, (readyRemaining[P] ?? 0) - 1);
  }

  return selected;
}

// buildPerProjectGauge — pure helper that assembles the per-tick slot-usage
// gauge object (CTL-706). Returns { freeSlots, perProject: { <KEY>: { inFlight,
// maxParallel?, reserve? } } } over the union of in-flight + configured projects.
export function buildPerProjectGauge(inFlight, perProject = {}, freeSlots) {
  const pp = perProject ?? {};
  const inFlightTally = tallyByProject(inFlight);
  const allKeys = new Set([...Object.keys(inFlightTally), ...Object.keys(pp)]);
  const gauge = {};
  for (const k of allKeys) {
    const entry = { inFlight: inFlightTally[k] ?? 0 };
    if (Number.isInteger(pp[k]?.maxParallel)) entry.maxParallel = pp[k].maxParallel;
    if (Number.isInteger(pp[k]?.reserve)) entry.reserve = pp[k].reserve;
    gauge[k] = entry;
  }
  return { freeSlots, perProject: gauge };
}

// ─── Phase 4: dispatch and FSM-driven phase advancement ───
//
// The dispatch adapter (defaultDispatch / dispatchTicket) lives in dispatch.mjs
// (CTL-565) so the monitor's →Triage one-shot dispatch shares the same seam.

// listStartedTickets — every ticket that already has a worker dir, in any
// status. The pull step excludes these so a finished/failed ticket is never
// re-pulled as new work (revive of a failed ticket is a separate owner's job).
export function listStartedTickets(orchDir) {
  try {
    return new Set(
      readdirSync(join(orchDir, "workers"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    );
  } catch {
    return new Set();
  }
}

// readAllEligibleTickets — concatenate every per-project eligible projection
// (~/catalyst/execution-core/eligible/*.json — the CTL-535 monitor's output).
// ENOENT on the dir is expected and stays silent; any other read error or a
// malformed projection is logged — a persistent upstream bug (the monitor
// writing bad JSON every reconcile) must not look like a healthy idle scheduler.
export function readAllEligibleTickets() {
  let files;
  try {
    files = readdirSync(getEligibleDir());
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn(
        { err: err.message, code: err.code, dir: getEligibleDir() },
        "scheduler: eligible dir unreadable — treating as empty"
      );
    }
    return []; // eligible dir not created yet
  }
  const all = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const proj = JSON.parse(readFileSync(join(getEligibleDir(), f), "utf8"));
      if (Array.isArray(proj?.tickets)) all.push(...proj.tickets);
    } catch (err) {
      log.warn(
        { err: err.message, file: f },
        "scheduler: malformed eligible projection — skipping"
      );
    }
  }
  return all;
}

// deriveAdvancement — pure. Given a ticket's phase→status signals, return the
// phase the FSM owes next, or null. The next phase is owed when the latest
// known phase is `done` and its transition() successor is a non-terminal phase
// with no signal yet. Advancement goes through phase-fsm.mjs — never a local
// copy of NEXT_PHASE.
// CTL-653: the optional second param injects the verify verdict + the
// event-counted remediate cycle count so the router can branch verify →
// remediate vs verify → review while staying pure (no I/O). Backward compatible:
// existing single-arg callers default to { verifyVerdict: undefined,
// remediateCycleCount: 0 }, which preserves the legacy verify → review edge.
export function deriveAdvancement(signals, { verifyVerdict, remediateCycleCount = 0 } = {}) {
  const sig = signals ?? {};
  let latest = null;
  for (const p of PHASES) if (p in sig) latest = p; // remediate ∉ PHASES → invisible here
  if (latest === null || sig[latest] !== "done") return null;

  // CTL-653: verdict routing at verify. A verdict-fail detours to remediate
  // (until the cycle cap); pass/null/undefined falls through to the normal
  // verify → review edge. The cap-and-escalate path returns null here — the
  // sweep's maybeEscalateRemediateExhausted owns the stall, not a dispatch.
  if (latest === "verify" && verifyVerdict === "fail") {
    if (remediateCycleCount >= REMEDIATE_CYCLE_CAP) return null; // exhausted → sweep stalls it
    if (REMEDIATE_PHASE in sig) return null; // remediate already dispatched this cycle
    return REMEDIATE_PHASE;
  }

  const next = transition(
    { phase: latest, reviveCount: 0, parkedFrom: null },
    { type: "complete" }
  );
  if (isTerminal(next)) return null; // pipeline reached monitor-deploy → done
  if (next.phase in sig) return null; // successor already dispatched
  return next.phase;
}

// REMEDIATE_CYCLE_FILES — the per-cycle signal/artifact files the sweep deletes
// to re-enter verify after a completed remediation (CTL-653). Limited to the
// three files that constitute one verify⇄remediate cycle; upstream signals
// (triage/research/plan/implement) and their artifacts are never touched.
const REMEDIATE_CYCLE_FILES = ["phase-verify.json", "phase-remediate.json", "verify.json"];

// maybeResetForRemediateCycle — CTL-653 re-entry. A completed remediate cycles
// back to a fresh verify, but deriveAdvancement's `next.phase in sig` guard
// blocks re-dispatching verify while its signal exists. Rather than special-
// casing the guard, reset the cycle by deleting the verify+remediate signals
// (and verify.json). The next deriveAdvancement then sees implement as the
// latest `done` phase and cleanly re-dispatches verify. The cycle count
// survives because it is event-counted (countRemediateCycles), not signal-stored.
// Returns true when a reset happened (so the caller re-reads the signals).
export function maybeResetForRemediateCycle(
  orchDir,
  ticket,
  { rm = rmSync, readSignals = readPhaseSignals } = {}
) {
  const sig = readSignals(orchDir, ticket);
  if (sig[REMEDIATE_PHASE] !== "done") return false;
  for (const f of REMEDIATE_CYCLE_FILES) {
    try {
      rm(join(orchDir, "workers", ticket, f), { force: true });
    } catch {
      // best-effort — a missing file is the desired end state anyway
    }
  }
  return true;
}

// maybeEscalateRemediateExhausted — CTL-653 cap. A verify verdict-fail with no
// remediation budget left escalates to terminal `stalled`, so the existing
// terminal sweep (this file, ~line 653) applies the `needs-human` label and
// frees the slot. Writes status:"stalled" onto the verify signal in place;
// idempotent (a signal already stalled is a no-op success). Returns true when
// the ticket is (or was already) escalated, so the caller skips its dispatch.
export function maybeEscalateRemediateExhausted(
  orchDir,
  ticket,
  signals,
  verdict,
  cycleCount,
  { writeFile = writeFileSync, readFile = readFileSync } = {}
) {
  if (signals.verify !== "done" || verdict !== "fail" || cycleCount < REMEDIATE_CYCLE_CAP) {
    return false;
  }
  const p = join(orchDir, "workers", ticket, "phase-verify.json");
  try {
    const cur = JSON.parse(readFile(p, "utf8"));
    if (cur.status === "stalled") return true; // idempotent
    writeFile(
      p,
      JSON.stringify({
        ...cur,
        status: "stalled",
        stalledReason: "remediate-cycle-cap-exhausted",
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    // best-effort — a missing/unreadable signal means nothing to stall
  }
  return true;
}

// safeWrite — run a best-effort Linear-write call (CTL-558). A write failure
// must never abort the tick: a thrown error is logged and swallowed. `ctx` is
// merged into the log line so the failing { ticket, phase } stays visible.
function safeWrite(fn, ctx) {
  try {
    fn();
  } catch (err) {
    log.warn({ ...ctx, err: err.message }, "scheduler: Linear write-back threw — continuing tick");
  }
}

// CTL-660: best-effort guard for the dispatch-lifecycle emitters. The default
// emitters (defaultAppendDispatchRequested/LaunchedEvent → appendEnvelopeBestEffort)
// already swallow IO errors and return false, but the emitters are an injection
// seam — a test or future caller could pass one that throws. An audit emit must
// NEVER gate or abort a dispatch decision, so isolate the call here.
function safeEmit(fn, arg, ctx) {
  try {
    fn(arg);
  } catch (err) {
    log.warn({ ...ctx, err: err.message }, "scheduler: dispatch-lifecycle emit threw — continuing tick");
  }
}

// CTL-585 labelOnce now lives in `label-guard.mjs` (CTL-638 re-home — see the
// import block at the top of this file). The shared module also hosts the
// per-(ticket, phase) escalation cool-down used by the recovery sweep.

// CTL-624: dispatch cool-down marker. Conceptually mirrors the labelOnce
// once-marker (workers/<T>/.linear-label-*), but with two deliberate
// differences: (1) the marker carries a timestamp and the guard is time-based —
// re-dispatch is suppressed only while now - failedAt < DISPATCH_COOLDOWN_MS, so
// the window self-heals once the upstream artifact appears (unlike labelOnce's
// permanent .skipped marker); (2) the marker lives in a dedicated
// orchDir/.dispatch-cooldowns/ dir, NOT under workers/<T>/. A new-work ticket
// refused at the entry phase has no worker dir yet; writing a marker into
// workers/<T>/ would manufacture one, and listStartedTickets (dir-existence)
// would then exclude the ticket from the new-work pull *forever* — dropping it
// silently instead of merely throttling re-dispatch. Keeping the marker off the
// workers/ tree leaves listStartedTickets / listInFlightTickets / readWorkerSignals
// semantics untouched, so the ticket stays eligible and re-dispatches after the window.
export function dispatchCooldownPath(orchDir, ticket, phase) {
  return join(orchDir, ".dispatch-cooldowns", `${ticket}-${phase}.json`);
}

export function inDispatchCooldown(orchDir, ticket, phase, now) {
  const p = dispatchCooldownPath(orchDir, ticket, phase);
  let failedAt;
  try {
    failedAt = JSON.parse(readFileSync(p, "utf8"))?.failedAt;
  } catch {
    return false; // absent / malformed → treat as no cool-down
  }
  if (typeof failedAt !== "number") return false;
  return now - failedAt < DISPATCH_COOLDOWN_MS;
}

export function recordDispatchFailure(orchDir, ticket, phase, code, now) {
  const dir = join(orchDir, ".dispatch-cooldowns");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dispatchCooldownPath(orchDir, ticket, phase),
      JSON.stringify({ phase, code, failedAt: now })
    );
  } catch (err) {
    // Never let a marker write crash the tick — worst case is the next tick
    // retries (the pre-CTL-624 behavior).
    log.warn(
      { ticket, phase, err: err.message },
      "scheduler: dispatch cool-down marker write failed — continuing"
    );
  }
}

export function clearDispatchCooldown(orchDir, ticket, phase) {
  try {
    rmSync(dispatchCooldownPath(orchDir, ticket, phase), { force: true });
  } catch {
    // best-effort — a stale marker just means one suppressed re-dispatch
  }
}

// CTL-611: post-dispatch verifier. A dispatch is only really successful if
// workers/<T>/phase-<P>.json was written with a non-empty bg_job_id and a
// runnable status. A --dry-run leak (no signal at all) or a mark_launch_failed
// half-write (status="dispatched"/"running" but bg_job_id=null) used to be
// silently treated as a real advance, leaving the orchestrator wedged. The
// returned {ok, reason} feeds the demotion path: on !ok the rc=0 result is
// reclassified as a failure with reason="verify_failed:<reason>" and a
// phase.dispatch.failed.<T> event fires.
export function verifyDispatchedSignal(orchDir, ticket, phase) {
  const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  let raw;
  try {
    raw = readFileSync(signalPath, "utf8");
  } catch {
    return { ok: false, reason: "signal_missing" };
  }
  let signal;
  try {
    signal = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "signal_unparseable" };
  }
  const status = signal?.status;
  if (status !== "dispatched" && status !== "running") {
    return { ok: false, reason: "status_not_runnable" };
  }
  const bgJob = signal?.bg_job_id;
  if (typeof bgJob !== "string" || bgJob.length === 0) {
    return { ok: false, reason: "bg_job_id_missing" };
  }
  return { ok: true };
}

// REQUIRED_WORKSPACE_LABELS — the flat labels the CTL-558 coordinator sweep
// writes. Must pre-exist in the Linear workspace; linearis has no
// `labels create`. CTL-585's preflight warns once at daemon start if it
// is missing, so an operator sees the contract gap before the per-tick label
// sweep starts (and so the missing-label short-circuit in labelOnce does not
// surprise a fresh operator).
const REQUIRED_WORKSPACE_LABELS = ["needs-human"];

// preflightWorkspaceLabels — best-effort daemon-start check. For each team,
// list the team's labels and warn once per missing expected label. `exec`
// defaults to a spawnSync wrapper that normalises the result shape; `log`
// defaults to the module logger. Never throws — a broken linearis (missing
// binary, network outage) logs a single info line and returns.
export function preflightWorkspaceLabels({
  teams,
  exec = defaultPreflightExec,
  log: logger = log,
} = {}) {
  if (!Array.isArray(teams) || teams.length === 0) return;
  for (const team of teams) {
    try {
      const { code, stdout, stderr } = exec("linearis", ["labels", "list", "--team", team]);
      if (code !== 0) {
        logger.info(
          { team, code, stderr },
          "scheduler: workspace-label preflight skipped — linearis labels list failed"
        );
        continue;
      }
      // linearis labels list emits JSON ({nodes: [{name, ...}, ...]}) — match
      // the parsing used in linear-query.mjs:100-106. A non-JSON stdout is
      // treated as a soft preflight skip, not a throw.
      let names = [];
      try {
        const parsed = JSON.parse(String(stdout || "{}"));
        names = (parsed?.nodes ?? []).map((n) => n?.name).filter(Boolean);
      } catch (err) {
        logger.info(
          { team, err: err.message },
          "scheduler: workspace-label preflight skipped — linearis stdout is not JSON"
        );
        continue;
      }
      const present = new Set(names);
      for (const label of REQUIRED_WORKSPACE_LABELS) {
        if (!present.has(label)) {
          logger.warn(
            { team, label },
            "scheduler: Linear workspace is missing required label — create it in the Linear UI; the label sweep will skip this label for this run"
          );
        }
      }
    } catch (err) {
      logger.info(
        { team, err: err.message },
        "scheduler: workspace-label preflight threw — swallowed"
      );
    }
  }
}

function defaultPreflightExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// teardownWorktreeOnce — remove a ticket's git worktree once it reaches
// terminal Done (CTL-582 Phase 4). The terminal sweep revisits every started
// ticket each tick, so a once-marker at workers/<T>/.worktree-removed makes
// teardown fire a single time. repoRoot is resolved from the central registry
// by the ticket's team. Best-effort: an unresolvable team or a thrown teardown
// is swallowed — never aborts the tick. The marker is written only on a
// confirmed teardown (worktree gone), so a transient git failure retries.
function teardownWorktreeOnce(orchDir, ticket, teardownWorktree) {
  const marker = join(orchDir, "workers", ticket, ".worktree-removed");
  if (existsSync(marker)) return;
  const entry = getProjectConfig(teamOf(ticket));
  if (!entry?.repoRoot) {
    // The codebase favors loud failures: a Done ticket whose team is absent
    // from the registry can never have its worktree resolved here — surface it
    // rather than silently leaking the worktree. No marker is written, so a
    // restored registry entry is retried on a later tick.
    log.warn(
      { ticket },
      "scheduler: worktree teardown deferred — ticket's team has no registry entry"
    );
    return;
  }
  try {
    if (teardownWorktree({ repoRoot: entry.repoRoot, ticket })) {
      writeFileSync(marker, "");
    }
  } catch (err) {
    log.warn({ ticket, err: err.message }, "scheduler: worktree teardown threw — continuing tick");
  }
}

// terminalDoneOnce — write the terminal `Done` Linear state for a ticket at
// most once for the run's lifetime (CTL-597). The terminal sweep revisits every
// started worker dir each tick, and applyTerminalDone → linear-transition.sh
// does an unconditional `linearis issues read` before it can decide the state
// already matches — so without a guard every terminal dir burns one Linear API
// read per tick, exhausting the rate-limit cap. A once-marker at
// workers/<T>/.terminal-done.applied (restart-safe — persists with the worker
// dir) records a confirmed apply, mirroring labelOnce / teardownWorktreeOnce.
// Best-effort: any throw is logged and swallowed, never aborting the tick.
function terminalDoneOnce(orchDir, ticket, writeStatus) {
  const marker = join(orchDir, "workers", ticket, ".terminal-done.applied");
  if (existsSync(marker)) return;
  try {
    const res = writeStatus.applyTerminalDone({ ticket });
    // Write the marker only on a confirmed apply — a failed write is retried
    // next tick. Note applyTerminalDone returns applied:true even for the
    // already-Done `action:"skipped"` outcome, so the marker lands on the first
    // confirming tick. A fake that returns undefined (test stubs) is treated as
    // success so the once-semantics stay testable without a real result.
    if (res === undefined || res?.applied) {
      writeFileSync(marker, "");
    }
  } catch (err) {
    log.warn(
      { ticket, err: err.message },
      "scheduler: terminal-Done write-back threw — continuing tick"
    );
  }
}

// schedulerTick — one pull cycle: (1) advancement sweep, (2) new-work pull,
// (3) terminal-Done sweep (CTL-558) + worktree teardown (CTL-582). Idempotent
// and restart-safe — derives every action from filesystem state. `exec` is the
// injectable seam for the D5 out-of-set blocker-state fetch; `writeStatus` is
// the injectable Linear-write seam (CTL-558); `teardownWorktree` is the
// injectable worktree-teardown seam (CTL-582) — both default to the real module.
export function schedulerTick(
  orchDir,
  {
    readEligible,
    dispatch = defaultDispatch,
    exec,
    writeStatus = linearWrite,
    teardownWorktree = defaultTeardownWorktree,
    reclaimDeadWork = defaultReclaimDeadWork,
    now = Date.now, // CTL-624: injectable clock for the dispatch cool-down
    cache, // CTL-634: opt-in out-of-set blocker state cache
    // CTL-665: the committed worker-slot concurrency knobs (maxParallel +
    // minParallel/maxParallelCeiling bounds), threaded from the daemon via
    // startScheduler → runningOpts → runTick. Empty {} preserves the legacy
    // state.json-only ceiling for every test that doesn't thread it.
    concurrency = {},
    // CTL-657: concurrency = the real count of live `background` claude agents,
    // NOT a scan of workers/ + signal files. A leaked-but-running worker freed
    // its slot on paper (signal flipped terminal while the process lived on) and
    // per-ticket duplicates went uncounted — so the daemon over-dispatched into
    // the 28GB pileup. Querying `claude agents` makes a still-alive worker hold
    // its slot. Interactive sessions are excluded (unlimited). Injectable for
    // tests so a unit tick need not shell out to `claude`.
    liveBackgroundCount = () => countBackgroundAgents(),
    // CTL-611: injectable verifier + audit-event emitter so tests can pin the
    // demotion path independently of fixture choice (fakeDispatch / recorder).
    verifyDispatched = verifyDispatchedSignal,
    appendDispatchFailedEvent = defaultAppendDispatchFailedEvent,
    // CTL-660: success-path lifecycle emitters. requested fires when the
    // scheduler DECIDES to dispatch; launched fires only after verifyDispatched
    // confirms a live worker. Both best-effort — no branch gates on the return.
    appendDispatchRequestedEvent = defaultAppendDispatchRequestedEvent,
    appendDispatchLaunchedEvent = defaultAppendDispatchLaunchedEvent,
    // CTL-702: injectable yield-file-skip emitter. Deduped by observedYieldFiles
    // (module-level set) so only the first observation per daemon lifetime fires.
    appendYieldFileSkipEvent = defaultAppendYieldFileSkipEvent,
    // CTL-705: preemption seams — injectable for tests, default to real helpers.
    killBgJob = defaultKillBgJob,
    appendPreemptedEvent = defaultAppendPreemptedEvent,
    appendResumedAfterPreemptionEvent = defaultAppendResumedAfterPreemptionEvent,
    // CTL-705 Phase 5: resume resolver — maps a dead bg_job_id to a claude
    // --resume UUID. Null return → cold re-dispatch (no --resume-session).
    resolveSession = defaultResolveSession,
  } = {}
) {
  // (0) Reclaim-dead-work sweep (CTL-574) — close phase signals whose bg worker
  // died but whose work was committed before the death. Runs BEFORE the
  // advancement sweep so a reclaimed phase advances the same tick. Iterates
  // every active worker signal (readWorkerSignals returns one per ticket — the
  // active, non-terminal-first phase) and asks reclaimDeadWork to decide.
  // Reclaim is a strict superset of "do nothing": only the dead+work-done case
  // mutates the signal; all other classes (terminal/running/unknown/not-done/
  // not-applicable) are zero-action no-ops.
  // CTL-587: reclaimDeadWork now returns up to 8 discriminators. The four
  // that callers can act on (HUD, daemon log) populate parallel arrays; the
  // others (noop, not-done, not-applicable, reclaim-failed, superseded-noop)
  // are silent because they describe "no externally-visible change" — the next
  // tick will re-evaluate. The 'reviveSuppressed' bucket is the storm-breaker
  // marker; 'escalated' fires `needs-human` via the per-phase recovery path.
  const reclaimed = [];
  const revived = [];
  const reviveSuppressed = [];
  const escalated = [];
  // CTL-643: drop terminal tickets from the reclaim attention set.
  // reclaimDeadWorkIfPossible already short-circuits on terminal signals
  // (recovery.mjs:~1009); filtering here eliminates iteration cost + the
  // log/audit churn that fed the HUD escalation storm (2/min) and lets the
  // per-tick cost match the in-flight set size, not the started-ticket set
  // size. listInFlightTickets defines in-flight as "has ≥1 signal AND is
  // neither pipeline-complete (monitor-deploy done/skipped) nor
  // failed/stalled/aborted" — exactly the set this sweep cares about.
  const inFlightTickets = listInFlightTickets(orchDir);

  // CTL-702: scan worker dirs for yield tombstones. Emit once per unique
  // absolute path per daemon lifetime (deduped via observedYieldFiles).
  try {
    const workersDirEntries = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
    for (const d of workersDirEntries) {
      if (!d.isDirectory()) continue;
      const ticket = d.name;
      for (const f of readdirSync(join(orchDir, "workers", ticket))) {
        if (!f.startsWith("phase-") || !f.endsWith(".json") || !f.includes("-yield-")) continue;
        const absPath = join(orchDir, "workers", ticket, f);
        if (observedYieldFiles.has(absPath)) continue;
        observedYieldFiles.add(absPath);
        appendYieldFileSkipEvent({ ticket, orchId: ticket, filename: f });
      }
    }
  } catch {
    // fail-open — a missing/unreadable workers dir does not abort the tick
  }

  for (const sig of readWorkerSignals(orchDir)) {
    if (!inFlightTickets.has(sig.ticket)) continue;
    // CTL-705: a parked ("preempted") worker is paused, not dead. Its signal
    // preserves the now-killed bg_job_id, so classifyWorker would route it
    // through the death trigger and reclaimDeadWork would falsely revive it —
    // spawning a duplicate AND defeating the resume sweep (1.5), the only path
    // that re-dispatches a parked ticket with --resume-session continuity
    // (CTL-690). The reclaim sweep runs BEFORE sweep 1.5, so without this guard
    // it wins the race every tick. (The advancement guard at the (1) sweep only
    // stops false advancement, not false reclaim — both are needed.)
    if (sig.status === PREEMPTED_STATUS) continue;
    try {
      const team = teamOf(sig.ticket);
      const repoRoot = team ? (getProjectConfig(team)?.repoRoot ?? null) : null;
      const r = reclaimDeadWork(orchDir, sig, { repoRoot });
      const entry = { ticket: sig.ticket, phase: sig.phase };
      switch (r) {
        case "reclaimed":
          reclaimed.push(entry);
          break;
        case "revived":
          revived.push(entry);
          break;
        case "revive-suppressed":
          reviveSuppressed.push(entry);
          break;
        case "escalated":
          escalated.push(entry);
          break;
        case "escalation-suppressed":
          // CTL-638: the per-(ticket, phase) cool-down throttled the audit event
          // and label write. Invisible by design — operators saw the original
          // escalation in events.jsonl already; surfacing this would re-recreate
          // the noise the cool-down exists to prevent.
          break;
        case "alive-quiet-suppressed":
          // CTL-610: the bg worker is alive (kill -0) but quiet on a long tool
          // call (the pre-first-output window for research/plan, or a long
          // synchronous Edit/Bash inside implement). Invisible by design — no
          // duplicate spawn, no state change; the next tick re-evaluates the
          // mtime + pidAlive pair. Surfacing it in result.revived / .escalated
          // / .reviveSuppressed would re-create the very revive-storm noise the
          // (C0) guard exists to suppress (and would re-feed the scheduler's own
          // fs.watch fast path via any audit-event write — CTL-638 lineage).
          break;
        default:
          // noop | not-done | not-applicable | reclaim-failed → invisible.
          // CTL-606: superseded-noop also buckets here — a dead predecessor signal
          // the ticket has already advanced past. Invisible by design (the active
          // phase is progressing normally); surfacing it would be noise.
          break;
      }
    } catch (err) {
      // CTL-702: per-worker isolation — one bad signal cannot abort the whole
      // tick. Log and continue to the next worker.
      log.warn(
        { ticket: sig.ticket, phase: sig.phase, step: "reclaim", err: err.message },
        "scheduler: per-worker step failed — skipping signal, continuing tick (CTL-702)",
      );
    }
  }

  // CTL-705: hoist eligible read here so both the preemption sweep (0.5) and
  // the new-work pull (2) share a single read per tick.
  const eligible = readEligible ? readEligible() : readAllEligibleTickets();

  // CTL-705: hoist the worker-slot ceiling + live background count to a SINGLE
  // read per tick, shared by the preemption sweep (0.5), the resume sweep (1.5),
  // and the new-work pull (2). `claude stop` does not deregister within the same
  // tick (a just-preempted worker's process lingers until the next agents scan),
  // so liveBackgroundCount is stable across all three sweeps — one read is
  // semantically correct AND avoids tripling the per-tick `claude agents --json`
  // subprocess cost on the hot daemon loop (was the root cause of the CTL-653
  // verify-remediate test timeout). freeSlots is recomputed arithmetically per
  // sweep (subtracting resumedCount in sweep 2) rather than re-shelling-out.
  const maxParallel = readMaxParallel(orchDir, concurrency);
  const liveCount = liveBackgroundCount();

  // (0.5) Preemption sweep — if slots are saturated AND the top-ranked queued
  // ticket out-ranks the lowest-ranked preemptable in-flight worker, stop that
  // worker and park it for resume when a slot frees. Safety guards prevent
  // thrash: non-preemptable phases, 60s min-runtime, implement quiet-window,
  // 30s hysteresis. Runs after reclaim (so a just-reclaimed slot is counted)
  // and before advancement (so a preempted signal isn't falsely advanced).
  {
    if (computeFreeSlots(maxParallel, liveCount) <= 0) {
      // Build the global ranking to find topQueued and potential victim.
      const ranking = buildGlobalRanking(orchDir, eligible);
      const topQueued = ranking.find((d) => !d.inFlight);
      // Victim candidates: in-flight, sorted worst-to-best (reverse ranking).
      const inFlightRanked = ranking.filter((d) => d.inFlight);
      // Scan from lowest-ranked in-flight (last in sorted array) toward highest.
      const nowMs = now();
      for (let i = inFlightRanked.length - 1; i >= 0; i--) {
        if (!topQueued) break; // no queued ticket wants a slot
        const candidate = inFlightRanked[i];
        // Only preempt if topQueued strictly out-ranks this candidate.
        if (compareTickets(topQueued, candidate) >= 0) break; // sorted, so remaining are worse

        // Read the candidate's active signal to get phase and startedAt.
        const signals = readPhaseSignals(orchDir, candidate.identifier);
        const activePhase = Object.entries(signals).reduce((best, [phase, status]) => {
          if (TERMINAL_SIGNAL_STATUSES.has(status)) return best;
          if (phase === TERMINAL_PHASE && (status === "done" || status === "skipped")) return best;
          const rank = STAGE_RANK[phase] ?? -1;
          return rank > (STAGE_RANK[best] ?? -1) ? phase : best;
        }, null);
        if (!activePhase) continue;

        // Guard: non-preemptable phase
        if (NON_PREEMPTABLE_PHASES.has(activePhase)) continue;

        const signalRaw = readPhaseSignalRaw(orchDir, candidate.identifier, activePhase);
        if (!signalRaw) continue;

        // Guard: min-runtime floor
        const startedMs = signalRaw.startedAt ? Date.parse(signalRaw.startedAt) : 0;
        if (startedMs > 0 && nowMs - startedMs < PREEMPT_MIN_RUNTIME_MS) continue;

        // Guard: implement quiet-window (mtime of the phase signal file)
        if (activePhase === "implement") {
          const signalPath = join(orchDir, "workers", candidate.identifier, `phase-${activePhase}.json`);
          try {
            const st = statSync(signalPath);
            if (nowMs - st.mtimeMs < PREEMPT_IMPLEMENT_QUIET_MS) continue;
          } catch {
            // can't stat → fail-open (skip the quiet-window guard)
          }
        }

        // Guard: hysteresis — must have out-ranked this candidate for ≥30s
        const hysteresisKey = `${topQueued.identifier}:${candidate.identifier}`;
        if (!rankedAboveSince.has(hysteresisKey)) {
          rankedAboveSince.set(hysteresisKey, nowMs);
          continue; // first observation this tick — start the clock
        }
        if (nowMs - rankedAboveSince.get(hysteresisKey) < PREEMPT_HYSTERESIS_MS) continue;

        // All guards passed — preempt this candidate.
        const bgJobId = signalRaw.bg_job_id;
        killBgJob({ bgJobId });

        // Atomically park the signal: status → "preempted", add parkedFrom + attentionReason.
        const signalPath = join(orchDir, "workers", candidate.identifier, `phase-${activePhase}.json`);
        try {
          const updated = {
            ...signalRaw,
            status: PREEMPTED_STATUS,
            parkedFrom: activePhase,
            attentionReason: "preempted-by-priority",
            updatedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
          };
          const tmp = `${signalPath}.tmp.${process.pid}`;
          writeFileSync(tmp, JSON.stringify(updated));
          renameSync(tmp, signalPath);
        } catch (err) {
          log.warn(
            { ticket: candidate.identifier, phase: activePhase, err: err.message },
            "scheduler: preemption signal write failed — skipping"
          );
          continue;
        }

        safeEmit(
          appendPreemptedEvent,
          {
            orchId: candidate.identifier,
            ticket: candidate.identifier,
            phase: activePhase,
            preemptedBy: topQueued.identifier,
            bgJobId,
          },
          { ticket: candidate.identifier, phase: activePhase }
        );

        rankedAboveSince.delete(hysteresisKey); // clear after successful preemption
        break; // one preemption per tick
      }

      // Prune hysteresis entries whose candidates are no longer lowest-ranked.
      // (Avoids stale entries from tickets that advanced or completed.)
      if (topQueued) {
        for (const [key] of rankedAboveSince) {
          const victimId = key.split(":")[1];
          if (!inFlightRanked.find((d) => d.identifier === victimId)) {
            rankedAboveSince.delete(key);
          }
        }
      }
    }
  }

  // (1) Advancement sweep — dispatch the FSM-owed next phase per in-flight ticket.
  // CTL-705: preempted workers are skipped — their active status is not "done" so
  // deriveAdvancement returns null, but an early continue makes the intent explicit
  // and provides a regression anchor (test 9 in the plan).
  const advanced = [];
  for (const ticket of listInFlightTickets(orchDir)) {
    // Skip parked (preempted) tickets — they re-enter via the resume sweep (1.5).
    const ticketSignals = readPhaseSignals(orchDir, ticket);
    if (Object.values(ticketSignals).some((s) => s === PREEMPTED_STATUS)) continue;

    // CTL-661 hole #2: snapshot the signals + the remediate worker's raw signal
    // BEFORE maybeResetForRemediateCycle deletes the verify+remediate signals,
    // so a remediate→verify re-entry can still name + reap the remediate worker
    // (the NEXT_PHASE inversion alone would wrongly pick the long-finished
    // implement worker, and the deleted signal would carry no bg_job_id).
    const preResetSignals = readPhaseSignals(orchDir, ticket);
    const remediateRaw = readPhaseSignalRaw(orchDir, ticket, REMEDIATE_PHASE);

    // CTL-653: re-enter verify after a completed remediation (deletes the cycle
    // signals so deriveAdvancement re-dispatches a fresh verify this tick).
    maybeResetForRemediateCycle(orchDir, ticket);

    const signals = readPhaseSignals(orchDir, ticket);
    // CTL-653: the verdict-router reads — verify.json verdict + event-counted
    // cycle budget. Injected into deriveAdvancement so the router stays pure.
    const verdict = readVerifyVerdict({ ticket, orchDir });
    const cycleCount = countRemediateCycles({ ticket });

    // CTL-653: cap reached → stall (needs-human via the terminal sweep below),
    // skip any dispatch for this ticket this tick.
    if (maybeEscalateRemediateExhausted(orchDir, ticket, signals, verdict, cycleCount)) continue;

    const next = deriveAdvancement(signals, {
      verifyVerdict: verdict,
      remediateCycleCount: cycleCount,
    });
    if (!next) continue;
    if (inDispatchCooldown(orchDir, ticket, next, now())) continue; // CTL-624: throttle refused re-dispatch
    // CTL-660: record the dispatch DECISION before the spawn. Best-effort.
    safeEmit(
      appendDispatchRequestedEvent,
      { orchId: ticket, ticket, target_phase: next, reason: "advance" },
      { ticket, phase: next }
    );
    const r = dispatchTicket(orchDir, ticket, next, { dispatch });
    if (r.code === 0) {
      // CTL-611: verify the dispatch actually produced a live worker before
      // declaring success. A --dry-run leak / mark_launch_failed half-write
      // returns rc=0 with no usable signal, which used to silently leave the
      // pipeline wedged. !ok demotes to failure (cool-down + event).
      const v = verifyDispatched(orchDir, ticket, next);
      if (v.ok) {
        clearDispatchCooldown(orchDir, ticket, next); // CTL-624: success clears any prior cool-down
        // CTL-660: record the VERIFIED launch. Re-read the signal for the
        // bg_job_id + worktreePath the launched worker wrote.
        const sig = readPhaseSignalRaw(orchDir, ticket, next);
        safeEmit(
          appendDispatchLaunchedEvent,
          {
            orchId: ticket,
            ticket,
            target_phase: next,
            bg_job_id: sig?.bg_job_id,
            worktree_path: sig?.worktreePath,
          },
          { ticket, phase: next }
        );
        advanced.push({ ticket, phase: next });
        // CTL-657 / CTL-661: stop the predecessor worker now that its successor
        // is live. resolveReapPredecessor reads the PRE-reset signals so the
        // verify⇄remediate detour edges name the correct just-finished worker;
        // remediateRaw supplies the bg_job_id the reset already deleted.
        emitPredecessorReap(orchDir, ticket, preResetSignals, next, { remediateRaw });
        // CTL-558: write the dispatched phase's mapped Linear status. Idempotent
        // (linear-transition.sh read-compares first); never aborts the tick.
        safeWrite(() => writeStatus.applyPhaseStatus({ ticket, phase: next }), {
          ticket,
          phase: next,
        });
      } else {
        // CTL-611 Gap 1 demotion: rc=0 but no live bg job. Same on-disk
        // effects as a real rc!=0 failure so the broker / HUD / operator can
        // see the drop.
        recordDispatchFailure(orchDir, ticket, next, 0, now());
        appendDispatchFailedEvent({
          orchId: ticket,
          ticket,
          target_phase: next,
          code: 0,
          reason: `verify_failed:${v.reason}`,
        });
        log.warn(
          { ticket, phase: next, verifyReason: v.reason },
          "scheduler: dispatched signal verification failed"
        );
      }
    } else {
      recordDispatchFailure(orchDir, ticket, next, r.code, now()); // CTL-624: arm the cool-down window
      // CTL-611 Gap 2: surface the silent drop as an event so the broker /
      // HUD / operator can react. Best-effort; failure is logged inside.
      appendDispatchFailedEvent({
        orchId: ticket,
        ticket,
        target_phase: next,
        code: r.code,
        reason: "dispatch_nonzero_exit",
      });
      log.warn({ ticket, phase: next, code: r.code }, "scheduler: advance dispatch failed");
    }
  }

  // (1.5) Resume-after-preemption sweep — re-dispatch parked ("preempted") tickets
  // at their parkedFrom phase when a slot frees. Parked tickets are ranked by
  // buildGlobalRanking and processed top-ranked first. Runs after advancement
  // (so a slot freed by an advanced ticket is credited here) and before new-work
  // pull (so a preempted ticket reclaims its slot ahead of brand-new work).
  let resumedCount = 0;
  {
    let resumeSlots = computeFreeSlots(maxParallel, liveCount);
    if (resumeSlots > 0) {
      // Collect parked tickets: in-flight tickets with status === PREEMPTED_STATUS.
      const parkedDescriptors = [];
      for (const ticket of listInFlightTickets(orchDir)) {
        const sigs = readPhaseSignals(orchDir, ticket);
        const parkedPhase = Object.entries(sigs).find(([, s]) => s === PREEMPTED_STATUS)?.[0];
        if (!parkedPhase) continue;
        const { priority, createdAt } = readWorkerPriority(orchDir, ticket);
        parkedDescriptors.push({
          identifier: ticket,
          priority,
          createdAt,
          stage: STAGE_RANK[parkedPhase] ?? -1,
          inFlight: true,
          parkedFrom: parkedPhase,
        });
      }
      const rankedParked = rankTickets(parkedDescriptors);

      for (const pd of rankedParked) {
        if (resumeSlots <= 0) break;
        const parkedPhase = pd.parkedFrom;
        const signalRaw = readPhaseSignalRaw(orchDir, pd.identifier, parkedPhase);
        const bgJobId = signalRaw?.bg_job_id;

        const resumeSession = resolveSession(bgJobId) ?? undefined;
        safeEmit(
          appendDispatchRequestedEvent,
          { orchId: pd.identifier, ticket: pd.identifier, target_phase: parkedPhase, reason: "resume-after-preemption" },
          { ticket: pd.identifier, phase: parkedPhase }
        );

        // Reset the signal to "stalled" so phase-agent-dispatch's idempotency
        // guard does not block re-dispatch (mirrors defaultReviveDispatch).
        const signalPath = join(orchDir, "workers", pd.identifier, `phase-${parkedPhase}.json`);
        try {
          const tmp = `${signalPath}.tmp.${process.pid}`;
          writeFileSync(tmp, JSON.stringify({
            ...(signalRaw ?? {}),
            status: "stalled",
            attentionReason: "resume-after-preemption",
            updatedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
          }));
          renameSync(tmp, signalPath);
        } catch (err) {
          log.warn({ ticket: pd.identifier, phase: parkedPhase, err: err.message }, "scheduler: resume signal reset failed");
          continue;
        }

        const r = dispatchTicket(orchDir, pd.identifier, parkedPhase, { dispatch, resumeSession });
        if (r.code === 0) {
          const v = verifyDispatched(orchDir, pd.identifier, parkedPhase);
          if (v.ok) {
            clearDispatchCooldown(orchDir, pd.identifier, parkedPhase);
            rankedAboveSince.delete(`${pd.identifier}:${pd.identifier}`); // clear any stale hysteresis
            const sig2 = readPhaseSignalRaw(orchDir, pd.identifier, parkedPhase);
            safeEmit(
              appendDispatchLaunchedEvent,
              { orchId: pd.identifier, ticket: pd.identifier, target_phase: parkedPhase, bg_job_id: sig2?.bg_job_id, worktree_path: sig2?.worktreePath },
              { ticket: pd.identifier, phase: parkedPhase }
            );
            safeEmit(
              appendResumedAfterPreemptionEvent,
              { orchId: pd.identifier, ticket: pd.identifier, phase: parkedPhase, resumeSession: resumeSession ?? null },
              { ticket: pd.identifier, phase: parkedPhase }
            );
            safeWrite(
              () => writeStatus.applyPhaseStatus({ ticket: pd.identifier, phase: parkedPhase }),
              { ticket: pd.identifier, phase: parkedPhase }
            );
            resumeSlots--;
            resumedCount++;
          } else {
            recordDispatchFailure(orchDir, pd.identifier, parkedPhase, 0, now());
            appendDispatchFailedEvent({
              orchId: pd.identifier, ticket: pd.identifier, target_phase: parkedPhase,
              code: 0, reason: `verify_failed:${v.reason}`,
            });
          }
        } else {
          recordDispatchFailure(orchDir, pd.identifier, parkedPhase, r.code, now());
          appendDispatchFailedEvent({
            orchId: pd.identifier, ticket: pd.identifier, target_phase: parkedPhase,
            code: r.code, reason: "dispatch_nonzero_exit",
          });
        }
      }
    }
  }

  // (2) New-work pull — fill free slots with top-ranked ready tickets. D5:
  // hydrate the live state of every out-of-set blocker first so a Ready ticket
  // blocked by a non-terminal out-of-set ticket is held back.
  // CTL-705: `eligible` is hoisted above sweep 0.5 — used by buildGlobalRanking there.
  const blockerStates = hydrateOutOfSetBlockers(eligible, { exec, cache });
  // CTL-634: surface the cache hit-rate once per tick. Log-line-only matches
  // the daemon's pino-only observability convention (schedulerTick's return
  // object is discarded by runTick, so a metric must be logged, not returned).
  if (cache) log.info(cache.stats(), "scheduler: cache stats");
  const ready = computeReadyTickets(eligible, { blockerStates });
  // CTL-657: the in-flight count is the live `background` claude-agents count,
  // not listInFlightTickets(orchDir).size. A worker that leaked (signal terminal
  // but process alive) still consumes a slot; a duplicate spawn is counted.
  // CTL-705: reuse the tick-hoisted liveCount (a single `claude agents --json`
  // read) instead of re-shelling-out — `claude stop` does not deregister within
  // the same tick, so the count is stable since sweep 0.5.
  const inFlightCount = liveCount;
  // CTL-665: config-first ceiling — a committed executionCore.maxParallel
  // (threaded via `concurrency`) wins over state.json; clamped to the bounds.
  // CTL-705: subtract resumed slots (sweep 1.5) so resume and new-work don't
  // both fill the same slot when claude stop hasn't deregistered yet. maxParallel
  // is the tick-hoisted readMaxParallel value (single read per tick).
  const freeSlots = Math.max(0, computeFreeSlots(maxParallel, inFlightCount) - resumedCount);
  // CTL-706: per-project caps + reserves gate selection AFTER ranking. With
  // no perProject config this is byte-for-byte selectDispatchable.
  // inFlightTickets was already computed above for the reclaim sweep.
  const selected = selectDispatchablePerProject(ready, listStartedTickets(orchDir), freeSlots, {
    perProject: concurrency?.perProject,
    inFlight: inFlightTickets,
  });
  // CTL-706: per-project slot-usage gauge (dashboarding). log-line-only,
  // matching the cache.stats() per-tick metric convention.
  if (concurrency?.perProject && Object.keys(concurrency.perProject).length > 0) {
    log.info(
      buildPerProjectGauge(inFlightTickets, concurrency.perProject, freeSlots),
      "scheduler: per-project slots",
    );
  }

  const dispatched = [];
  for (const t of selected) {
    if (inDispatchCooldown(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, now())) continue; // CTL-624: throttle refused re-dispatch
    // CTL-660: record the new-work dispatch DECISION before the spawn.
    safeEmit(
      appendDispatchRequestedEvent,
      {
        orchId: t.identifier,
        ticket: t.identifier,
        target_phase: NEW_WORK_ENTRY_PHASE,
        reason: "new-work",
      },
      { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE }
    );
    const r = dispatchTicket(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, { dispatch });
    if (r.code === 0) {
      // CTL-611: same Gap 1 verifier as the advancement sweep — a rc=0
      // without a live successor signal must be demoted.
      const v = verifyDispatched(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE);
      if (v.ok) {
        clearDispatchCooldown(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE); // CTL-624: success clears any prior cool-down
        // CTL-660: record the VERIFIED launch for the new ticket's entry phase.
        const sig = readPhaseSignalRaw(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE);
        safeEmit(
          appendDispatchLaunchedEvent,
          {
            orchId: t.identifier,
            ticket: t.identifier,
            target_phase: NEW_WORK_ENTRY_PHASE,
            bg_job_id: sig?.bg_job_id,
            worktree_path: sig?.worktreePath,
          },
          { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE }
        );
        dispatched.push(t.identifier);
        // CTL-705: persist priority + createdAt for the global rank, so
        // preemption decisions need no per-tick Linear API calls.
        writeWorkerPriority(orchDir, t.identifier, {
          priority: t.priority,
          createdAt: t.createdAt ?? null,
        });
        // CTL-558: write the entry-phase (`research`) status for the new ticket.
        safeWrite(
          () =>
            writeStatus.applyPhaseStatus({
              ticket: t.identifier,
              phase: NEW_WORK_ENTRY_PHASE,
            }),
          { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE }
        );
      } else {
        recordDispatchFailure(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, 0, now());
        appendDispatchFailedEvent({
          orchId: t.identifier,
          ticket: t.identifier,
          target_phase: NEW_WORK_ENTRY_PHASE,
          code: 0,
          reason: `verify_failed:${v.reason}`,
        });
        log.warn(
          { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE, verifyReason: v.reason },
          "scheduler: dispatched signal verification failed"
        );
      }
    } else {
      recordDispatchFailure(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, r.code, now()); // CTL-624: arm the cool-down window
      // CTL-611: Gap 2 entry-phase silent-drop event.
      appendDispatchFailedEvent({
        orchId: t.identifier,
        ticket: t.identifier,
        target_phase: NEW_WORK_ENTRY_PHASE,
        code: r.code,
        reason: "dispatch_nonzero_exit",
      });
      log.warn({ ticket: t.identifier, code: r.code }, "scheduler: dispatch failed");
    }
  }

  // (3) Terminal-Done + label sweep (CTL-558) — one pass over every started
  // ticket. deriveAdvancement returns null once monitor-deploy completes, so
  // terminal `Done` is not a dispatch — it needs this dedicated sweep. In the
  // same pass: apply the flat `needs-human` label when any phase signal is
  // `stalled` (D7 — the worker keeps its phase state, it does not bounce to
  // Triage). Status writes are idempotent via linear-transition.sh; label
  // writes are guarded once-per-run by labelOnce's marker file.
  for (const ticket of listStartedTickets(orchDir)) {
    const signals = readPhaseSignals(orchDir, ticket);
    // CTL-589 (CTL-512 followup): `skipped` is the second terminal status for
    // monitor-deploy — emitted when no GitHub Deployments arrive within the
    // probe timeout (the skipDeployVerification path). It must trigger the
    // same Linear Done write + worktree teardown as `done`, matching the
    // isTicketInFlight gate at line ~93. Without this, the ticket lingers
    // at `PR` in Linear and the worktree leaks on disk indefinitely.
    if (signals["monitor-deploy"] === "done" || signals["monitor-deploy"] === "skipped") {
      // CTL-597: once-marker guards the per-tick Linear read (was safeWrite-only).
      terminalDoneOnce(orchDir, ticket, writeStatus);
      // CTL-582: the ticket reached terminal Done — tear down its worktree.
      teardownWorktreeOnce(orchDir, ticket, teardownWorktree);
    }
    if (Object.values(signals).some((s) => s === "stalled")) {
      labelOnce(orchDir, ticket, "needs-human", writeStatus);
    }
  }

  return {
    reclaimed,
    revived,
    reviveSuppressed,
    escalated,
    advanced,
    dispatched,
    freeSlots,
    ready: ready.map((t) => t.identifier),
  };
}

// ─── Phase 5: the pull-loop daemon ───

// Periodic tick interval — the correctness backstop. The event fast path makes
// the daemon react sooner; this guarantees forward progress if events are missed.
const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 30_000;
// Debounce window — a burst of event-log appends coalesces into one tick.
const TICK_DEBOUNCE_MS = Number(process.env.SCHEDULER_DEBOUNCE_MS) || 2_000;

// CTL-624: per-(ticket,phase) dispatch cool-down. When a dispatch is refused
// (e.g. prior_artifact_missing → phase-agent-dispatch exit 2) the dispatcher
// writes no signal file, so isTicketInFlight frees the slot and the next
// debounced tick re-dispatches immediately — a 2–4 events/sec storm. A
// timestamped marker under workers/<T>/ throttles re-dispatch of the same
// (ticket,phase) to one attempt per window. Time-based (not a permanent
// .skipped marker like labelOnce) so it self-heals once the artifact appears.
const DISPATCH_COOLDOWN_MS = Number(process.env.SCHEDULER_DISPATCH_COOLDOWN_MS) || 60_000;

// --- daemon module state ---
let tickTimer = null;
let debounceTimer = null;
let watcher = null;
let runningOpts = null;

// CTL-702: observed yield tombstones for the lifetime of this daemon process.
// Keyed by absolute path so the same file across multiple ticks emits exactly
// one event. Cleared only on daemon restart (via __resetForTests in tests).
const observedYieldFiles = new Set();

function runTick() {
  try {
    // CTL-676 + CTL-678: hot-reload the concurrency knobs by re-reading the
    // project config at the top of every tick. When `configPath` is unset
    // (back-compat scheduler harnesses that never threaded it), fall back to
    // the boot-captured `concurrency` object — byte-for-byte the pre-CTL-676
    // behavior. When both `configPath` (Layer-1 seed) AND `layer2Path`
    // (machine-canonical Layer-2 override, ~/.config/catalyst/config.json)
    // are wired in (production), the merger picks per-field winners on each
    // tick — an operator can edit Layer-2 with no daemon restart. Both
    // readers are null/ENOENT/parse-error safe (return `{}`), so a malformed
    // mid-run edit fails open: the next `readMaxParallel` falls through to
    // state.json + the hardcoded default. Boot-resume keeps the boot-captured
    // object — it fires once before the scheduler starts and never re-reads.
    let concurrency;
    if (runningOpts.configPath) {
      const layer1 = readExecutionCoreConcurrency(runningOpts.configPath);
      const layer2 = runningOpts.layer2Path
        ? readExecutionCoreConcurrencyLayer2(runningOpts.layer2Path)
        : {};
      concurrency = mergeExecutionCoreConcurrency(layer1, layer2);
    } else {
      concurrency = runningOpts.concurrency;
    }
    schedulerTick(runningOpts.orchDir, {
      readEligible: runningOpts.readEligible,
      dispatch: runningOpts.dispatch,
      exec: runningOpts.exec,
      writeStatus: runningOpts.writeStatus,
      teardownWorktree: runningOpts.teardownWorktree,
      cache: runningOpts.cache, // CTL-634: shared out-of-set blocker state cache
      concurrency, // CTL-665 + CTL-676: per-tick re-read, then threaded into readMaxParallel
      // CTL-676: forward the optional liveBackgroundCount seam (test-only) so
      // a unit test can drive freeSlots deterministically without shelling
      // out to `claude agents`. Undefined here keeps the production default.
      liveBackgroundCount: runningOpts.liveBackgroundCount,
    });
  } catch (err) {
    // A tick must never crash the daemon — log and let the next tick retry.
    log.error({ err: err.message }, "scheduler: tick failed");
  }
}

function scheduleDebouncedTick(debounceMs) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runTick, debounceMs);
}

// startScheduler — immediate authoritative tick, arm the periodic timer, then
// start the event-log fast path. `dispatch` / `readEligible` / `exec` /
// `writeStatus` / `teardownWorktree` are injectable so a test drives a hermetic
// daemon (`exec` is the D5 blocker-state fetch seam, CTL-565; `writeStatus` is
// the CTL-558 Linear-write seam; `teardownWorktree` is the CTL-582 worktree
// seam — each undefined here defaults to the real module in schedulerTick).
export function startScheduler({
  orchDir,
  dispatch,
  readEligible,
  exec,
  writeStatus,
  teardownWorktree,
  cache, // CTL-634: shared out-of-set blocker state cache (from startDaemon)
  concurrency = {}, // CTL-665 + CTL-676: boot-captured executionCore knobs. When
  // `configPath` is also set (production wiring), runTick re-reads the live
  // file every tick and ignores this object; the boot-captured value is the
  // back-compat path for tests that never thread `configPath`.
  configPath = null, // CTL-676: when set, runTick re-reads concurrency from
  // this path per tick (hot-reload). Threaded from startDaemon, which resolves
  // it from CATALYST_CONFIG_FILE || <cwd>/.catalyst/config.json. Null in tests
  // that exercise the back-compat boot-captured-only shape.
  layer2Path = null, // CTL-678: when set (production wiring), runTick also
  // re-reads the machine-canonical Layer-2 file per tick and merges it
  // per-field over Layer-1. Null in tests that exercise the Layer-1-only
  // shape; the merger's both-empty path then returns Layer-1 verbatim.
  liveBackgroundCount, // CTL-676: optional test-only seam, forwarded to
  // schedulerTick where it defaults to countBackgroundAgents (the live
  // `claude agents --json` count). Symmetric with the existing dispatch /
  // exec / writeStatus / teardownWorktree seams on schedulerTick.
  preflight = preflightWorkspaceLabels, // CTL-585
  tickIntervalMs = TICK_INTERVAL_MS,
  debounceMs = TICK_DEBOUNCE_MS,
} = {}) {
  if (!orchDir) throw new Error("startScheduler: orchDir is required");
  runningOpts = {
    orchDir,
    dispatch,
    readEligible,
    exec,
    writeStatus,
    teardownWorktree,
    cache,
    concurrency,
    configPath, // CTL-676: per-tick Layer-1 re-read source
    layer2Path, // CTL-678: per-tick Layer-2 re-read source (host-wide override)
    liveBackgroundCount, // CTL-676: test seam
  };

  // CTL-585: warn once at startup if the Linear workspace lacks the labels
  // the CTL-558 sweep writes. Best-effort — never blocks startup.
  try {
    const teams = listProjects()
      .map((p) => p.team)
      .filter(Boolean);
    preflight({ teams });
  } catch (err) {
    log.info({ err: err.message }, "scheduler: preflight wrapper threw — swallowed");
  }

  runTick(); // authoritative initial pass
  tickTimer = setInterval(runTick, tickIntervalMs);

  // Event fast path: any change to the event log wakes a debounced tick. No
  // parsing — schedulerTick re-derives every action from filesystem state, so
  // "something changed, re-tick" is both correct and cheap.
  //
  // The event type is deliberately NOT filtered: macOS fs.watch on a directory
  // reports `rename` even for in-place appends, while Linux reports `change`.
  // Reacting to either keeps the fast path working on both platforms; the
  // periodic tick is the correctness backstop regardless.
  const eventsDir = dirname(getEventLogPath());
  mkdirSync(eventsDir, { recursive: true });
  watcher = watch(eventsDir, (_eventType, filename) => {
    if (filename !== null && filename !== basename(getEventLogPath())) return;
    scheduleDebouncedTick(debounceMs);
  });
}

// stopScheduler — clear the timer, the debounce timer, and the watcher.
// Idempotent and safe to call before startScheduler.
export function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  watcher?.close();
  watcher = null;
  runningOpts = null;
  rankedAboveSince.clear(); // CTL-705: reset hysteresis state on daemon stop
}

// __resetForTests — clear daemon state between unit tests. Not part of the
// public contract; the index.mjs barrel does not re-export it.
export function __resetForTests() {
  stopScheduler();
  observedYieldFiles.clear(); // CTL-702: reset per-lifetime dedup set between tests
  // rankedAboveSince is cleared by stopScheduler above (CTL-705)
}

// --- standalone entrypoint (operator dry-run / CTL-554 wires the real daemon) ---
function main() {
  const idx = process.argv.indexOf("--orch-dir");
  const orchDir = idx >= 0 ? process.argv[idx + 1] : process.env.CATALYST_ORCHESTRATOR_DIR;
  if (!orchDir) {
    console.error("usage: bun scheduler.mjs --orch-dir <path>");
    process.exit(1);
  }
  log.info({ orchDir }, "execution-core scheduler starting");
  startScheduler({ orchDir });
  const shutdown = (sig) => {
    log.info({ sig }, "execution-core scheduler shutting down");
    stopScheduler();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) main();
