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
import {
  analyzeDependencyGraph,
  referencedBlockerIds,
  buildDependencyEdges,
  DEFAULT_TERMINAL_STATUSES,
} from "../lib/dependency-graph.mjs";
// teamOf (CTL-838 cross-team guard) is imported from ./dispatch.mjs below.
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
// CTL workflow descriptor (provenance swap): the pipeline-shape constants
// (STAGE_RANK, TERMINAL_PHASE, NEW_WORK_ENTRY_PHASE, NON_PREEMPTABLE_PHASES) are
// derived from lib/workflow.default.json. STAGE_RANK + NON_PREEMPTABLE_PHASES are
// re-exported here for back-compat (scheduler.test.mjs imports them from here).
import {
  STAGE_RANK,
  TERMINAL_PHASE,
  NEW_WORK_ENTRY_PHASE,
  NON_PREEMPTABLE_PHASES,
} from "../lib/workflow-descriptor.mjs";
export { STAGE_RANK, NON_PREEMPTABLE_PHASES };
// CTL-653: the verdict-router reads (verify.json verdict + event-counted cycle
// budget) live here. deriveAdvancement stays pure — the impure reads happen in
// the sweep and are injected, so the router itself is unit-testable.
import { readVerifyVerdict } from "./work-done-probes.mjs";
import { countRemediateCycles, countTicketEventsInWindow } from "./event-scan.mjs";
import { rankTickets, compareTickets } from "./scheduler-rank.mjs";
import { defaultDispatch, dispatchTicket, teamOf } from "./dispatch.mjs";
import { fetchTicketState, fetchTicketsBatch, classifyTicketResolution, fetchTicketAssignee, isAssigneeClaimable } from "./linear-query.mjs";
import { getProjectConfig, listProjects } from "./registry.mjs";
// CTL-703: worktree teardown is now handled by the dedicated phase-teardown
// phase agent (the 10th pipeline phase), not the scheduler's terminal sweep.
// The gatedTeardownWorktree import is removed; the teardown phase agent
// re-implements the gate in bash (merge-confirmation evidence + worktree
// presweep + non-force `git worktree remove`) in phase-teardown/SKILL.md.
import { readWorkerSignals } from "./signal-reader.mjs";
// CTL-933: shadow belief-store fact collector (opt-in CATALYST_BELIEFS_SHADOW=1).
import { collectBeliefsTick } from "./beliefs/collector.mjs";
// CTL-642/758: the live PR-merged adapter. makePrView is the single gh
// `pr view` source of truth (shared with the scan CLI's makeScanAdapters), so
// the daemon's recovery short-circuit + reconcile backstop run the identical
// `gh -R <slug> pr view <n> --json state,mergeStateStatus,mergedAt,mergeCommit`
// call without copy-pasting it. Constructed ONCE per daemon boot (see runTick),
// never per-tick / per-ticket — the gh subprocess only fires from inside prView
// on the rare merged-zombie / drift path, not on construction.
import { makePrView } from "./scan-adapters.mjs";
import {
  countBackgroundAgents,
  getAgentsCached,
  isBgJobAlive as defaultIsBgJobAlive,
} from "./claude-agents.mjs";
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
  defaultAppendCooldownGcEvent,
  defaultAppendCooldownEscalatedEvent,
  defaultAppendPhaseAdvanceHeldEvent,
  defaultAppendRunawayEvent,
  defaultAppendOrphanDetectedEvent,
} from "./recovery.mjs";
// CTL-558: the deterministic Linear status/label write seam. The whole module
// is injected as `writeStatus` so tests pass fakes; production uses the real
// module (best-effort — every write swallows its own failures).
import * as linearWrite from "./linear-write.mjs";
// CTL-757: the canonical linear.state.write audit emitter. CALLER-EMITS at each
// scheduler write site (source/phase/reason known only here) — NEVER inside
// runTransition (would double-audit the triage path, which keeps its own
// phase.triage.linear-transition event). Best-effort: swallow-on-error.
import { appendLinearStateWriteEvent } from "./linear-state-write-event.mjs";
// CTL-642 + CTL-758: the SHARED Linear terminal-state predicate. isLinearTerminal
// ({Done,Canceled} — its OWN set) backs both the reconcile-backstop's
// "live state !terminal" check and the recovery short-circuit threaded into
// reclaimOpts below.
import { isLinearTerminal } from "./terminal-state.mjs";
// CTL-638: labelOnce moved out of this file into a shared leaf module so the
// recovery-sweep escalation path can use the same once-marker guard. Keeping
// labelOnce here would force recovery.mjs → scheduler.mjs to import it, but
// scheduler.mjs already imports reclaimDeadWorkIfPossible from recovery.mjs —
// a cycle. label-guard.mjs is the leaf module both can import.
import { labelOnce, clearStalledLabel } from "./label-guard.mjs";
import { processApprovedResumes } from "./boot-resume.mjs"; // CTL-644: per-tick approval poll
import { countReapOutcomes } from "./reaper-metrics.mjs";
import { log, getEligibleDir, getEventLogPath, getHostName, getClusterHosts } from "./config.mjs";
import { defaultCheckSequencing } from "./sequencing.mjs"; // CTL-537
import { ownedBy } from "./hrw.mjs"; // CTL-850: HRW ownership filter
import { claimDispatchSync } from "./cluster-claim-sync.mjs"; // CTL-850: cross-host claim soft-CAS

// The last pipeline phase — its `done` signal means the whole pipeline
// finished. `done` is otherwise phase-dependent: a `triage: done` signal still
// occupies a slot (the ticket is mid-pipeline), so isTicketInFlight checks the
// phase, not just the status.
// TERMINAL_PHASE ("teardown") is imported from workflow-descriptor.mjs (above).
// CTL-703: teardown is the 10th phase; monitor-deploy now advances to teardown.

// New work enters the pipeline at `research`: a Ready ticket has already been
// triaged (the →Triage watcher dispatched its triage agent — monitor.mjs). The
// scheduler never dispatches `triage`. CTL-565 Part B. Deliberately NOT
// PHASES[0] ("triage"); the FSM still owns chaining research → plan → … .
// NEW_WORK_ENTRY_PHASE ("research") is imported from workflow-descriptor.mjs (above).

// CTL-705: STAGE_RANK — integer stage index for every pipeline phase + remediate
// (higher = later = closer to done, for shortest-remaining-time-first preemption).
// Derived from each descriptor step's explicit `rank` (non-dense: remediate=4 sits
// between implement=3 and verify=5; key ORDER == [...PHASES, "remediate"], asserted
// by the drift guard in workflow-descriptor.test.mjs + scheduler.test.mjs).
// Imported + re-exported above from workflow-descriptor.mjs.

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
// readTriageEstimate — read workers/<T>/triage.json and return the numeric
// `.estimate` if it is one of the allowed Fibonacci points {1,3,5,8,13}
// (CTL-751). Returns null on missing file, unparseable JSON, absent field,
// or non-allowed value. Never throws.
const ALLOWED_ESTIMATE_POINTS_SET = new Set([1, 3, 5, 8, 13]);
function readTriageEstimate(orchDir, ticket) {
  try {
    const raw = readFileSync(join(orchDir, "workers", ticket, "triage.json"), "utf8");
    const { estimate } = JSON.parse(raw);
    return ALLOWED_ESTIMATE_POINTS_SET.has(estimate) ? estimate : null;
  } catch {
    return null;
  }
}

// CTL-755 STEP E — a TEAM-NNN identifier (the shape phase-triage scrapes from
// the ticket body). Used to drop prose-only tokens before resolving a dependency
// against Linear. Mirrors the skill's scrape regex (phase-triage/SKILL.md:167).
const TICKET_REF_RE = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

// readTriageDependencies — read workers/<T>/triage.json `.dependencies` and
// return the candidate dependency IDENTIFIERS (TEAM-NNN strings) the scheduler
// should validate + persist as durable blocked_by edges. The skill stays
// read-only (CTL-497/CTL-558): it scrapes the ids; the scheduler resolves +
// writes. Tolerant of BOTH shapes so a future skill enrichment is forward-
// compatible without a scheduler change:
//   - flat strings:        ["CTL-100", "PROSE-1"]            (current skill)
//   - rich descriptors:    [{ id: "CTL-100", exists: true }] (richer shape)
// Tokens that are not a valid TEAM-NNN identifier, the candidate itself
// (self-ref), or empty are dropped here; the per-blocker Linear-state validation
// (resolvable + non-terminal) + cycle-check happen at the STEP-E call site.
// Returns a de-duplicated array; never throws.
function readTriageDependencies(orchDir, ticket) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(orchDir, "workers", ticket, "triage.json"), "utf8"));
  } catch {
    return [];
  }
  const deps = Array.isArray(raw?.dependencies) ? raw.dependencies : [];
  const out = [];
  const seen = new Set();
  for (const d of deps) {
    const id = typeof d === "string" ? d : typeof d?.id === "string" ? d.id : null;
    if (!id || !TICKET_REF_RE.test(id)) continue; // prose-only / malformed → drop
    if (id === ticket) continue; // self-ref → drop
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// CTL-929: does triage.json EXPLICITLY declare a zero-dependency picture?
// A triaged-waiting candidate whose durable signal carries `dependencies: []`
// has a fully-known, unblocked dependency picture from disk — it needs no live
// Linear read to confirm it. Contrast readTriageDependencies, which returns []
// for BOTH an explicit empty array AND a missing/unreadable file; here we must
// distinguish them so a genuinely-UNKNOWN picture (missing/malformed file, or a
// non-array `dependencies`) still fails SAFE (held until a read succeeds).
// Never throws.
function triageDeclaresZeroDeps(orchDir, ticket) {
  try {
    const raw = JSON.parse(readFileSync(join(orchDir, "workers", ticket, "triage.json"), "utf8"));
    return Array.isArray(raw?.dependencies) && raw.dependencies.length === 0;
  } catch {
    return false; // missing / unreadable / malformed → unknown → fail safe
  }
}

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

// Phases that must never be preempted (descriptor steps with preemptable:false):
// monitor-deploy is a passive observer of deployment outcomes; triage runs once at
// pipeline entry and is brief. Imported + re-exported above from workflow-descriptor.mjs.

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

// resolveTargetSetpoint — CTL-770: resolve the autotuner's seek-to TARGET with
// host-over-repo layering. The HOST Layer-2 file may carry a NEW key
// `catalyst.orchestration.executionCore.targetParallel` (distinct from
// `maxParallel`, which the autotuner clobbers every tick as its live runtime
// mirror — reusing it for the target would be overwritten). When the host key is
// a positive integer it wins; otherwise fall back to Layer-1's committed
// `maxParallel`. Returns `undefined` when neither is set → the caller's
// convergence branches no-op (backward-compatible). Positive-int guard mirrors
// mergeExecutionCoreConcurrency (:463-465) so a malformed host value never zeroes
// the setpoint. The caller is responsible for core-bounding the result.
export function resolveTargetSetpoint(layer1 = {}, layer2 = {}) {
  const t = layer2?.targetParallel;
  if (Number.isInteger(t) && t > 0) return t;
  return layer1?.maxParallel;
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
export function clampToBounds(value, { minParallel, maxParallelCeiling } = {}) {
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

// emitTerminalWorkerReapOnce — CTL-695: nominate a terminal worker for reaping
// once per worker/phase. Covers the gaps the happy-path emitPredecessorReap
// (advance-success only) never reaches: self-exited failed/stalled workers and
// the final monitor-deploy worker. Once-marker prevents per-tick re-emission.
// The marker is written BEFORE the emit (optimistic) so a synchronous second
// tick sees it and skips — emitReapIntent uses appendFileSync (no await), so
// the file is already written before this function returns.
function emitTerminalWorkerReapOnce(orchDir, ticket, phase) {
  const marker = join(orchDir, "workers", ticket, `.terminal-reap-${phase}.applied`);
  if (existsSync(marker)) return;
  const raw = readPhaseSignalRaw(orchDir, ticket, phase);
  const bgJobId = raw?.bg_job_id;
  if (!bgJobId) return; // no bg session to stop (unit-test signal / new-work entry)
  writeFileSync(marker, ""); // optimistic pre-write: prevents re-spam even if emit fails
  emitReapIntent("phase.terminal.reap-requested", {
    ticket,
    phase,
    bgJobId,
    worktreePath: raw?.worktreePath,
    reason: "ctl-695-terminal-worker",
  }).catch(() => {}); // best-effort; marker already guards against re-emission
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
// CTL-634: the opt-in `cache` is threaded so the same out-of-set blocker is read
// at most once per TTL window across ticks. CTL-784: the per-blocker reads are
// now collapsed into ONE batched query (fetchBatch, the SAME cache-first
// fetchTicketsBatch the admission gate uses) — externalBlockers resolve in a
// single request, cache-first, instead of one `linearis issues read` each. A
// blocker the batch does not return (read failure / not-found) is ABSENT from
// the map → the UNFETCHED_BLOCKER_STATE sentinel, failing safe exactly as the
// per-id null read did. Absent a cache, each tick re-batches (one request).
export function hydrateOutOfSetBlockers(
  eligibleTickets,
  { fetchBatch = fetchTicketsBatch, cache } = {}
) {
  const list = eligibleTickets ?? [];
  const inSet = new Set(list.map((t) => t?.identifier).filter(Boolean));
  const externalBlockers = referencedBlockerIds(list).filter((id) => !inSet.has(id));
  const blockerStates = {};
  if (externalBlockers.length === 0) return blockerStates;
  // fetchBatch (production: fetchTicketsBatch) owns its own batch exec (the curl
  // GraphQL POST) — do NOT thread the scheduler's linearis `exec` here (wrong shape).
  const batch = fetchBatch(externalBlockers, { cache });
  for (const id of externalBlockers) {
    const desc = batch.get(id);
    blockerStates[id] = desc?.state ?? UNFETCHED_BLOCKER_STATE; // miss → non-terminal, fails safe
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
  // CTL-703: `skipped` is advancement-eligible for monitor-deploy ONLY.
  // monitor-deploy `skipped` must advance to teardown (just as `done` does),
  // so the pipeline can reach the dedicated teardown phase even when no deploy
  // event arrived before the timeout. Every OTHER phase keeps the
  // isTicketInFlight invariant: a stray mid-pipeline `skipped` holds the slot
  // (does NOT advance) so a producer bug can't silently leak past a phase.
  const latestStatus = sig[latest];
  const advanceEligible =
    latestStatus === "done" ||
    (latestStatus === "skipped" && latest === "monitor-deploy");
  if (latest === null || !advanceEligible) return null;

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
  if (isTerminal(next)) return null; // pipeline reached teardown → done (CTL-703)
  if (next.phase in sig) return null; // successor already dispatched
  return next.phase;
}

// REMEDIATE_CYCLE_FILES — the per-cycle signal/artifact files the sweep deletes
// to re-enter verify after a completed remediation (CTL-653). Limited to the
// three files that constitute one verify⇄remediate cycle; upstream signals
// (triage/research/plan/implement) and their artifacts are never touched.
const REMEDIATE_CYCLE_FILES = ["phase-verify.json", "phase-remediate.json", "verify.json"];

// REMEDIATE_CYCLE_CLAIM_PHASES — the cycle members whose CTL-736 single-flight
// claim tombstones (`<phase>.claim.<gen>`) must ALSO be dropped on a reset.
// GATE-0: the reset deletes the signal files above, so the re-dispatch derives a
// fresh generation 1 (phase-agent-dispatch reads the generation from the
// now-absent signal). A leftover `verify.claim.1` / `remediate.claim.1` from the
// prior cycle would collide on the O_EXCL create → claim-lost → the re-verify is
// silently suppressed and the self-healing cycle stalls to needs-human. The
// worktree-recreate path drops claims for exactly this reason
// (phase-agent-dispatch:735-739); the cycle reset must do the same.
const REMEDIATE_CYCLE_CLAIM_PHASES = ["verify", REMEDIATE_PHASE];

// maybeResetForRemediateCycle — CTL-653 re-entry. A completed remediate cycles
// back to a fresh verify, but deriveAdvancement's `next.phase in sig` guard
// blocks re-dispatching verify while its signal exists. Rather than special-
// casing the guard, reset the cycle by deleting the verify+remediate signals
// (and verify.json) AND their claim tombstones (GATE-0). The next
// deriveAdvancement then sees implement as the latest `done` phase and cleanly
// re-dispatches verify at a fresh, exclusive generation. The cycle count
// survives because it is event-counted (countRemediateCycles), not signal-stored.
// Returns true when a reset happened (so the caller re-reads the signals).
export function maybeResetForRemediateCycle(
  orchDir,
  ticket,
  { rm = rmSync, readSignals = readPhaseSignals, readdir = readdirSync } = {}
) {
  const sig = readSignals(orchDir, ticket);
  if (sig[REMEDIATE_PHASE] !== "done") return false;
  const workerDir = join(orchDir, "workers", ticket);
  for (const f of REMEDIATE_CYCLE_FILES) {
    try {
      rm(join(workerDir, f), { force: true });
    } catch {
      // best-effort — a missing file is the desired end state anyway
    }
  }
  // GATE-0: also drop the cycle members' claim tombstones so the re-dispatch's
  // fresh (no-signal ⇒ gen 1) claim is exclusive and wins instead of colliding.
  // CTL-736 Phase 3: AND drop their `.progress-<phase>` high-water markers, so the
  // fresh verify/remediate attempt is measured from zero — a stale high-water from
  // the prior cycle would otherwise false-STOP the new attempt on its first death.
  let workerEntries;
  try {
    workerEntries = readdir(workerDir);
  } catch {
    workerEntries = []; // worker dir gone — nothing to clean
  }
  for (const f of workerEntries) {
    const isCycleClaim = REMEDIATE_CYCLE_CLAIM_PHASES.some((p) => f.startsWith(`${p}.claim.`));
    const isCycleProgress = REMEDIATE_CYCLE_CLAIM_PHASES.some((p) => f === `.progress-${p}`);
    if (isCycleClaim || isCycleProgress) {
      try {
        rm(join(workerDir, f), { force: true });
      } catch {
        // best-effort
      }
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

// ─── CTL-755: admission-gate held-indicator labels ───
//
// A triage-complete ticket held back from the research promotion carries ONE of
// two dynamic labels so the hold is unmistakable on the orch-monitor board:
//   • "blocked" — ≥1 blocked_by dependency is non-terminal (not in readyIds).
//   • "waiting" — deps satisfied (in readyIds) but lost the priority/capacity
//                 selection this tick.
// These are converged ON A DIFF against the ticket's CURRENT labels via
// applyLabel/removeLabel (NOT labelOnce — labelOnce is apply-once-forever,
// reserved for needs-human/cycle members). A candidate that becomes admitted
// gets BOTH labels removed (clear-on-pickup). The two label names live here so
// the diff logic and any board reader share one source of truth.
export const HELD_LABEL_BLOCKED = "blocked";
export const HELD_LABEL_WAITING = "waiting";
const HELD_LABELS = [HELD_LABEL_BLOCKED, HELD_LABEL_WAITING];

// Terminal Linear states a blocker can be in (a blocker in one of these does NOT
// hold its dependent). Single source of truth: lib/dependency-graph.mjs
// DEFAULT_TERMINAL_STATUSES (the same set computeReadySet applies to admissionPool),
// imported so the held-classification + the readiness partition cannot drift apart.
const ADMISSION_TERMINAL_STATES = new Set(DEFAULT_TERMINAL_STATUSES);

// unmetBlockersFor — the non-terminal blocked_by blocker identifiers for ONE
// candidate, over the combined admission edge set. An in-set blocker is unmet
// unless its descriptor state is terminal; an out-of-set blocker is unmet when
// its hydrated state (blockerStates) is non-terminal (a failed/absent hydration
// is the non-terminal UNFETCHED sentinel → unmet, failing safe). Used to fill
// the phase.advance.held event's `blockers` array. Pure.
function unmetBlockersFor(candidateId, edges, poolById, blockerStates) {
  const unmet = [];
  for (const { from, to } of edges ?? []) {
    if (to !== candidateId) continue;
    const inSet = poolById.get(from);
    if (inSet) {
      if (!ADMISSION_TERMINAL_STATES.has(inSet?.state?.name)) unmet.push(from);
    } else if (from in (blockerStates ?? {})) {
      if (!ADMISSION_TERMINAL_STATES.has(blockerStates[from])) unmet.push(from);
    }
    // else: unknown out-of-set blocker, no hydrated state → non-blocking (legacy).
  }
  return unmet;
}

// convergeHeldLabel — apply/remove the held-indicator labels (blocked/waiting)
// on a DIFF so a steady-state held tick makes ZERO Linear writes (CTL-755
// ADDENDUM). `current` is the ticket's fresh label set (from fetchRelations);
// `desired` is one of HELD_LABEL_BLOCKED | HELD_LABEL_WAITING | null.
//
// CTL-834: the apply is COOL-DOWN-GATED. The prior version re-issued the
// remove+apply every ~22s tick; when the apply failed UNRECOVERABLY (the desired
// label is in an exclusive Linear group whose sibling is already on the ticket —
// "not exclusive child"), the label never landed, the diff was never satisfied,
// and the write re-fired forever (observed: 218 fails / 44 min, burning the
// Linear write quota — CTL-838 blocked↔needs-human, ADV-1295 blocked↔waiting).
// Now: if a recent apply of `desired` failed unrecoverably, inLabelCooldown
// short-circuits the whole convergence until LABEL_COOLDOWN_MS elapses
// (time-boxed, so it self-heals once the conflict clears — mirrors the CTL-624
// dispatch cool-down). The apply's {applied, reason} is captured directly (NOT
// via the result-discarding safeWrite) so the cool-down can arm. Returns the
// number of write calls issued (0 == idempotent no-op OR cooled-down). `orchDir`/
// `now` are optional so legacy callers / bare unit ticks keep the prior
// best-effort-every-tick behavior (the cool-down simply never arms).
export function convergeHeldLabel(ticket, current, desired, writeStatus, { orchDir, now = Date.now } = {}) {
  // CTL-834: back off if a recent apply of `desired` failed unrecoverably.
  if (orchDir && desired && inLabelCooldown(orchDir, ticket, desired, now())) {
    return 0;
  }
  const have = new Set(current ?? []);
  let writes = 0;
  // Remove any held label that is present but not desired.
  for (const label of HELD_LABELS) {
    if (label !== desired && have.has(label)) {
      safeWrite(() => writeStatus.removeLabel(ticket, label), { ticket, phase: "admission" });
      writes++;
    }
  }
  // Apply the desired label if it is not already present. Capture the result so
  // an unrecoverable failure arms the cool-down (applyLabel is sync + never
  // throws, returning {applied, reason}; a throw from a test fake is swallowed).
  if (desired && !have.has(desired)) {
    let res;
    try {
      res = writeStatus.applyLabel({ ticket, label: desired });
    } catch (err) {
      log.warn({ ticket, label: desired, err: err.message }, "convergeHeldLabel: applyLabel threw — continuing tick");
    }
    writes++;
    if (orchDir && res && res.applied === false && UNRECOVERABLE_LABEL_REASONS.has(res.reason)) {
      recordLabelCooldown(orchDir, ticket, desired, now());
      log.warn(
        { ticket, label: desired, reason: res.reason },
        "ctl-834: held-label apply unrecoverable — backing off (cool-down)"
      );
    }
  }
  return writes;
}

// UNRECOVERABLE_LABEL_REASONS — applyLabel reasons that can never land this
// daemon lifetime, so convergeHeldLabel arms a cool-down instead of re-issuing
// the write every tick (CTL-834). Mirrors label-guard.labelOnce's .skipped set.
const UNRECOVERABLE_LABEL_REASONS = new Set(["missing-label", "exclusive-conflict"]);

// CTL-834 held-label apply cool-down — the same time-boxed-marker shape as the
// CTL-624 dispatch cool-down: a per-(ticket,label) JSON marker carrying failedAt,
// kept OUTSIDE workers/<T>/ so it survives worker-dir GC (see dispatchCooldownPath
// + memory project_scheduler_marker_under_workers_excludes_ticket). The window
// self-heals so an exclusive conflict that later clears lets the label re-apply.
export function labelCooldownPath(orchDir, ticket, label) {
  return join(orchDir, ".label-cooldowns", `${ticket}-${label}.json`);
}
function inLabelCooldown(orchDir, ticket, label, now) {
  try {
    const marker = JSON.parse(readFileSync(labelCooldownPath(orchDir, ticket, label), "utf8"));
    return typeof marker.failedAt === "number" && now - marker.failedAt < LABEL_COOLDOWN_MS;
  } catch {
    return false;
  }
}
function recordLabelCooldown(orchDir, ticket, label, now) {
  const p = labelCooldownPath(orchDir, ticket, label);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ failedAt: now }));
}

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

// CTL-671: single reader for the cool-down marker, shared by inDispatchCooldown,
// recordDispatchFailure, and maybeTripCircuitBreaker (avoids three copies of the
// try/parse). Returns the parsed marker object, or null when absent/malformed.
function readCooldownMarker(orchDir, ticket, phase) {
  try {
    return JSON.parse(readFileSync(dispatchCooldownPath(orchDir, ticket, phase), "utf8"));
  } catch {
    return null; // absent / malformed → treat as no marker
  }
}

export function inDispatchCooldown(orchDir, ticket, phase, now) {
  const marker = readCooldownMarker(orchDir, ticket, phase);
  if (!marker) return false; // absent / malformed → no cool-down
  if (typeof marker.expiresAt === "number") return now < marker.expiresAt;
  // Legacy CTL-624 marker (failedAt only): preserve old behavior.
  if (typeof marker.failedAt === "number") return now - marker.failedAt < DISPATCH_COOLDOWN_MS;
  return false;
}

// CTL-671: extends the CTL-624 marker with a `consecutiveFailures` counter
// (read-modify-write, preserving every existing field — phase/code/failedAt). A
// pre-CTL-671 marker without the counter reads as 0 (the `?? 0` default) and
// self-upgrades on this write. clearDispatchCooldown rmSync's the whole marker,
// so a successful dispatch resets the counter for free.
export function recordDispatchFailure(orchDir, ticket, phase, code, now) {
  const dir = join(orchDir, ".dispatch-cooldowns");
  const path = dispatchCooldownPath(orchDir, ticket, phase);
  const prev = readCooldownMarker(orchDir, ticket, phase);
  let consecutiveFailures = 1;
  if (prev?.code === code && typeof prev.consecutiveFailures === "number") {
    consecutiveFailures = prev.consecutiveFailures + 1;
  }
  const ttl = PERMANENT_FAILURE_CODES.has(code)
    ? DISPATCH_PERMANENT_COOLDOWN_MS
    : DISPATCH_COOLDOWN_MS;
  const marker = { ticket, phase, code, failedAt: now, expiresAt: now + ttl, consecutiveFailures };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(marker));
  } catch (err) {
    log.warn(
      { ticket, phase, err: err.message },
      "scheduler: dispatch cool-down marker write failed — continuing"
    );
  }
  return marker;
}

export function clearDispatchCooldown(orchDir, ticket, phase) {
  try {
    rmSync(dispatchCooldownPath(orchDir, ticket, phase), { force: true });
  } catch {
    // best-effort — a stale marker just means one suppressed re-dispatch
  }
}

// CTL-713: garbage-collect expired cooldown markers whose ticket has left the
// eligible set (Done/Canceled). Both conditions required: an eligible ticket
// still failing must keep its marker so consecutiveFailures accrues toward
// escalation. Best-effort + never throws — a tick must never crash on a stray
// file. Returns [{ ticket, phase }] for the caller to emit events.
export function gcDispatchCooldowns(orchDir, eligibleIdentifiers, now) {
  const dir = join(orchDir, ".dispatch-cooldowns");
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const reaped = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    let marker;
    try { marker = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const phase = typeof marker?.phase === "string" ? marker.phase : null;
    let ticket = typeof marker?.ticket === "string" ? marker.ticket : null;
    if (!ticket && phase && f.endsWith(`-${phase}.json`)) {
      ticket = f.slice(0, f.length - `-${phase}.json`.length);
    }
    if (!ticket) continue;
    const expiresAt = typeof marker?.expiresAt === "number"
      ? marker.expiresAt
      : (typeof marker?.failedAt === "number" ? marker.failedAt + DISPATCH_COOLDOWN_MS : null);
    if (expiresAt === null || now < expiresAt) continue;
    if (eligibleIdentifiers.has(ticket)) continue;
    try { rmSync(p, { force: true }); reaped.push({ ticket, phase }); } catch { /* best-effort */ }
  }
  return reaped;
}

// CTL-713: consecutive-failure escalation. When a (ticket,phase) has failed N
// times in a row with the same code, apply needs-human via labelOnce and emit
// cooldown-escalated. labelOnce's .applied marker makes this idempotent.
export function maybeEscalateDispatchFailures(orchDir, marker, { writeStatus, appendEvent }) {
  if (!marker || marker.consecutiveFailures < DISPATCH_FAILURE_ESCALATION_THRESHOLD) return;
  labelOnce(orchDir, marker.ticket, "needs-human", writeStatus);
  appendEvent({
    ticket: marker.ticket, orchId: marker.ticket,
    target_phase: marker.phase, code: marker.code,
    consecutiveFailures: marker.consecutiveFailures,
  });
}

// CTL-712: the refused-dispatch path writes NO signal file (the artifact gate
// in phase-agent-dispatch precedes the signal write, and emit-complete's
// file-exists guard skips the update). So when the retry ceiling is hit we must
// CREATE workers/<T>/phase-<phase>.json as `stalled` — that single write makes
// isTicketInFlight false (loop stops) and trips the needs-human terminal sweep.
// Idempotent and best-effort: a write failure just means the next tick retries.
// See also: maybeEscalateRemediateExhausted (create-vs-mutate difference — kept
// separate per CTL-565 intentional-divergence convention).
export function escalateDispatchExhausted(
  orchDir,
  ticket,
  phase,
  { writeFile = writeFileSync, readFile = readFileSync } = {}
) {
  const dir = join(orchDir, "workers", ticket);
  const p = join(dir, `phase-${phase}.json`);
  let existing = {};
  try {
    existing = JSON.parse(readFile(p, "utf8")) ?? {};
  } catch {
    // absent / malformed → create fresh
  }
  if (existing.status === "stalled") return true; // idempotent
  try {
    mkdirSync(dir, { recursive: true });
    writeFile(
      p,
      JSON.stringify({
        ...existing,
        ticket,
        phase,
        status: "stalled",
        stalledReason: "prior-artifact-retry-exhausted",
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (err) {
    log.warn(
      { ticket, phase, err: err.message },
      "scheduler: escalateDispatchExhausted write failed — continuing"
    );
    return false;
  }
  clearDispatchCooldown(orchDir, ticket, phase); // marker no longer needed; stalled signal is the stop
  return true;
}

// CTL-671: shared terminal-`stalled` writer for the dispatch circuit breaker
// (Phase 1) and the phantom worker-dir sweep (Phase 3). Writes status:"stalled"
// + stalledReason onto an EXISTING phase signal in place (every other field
// preserved), so isTicketInFlight() drops the ticket and the terminal sweep
// applies `needs-human`. Idempotent (a signal already stalled is a no-op).
// Best-effort: a missing/unreadable signal returns false (nothing to stall) —
// the caller decides whether that still counts as "handled". Mirrors the shape
// of maybeEscalateRemediateExhausted's in-place write.
function writeTerminalStalled(
  orchDir,
  ticket,
  phase,
  reason,
  extra = {},
  { readFile = readFileSync, writeFile = writeFileSync } = {}
) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  let cur;
  try {
    cur = JSON.parse(readFile(p, "utf8"));
  } catch {
    return false; // no signal to stall
  }
  if (cur.status === "stalled") return true; // idempotent
  try {
    writeFile(
      p,
      JSON.stringify({
        ...cur,
        ...extra,
        status: "stalled",
        stalledReason: reason,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    return false; // best-effort — could not persist the stall
  }
  return true;
}

// CTL-671: trip the per-ticket dispatch circuit breaker. When the cool-down
// marker's consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD, write terminal
// `stalled` onto the ticket's phase signal (via writeTerminalStalled) so
// isTicketInFlight() drops it and the terminal sweep applies `needs-human`.
// Returns true at/above threshold REGARDLESS of whether a signal existed to
// stall — a refused dispatch never wrote a target-phase signal, but the caller
// must still stop re-dispatching. Below threshold (or no marker) → false.
// Idempotent. Best-effort.
export function maybeTripCircuitBreaker(orchDir, ticket, phase, opts = {}) {
  const n = readCooldownMarker(orchDir, ticket, phase)?.consecutiveFailures ?? 0;
  if (n < CIRCUIT_BREAKER_THRESHOLD) return false;
  writeTerminalStalled(
    orchDir,
    ticket,
    phase,
    "dispatch-circuit-breaker",
    { consecutiveFailures: n },
    opts
  );
  return true;
}

// CTL-671: quarantine a phantom worker dir to terminal `stalled`. Thin wrapper
// over writeTerminalStalled with reason "phantom-ticket". The phantom sweep
// (schedulerTick Pass 0a) only calls this after the full conjunction — Linear
// not-found AND not-eligible AND no live bg job — so a Linear outage (unknown)
// or a real in-flight ticket is never quarantined. Returns true when the signal
// is (or was already) stalled, false when there was no signal to stall.
function maybeQuarantinePhantom(orchDir, ticket, phase, opts = {}) {
  return writeTerminalStalled(orchDir, ticket, phase, "phantom-ticket", {}, opts);
}

// CTL-671: once-per-window guard for the runaway alert, mirroring the dispatch
// cool-down marker (timestamp + time-based window). Lives under
// orchDir/.runaway-alerts/<ticket>.json so it never manufactures a worker dir
// (same reasoning as the .dispatch-cooldowns placement, CTL-624). Best-effort.
function runawayAlertPath(orchDir, ticket) {
  return join(orchDir, ".runaway-alerts", `${ticket}.json`);
}

function inRunawayCooldown(orchDir, ticket, now) {
  let alertedAt;
  try {
    alertedAt = JSON.parse(readFileSync(runawayAlertPath(orchDir, ticket), "utf8"))?.alertedAt;
  } catch {
    return false; // absent / malformed → not in cool-down
  }
  if (typeof alertedAt !== "number") return false;
  return now - alertedAt < RUNAWAY_WINDOW_MS;
}

function recordRunawayAlert(orchDir, ticket, now) {
  const dir = join(orchDir, ".runaway-alerts");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(runawayAlertPath(orchDir, ticket), JSON.stringify({ ticket, alertedAt: now }));
  } catch (err) {
    log.warn({ ticket, err: err.message }, "scheduler: runaway-alert marker write failed — continuing");
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
// CTL-700 (Item A): read the reason the dispatch bash script recorded into the
// signal file so the scheduler's phase.dispatch.failed event carries the real
// reason instead of the generic "dispatch_nonzero_exit". The dispatch script
// writes .failureReason on the rebase/thoughts-conflict stall path and
// .attentionReason on launch failures. Read-with-fallback: returns null when
// the signal is absent, unparseable, or carries no reason — callers OR this
// with the legacy literal.
export function readDispatchFailureReason(orchDir, ticket, phase) {
  const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  let signal;
  try {
    signal = JSON.parse(readFileSync(signalPath, "utf8"));
  } catch {
    return null;
  }
  const reason = signal?.failureReason ?? signal?.attentionReason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

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

// REQUIRED_WORKSPACE_LABELS — the worker-status labels the daemon's escalation
// + admission-hold sweeps write. ALL THREE are WORKSPACE-scoped (team:null)
// members of the `worker-status` exclusive group (CTL-764) and must pre-exist;
// linearis has no `labels create`. CTL-585's preflight warns once at daemon
// start if one is missing, so an operator sees the contract gap before the
// per-tick label sweep starts (and so the missing-label short-circuit in
// labelOnce / convergeHeldLabel does not surprise a fresh operator).
//
//   • needs-human — the escalation label (labelOnce, scheduler/recovery).
//   • blocked / waiting — HELD_LABEL_BLOCKED / HELD_LABEL_WAITING, applied by
//     convergeHeldLabel for admission-hold indicators (CTL-874: the pre-CTL-874
//     set listed only needs-human, so a missing held label went undetected).
const REQUIRED_WORKSPACE_LABELS = ["needs-human", HELD_LABEL_BLOCKED, HELD_LABEL_WAITING];

// preflightWorkspaceLabels — best-effort daemon-start check. CTL-874: the
// required labels are WORKSPACE-scoped (team:null), so the pre-CTL-874
// `linearis labels list --team <team>` per-team query NEVER returned them and
// the preflight warned "missing required label" on EVERY boot for EVERY team
// even though the labels existed (and the runtime apply path, which lists
// without --team, applied them fine). The fix lists WORKSPACE-scoped labels
// ONCE via `--scope workspace` and warns per missing label (team-independent).
// `teams` is retained only as a "is any team configured?" gate so an
// unconfigured daemon stays a no-op. `exec` defaults to a spawnSync wrapper
// that normalises the result shape; `log` defaults to the module logger. Never
// throws — a broken linearis (missing binary, network outage) logs a single
// info line and returns.
export function preflightWorkspaceLabels({
  teams,
  exec = defaultPreflightExec,
  log: logger = log,
} = {}) {
  if (!Array.isArray(teams) || teams.length === 0) return;
  try {
    const { code, stdout, stderr } = exec("linearis", [
      "labels",
      "list",
      "--scope",
      "workspace",
      "--limit",
      "250",
    ]);
    if (code !== 0) {
      logger.info(
        { code, stderr },
        "scheduler: workspace-label preflight skipped — linearis labels list failed"
      );
      return;
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
        { err: err.message },
        "scheduler: workspace-label preflight skipped — linearis stdout is not JSON"
      );
      return;
    }
    const present = new Set(names);
    for (const label of REQUIRED_WORKSPACE_LABELS) {
      if (!present.has(label)) {
        logger.warn(
          { label },
          "scheduler: Linear workspace is missing required label — create it in the Linear UI; the label sweep will skip this label for this run"
        );
      }
    }
  } catch (err) {
    logger.info(
      { err: err.message },
      "scheduler: workspace-label preflight threw — swallowed"
    );
  }
}

function defaultPreflightExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// CTL-703: teardownWorktreeOnce is REMOVED. Worktree removal is now handled by
// the dedicated phase-teardown phase agent (the 10th pipeline phase). The
// scheduler no longer calls gatedTeardownWorktree directly; the teardown phase
// worker runs after monitor-deploy completes and performs the evidence-gated
// teardown as part of the normal phase-agent pipeline.

// terminalDoneOnce — write the terminal `Done` Linear state for a ticket at
// most once for the run's lifetime (CTL-597). The terminal sweep revisits every
// started worker dir each tick, and applyTerminalDone → linear-transition.sh
// does an unconditional `linearis issues read` before it can decide the state
// already matches — so without a guard every terminal dir burns one Linear API
// read per tick, exhausting the rate-limit cap. A once-marker at
// workers/<T>/.terminal-done.applied (restart-safe — persists with the worker
// dir) records a confirmed apply, mirroring labelOnce.
// Best-effort: any throw is logged and swallowed, never aborting the tick.
// CTL-757: the optional `emitStateWrite` callback (closed over schedulerTick's
// injected emitter) audits the terminal-sweep Done write. Optional so the
// once-semantics tests that call terminalDoneOnce directly need not supply it.
function terminalDoneOnce(orchDir, ticket, writeStatus, emitStateWrite) {
  const marker = join(orchDir, "workers", ticket, ".terminal-done.applied");
  if (existsSync(marker)) return;
  try {
    const res = writeStatus.applyTerminalDone({ ticket });
    // CTL-757: audit the terminal Done write (source=terminal-sweep). Emit even
    // when res is undefined (test stub) is skipped — emitStateWrite no-ops on a
    // falsy writerResult, so a stub-undefined result simply emits nothing.
    if (typeof emitStateWrite === "function") {
      emitStateWrite({ writerResult: res, ticket, phase: TERMINAL_PHASE, source: "terminal-sweep", orchId: ticket });
    }
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

// reconcileTerminalBackstop — CTL-758 defense-in-depth (the reconcile backstop).
// A ticket whose pipeline already reached terminal Done (the .terminal-done.applied
// marker exists) but whose LIVE Linear state has drifted BACK to a non-terminal
// state — a late phase-pr/advance echo un-completing it (CTL-549/550/749) — is
// re-Done'd here. The backward-write guard (CTL-758 in runTransition) refuses the
// daemon's OWN backward writes; this backstop catches a drift from ANY source
// (a webhook echo, an operator, a sibling process) and forces the forward Done
// write (which the guard explicitly permits: key === TERMINAL_LINEAR_KEY).
//
// Heavily rate-limited so it is cheap on the hot loop:
//   - GATE 1: only tickets with the .terminal-done.applied marker (pipeline
//     provably reached terminal) are even considered.
//   - GATE 2: the PR must be MERGED (prAdapter.prView). No prAdapter / no PR
//     number → the backstop is inert (the cheap Linear-only path cannot prove a
//     merge, so it stays conservative and does nothing).
//   - GATE 3: the cached live Linear read must be NON-terminal (else there is
//     nothing to fix — the common case is a no-op).
// The applyTerminalDone write itself rides the shared linearBreaker (defaultExec).
function reconcileTerminalBackstop(orchDir, ticket, signal, writeStatus, emitStateWrite, { cache, prAdapter, fetchState = fetchTicketState } = {}) {
  // GATE 1 — pipeline reached terminal (marker present).
  const marker = join(orchDir, "workers", ticket, ".terminal-done.applied");
  if (!existsSync(marker)) return;
  // GATE 2 — PR merged. Inert without a prAdapter + PR number.
  const pr = signal?.raw?.pr ?? signal?.pr ?? null;
  if (!prAdapter || typeof prAdapter.prView !== "function" || !pr?.number) return;
  let merged = false;
  try {
    const view = prAdapter.prView(ticket, pr);
    merged = !!(view && (view.state === "MERGED" || view.mergedAt != null));
  } catch {
    return; // fail-soft — a gh error never forces a write
  }
  if (!merged) return;
  // GATE 3 — live Linear state drifted back to non-terminal.
  let state;
  try {
    state = fetchState(ticket, { cache });
  } catch {
    return; // unreadable → fail-safe, do nothing
  }
  if (state == null || isLinearTerminal(state)) return; // already terminal or unreadable → no-op
  // Drift detected: force the forward Done write (the CTL-758 guard permits it).
  try {
    const res = writeStatus.applyTerminalDone({ ticket, cache });
    if (typeof emitStateWrite === "function") {
      emitStateWrite({ writerResult: res, ticket, phase: TERMINAL_PHASE, source: "reconcile-backstop", orchId: ticket });
    }
    log.warn(
      { ticket, driftedState: state },
      "ctl-758: reconcile backstop re-Done'd a merged ticket whose Linear state drifted back to non-terminal",
    );
  } catch (err) {
    log.warn(
      { ticket, err: err.message },
      "scheduler: reconcile-backstop Done write threw — continuing tick",
    );
  }
}

// emitOrphanDetectedOnce — CTL-868 route (B) of the orphan-reconcile sweep. A
// ticket with a `stalled` phase signal has exhausted automatic recovery: the
// reclaim sweep (reclaimDeadWorkIfPossible) has already stopped the dead worker
// and the sweep applies needs-human. Emit ONE canonical
// phase.<phase>.orphan-detected.<ticket> event so the orch-monitor dashboard can
// surface the orphan instead of it hiding behind a buried label, then drop a
// marker so the hot loop never re-emits. Best-effort: a failed append leaves the
// marker absent so it retries next tick; an unexpected throw never aborts the tick.
//
// SCOPE NOTE: this covers tickets that still have a worker dir (listStartedTickets).
// The dir-less stranded case — a ticket that left Todo with NO worker dir at all
// (e.g. a research=stalled zombie reaped to nothing) — needs a working-state Linear
// query and is the CTL-808 Reconciler's job, which this ticket's RCA notes subsumes
// the full sweep; re-implementing it here would duplicate CTL-808 (see CTL-870).
function emitOrphanDetectedOnce(orchDir, ticket, signals, appendOrphanDetectedEvent) {
  const marker = join(orchDir, "workers", ticket, ".orphan-detected.applied");
  if (existsSync(marker)) return;
  const stalledPhases = Object.entries(signals)
    .filter(([, s]) => s === "stalled")
    .map(([p]) => p);
  if (stalledPhases.length === 0) return;
  try {
    const ok = appendOrphanDetectedEvent({
      phase: stalledPhases[0],
      ticket,
      orchId: ticket,
      reason: "stalled-no-recovery",
      stalled_phases: stalledPhases,
    });
    if (ok !== false) writeFileSync(marker, "");
  } catch (err) {
    log.warn({ ticket, err: err.message }, "ctl-868: orphan-detected emit threw — continuing tick");
  }
}

// schedulerTick — one pull cycle: (1) advancement sweep, (2) new-work pull,
// (3) terminal-Done sweep (CTL-558). Idempotent and restart-safe — derives
// every action from filesystem state. `exec` is the injectable seam for the
// D5 out-of-set blocker-state fetch; `writeStatus` is the injectable Linear-
// write seam (CTL-558). CTL-703: worktree teardown is now handled by the
// dedicated phase-teardown phase agent, not the scheduler sweep.
export function schedulerTick(
  orchDir,
  {
    readEligible,
    dispatch = defaultDispatch,
    exec,
    writeStatus = linearWrite,
    reclaimDeadWork = defaultReclaimDeadWork,
    now = Date.now, // CTL-624: injectable clock for the dispatch cool-down
    cache, // CTL-634: opt-in out-of-set blocker state cache
    // CTL-736 Phase 3: the CTL-735 per-tick revive cap (perTickReviveCap /
    // reviveBudgetRemaining) is DELETED. The progress gate + Phase-1 O_EXCL claim
    // bound the mass-revive storm structurally, so the sweep no longer threads a
    // per-tick budget into reclaimDeadWork.
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
    // CTL-731 Phase 00 / CTL-736: `livenessIsFresh` gates new-work admission — a
    // stale/never-populated `claude agents` snapshot means the live count is
    // untrustworthy, so we HOLD new dispatch (fail-safe, never over-spawn) while
    // advancement of in-flight phases continues. Defaults to fresh so existing
    // tests (which inject only liveBackgroundCount) dispatch exactly as before.
    // (The companion `livenessSnapshot` seam that bound the shared agents list
    // into the per-worker reclaim liveness was removed with CTL-736: the reclaim
    // death trigger now reads each worker's local state.json and never consults
    // the snapshot.)
    livenessIsFresh = () => true,
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
    // CTL-713: GC + escalation emitters. Injectable for tests.
    appendCooldownGcEvent = defaultAppendCooldownGcEvent,
    appendCooldownEscalatedEvent = defaultAppendCooldownEscalatedEvent,
    // CTL-868 — orphan-detected emitter (route B observability). Injectable; tests
    // pass a spy, production uses the canonical unified-event-log appender.
    appendOrphanDetectedEvent = defaultAppendOrphanDetectedEvent,
    // CTL-537: sequencing seam. Default undefined → the new-work gate is skipped
    // entirely (byte-for-byte legacy dispatch for every test that doesn't inject
    // it). Production wires defaultCheckSequencing via runTick/startScheduler.
    checkSequencing = undefined,
    // CTL-755/784: admission-gate hydration seam — resolves the live state +
    // relations + priority + labels for a SET of tickets in ONE batched,
    // cache-first request (fetchTicketsBatch → Map<id, descriptor>). Used by
    // STEP A.3 (triaged-waiting candidates), STEP E (deps), and threaded into
    // both hydrateOutOfSetBlockers calls. Defaults to the real batch helper;
    // tests inject a stub `(ids) => Map<id, descriptor>` so a tick never shells out.
    fetchBatch = fetchTicketsBatch,
    // CTL-755: held-indicator audit emitter — phase.advance.held.<ticket>.
    // Best-effort, only-on-state-change. Mirrors appendDispatchRequestedEvent.
    appendPhaseAdvanceHeldEvent = defaultAppendPhaseAdvanceHeldEvent,
    // CTL-757: canonical linear.state.write audit emitter, injectable for tests.
    // Caller-emitted at the 4 scheduler write sites (scheduler-advance,
    // preemption-resume, terminal-sweep, reconcile-backstop) via the emitStateWrite
    // helper below; NEVER fired on the triage path. (`parked-redispatch` is NOT a
    // distinct source tag — slice-1's deviation note: the parked re-dispatch reuses
    // the scheduler-advance / preemption-resume sites, it is not its own write.)
    appendStateWriteEvent = appendLinearStateWriteEvent,
    // CTL-642/758: PR-merged adapter for the recovery terminal short-circuit's
    // optional second check (merged-but-not-yet-Done zombie) AND the reconcile
    // backstop's gate-2 merged check. Default undefined here keeps every legacy
    // unit tick that doesn't thread it on the cheap Linear-terminal read ONLY;
    // PRODUCTION wires the real makePrView-backed adapter via startScheduler →
    // runningOpts.prAdapter → runTick, so both paths fire live. Injectable so
    // tests can exercise the pr-merged branch without shelling out to `gh`.
    prAdapter = undefined,
    // CTL-671: phantom worker-dir validity sweep seams. classifyResolution is
    // the 3-valued Linear probe (exists|not-found|unknown); isBgJobAlive maps a
    // dead worker's bg_job_id to a live `claude agents` session. The DEFAULTS
    // here are deliberately SAFE no-ops (resolution always "unknown", liveness
    // always alive) so a bare unit tick never shells out to linearis /
    // `claude agents` and never quarantines. The daemon (runTick) injects the
    // real classifyTicketResolution + isBgJobAlive to arm the sweep in
    // production; sweep-specific tests inject their own stubs.
    classifyResolution = () => "unknown",
    isBgJobAlive = () => true,
    // CTL-823: the daemon's durable-descriptor-store reader; threaded into the
    // fetchState injections below. undefined in bare unit ticks (fail-open —
    // fetchTicketState without gateway behaves exactly as before).
    gateway = undefined,
    // CTL-781: respect-assignment + self-assign. botUserIds is the Set of known
    // bot UUIDs (predicate membership); botWriteId is the single orchestrator
    // UUID written as assignee on claim. undefined / empty Set → the gate and
    // the write are both skipped (fail-open, CTL-749 convention) — every
    // existing test and unconfigured install behaves byte-for-byte as before.
    botUserIds = undefined,
    botWriteId = undefined,
    // CTL-781: injectable assignee read so tests never shell out.
    fetchAssignee = fetchTicketAssignee,
    // CTL-671: runaway-alert seams. countTicketEvents reads the unified event
    // log (safe in tests — CATALYST_DIR is redirected), so it defaults to the
    // real scan; appendRunawayEvent writes the canonical alert. Both injectable
    // for hermetic unit assertions.
    countTicketEvents = countTicketEventsInWindow,
    appendRunawayEvent = defaultAppendRunawayEvent,
    // CTL-850: cross-host coordination seams. `hosts` is the cluster roster and
    // `hostName` this host's coordination name; left undefined they resolve to
    // the real getClusterHosts()/getHostName() (a single-host fallback when
    // .catalyst/hosts.json is absent), so every existing single-host install +
    // bare unit tick is unaffected. `claimDispatch` is the synchronous soft-CAS
    // claim seam — a spawnSync bridge over cluster-claim.mjs — invoked ONLY when
    // the roster has >1 host. Tests inject a fixed roster + a recorder to drive
    // the multi-host HRW-filter and claim-lost paths without touching Linear.
    hosts = undefined,
    hostName = undefined,
    claimDispatch = claimDispatchSync,
  } = {}
) {
  // CTL-850: resolve this host + the cluster roster ONCE per tick (cheap
  // readFileSync; a per-tick read lets `hosts.json` edits take effect without a
  // daemon restart). multiHost gates the Linear-touching claim: a single-host
  // roster makes the HRW filter an identity AND skips the claim entirely, so the
  // coordination wiring is an exact no-op until a 2nd host joins the roster.
  const roster = hosts ?? getClusterHosts();
  const self = hostName ?? getHostName();
  const multiHost = roster.length > 1;
  // CTL-757: emitStateWrite — caller-emit the canonical linear.state.write audit
  // event for ONE scheduler write site. `writerResult` is the runTransition return
  // ({applied, reason, from_state, to_state, ...}) from applyPhaseStatus /
  // applyTerminalDone; null (a no-status-key/short-circuited write) emits nothing.
  // `source` tags WHICH site fired (scheduler-advance | preemption-resume |
  // terminal-sweep | reconcile-backstop). Wrapped in safeEmit
  // so an emitter throw never aborts the tick. NEVER call this on the triage path.
  function emitStateWrite({ writerResult, ticket, phase, source, orchId }) {
    if (!writerResult) return;
    safeEmit(
      appendStateWriteEvent,
      {
        ticket,
        orchId: orchId ?? ticket,
        phase,
        source,
        from_state: writerResult.from_state ?? null,
        to_state: writerResult.to_state ?? null,
        transition_key: writerResult.action ?? null,
        applied: writerResult.applied ?? false,
        verified: writerResult.verified ?? false,
        reason: writerResult.reason ?? null,
      },
      { ticket, phase, source }
    );
  }

  // ─── CTL-826: dispatchAndVerify — the shared dispatch→verify core ───
  //
  // Collapses the ~240 lines of identical "decide → dispatch → verify the worker
  // landed → on success clear-cooldown + re-read signal + emit launched / on
  // failure run the cool-down + circuit-breaker + escalation ladder" skeleton that
  // recurred VERBATIM across the three scheduler dispatch sweeps:
  //   • Pass 1   advancement          (advance dispatch)
  //   • Pass 1.5 resume-after-preempt (reduced failure ladder)
  //   • Pass 2   new-work pull        (entry-phase dispatch)
  //
  // PURE REFACTOR — zero behavior change. It owns ONLY the byte-identical core
  // (steps 1–4 of the ticket). Every per-site DIVERGENCE stays at the call site,
  // driven off the returned `{ ok, code, reason, signal }`:
  //   • success follow-ups (advanced.push / promotedCount++ / emitPredecessorReap /
  //     applyPhaseStatus+emitStateWrite / applyEstimate / writeWorkerPriority /
  //     applyAssignee / appendResumedAfterPreemptionEvent / rankedAboveSince.delete /
  //     resumeSlots--/resumedCount++ / dispatched.push)
  //   • Pass 1's CTL-695 emitPredecessorReap on the FAILURE branches
  //
  // Ordering is preserved exactly: the requested-emit fires first, then the
  // optional `preDispatch` hook (Pass 1.5's signal reset-to-stalled, which may
  // abort the iteration), then dispatchTicket → verifyDispatched. The launched
  // re-read returns the signal so the caller need not re-read it.
  //
  // `fullFailureLadder` selects the failure handling: Pass 1 & 2 run the full
  // ladder (recordDispatchFailure → escalateDispatchExhausted at the retry ceiling
  // → maybeTripCircuitBreaker → appendDispatchFailedEvent with expiresAt +
  // consecutiveFailures → maybeEscalateDispatchFailures); Pass 1.5 keeps its
  // deliberately reduced ladder (recordDispatchFailure → appendDispatchFailedEvent
  // WITHOUT the counter/cooldown-escalation fields) by passing false.
  //
  // Returns: { ok, code, reason, signal } on a real dispatch attempt, or
  // { aborted: true } when preDispatch vetoed the iteration (caller `continue`s).
  function dispatchAndVerify(
    orchDir,
    ticket,
    phase,
    {
      dispatch,
      resumeSession, // optional; dispatchTicket only adds the key when truthy
      requestedReason, // reason field for the dispatch-requested event
      preDispatch, // optional () => boolean; a false return aborts (→ { aborted: true })
      fullFailureLadder = true, // Pass 1.5 passes false for its reduced ladder
      failLogMsg, // optional log.warn message for the rc!=0 branch (omit → no log)
      failLogIncludePhase = true, // Pass 2's original rc!=0 log omits the phase field
    }
  ) {
    // CTL-660: record the dispatch DECISION before the spawn. Best-effort.
    safeEmit(
      appendDispatchRequestedEvent,
      { orchId: ticket, ticket, target_phase: phase, reason: requestedReason },
      { ticket, phase }
    );
    // Pass 1.5: reset the parked signal to "stalled" before dispatch; a false
    // return (reset write failed) aborts so the caller can `continue`.
    if (preDispatch && preDispatch() === false) return { aborted: true };

    const r = dispatchTicket(orchDir, ticket, phase, { dispatch, resumeSession });
    if (r.code === 0) {
      // CTL-611: verify the dispatch actually produced a live worker before
      // declaring success. A --dry-run leak / mark_launch_failed half-write
      // returns rc=0 with no usable signal; !ok demotes to failure.
      const v = verifyDispatched(orchDir, ticket, phase);
      if (v.ok) {
        clearDispatchCooldown(orchDir, ticket, phase); // CTL-624: success clears any prior cool-down
        // CTL-660: record the VERIFIED launch. Re-read the signal for the
        // bg_job_id + worktreePath the launched worker wrote.
        const signal = readPhaseSignalRaw(orchDir, ticket, phase);
        safeEmit(
          appendDispatchLaunchedEvent,
          {
            orchId: ticket,
            ticket,
            target_phase: phase,
            bg_job_id: signal?.bg_job_id,
            worktree_path: signal?.worktreePath,
          },
          { ticket, phase }
        );
        return { ok: true, code: 0, reason: null, signal };
      }
      // CTL-611 Gap 1 demotion: rc=0 but no live bg job. Same on-disk effects as
      // a real rc!=0 failure so the broker / HUD / operator can see the drop.
      const reason = `verify_failed:${v.reason}`;
      const cd = recordDispatchFailure(orchDir, ticket, phase, 0, now());
      if (fullFailureLadder) {
        if (cd.consecutiveFailures >= getMaxDispatchRetries()) escalateDispatchExhausted(orchDir, ticket, phase); // CTL-712 terminal stop
        maybeTripCircuitBreaker(orchDir, ticket, phase); // CTL-671: trip same tick if at threshold
        appendDispatchFailedEvent({
          orchId: ticket,
          ticket,
          target_phase: phase,
          code: 0,
          reason,
          expiresAt: cd.expiresAt,
          consecutiveFailures: cd.consecutiveFailures,
        });
        maybeEscalateDispatchFailures(orchDir, cd, { writeStatus, appendEvent: appendCooldownEscalatedEvent });
        log.warn({ ticket, phase, verifyReason: v.reason }, "scheduler: dispatched signal verification failed");
      } else {
        appendDispatchFailedEvent({
          orchId: ticket,
          ticket,
          target_phase: phase,
          code: 0,
          reason,
        });
      }
      return { ok: false, code: 0, reason, signal: null };
    }

    // rc != 0 — real dispatch failure.
    const reason = readDispatchFailureReason(orchDir, ticket, phase) ?? "dispatch_nonzero_exit";
    const cd = recordDispatchFailure(orchDir, ticket, phase, r.code, now()); // CTL-624: arm the cool-down window
    if (fullFailureLadder) {
      if (cd.consecutiveFailures >= getMaxDispatchRetries()) escalateDispatchExhausted(orchDir, ticket, phase); // CTL-712 terminal stop
      maybeTripCircuitBreaker(orchDir, ticket, phase); // CTL-671: trip same tick if at threshold
      // CTL-611 Gap 2: surface the silent drop as an event.
      appendDispatchFailedEvent({
        orchId: ticket,
        ticket,
        target_phase: phase,
        code: r.code,
        reason,
        expiresAt: cd.expiresAt,
        consecutiveFailures: cd.consecutiveFailures,
      });
      maybeEscalateDispatchFailures(orchDir, cd, { writeStatus, appendEvent: appendCooldownEscalatedEvent });
      if (failLogMsg) {
        log.warn(failLogIncludePhase ? { ticket, phase, code: r.code } : { ticket, code: r.code }, failLogMsg);
      }
    } else {
      appendDispatchFailedEvent({
        orchId: ticket,
        ticket,
        target_phase: phase,
        code: r.code,
        reason,
      });
    }
    return { ok: false, code: r.code, reason, signal: null };
  }

  // CTL-671: compute the eligible set ONCE per tick. Consumed by the phantom
  // validity sweep (Pass 0a, below) and the new-work pull (Pass 2). readEligible
  // is the test injection seam; production reads all per-project eligible
  // projections (written exclusively from a live `linearis issues list`).
  const eligible = readEligible ? readEligible() : readAllEligibleTickets();
  const eligibleIds = new Set(eligible.map((t) => t.identifier));

  // (0a) CTL-671 phantom/orphan validity sweep — quarantine a worker dir whose
  // ticket is definitively non-existent in Linear, NOT in the eligible set, and
  // has NO live bg worker. The conjunction of all three is required so a Linear
  // outage (unknown resolution) or a real in-flight ticket is never touched.
  // Runs BEFORE the reclaim sweep so the per-tick probe-storm path that
  // sustained phantom CTL-9 (24,560 events) is cut on the first tick that sees
  // it, instead of looping forever. Cheap checks (eligible membership, then
  // bg-liveness) gate the Linear call, so a healthy fleet pays nothing.
  const quarantinedPhantoms = [];
  for (const sig of readWorkerSignals(orchDir)) {
    if (!sig.ticket) continue;
    if (!isTicketInFlight(readPhaseSignals(orchDir, sig.ticket))) continue; // skip terminal — no probe

    // CTL-671 runaway-rate alert — OBSERVABILITY ONLY (does not quarantine, so
    // it covers noisy-but-real tickets too and runs before the phantom gates).
    // Fires once per RUNAWAY_WINDOW_MS via the .runaway-alerts/<ticket> marker.
    const evCount = countTicketEvents({ ticket: sig.ticket, windowMs: RUNAWAY_WINDOW_MS, now });
    if (evCount >= RUNAWAY_THRESHOLD && !inRunawayCooldown(orchDir, sig.ticket, now())) {
      appendRunawayEvent({
        ticket: sig.ticket,
        orchId: sig.raw?.orchestrator ?? sig.ticket,
        count: evCount,
        window_ms: RUNAWAY_WINDOW_MS,
      });
      recordRunawayAlert(orchDir, sig.ticket, now());
      log.warn(
        { ticket: sig.ticket, count: evCount, window_ms: RUNAWAY_WINDOW_MS },
        "scheduler: ticket event-rate domination — emitted phase.dispatch.runaway (CTL-671)"
      );
    }

    if (eligibleIds.has(sig.ticket)) continue; // (a) eligible → real ticket
    const bgId = sig.liveness?.kind === "bg" ? sig.liveness.value : null;
    if (isBgJobAlive(bgId)) continue; // (c) live worker → cheap check before the Linear call
    if (classifyResolution(sig.ticket, { exec }) !== "not-found") continue; // (b) definitive only
    if (maybeQuarantinePhantom(orchDir, sig.ticket, sig.phase)) {
      quarantinedPhantoms.push({ ticket: sig.ticket, phase: sig.phase });
      log.warn(
        { ticket: sig.ticket, phase: sig.phase },
        "scheduler: quarantined phantom worker dir (not-found + not-eligible + dead bg) — CTL-671"
      );
    }
  }

  // CTL-644: per-tick approval poll — dispatch any gated tickets that now have an
  // approval sentinel. Cheap (directory scan + existsSync per worker); no API calls
  // unless a dispatch fires. Runs before the reclaim sweep so an approved ticket
  // can advance in the same tick it's dispatched.
  processApprovedResumes({ orchDir });

  // (0) Reclaim-dead-work sweep (CTL-574) — close phase signals whose bg worker
  // died but whose work was committed before the death. Runs BEFORE the
  // advancement sweep so a reclaimed phase advances the same tick. Iterates
  // every active worker signal (readWorkerSignals returns one per ticket — the
  // active, non-terminal-first phase) and asks reclaimDeadWork to decide.
  // Reclaim is a strict superset of "do nothing": only the dead+work-done case
  // mutates the signal; all other classes (terminal/running/unknown/alive-
  // suppressed/superseded-noop) are zero-action no-ops.
  // CTL-736: reclaimDeadWork's actionable returns populate parallel arrays for
  // the HUD / daemon log; the rest (noop, reclaim-failed, superseded-noop,
  // inert-stale, alive-suppressed, rate-limited-deferred, escalation-suppressed)
  // are silent — they describe "no externally-visible change" the next tick
  // re-evaluates. 'reviveSuppressed' now marks only the audit-append-failure
  // path; 'noProgressStopped' + 'escalated' fire `needs-human`.
  const reclaimed = [];
  const revived = [];
  // CTL-736: reviveSuppressed now marks ONLY the audit-append-failure path (the
  // revive event could not be persisted, so the dispatch is skipped to preserve
  // the attempt counter). The fleet-wide storm-breaker that used to populate it is
  // deleted. The CTL-735 revivePending (grace window) + reviveCapped (per-tick cap)
  // buckets are deleted with their mechanisms.
  const reviveSuppressed = [];
  // CTL-736 Phase 3: workers STOPPED for making zero forward progress (the futile
  // idle-respawn loop) — flagged needs-human, never respawned.
  const noProgressStopped = [];
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

  // CTL-736: the reclaim death trigger is the authoritative LOCAL state.json
  // lifecycle (jobLifecycle), so the reclaim sweep no longer reads the `claude
  // agents` snapshot at all. The CTL-731 per-tick snapshot read + per-worker
  // liveness binding AND the cold-snapshot skip (reclaimColdSkip) are both gone:
  // a local statSync of one job dir per worker has no cold/warm distinction and
  // no per-worker subprocess fan-out to guard against, so the sweep runs every
  // tick. (New-work admission still gates on `livenessIsFresh()` below — a
  // separate concern that keeps the snapshot warm for concurrency counting.)

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
      // CTL-736: reclaim reads only the local state.json lifecycle — no snapshot
      // liveness binding (the death trigger never consults `claude agents`).
      // CTL-642 (LOAD-BEARING): thread the SHARED TTL state cache + fetchState +
      // prAdapter so the recovery terminal short-circuit reuses the same cached
      // Linear read as the rest of the tick (≤1 fetchState per ticket per TTL —
      // NOT a new per-tick API storm). cache may be undefined (legacy tests that
      // don't inject it); fetchTicketState handles an undefined cache by exec-ing
      // every call exactly as before.
      const reclaimOpts = {
        repoRoot,
        cache,
        fetchState: (id, o = {}) => fetchTicketState(id, { ...o, gateway }),
        prAdapter,
        // CTL-809 — thread the warm agents snapshot so the reclaim alive-branch can
        // cross-check a jobLifecycle-alive-but-process-gone ghost (getAgentsCached is
        // already imported at scheduler.mjs:81).
        agentsSnapshot: getAgentsCached,
      };
      // CTL-736 Phase 3: no per-tick revive budget is threaded — the progress gate
      // (revive only while progressing; stop on zero progress) + the Phase-1 O_EXCL
      // claim bound the mass-revive storm structurally.
      const r = reclaimDeadWork(orchDir, sig, reclaimOpts);
      const entry = { ticket: sig.ticket, phase: sig.phase };
      switch (r) {
        case "reclaimed":
          reclaimed.push(entry);
          break;
        case "terminal-short-circuit":
          // CTL-642: the ticket was already terminal (Linear Done/Canceled) or its
          // PR merged; reclaimDeadWork flipped its signal to `done` and audited it
          // (NO escalated event). Bucket with reclaimed for HUD/log visibility —
          // the ticket drops from the in-flight attention set next tick.
          reclaimed.push(entry);
          break;
        case "revived":
          revived.push(entry);
          break;
        case "wedged-redispatched":
          // CTL-932: a turn-zero-wedged worker (registered, never started its
          // first turn) was stopped and replaced via the revive path. Bucket
          // with revived — a replacement worker is now live for the phase.
          revived.push(entry);
          break;
        case "revive-suppressed":
          // CTL-736: the revive event could not be persisted (audit-append failure)
          // so the dispatch was skipped to preserve the attempt counter; retries
          // next tick. (The fleet-wide storm-breaker that also used this is gone.)
          reviveSuppressed.push(entry);
          break;
        case "no-progress-stopped":
          // CTL-736 Phase 3: a dead worker that made zero forward progress was
          // stopped + flagged needs-human, never respawned (the futile idle loop).
          noProgressStopped.push(entry);
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
        case "rate-limited-deferred":
          // CTL-736/CTL-679: a no-progress STOP whose needs-human escalation
          // deferred because the Linear breaker is open. The worker WAS stopped;
          // the label retries next tick once the breaker closes. Bucket it with
          // the no-progress stops so the killed-but-pending-flag worker is visible
          // (rather than silently invisible in `default`).
          noProgressStopped.push(entry);
          break;
        default:
          // noop | reclaim-failed → invisible.
          // CTL-606: superseded-noop also buckets here — a dead predecessor signal
          // the ticket has already advanced past. Invisible by design (the active
          // phase is progressing normally); surfacing it would be noise.
          // CTL-736: alive-suppressed (worker still working) + inert-stale (an
          // abandoned historical dir too old to revive) also bucket here — both
          // steady-state non-events that would otherwise be persistent noise.
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

  // CTL-705: the eligible read is hoisted to the top of the tick (see the CTL-671
  // phantom-sweep block above) so the preemption sweep (0.5), the new-work pull
  // (2), and the phantom sweep (0a) all share a single read per tick. `eligible`
  // is already in scope here.

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

  // (STEP A) CTL-755 admission-control compute — gate the triage→research
  // promotion by deps + priority + capacity. PURE-COMPUTE + labelOnce escalation
  // only: no dispatch, no signal mutation. Produces `admittedThisTick` (the set
  // of triaged-waiting tickets allowed to advance to research this tick) which
  // the advancement sweep (STEP B) consumes as a predicate. Runs after the
  // liveCount hoist (so the promotion budget reflects the live slot count) and
  // before the preemption sweep (so it is independent of the dispatch sweeps).
  let promotedCount = 0;
  let admittedThisTick = new Set();
  {
    // A.1 — the triaged-waiting pool: exactly the set sweep 1 would free-promote
    // this tick (triage:done, no research signal, not parked). Covers live
    // triage-complete, reclaim branch-B emitComplete, AND post-boot — all
    // converge on triage:done / no-research.
    const triagedWaiting = [];
    for (const ticket of listInFlightTickets(orchDir)) {
      const s = readPhaseSignals(orchDir, ticket);
      if (s.triage !== "done") continue;
      if ("research" in s) continue;
      if (Object.values(s).some((v) => v === PREEMPTED_STATUS)) continue;
      triagedWaiting.push(ticket);
    }

    // A.2 — early-exit when nothing is waiting. Zero Linear cost in the common
    // path (no fetch, no hydration, no label diff).
    if (triagedWaiting.length > 0) {
      // A.3 — hydrate every candidate's live state + relations + priority +
      // labels FRESH in ONE batched, cache-first request (CTL-784 — was one
      // `linearis issues read` per candidate every tick). A candidate the batch
      // does not return (read failure / not-found) is ABSENT from the map → it
      // fails SAFE: tracked in readFailedTickets and forced out of readyIds below
      // (A.4), never silently promoted on an unknown dependency picture. Build
      // pseudo-issue descriptors in the buildDependencyEdges shape (state
      // re-nested into {name} — the descriptor carries a flat string state).
      const relByTicket = fetchBatch(triagedWaiting, { cache });
      const waitingDescriptors = [];
      const labelsByTicket = new Map(); // ticket → current Linear label set
      const readFailedTickets = new Set(); // fail-safe: missing read → held
      for (const ticket of triagedWaiting) {
        const rel = relByTicket.get(ticket) ?? null;
        const { priority, createdAt } = readWorkerPriority(orchDir, ticket);
        if (rel === null && !triageDeclaresZeroDeps(orchDir, ticket)) {
          // CTL-929: a transient Linear read failure (commonly linearBreaker open
          // from a 429) must NOT strand a ticket whose dependency picture is already
          // known-empty from the durable triage.json signal. Only apply the fail-safe
          // hold when the picture is genuinely unknown — i.e. the ticket may have
          // declared blockers whose state we cannot confirm without the read, OR
          // triage.json is missing/malformed.
          readFailedTickets.add(ticket);
        }
        // missing rel → fail-safe: non-terminal sentinel state, no edges, no labels.
        const stateName = rel?.state ?? UNFETCHED_BLOCKER_STATE;
        labelsByTicket.set(ticket, rel?.labels ?? []);
        waitingDescriptors.push({
          identifier: ticket,
          // Prefer the live Linear priority; fall back to the persisted worker
          // priority when the read failed or carried no priority.
          priority: typeof rel?.priority === "number" ? rel.priority : priority,
          createdAt,
          state: { name: stateName },
          // CTL-878: carry the parent epic id so buildDependencyEdges (A.7) drops a
          // parent→child blocks edge AND STEP E skips persisting child blocked_by
          // parent. This literal cherry-picks fields (it does NOT spread `rel`), so
          // parent MUST be copied explicitly or the parent-deadlock guard no-ops for
          // the very triaged-waiting path that holds the epic's children.
          parent: rel?.parent ?? null,
          relations: rel?.relations ?? { nodes: [] },
          inverseRelations: rel?.inverseRelations ?? { nodes: [] },
        });
      }

      // A.4 — combined dep analysis over candidates + eligible new work. Hydrates
      // BOTH pools' out-of-set blockers in one batched request (closes the D5
      // fail-open gap). The candidates are not in `eligible`, so they cannot leak
      // into sweep-2 selection — sweep 2 keeps its own computation over `eligible`.
      const admissionPool = [...eligible, ...waitingDescriptors];
      const admissionBlockerStates = hydrateOutOfSetBlockers(admissionPool, { cache, fetchBatch });
      const graph = analyzeDependencyGraph(admissionPool, {
        blockerStates: admissionBlockerStates,
      });
      const readyIds = new Set(graph.ready);
      // Fail-safe: a candidate whose fresh read FAILED has an unknown dependency
      // picture (empty edges from a null read would otherwise read as "ready") —
      // hold it (drop from readyIds → classified "blocked"). Retries next tick.
      for (const ticket of readFailedTickets) readyIds.delete(ticket);

      // A.5 — cycle escalation: a triaged-waiting ticket in a dependency cycle
      // can never become ready, so flag it needs-human (labelOnce, apply-once).
      const cycleMembers = new Set();
      for (const anomaly of graph.anomalies) {
        for (const member of anomaly.members) {
          if (triagedWaiting.includes(member)) {
            cycleMembers.add(member);
            labelOnce(orchDir, member, "needs-human", writeStatus);
          }
        }
      }

      // A.6 — priority + capacity selection over the COMBINED ready pool. Triaged
      // candidates compete fairly with brand-new ready work for the shared
      // free-slot ceiling. Empty exclude is correct (candidates have no research
      // signal yet). Brand-new eligible tickets in the slice are NOT acted on
      // here — they flow through sweep 2; their presence only makes the triaged
      // candidates compete fairly.
      const freeSlotsForPromotion = livenessIsFresh()
        ? Math.max(0, computeFreeSlots(maxParallel, liveCount))
        : 0;
      const readyCandidates = rankTickets(
        admissionPool.filter((t) => readyIds.has(t.identifier)),
      );
      const admittedSlice = selectDispatchablePerProject(
        readyCandidates,
        new Set(),
        freeSlotsForPromotion,
        { perProject: concurrency?.perProject, inFlight: inFlightTickets },
      );
      admittedThisTick = new Set(
        admittedSlice
          .filter((t) => triagedWaiting.includes(t.identifier))
          .map((t) => t.identifier),
      );

      // A.7 — held-indicator convergence (CTL-755 ADDENDUM). For each candidate,
      // compute the desired held label and converge ON A DIFF (steady-state tick
      // = zero writes). Emit phase.advance.held only-on-state-change.
      const edges = buildDependencyEdges(admissionPool, {
        externalIds: Object.keys(admissionBlockerStates),
      });
      const poolById = new Map(
        admissionPool.filter((t) => t?.identifier).map((t) => [t.identifier, t]),
      );
      for (const ticket of triagedWaiting) {
        if (cycleMembers.has(ticket)) {
          // Cycle member → owned by needs-human (labelOnce above). Clear any
          // stale held label so it doesn't double-signal, and drop its held
          // emit-state so a future non-cycle hold re-emits.
          convergeHeldLabel(ticket, labelsByTicket.get(ticket), null, writeStatus, { orchDir, now });
          lastHeldEmitState.delete(ticket);
          continue;
        }
        let desired = null;
        let reason = null;
        let blockers = [];
        if (!readyIds.has(ticket)) {
          desired = HELD_LABEL_BLOCKED;
          if (readFailedTickets.has(ticket)) {
            // A null relations read forced this ticket out of readyIds (fail-safe
            // hold). The dependency picture is UNKNOWN, not a confirmed open dep —
            // emit a distinct reason so the audit log can't conflate a hydration
            // failure with a genuine zero-or-more open-dependency hold.
            reason = "dependency-state-unknown";
            blockers = [];
          } else {
            reason = "blocked-by-open-dependency";
            blockers = unmetBlockersFor(ticket, edges, poolById, admissionBlockerStates);
          }
        } else if (!admittedThisTick.has(ticket)) {
          desired = HELD_LABEL_WAITING;
          reason = "awaiting-capacity-or-priority";
        }
        // else: admitted → desired null → clear-on-pickup (both labels removed).

        convergeHeldLabel(ticket, labelsByTicket.get(ticket), desired, writeStatus, { orchDir, now });

        if (desired) {
          // Only-on-state-change emission: skip if the same held class already
          // emitted for this ticket since it was last cleared/admitted.
          if (lastHeldEmitState.get(ticket) !== desired) {
            lastHeldEmitState.set(ticket, desired);
            safeEmit(
              appendPhaseAdvanceHeldEvent,
              { orchId: ticket, ticket, reason, blockers },
              { ticket, phase: "advance" },
            );
          }
        } else {
          // Admitted (or no longer held) → reset so a future re-hold re-emits.
          lastHeldEmitState.delete(ticket);
        }
      }

      // (STEP E) CTL-755 dep PERSISTENCE — scheduler-side (CTL-497/CTL-558: the
      // phase-triage skill stays READ-ONLY; the durable `blocked_by` write lives
      // here, never in the skill). For each triaged-waiting candidate, read its
      // triage.json `.dependencies`, VALIDATE each scraped TEAM-NNN token like
      // the CTL-537 sequencing block (resolve via fetchTicketState — drop
      // unresolvable / prose-only / self-refs; keep only real NON-TERMINAL
      // blockers; skip a token that would close a cycle with the candidate), and
      // for each surviving (candidate, blocker) NOT already in the candidate's
      // FRESH relations (idempotent — a steady-state tick writes nothing), write
      // the durable edge via the same applyBlockedByRelation seam CTL-537 uses.
      // This is what makes the admission gate (STEP A) durable: the next tick's
      // analyzeDependencyGraph reads the persisted edge from Linear.
      const descriptorByTicket = new Map(
        waitingDescriptors.map((d) => [d.identifier, d]),
      );
      // CTL-784: pre-collect every (non-cycle) candidate's triage.json deps and
      // resolve their live Linear states in ONE batched, cache-first request —
      // was one fetchTicketState per dep per candidate. The per-dep loop below
      // reads state from this map; a dep the batch does not return (404 /
      // unresolvable / prose-only token) is ABSENT → dropped, exactly like the
      // prior null fetchTicketState. Most deps are already warm from A.3/A.4.
      const depIdsByCandidate = new Map();
      const allDepIds = new Set();
      for (const candidate of triagedWaiting) {
        if (cycleMembers.has(candidate)) continue; // owned by needs-human
        const depIds = readTriageDependencies(orchDir, candidate);
        if (depIds.length === 0) continue;
        depIdsByCandidate.set(candidate, depIds);
        for (const dep of depIds) allDepIds.add(dep);
      }
      const depBatch = fetchBatch([...allDepIds], { cache });
      for (const candidate of triagedWaiting) {
        const depIds = depIdsByCandidate.get(candidate);
        if (!depIds) continue; // cycle member or no deps

        const desc = descriptorByTicket.get(candidate);
        // CTL-878: the candidate's parent epic. A parent/child hierarchy link is
        // NOT a dependency — persisting `child blocked_by parent-epic` deadlocks
        // the child (a tracking epic is never worked → never terminal → the gate
        // never clears). Triage scrapes the parent id out of the child's body, so
        // skip the durable write below when a dep IS the parent. This guards only
        // NEW edges: an ALREADY-durable parent edge is short-circuited earlier by
        // the existingBlockers idempotency check and is left in Linear — harmless,
        // because the read-layer buildDependencyEdges drop (the load-bearing fix)
        // neutralizes it at read time regardless; a one-time operator edge delete
        // clears the residual UI noise.
        const candidateParent = desc?.parent ?? null;
        // Already-durable blocked_by blockers for THIS candidate, read from its
        // FRESH inverseRelations ({type:"blocks", issue:<blocker>} ⇒ blocker
        // blocks candidate). The idempotency guard: skip writing an edge we can
        // already see on Linear.
        const existingBlockers = new Set();
        for (const node of desc?.inverseRelations?.nodes ?? []) {
          if (node?.type === "blocks" && node?.issue?.identifier) {
            existingBlockers.add(node.issue.identifier);
          }
        }
        // CTL-537 cycle guard (Open-Q4 lightweight form): the candidate's own
        // OUTGOING `blocks` edges name tickets it already blocks. A new
        // blocked_by edge naming one of those would close a 2-node cycle, so
        // skip it. (The broader admission graph's detectCycles already escalated
        // any in-set cycle to needs-human above; this catches the candidate→dep
        // back-edge for an out-of-set dep before we persist it.)
        const candidateBlocks = new Set();
        for (const node of desc?.relations?.nodes ?? []) {
          if (node?.type === "blocks" && node?.relatedIssue?.identifier) {
            candidateBlocks.add(node.relatedIssue.identifier);
          }
        }

        for (const dep of depIds) {
          if (existingBlockers.has(dep)) continue; // idempotent — edge already durable
          if (dep === candidateParent) {
            // CTL-878: the dep is the candidate's parent epic. Never persist a
            // child→parent-epic blocked_by edge — it is a hierarchy link mis-scraped
            // as a dependency and would deadlock the child against a never-worked epic.
            log.warn(
              { candidate, dep },
              "ctl-878 step-e: skipping dependency that is the candidate's parent epic",
            );
            continue;
          }
          if (teamOf(dep) !== teamOf(candidate)) {
            // CTL-838: the dep is in a DIFFERENT team. This daemon orchestrates one
            // team and cannot work another team's ticket to terminal, so a
            // cross-team blocked_by edge can only deadlock the candidate. Never
            // persist it (the read-layer buildDependencyEdges drop is the backstop).
            log.warn(
              { candidate, dep, candidateTeam: teamOf(candidate), depTeam: teamOf(dep) },
              "ctl-838 step-e: skipping cross-team dependency (daemon cannot work it)",
            );
            continue;
          }
          if (candidateBlocks.has(dep)) {
            // Persisting blocked_by(candidate ← dep) while candidate already
            // blocks dep would close a cycle. Drop it (do not deadlock).
            log.warn(
              { candidate, dep },
              "ctl-755 step-e: skipping dependency that would close a cycle",
            );
            continue;
          }
          // Resolve the dep's live Linear state from the batch (CTL-784). An
          // absent dep (404 / unparseable / prose-only token that is not a real
          // ticket) is dropped — we never persist an edge to a ticket we cannot
          // resolve. A TERMINAL dep (Done/Canceled) is a no-op blocker, so do
          // not write a durable edge for it (it would never hold the gate and
          // only adds Linear noise).
          const depState = depBatch.get(dep)?.state ?? null;
          if (depState == null) continue; // unresolvable → drop
          if (ADMISSION_TERMINAL_STATES.has(depState)) continue; // terminal → no durable edge

          safeWrite(
            () => writeStatus.applyBlockedByRelation({ ticket: candidate, blockedBy: dep }),
            { ticket: candidate, phase: "triage-deps" },
          );
          // CTL-784: we just wrote a NEW durable blocked_by edge for this
          // candidate. Its cached relations descriptor (read this tick by A.3)
          // does NOT carry the edge, so without invalidation a freed-slot tick
          // within the TTL window would serve the stale no-edge descriptor and
          // OVER-PROMOTE the candidate past its open blocker. Drop the cache
          // entry so the next tick re-reads fresh and the gate holds. (The OLD
          // per-tick fresh read had no such window.)
          cache?.invalidate?.(candidate);
        }
      }
    }
  }

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
    // (STEP B) CTL-755 admission gate — hold the triage→research promotion unless
    // STEP A admitted this ticket (deps terminal + won priority/capacity). Soft
    // hold: no dispatch → applyPhaseStatus(research)/applyEstimate never fire, the
    // ticket stays at Linear "Triage" (no cooldown, auto-retries next tick). Keyed
    // on `next === NEW_WORK_ENTRY_PHASE` which deriveAdvancement returns UNIQUELY
    // for the triage→research edge; non-research edges skip the guard.
    if (next === NEW_WORK_ENTRY_PHASE && signals.triage === "done" && !admittedThisTick.has(ticket)) continue;
    if (inDispatchCooldown(orchDir, ticket, next, now())) continue; // CTL-624: throttle refused re-dispatch
    // CTL-671: circuit breaker — once consecutiveFailures has crossed the
    // threshold, quarantine to terminal `stalled` and stop re-dispatching.
    if (maybeTripCircuitBreaker(orchDir, ticket, next)) continue;
    // CTL-826: the dispatch→verify core is shared (requested-emit, dispatch,
    // verify, success cooldown-clear + launched-emit, full failure ladder). The
    // advance-specific follow-ups stay here, keyed off the returned result.
    const dv = dispatchAndVerify(orchDir, ticket, next, {
      dispatch,
      requestedReason: "advance",
      failLogMsg: "scheduler: advance dispatch failed",
    });
    if (dv.ok) {
      advanced.push({ ticket, phase: next });
      // CTL-755: a verified triage→research promotion consumed a slot this tick.
      // liveCount was read at the top of the tick (before this dispatch), so the
      // promotion has not yet incremented it — STEP C subtracts promotedCount
      // from sweep-2 freeSlots to stop over-admitting into the just-taken slots.
      if (next === NEW_WORK_ENTRY_PHASE) promotedCount++;
      // CTL-657 / CTL-661: stop the predecessor worker now that its successor
      // is live. resolveReapPredecessor reads the PRE-reset signals so the
      // verify⇄remediate detour edges name the correct just-finished worker;
      // remediateRaw supplies the bg_job_id the reset already deleted.
      emitPredecessorReap(orchDir, ticket, preResetSignals, next, { remediateRaw });
      // CTL-558: write the dispatched phase's mapped Linear status. Idempotent
      // (linear-transition.sh read-compares first); never aborts the tick.
      safeWrite(
        () => {
          // CTL-757: capture the writer result so emitStateWrite can audit the
          // before/after pair. The write itself stays best-effort inside
          // safeWrite; the emit is a separate best-effort step.
          const wr = writeStatus.applyPhaseStatus({ ticket, phase: next, cache });
          emitStateWrite({ writerResult: wr, ticket, phase: next, source: "scheduler-advance", orchId: ticket });
        },
        { ticket, phase: next }
      );
      // CTL-751: on triage→research advance, write the reference-class
      // estimate to Linear if triage.json carries a valid numeric `.estimate`.
      if (next === "research") {
        const est = readTriageEstimate(orchDir, ticket);
        if (est !== null) {
          safeWrite(() => writeStatus.applyEstimate({ ticket, estimate: est }), {
            ticket,
            phase: next,
          });
        }
      }
    } else {
      // CTL-695: reap the just-finished predecessor even though its successor did
      // not come up — the failed dispatch (verify-failed OR rc!=0) leaves it alive.
      emitPredecessorReap(orchDir, ticket, preResetSignals, next, { remediateRaw });
    }
  }

  // (1.5) Resume-after-preemption sweep — re-dispatch parked ("preempted") tickets
  // at their parkedFrom phase when a slot frees. Parked tickets are ranked by
  // buildGlobalRanking and processed top-ranked first. Runs after advancement
  // (so a slot freed by an advanced ticket is credited here) and before new-work
  // pull (so a preempted ticket reclaims its slot ahead of brand-new work).
  let resumedCount = 0;
  {
    // CTL-755: subtract promotedCount so a triage→research promotion (STEP B, this
    // tick, before this sweep) and a resume cannot both claim the same free slot.
    // Symmetric to STEP C's sweep-2 subtraction — the same double-fill class CTL-705
    // closed for resume-vs-new-work, now also closed for promotion-vs-resume.
    let resumeSlots = Math.max(0, computeFreeSlots(maxParallel, liveCount) - promotedCount);
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

        // CTL-826: shared dispatch→verify core, with the RESUME divergences kept
        // here. preDispatch performs the signal reset-to-stalled BEFORE dispatch
        // (returning false on a failed reset aborts → `continue`); the reduced
        // failure ladder (fullFailureLadder:false) preserves this sweep's lighter
        // failure handling (no escalation/circuit-breaker/cooldown-escalation).
        const dv = dispatchAndVerify(orchDir, pd.identifier, parkedPhase, {
          dispatch,
          resumeSession,
          requestedReason: "resume-after-preemption",
          fullFailureLadder: false,
          preDispatch: () => {
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
              return false;
            }
            return true;
          },
        });
        if (dv.aborted) continue; // reset write failed — skip this parked ticket
        if (dv.ok) {
          rankedAboveSince.delete(`${pd.identifier}:${pd.identifier}`); // clear any stale hysteresis
          safeEmit(
            appendResumedAfterPreemptionEvent,
            { orchId: pd.identifier, ticket: pd.identifier, phase: parkedPhase, resumeSession: resumeSession ?? null },
            { ticket: pd.identifier, phase: parkedPhase }
          );
          safeWrite(
            () => {
              // CTL-757: audit the resume-after-preemption status write.
              const wr = writeStatus.applyPhaseStatus({ ticket: pd.identifier, phase: parkedPhase, cache });
              emitStateWrite({ writerResult: wr, ticket: pd.identifier, phase: parkedPhase, source: "preemption-resume", orchId: pd.identifier });
            },
            { ticket: pd.identifier, phase: parkedPhase }
          );
          resumeSlots--;
          resumedCount++;
        }
      }
    }
  }

  // (2) New-work pull — fill free slots with top-ranked ready tickets. D5:
  // hydrate the live state of every out-of-set blocker first so a Ready ticket
  // blocked by a non-terminal out-of-set ticket is held back. `eligible` was
  // computed once at the top of the tick (CTL-671) and is reused here.
  // CTL-705: `eligible` is hoisted above sweep 0.5 — used by buildGlobalRanking there.
  const blockerStates = hydrateOutOfSetBlockers(eligible, { cache, fetchBatch });
  // CTL-634: surface the cache hit-rate once per tick. Log-line-only matches
  // the daemon's pino-only observability convention (schedulerTick's return
  // object is discarded by runTick, so a metric must be logged, not returned).
  if (cache) {
    log.info(cache.stats(), "scheduler: cache stats");
    // CTL-784: surface the relation read-through hit-rate too (separate store).
    if (cache.relationsStats) log.info(cache.relationsStats(), "scheduler: relations cache stats");
  }
  // CTL-695: per-tick reaper telemetry — otel-forward ships this pino line as a
  // gauge (same log-line-only convention as cache.stats / per-project slots).
  log.info(countReapOutcomes(), "scheduler: reap stats");
  // CTL-850: HRW ownership filter — keep only the tickets THIS host owns under
  // the cluster roster so freeSlots + per-project caps compute over owned work
  // only. Applied to `ready` (NOT the raw `eligible`, whose `eligibleIds` drives
  // the phantom-quarantine sweep above — narrowing that would mis-quarantine a
  // sibling host's worker dirs). Identity filter for a single-host roster
  // (ownedBy is always true), so this is an exact no-op until a 2nd host joins.
  const ready = computeReadyTickets(eligible, { blockerStates }).filter((t) =>
    ownedBy(t.identifier, roster, self),
  );
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
  // CTL-731 Phase 00: staleness gate. If the liveness snapshot is stale or never
  // populated (cold start, or a hung `claude agents` RPC), the in-flight count is
  // untrustworthy — hold new-work admission (freeSlots → 0) rather than risk
  // over-spawning on a bad count. Advancement of in-flight phases (sweep 1) is
  // independent of freeSlots and already ran, so the pipeline keeps moving; only
  // NEW admissions pause until the read recovers. Fresh (the default) → no change.
  const livenessFresh = livenessIsFresh();
  // CTL-755: also subtract promotedCount — the triage→research promotions STEP B
  // dispatched this tick took slots that liveCount (read before STEP B) does not
  // yet reflect, so without this term sweep 2 over-admits into them (the same
  // double-fill class CTL-705's resumedCount term fixed; one symmetric extra term).
  const freeSlots = livenessFresh
    ? Math.max(0, computeFreeSlots(maxParallel, inFlightCount) - resumedCount - promotedCount)
    : 0;
  if (!livenessFresh) {
    log.warn(
      { maxParallel, inFlightCount, resumedCount, promotedCount },
      "scheduler: liveness snapshot stale/cold — holding new-work dispatch (CTL-731)",
    );
  }
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
    // CTL-537: sequencing gate — only when a worker is already in-flight and a
    // seam is wired. Fail-open verdicts dispatch normally.
    if (inFlightCount >= 1 && checkSequencing) {
      const verdict = checkSequencing({
        candidate: t.identifier,
        inFlightTickets,
        orchDir,
      });
      // CTL-537 (phase-review hardening): the verdict is LLM-generated, so its
      // hard_dependencies IDs are untrusted. Only honor an edge that arbitrates
      // the pair THIS gate is deciding — candidate must be the current ticket
      // and blocked_by must be a currently in-flight ticket. Dropping anything
      // else prevents a hallucinated/prompt-injected ID from writing a durable
      // blocked-by edge on an unrelated ticket (which D5 would wrongly stall).
      const rawDeps = verdict?.hard_dependencies ?? [];
      const validDeps = rawDeps.filter(
        (dep) => dep.candidate === t.identifier && inFlightTickets.has(dep.blocked_by)
      );
      if (rawDeps.length > validDeps.length) {
        log.warn(
          { candidate: t.identifier, dropped: rawDeps.length - validDeps.length },
          "sequencing: dropped hard_dependencies not arbitrating the (candidate, in-flight) pair"
        );
      }
      if (validDeps.length > 0) {
        for (const dep of validDeps) {
          safeWrite(
            () => writeStatus.applyBlockedByRelation({ ticket: dep.candidate, blockedBy: dep.blocked_by }),
            { ticket: dep.candidate, phase: "sequencing" }
          );
        }
        continue; // hold — D5 enforces the new edge next tick
      }
      if (verdict?.verdict === "hold") continue; // soft conflict — no cooldown marker
      // "go" → fall through to existing dispatch
    }
    // CTL-671: circuit breaker — stop re-dispatching a new-work ticket that has
    // failed its entry-phase dispatch THRESHOLD times in a row.
    if (maybeTripCircuitBreaker(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE)) continue;
    // CTL-781: respect-assignment gate — claim only assignee ∈ {null, bot}.
    // Gateway-first (rate-free); live read only on a miss. An unreadable
    // assignee HOLDS the candidate this tick (fail-safe) — it is not a dispatch
    // failure, so no cooldown marker and no failure event. Empty/absent
    // botUserIds disables the gate (CTL-749 fail-open convention).
    if (botUserIds instanceof Set && botUserIds.size > 0) {
      const a = fetchAssignee(t.identifier, { gateway, exec });
      if (!a.known) {
        log.debug({ ticket: t.identifier }, "ctl-781: assignee unreadable — holding candidate this tick");
        continue;
      }
      if (!isAssigneeClaimable(a.assignee, botUserIds)) {
        log.debug(
          { ticket: t.identifier, assignee: a.assignee },
          "ctl-781: candidate assigned to a non-bot — skipping (respect-assignment)"
        );
        continue;
      }
    }
    // CTL-850: claim-on-dispatch — the cross-host soft-CAS mutex, the actual
    // serializer behind the HRW pre-filter. Runs ONLY when the roster has >1 host
    // (a single-host install never touches Linear here). A LOST claim means
    // another host won the read-back — NOT a dispatch failure, so `continue` with
    // NO cooldown/failure marker and the ticket is simply reconsidered next tick.
    // Fail-closed: claimDispatch returns won:false on any error (never
    // double-dispatch on a transient Linear hiccup). Placed before the
    // dispatch-requested emit so a lost claim never emits a phantom "requested".
    if (multiHost) {
      const claim = claimDispatch({
        ticket: t.identifier,
        hostName: self,
        phase: NEW_WORK_ENTRY_PHASE,
      });
      if (!claim.won) {
        log.debug(
          { ticket: t.identifier, host: self },
          "ctl-850: lost cross-host claim — another host owns this dispatch, deferring"
        );
        continue;
      }
    }
    // CTL-826: shared dispatch→verify core (requested-emit "new-work", dispatch,
    // verify, success cooldown-clear + launched-emit, full failure ladder). The
    // new-work-specific success follow-ups stay here. Pass 2's original rc!=0 log
    // omits the phase field (failLogIncludePhase:false) to stay byte-identical.
    const dv = dispatchAndVerify(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, {
      dispatch,
      requestedReason: "new-work",
      failLogMsg: "scheduler: dispatch failed",
      failLogIncludePhase: false,
    });
    if (dv.ok) {
      dispatched.push(t.identifier);
      // CTL-705: persist priority + createdAt for the global rank, so
      // preemption decisions need no per-tick Linear API calls.
      writeWorkerPriority(orchDir, t.identifier, {
        priority: t.priority,
        createdAt: t.createdAt ?? null,
      });
      // CTL-558: write the entry-phase (`research`) status for the new ticket.
      // CTL-757: audit it as a scheduler-advance state write (new work entering
      // the pipeline is the entry-phase forward advance).
      safeWrite(
        () => {
          const wr = writeStatus.applyPhaseStatus({
            ticket: t.identifier,
            phase: NEW_WORK_ENTRY_PHASE,
            cache,
          });
          emitStateWrite({ writerResult: wr, ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE, source: "scheduler-advance", orchId: t.identifier });
        },
        { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE }
      );
      // CTL-781: self-assign the Catalyst bot so the claim is visible in
      // Linear. Best-effort (safeWrite) — an assignment failure never blocks
      // the pipeline; the read-back inside applyAssignee logs the gap.
      if (botWriteId) {
        safeWrite(
          () => writeStatus.applyAssignee?.({ ticket: t.identifier, userId: botWriteId }),
          { ticket: t.identifier, phase: "assignment" }
        );
      }
    }
  }

  // (3) Terminal-Done + label sweep (CTL-558) — one pass over every started
  // ticket. deriveAdvancement returns null once monitor-deploy completes, so
  // terminal `Done` is not a dispatch — it needs this dedicated sweep. In the
  // same pass: apply the flat `needs-human` label when any phase signal is
  // `stalled` (D7 — the worker keeps its phase state, it does not bounce to
  // Triage). Status writes are idempotent via linear-transition.sh; label
  // writes are guarded once-per-run by labelOnce's marker file.
  // CTL-758: per-ticket active signal map (carries raw.pr) for the reconcile
  // backstop's merged check. Built once from the same readWorkerSignals the
  // reclaim sweep used. Inert when no prAdapter is wired (production default).
  const signalByTicket = new Map();
  for (const sig of readWorkerSignals(orchDir)) {
    if (sig.ticket) signalByTicket.set(sig.ticket, sig);
  }
  for (const ticket of listStartedTickets(orchDir)) {
    const signals = readPhaseSignals(orchDir, ticket);
    // CTL-703: the terminal phase is now `teardown` (not `monitor-deploy`) —
    // read via the descriptor's TERMINAL_PHASE so a future pipeline change
    // can't silently bypass this sweep (redispatch research F2).
    // When the terminal phase completes, the pipeline is done — write Linear Done.
    // CTL-597: once-marker guards the per-tick Linear read (was safeWrite-only).
    // CTL-757: thread emitStateWrite so the terminal Done write is audited.
    if (signals[TERMINAL_PHASE] === "done") {
      terminalDoneOnce(orchDir, ticket, writeStatus, emitStateWrite);
      // CTL-646: terminal Done unconditionally clears needs-human (belt + teardown path).
      // CTL-703: worktree teardown is now the `teardown` FSM phase (teardownWorktreeOnce
      // removed) — only the label clear remains inline here.
      clearStalledLabel(orchDir, ticket, "needs-human", writeStatus);
    }
    // CTL-758: reconcile backstop — re-Done a merged ticket whose Linear state
    // drifted back to non-terminal (a late echo). Gated by the .terminal-done.applied
    // marker + merged PR + non-terminal live state, so it is a no-op in the common
    // case and inert without a prAdapter.
    reconcileTerminalBackstop(orchDir, ticket, signalByTicket.get(ticket), writeStatus, emitStateWrite, {
      cache,
      prAdapter,
      fetchState: (id, o = {}) => fetchTicketState(id, { ...o, gateway }),
    });
    if (Object.values(signals).some((s) => s === "stalled")) {
      labelOnce(orchDir, ticket, "needs-human", writeStatus);
      // CTL-868 route (B): also emit a canonical orphan-detected event (once) so a
      // stalled-no-recovery ticket is visible on the dashboard, not just label-flagged.
      emitOrphanDetectedOnce(orchDir, ticket, signals, appendOrphanDetectedEvent);
    } else {
      // CTL-646: no phase stalled → clear the ratchet if the marker exists.
      // Guard on marker presence so a no-stall, no-marker tick fires zero
      // removeLabel API calls (steady-state-zero-writes invariant).
      const base = join(orchDir, "workers", ticket, ".linear-label-needs-human");
      if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) {
        clearStalledLabel(orchDir, ticket, "needs-human", writeStatus);
      }
    }
    // CTL-695: nominate terminal workers for reaping once. Covers the gaps the
    // happy-path emitPredecessorReap (advance-success only) never reaches:
    // self-exited failed/stalled workers and the final teardown worker.
    // Intermediate `done` phases are excluded — those advance, and the existing
    // emitPredecessorReap (section 1, advance-success) owns their reap. The
    // reaper's _inflight 60s dedup + the per-phase marker make any overlap benign.
    for (const [phase, status] of Object.entries(signals)) {
      const isFinalTerminal =
        phase === TERMINAL_PHASE && (status === "done" || status === "skipped");
      if (status === "failed" || status === "stalled" || isFinalTerminal) {
        emitTerminalWorkerReapOnce(orchDir, ticket, phase);
      }
    }
  }

  // (4) Cooldown GC sweep (CTL-713) — reap expired markers for tickets that
  // have left the eligible set so .dispatch-cooldowns/ self-cleans instead of
  // accumulating orphans. Runs last: GC must not influence this tick's dispatch
  // decisions. `eligibleIds` is computed once at the top of the tick (CTL-671
  // phantom-sweep block) and is already in scope here.
  for (const { ticket, phase } of gcDispatchCooldowns(orchDir, eligibleIds, now())) {
    appendCooldownGcEvent({ ticket, orchId: ticket, target_phase: phase });
  }

  return {
    reclaimed,
    revived,
    reviveSuppressed,
    noProgressStopped,
    escalated,
    quarantinedPhantoms, // CTL-671 — phantom worker dirs stalled this tick
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
// CTL-834: held-label apply cool-down window (convergeHeldLabel). Same default as
// the dispatch cool-down; overridable for tests / quieter quota budgets.
const LABEL_COOLDOWN_MS = Number(process.env.SCHEDULER_LABEL_COOLDOWN_MS) || 60_000;
// CTL-713: permanent-failure cooldown. code=2 (prior_artifact_missing,
// phase-agent-dispatch exit 2) is a structural refusal — back it off longer than
// the 60s transient window. GC reaps the marker once the ticket leaves the eligible set.
const DISPATCH_PERMANENT_COOLDOWN_MS =
  Number(process.env.SCHEDULER_DISPATCH_PERMANENT_COOLDOWN_MS) || 30 * 60 * 1000;
const PERMANENT_FAILURE_CODES = new Set([2]);
// After this many consecutive same-code failures on one (ticket,phase), escalate
// to needs-human. Mirrors REMEDIATE_CYCLE_CAP.
const DISPATCH_FAILURE_ESCALATION_THRESHOLD =
  Number(process.env.SCHEDULER_DISPATCH_FAILURE_ESCALATION_THRESHOLD) || 3;
// CTL-712: terminal ceiling for refused-dispatch retries. Read lazily (not a
// module-level const) so the SCHEDULER_MAX_DISPATCH_RETRIES env var can be
// overridden at runtime (e.g. in tests via beforeEach). Default 5 mirrors the
// SCHEDULER_DISPATCH_COOLDOWN_MS precedent. At this ceiling escalateDispatchExhausted
// writes the stalled signal that terminally stops the loop; the CTL-713 label
// escalation at DISPATCH_FAILURE_ESCALATION_THRESHOLD (3) fires earlier as a flag.
const getMaxDispatchRetries = () => Number(process.env.SCHEDULER_MAX_DISPATCH_RETRIES) || 5;

// CTL-671: consecutive failed dispatches (no forward progress) before the ticket
// is quarantined to terminal `stalled` by the dispatch circuit breaker.
// Conservative default — well above any legitimate transient (rebase race,
// momentary launch failure). A successful dispatch (clearDispatchCooldown)
// resets the counter, so a healthy ticket can never trip it.
export const CIRCUIT_BREAKER_THRESHOLD =
  Number(process.env.SCHEDULER_CIRCUIT_BREAKER_THRESHOLD) || 8;

// CTL-671: per-ticket event-rate domination alert. When a single ticket emits
// >= RUNAWAY_THRESHOLD phase.*.<ticket> events within RUNAWAY_WINDOW_MS, the
// scheduler fires ONE phase.dispatch.runaway.<ticket> event per window
// (observability only — enforcement is the phantom sweep + circuit breaker).
// CTL-9's storm was ~24,560 events over 3 days; 50-in-10min is a conservative
// floor far above any healthy ticket's per-window rate.
export const RUNAWAY_THRESHOLD = Number(process.env.SCHEDULER_RUNAWAY_THRESHOLD) || 50;
export const RUNAWAY_WINDOW_MS =
  Number(process.env.SCHEDULER_RUNAWAY_WINDOW_MS) || 10 * 60 * 1000;

// --- daemon module state ---
let tickTimer = null;
let debounceTimer = null;
let watcher = null;
let runningOpts = null;

// CTL-702: observed yield tombstones for the lifetime of this daemon process.
// Keyed by absolute path so the same file across multiple ticks emits exactly
// one event. Cleared only on daemon restart (via __resetForTests in tests).
const observedYieldFiles = new Set();

// CTL-755: last-emitted held-state per ticket, so the phase.advance.held event
// fires only-on-state-change (not every tick a candidate stays held) — bounding
// log volume on a long-blocked ticket. Keyed by ticket → "blocked"|"waiting".
// An admitted/cleared ticket is deleted so a future re-hold re-emits. Cleared on
// daemon restart (via __resetForTests).
const lastHeldEmitState = new Map();

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
      // CTL-750: surface autotune throttle — when Layer-2 suppresses Layer-1's committed value
      // the operator otherwise sees only the resolved number with no explanation.
      const l1Max = layer1?.maxParallel;
      const l2Max = layer2?.maxParallel;
      if (Number.isInteger(l1Max) && Number.isInteger(l2Max) && l2Max < l1Max) {
        log.warn(
          { layer1Max: l1Max, layer2Max: l2Max, effective: concurrency.maxParallel },
          "scheduler: Layer-2 maxParallel overrides Layer-1 — autotune throttled below committed config (CTL-750)",
        );
      }
    } else {
      concurrency = runningOpts.concurrency;
    }
    // CTL-933: record this tick's liveness observations BEFORE the decisions run
    // (write-only shadow; own try/catch inside — never throws, never gates).
    collectBeliefsTick({ orchDir: runningOpts.orchDir, linearCache: runningOpts.cache });
    schedulerTick(runningOpts.orchDir, {
      readEligible: runningOpts.readEligible,
      dispatch: runningOpts.dispatch,
      exec: runningOpts.exec,
      writeStatus: runningOpts.writeStatus,
      cache: runningOpts.cache, // CTL-634: shared out-of-set blocker state cache
      concurrency, // CTL-665 + CTL-676: per-tick re-read, then threaded into readMaxParallel
      // CTL-676: forward the optional liveBackgroundCount seam (test-only) so
      // a unit test can drive freeSlots deterministically without shelling
      // out to `claude agents`. Undefined here keeps the production default.
      liveBackgroundCount: runningOpts.liveBackgroundCount,
      // CTL-731 Phase 00: production wiring for the new-work staleness gate. It
      // reads the ONE warm, never-blocking snapshot (getAgentsCached) — no
      // subprocess on the event loop — and HOLDS new dispatch when the live count
      // is untrustworthy.
      //
      // Coupling: an injected liveBackgroundCount means the caller is supplying a
      // deterministic, trustworthy count (the CTL-676 test seam), so the staleness
      // gate has nothing to protect against — default freshness to true. Production
      // never injects liveBackgroundCount, so it gets the real freshness. An
      // explicit override wins over both. (The CTL-736 reclaim death trigger reads
      // local state.json, so the old snapshot-derived reclaim binding is gone.)
      livenessIsFresh:
        runningOpts.livenessIsFresh ??
        (runningOpts.liveBackgroundCount !== undefined ? () => true : () => getAgentsCached().isFresh),
      // CTL-537: production defaults to defaultCheckSequencing; tests inject via
      // startScheduler({ checkSequencing }) or directly into schedulerTick.
      checkSequencing: runningOpts.checkSequencing ?? defaultCheckSequencing,
      // CTL-755/784: admission-gate seams. Undefined here keeps schedulerTick's
      // production defaults (fetchTicketsBatch / defaultAppendPhaseAdvanceHeldEvent);
      // tests inject a stub through startScheduler so a daemon tick never shells out.
      fetchBatch: runningOpts.fetchBatch,
      appendPhaseAdvanceHeldEvent: runningOpts.appendPhaseAdvanceHeldEvent,
      // CTL-642/758: the LIVE PR-merged adapter. Without this the recovery
      // short-circuit's pr-merged branch (terminal-state.mjs) AND the reconcile
      // backstop (reconcileTerminalBackstop gate 2) are BOTH inert in production —
      // schedulerTick's `prAdapter` default is undefined. Built ONCE at boot
      // (startScheduler → runningOpts.prAdapter) so we don't re-wire gh every tick.
      // A test may inject its own via startScheduler({ prAdapter }); production
      // gets the real makePrView-backed adapter.
      prAdapter: runningOpts.prAdapter,
      // CTL-671: phantom-sweep seams threaded from startScheduler. Undefined for
      // a direct startScheduler caller that did not opt in (unit tests) →
      // schedulerTick's SAFE no-op defaults apply, so a bare daemon tick never
      // shells out to linearis / `claude agents`. The real daemon (startDaemon)
      // + the standalone main() pass the real impls to arm the sweep.
      classifyResolution: runningOpts.classifyResolution,
      isBgJobAlive: runningOpts.isBgJobAlive,
      // CTL-781: respect-assignment + self-assign seams (undefined = gate off).
      botUserIds: runningOpts.botUserIds,
      botWriteId: runningOpts.botWriteId,
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
// `writeStatus` are injectable so a test drives a hermetic daemon (`exec` is
// the D5 blocker-state fetch seam, CTL-565; `writeStatus` is the CTL-558
// Linear-write seam — each undefined here defaults to the real module in
// schedulerTick). CTL-703: teardownWorktree removed; worktree teardown now
// happens in the phase-teardown agent.
export function startScheduler({
  orchDir,
  dispatch,
  readEligible,
  exec,
  writeStatus,
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
  // exec / writeStatus seams on schedulerTick.
  livenessIsFresh, // CTL-731: optional override; runTick defaults to getAgentsCached().isFresh.
  checkSequencing, // CTL-537: optional override; runTick defaults to defaultCheckSequencing.
  fetchBatch, // CTL-755/784: optional override; schedulerTick defaults to fetchTicketsBatch.
  appendPhaseAdvanceHeldEvent, // CTL-755: optional override; defaults to defaultAppendPhaseAdvanceHeldEvent.
  // CTL-642/758: the LIVE PR-merged adapter, wired into the production daemon
  // path so the recovery short-circuit's pr-merged branch + the reconcile
  // backstop actually fire (both inert while prAdapter === undefined). Built
  // ONCE here (hoisted out of the per-tick / per-ticket loop) and threaded via
  // runningOpts. The execution-core signal `pr` is `{number, url}` — no `.repo` —
  // so makePrView resolves the repo slug from the worker's worktree `origin`
  // remote. worktreeFor(ticket) reads the ticket's active signal `worktreePath`
  // (the canonical cwd of record, CTL-615); the lookup only runs when prView is
  // actually invoked (the rare merged-zombie / drift path), not every tick. A
  // test may inject its own prAdapter to stay hermetic.
  prAdapter = {
    prView: makePrView((ticket) => {
      for (const sig of readWorkerSignals(orchDir)) {
        if (sig.ticket === ticket && sig.worktreePath) return sig.worktreePath;
      }
      return "";
    }),
  },
  preflight = preflightWorkspaceLabels, // CTL-585
  // CTL-671: phantom-sweep seams. Undefined → schedulerTick's safe no-op
  // defaults (hermetic for unit tests that call startScheduler directly). The
  // real daemon (startDaemon) and the standalone main() pass the real impls.
  classifyResolution,
  isBgJobAlive,
  // CTL-781: respect-assignment + self-assign. Undefined → gate off (fail-open).
  botUserIds,
  botWriteId,
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
    cache,
    concurrency,
    configPath, // CTL-676: per-tick Layer-1 re-read source
    layer2Path, // CTL-678: per-tick Layer-2 re-read source (host-wide override)
    liveBackgroundCount, // CTL-676: test seam
    livenessIsFresh, // CTL-731: optional override (default getAgentsCached().isFresh)
    checkSequencing, // CTL-537: optional override (default defaultCheckSequencing)
    fetchBatch, // CTL-755/784: optional admission-gate batch hydration seam
    appendPhaseAdvanceHeldEvent, // CTL-755: optional held-indicator emit seam
    prAdapter, // CTL-642/758: live PR-merged adapter (built once above), threaded per-tick
    classifyResolution, // CTL-671: optional phantom-sweep Linear-probe seam
    isBgJobAlive, // CTL-671: optional phantom-sweep bg-liveness seam
    botUserIds, // CTL-781: respect-assignment predicate membership set
    botWriteId, // CTL-781: orchestrator bot UUID to write as assignee on claim
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
  lastHeldEmitState.clear(); // CTL-755: reset held-event only-on-change dedup
  // rankedAboveSince is cleared by stopScheduler above (CTL-705)
}

// __getRunningOpts — test-only accessor for the boot-captured daemon options.
// CTL-642/758: lets the regression test assert the PRODUCTION startScheduler
// path actually constructs + threads a live prAdapter (the bug was that
// schedulerTick's prAdapter defaulted to undefined and the production call site
// never passed one, leaving both the recovery short-circuit's pr-merged branch
// and the reconcile backstop inert). Not part of the public contract.
export function __getRunningOpts() {
  return runningOpts;
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
  // CTL-671: arm the phantom worker-dir validity sweep + bg-liveness reader with
  // the real impls (startScheduler defaults them to safe no-ops for hermetic
  // unit tests). This standalone dry-run mirrors the real daemon's behavior.
  startScheduler({
    orchDir,
    classifyResolution: classifyTicketResolution,
    isBgJobAlive: defaultIsBgJobAlive,
  });
  const shutdown = (sig) => {
    log.info({ sig }, "execution-core scheduler shutting down");
    stopScheduler();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) main();
