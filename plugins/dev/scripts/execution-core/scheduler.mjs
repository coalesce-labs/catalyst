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
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto"; // CTL-1337: deterministic per-tick trace/span id
import {
  analyzeDependencyGraph,
  referencedBlockerIds,
  buildDependencyEdges,
  DEFAULT_TERMINAL_STATUSES,
  wouldCreateCycle,
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
  ANCILLARY_PHASES, // CTL-1323: remediate etc. — still real pipeline work (PHASES is already imported from phase-fsm above)
} from "../lib/workflow-descriptor.mjs";
export { STAGE_RANK, NON_PREEMPTABLE_PHASES };
// CTL-653: the verdict-router reads (verify.json verdict + event-counted cycle
// budget) live here. deriveAdvancement stays pure — the impure reads happen in
// the sweep and are injected, so the router itself is unit-testable.
import { readVerifyVerdict } from "./work-done-probes.mjs";
import { countRemediateCycles, countTicketEventsInWindow } from "./event-scan.mjs";
import { rankTickets, compareTickets } from "./scheduler-rank.mjs";
import {
  defaultDispatch,
  dispatchTicket,
  teamOf,
  settleDispatchSync,
  isThenable,
  backstopOnRejection,
} from "./dispatch.mjs"; // CTL-1367 P1: settle async (sdk) dispatch synchronously + backstop a rejected async dispatch
import {
  fetchTicketState,
  fetchTicketsBatch,
  classifyTicketResolution,
  fetchTicketAssignee,
  isAssigneeClaimable,
  isClaimable,
  readTicketLabels,
} from "./linear-query.mjs";
import { gatewayLabelsHit } from "./gateway-read.mjs"; // CTL-1079
import { getProjectConfig, listProjects, ownerRepoFromRepoRoot } from "./registry.mjs"; // CTL-1157: ownerRepoFromRepoRoot reconciles registry repoRoot → GitHub owner/repo for board-health's composite (repo,number) PR-status lookup
// CTL-703: worktree teardown is now handled by the dedicated phase-teardown
// phase agent (the 10th pipeline phase), not the scheduler's terminal sweep.
// The gatedTeardownWorktree import is removed; the teardown phase agent
// re-implements the gate in bash (merge-confirmation evidence + worktree
// presweep + non-force `git worktree remove`) in phase-teardown/SKILL.md.
import {
  readWorkerSignals,
  countSdkInflight as defaultCountSdkInflight,
  hasFreshClaim,
} from "./signal-reader.mjs";
// CTL-1410 Phase B: the in-process SDK worker registry — the liveness fact for
// workers with no bg job (leaf module; a Map read, never a shell-out).
import { isSdkWorkerLive as registrySdkWorkerLive } from "./sdk-worker-registry.mjs";
// CTL-933: shadow belief-store fact collector (opt-in CATALYST_BELIEFS_SHADOW=1).
// CTL-937: getBeliefsDb exposes the module-level db handle for the diagnostician.
// CTL-1241: getEscalateHumanBelief reads the latest escalate_human belief for the
// recovery evidence attachment (revives the structurally-dead R12 branch).
import { collectBeliefsTick, getBeliefsDb, getEscalateHumanBelief } from "./beliefs/collector.mjs";
import { buildRecoveryItems } from "./recovery-evidence.mjs";
// CTL-1045 Bug 1: kill-storm suppression guard for defaultJanitorKillIntentRecorder.
import {
  isIntentEffective,
  getMaxAttempts,
  recordIntent as recordIntentBelief,
} from "./beliefs/intent.mjs";
// CTL-966 + CTL-935: the advancement shadow comparator — compares the procedural
// deriveAdvancement oracle against the advance_to / cycle_exhausted beliefs and
// logs disagreements. SHADOW ONLY (reads beliefs + computes oracle + logs; never
// dispatches/writes a signal/writes Linear).
import {
  runAdvanceShadow,
  readSignalsFromEdb,
  readVerdictFromEdb,
  readCycleFromEdb,
} from "./beliefs/advance-shadow.mjs";
import { recordShadowComparison } from "./beliefs/shadow-store.mjs";
import { runFreeSlotsShadow } from "./beliefs/free-slots-shadow.mjs";
import { makeReclaimShadowRecorder } from "./beliefs/reclaim-shadow.mjs";
// CTL-937: bounded stall-diagnostician wake wiring (opt-in CATALYST_DIAGNOSTICIAN=1).
import { processDiagnosticianWakes } from "./diagnostician.mjs";
import { executeEscalations } from "./beliefs/escalate.mjs";
// CTL-642/758: the live PR-merged adapter. makePrView is the single gh
// `pr view` source of truth (shared with the scan CLI's makeScanAdapters), so
// the daemon's recovery short-circuit + reconcile backstop run the identical
// `gh -R <slug> pr view <n> --json state,mergeStateStatus,mergedAt,mergeCommit`
// call without copy-pasting it. Constructed ONCE per daemon boot (see runTick),
// never per-tick / per-ticket — the gh subprocess only fires from inside prView
// on the rare merged-zombie / drift path, not on construction.
import { makePrView } from "./scan-adapters.mjs";
// CTL-1157 (ALARM-NOT-BLOCK): the open-PR ENUMERATOR the terminal sweep's direct
// Done write (terminalDoneOnce) consults — NOT a refuse-gate (THE REVERSAL). It no
// longer blocks the write; it supplies the FACTS used to decide whether to fire the
// recovery.done-applied-with-open-pr alarm. Permissive no-op default in schedulerTick;
// armed with this real impl by runTick.
import { defaultCheckOpenPrs } from "./open-pr-gate.mjs";
// CTL-1157 (ALARM-NOT-BLOCK): the loud `recovery.done-applied-with-open-pr` event
// the pure-code terminal sweep emits when it lands a Done while an open PR exists.
import {
  appendRecoveryDoneOpenPrEvent,
  appendRecoveryDoneAppliedEvent,
} from "./recovery-done-open-pr-event.mjs";
import {
  countBackgroundAgents,
  getAgentsCached,
  isBgJobAlive as defaultIsBgJobAlive,
  livenessForBgJob as defaultLivenessForBgJob, // CTL-768
  setLivenessLogger, // CTL-1330: wire the liveness-refresh observability sink
  setLivenessSpanSink, // CTL-1330 Tier 3: wire the liveness.refresh span sink
} from "./claude-agents.mjs";
// CTL-1330 Tier 3: OTLP span export (OFF unless CATALYST_TRACING=on).
import {
  initTracing,
  shutdownTracing,
  emitTickTrace,
  emitLivenessRefreshSpan,
} from "./tracing.mjs";
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
  reclaimDeadHostWork,
  // CTL-1191: surviving-roster primitives so the recovery passes (unstuck /
  // reasoning / diagnostician) HRW-gate over the SURVIVING roster — a dead
  // node's stuck work fails over to a live owner instead of stranding.
  readClusterHeartbeats,
  deadHosts,
  survivingRoster,
  defaultAppendDispatchFailedEvent,
  defaultAppendDispatchRequestedEvent,
  defaultAppendDispatchLaunchedEvent,
  defaultAppendYieldFileSkipEvent,
  defaultKillBgJob,
  defaultAppendPreemptedEvent,
  defaultAppendResumedAfterPreemptionEvent,
  defaultAppendHeldStoppedEvent,
  defaultAppendCooldownGcEvent,
  defaultAppendCooldownEscalatedEvent,
  defaultAppendPhaseAdvanceHeldEvent,
  defaultAppendRunawayEvent,
  defaultAppendOrphanDetectedEvent,
} from "./recovery.mjs";
import { resolvePhaseSessionId as defaultResolveSession } from "./session-resolve.mjs";
// CTL-729: progress-watchdog imports.
import { evaluateHungWorker } from "./hung-detector.mjs";
import { transcriptAgeMs as defaultTranscriptAgeMs } from "./transcript-silence.mjs";
import { killHungWorker as defaultKillEscalate } from "./watchdog-action.mjs";
import {
  readWatchdogConfig,
  phaseBudgetMs,
  readStallJanitorConfig,
  readCostCapConfig,
} from "./config.mjs";
// CTL-1137: cost-cap watcher (Pass 0c) — out-of-process per-session $ preemption.
import {
  shouldCheckNow,
  fetchSessionCostUsd,
  markPhaseSignalFailed,
  checkWorkerCost,
} from "./cost-cap.mjs";
import { defaultProgressMark } from "./work-done-probes.mjs";
// CTL-1004: stall-janitor (terminal-state leftover collapser) — runs as Pass 0j,
// shadow-first. The pure decision + action driver live in stall-janitor.mjs; the
// census + emit + intent seams are injected here so the bare tick stays inert.
// The default (read-only) census producers are wired into runTick below so the
// daemon exercises the pass in SHADOW by default.
import {
  runStallJanitorPass,
  defaultCollectOrphanCandidates,
  defaultCollectGhostCandidates,
  defaultCollectStallClearCandidates, // CTL-1005 J3
  defaultCollectTerminalSignalGcCandidates, // CTL-1242 J4
  defaultGcTerminalSignals, // CTL-1242 J4
} from "./stall-janitor.mjs";
// CTL-1064: unstuck-sweep (Pass 0u) — throttled classify-then-act sweep for
// the stalled/needs-human ticket backlog. Pure classifiers + action driver in
// unstuck-sweep.mjs; census producers below. Mode='off' by default; operators
// opt in via CATALYST_UNSTUCK_SWEEP=shadow then =enforce (or Layer-2 config).
import {
  runUnstuckSweepPass,
  defaultCollectUnstuckCandidates,
  emitUnstuckEvent,
} from "./unstuck-sweep.mjs";
// CTL-1176: Pass 0r — LLM reasoning recovery pass. Ships off by default (ADR-023);
// operators opt in via CATALYST_RECOVERY_PASS=shadow then =enforce.
//
// The host-local cooldown / intent ledger and the act-seams resolve their
// orchDir from process.env.CATALYST_ORCHESTRATOR_DIR — which the daemon NEVER
// sets on its own process (that env var is exported only onto CHILD phase-agent
// processes by dispatch.mjs / phase-agent-dispatch). So the bare defaults would
// resolve orchDir=null in the daemon, making the cooldown / max-attempts /
// escalated-latch all inert and turning shadow into an unconditional spammer.
// We import the defaults explicitly and BIND them to the tick's real orchDir at
// the call site (the scheduler already has orchDir in scope) so the storm guard
// is real in production, not just in unit tests that inject orchDir by hand.
import {
  reasoningRecoveryPass,
  defaultShouldSkipItem as recoveryShouldSkipItem,
  defaultSkipReason as recoverySkipReason, // CTL-1440 (P0b): exhausted-vs-cooldown truth
  escalateExhaustedIntents, // CTL-1440 (P0b): attempts-exhausted → loud escalation
  readDeferredBoardHealthIntents, // CTL-1432 (B2): deferred board-health anchor candidates
  defaultRecordIntent as recoveryRecordIntent,
  // CTL-1242 (corrected scope): forget the host-local recovery-intent latch when
  // a ticket goes terminal so the ledger doesn't accumulate stale finished-ticket
  // files (called from the terminal-sweep clear branch below).
  defaultForgetIntent as recoveryForgetIntent,
  defaultInvokeSeam as recoveryInvokeSeam,
  // CTL-1176 rung 3: the bounded-LLM path now dispatches the goal-driven
  // recovery-pass skill (replacing the phase-remediate detour). Bound to the
  // tick's orchDir at the call site. Still entirely behind CATALYST_RECOVERY_PASS
  // (mode=off ⇒ the pass never runs), so no live behavior change until opt-in.
  defaultInvokeRecoveryPass as recoveryInvokeRecoveryPass,
  // CTL-1157: the curated-escalation signal writer (Workstream C) + the defer
  // attempts reader (Workstream B). Bound to the tick's orchDir at the call site
  // (like recordIntent) — the daemon never sets CATALYST_ORCHESTRATOR_DIR on its
  // own process, so the env-resolving defaults would otherwise no-op.
  defaultWriteEscalationSignal as recoveryWriteEscalationSignal,
  defaultReadIntentAttempts as recoveryReadIntentAttempts,
} from "./recovery-reasoning.mjs";
// CTL-1331: the async board-health delegate queue. countQueuedDelegates is the
// slot reservation (a queued/claimed delegate has taken a slot its `claude --bg`
// hasn't filled yet, so it is invisible to liveBackgroundCount); gcDelegateIntents
// releases terminal/stale reservations. Both are injectable seams on schedulerTick
// (defaults below) so a bare tick with an empty queue is a strict no-op (Phase A).
import {
  countQueuedDelegates as defaultCountQueuedDelegates,
  gcDelegateIntents as defaultGcDelegateIntents,
  enqueueRecoveryItemDelegate, // CTL-1331 FU-1: per-item Pass 0r recovery → queue
} from "./delegate-queue.mjs";
// CTL-1219: the per-category enforcement seam registry (dirty-tree /
// source-conflict / orphan-stale / stale-label). Pure-cored + injectable; bound
// to production deps at the unstuckSweep wiring point below. Wiring this does NOT
// flip enforce on — the mode gate stays at its safe 'off' default (ADR-023).
import { buildUnstuckActSeams } from "./unstuck-act-seams.mjs";
import {
  readUnstuckSweepConfig,
  readRecoveryPassConfig,
  readBoardHealthConfig,
  readSanctionedNeedsHuman,
  readReclaimGatewayFreshMs,
  isThrottled,
} from "./config.mjs";
// CTL-558: the deterministic Linear status/label write seam. The whole module
// is injected as `writeStatus` so tests pass fakes; production uses the real
// module (best-effort — every write swallows its own failures).
import * as linearWrite from "./linear-write.mjs";
// CTL-863: zombie-guard for external-write sites on multi-host clusters.
import { fenceGuard } from "./fence-guard.mjs";
// CTL-863: Linear-free fence event emitter (durable fence → event-log migration).
import { emitFenceClaimed } from "./fence-event.mjs";
// CTL-1481: best-effort worker:<host> label visibility-projection stamp on a
// won cluster claim. Never the claim arbiter — see worker-label.mjs header.
import { stampWorkerLabel as defaultStampWorkerLabel } from "./worker-label.mjs";
// CTL-757: the canonical linear.state.write audit emitter. CALLER-EMITS at each
// scheduler write site (source/phase/reason known only here) — NEVER inside
// runTransition (would double-audit the triage path, which keeps its own
// phase.triage.linear-transition event). Best-effort: swallow-on-error.
import { appendLinearStateWriteEvent } from "./linear-state-write-event.mjs";
import { appendWorkerTransitionEvent as defaultAppendWorkerTransitionEvent } from "./worker-transition-event.mjs"; // CTL-764 Phase 5
import { resolveTicketType } from "./ticket-type.mjs"; // CTL-1023: work-type dimension
// CTL-642 + CTL-758: the SHARED Linear terminal-state predicate. isLinearTerminal
// ({Done,Canceled} — its OWN set) backs both the reconcile-backstop's
// "live state !terminal" check and the recovery short-circuit threaded into
// reclaimOpts below.
// CTL-1191: isTicketTerminalOrMerged — used by the recovery-reasoning pass (Pass
// 0r) to stop reasoning over a ticket already finished (terminal Linear state or
// merged PR), per the PR #2163 verify flag.
import { isLinearTerminal, isTicketTerminalOrMerged } from "./terminal-state.mjs";
// CTL-638: labelOnce moved out of this file into a shared leaf module so the
// recovery-sweep escalation path can use the same once-marker guard. Keeping
// labelOnce here would force recovery.mjs → scheduler.mjs to import it, but
// scheduler.mjs already imports reclaimDeadWorkIfPossible from recovery.mjs —
// a cycle. label-guard.mjs is the leaf module both can import.
import { labelOnce, clearStalledLabel, labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";
import { processApprovedResumes } from "./boot-resume.mjs"; // CTL-644: per-tick approval poll
import { countReapOutcomes } from "./reaper-metrics.mjs";
import {
  log,
  getEligibleDir,
  getEventLogPath,
  getHostName,
  getClusterHosts,
  hostMembershipWarning,
  isDraining as isDrainingDefault,
  getDrainedMarkerPath, // CTL-1321: shared resolver for the drain.drained sentinel
  HEARTBEAT_GRACE_MS, // CTL-1191: dead-host grace for surviving-roster recovery gate
  HEARTBEAT_RESTORE_HOLD_MS, // CTL-1091: restore-side deflap hold for the dispatch roster
  isInProcessDispatchMode, // CTL-1457 (T2): sdk|codex-exec occupancy gate predicate
} from "./config.mjs";
import { emitDrainedEvent as defaultEmitDrainedEvent } from "./drain-event.mjs"; // CTL-1095: drained sentinel
import { defaultCheckSequencing } from "./sequencing.mjs"; // CTL-537
import { ownedBy, ownerForTicket } from "./hrw.mjs"; // CTL-850: HRW ownership filter (CTL-1191 also uses it for the diagnostician gate); ownerForTicket: CTL-1290 board-health stranded-node + enforce HRW gate
import { computeDispatchRoster, readDeflapState, writeDeflapState } from "./liveness-deflap.mjs"; // CTL-1091: restore-side deflap for the dispatch roster
import { boardHealthPass } from "./board-health.mjs"; // CTL-1290: the whole-board health delegate (shadow-first)
import {
  getAllTicketDescriptors,
  getAllPrStatuses,
  openBrokerStateDb,
} from "../broker/broker-state.mjs"; // CTL-1290: board snapshot (reads only). bun:sqlite-backed — safe here: scheduler.mjs is daemon-only and NOT in the orch-monitor vite/UI graph (see MEMORY vite_config_bun_sqlite_trap). CTL-1157: getAllPrStatuses = the filter_state PR-lifecycle reader for the phantom/orphaned-PR invariants. openBrokerStateDb (CTL-1157 Codex round-6): the exec-core daemon must open the broker DB handle before these readers — ensure() throws otherwise and assembleBoardState swallows it, leaving the board/PR maps empty and the cohorts inert.
import { readReconcileHealthMarkers } from "./reconcile-health.mjs"; // CTL-1290: stranded-node reconcile signal
import { claimDispatchSync } from "./cluster-claim-sync.mjs"; // CTL-850: cross-host claim soft-CAS
// CTL-954: team estimation method — lazy-cached from Linear, used to expand
// the allowed estimate point set beyond the hard-coded Fibonacci values.
import {
  getEstimationMethod,
  scaleForMethod,
  mapScopeToEstimate,
} from "./linear-estimation-method.mjs";
import {
  buildExplanation,
  buildRemediateCapExplanation,
  coerceExplanation,
} from "./escalation-explanation.mjs"; // CTL-1130

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

// CTL-1191: computeSurvivingRoster — the roster minus hosts whose heartbeat is
// older than the grace window. SHARED by both recovery-pass HRW gates
// (schedulerTick's ownsForRecovery and runTick's diagnostician ownsSubject) so
// the two never disagree about who is alive. Mirrors reclaimDeadHostWork's
// survivor computation (recovery.mjs:2979-2983) exactly.
//
// FAIL-SAFE: a thrown heartbeat read, or a roster where EVERY host looks dead
// (e.g. an empty/garbled event log), degrades to the FULL roster — each node
// then owns only its own HRW slice (NEVER double-acts) and we merely forgo the
// dead-owner failover for this tick (no worse than the pre-CTL-1191 strand).
// Single-host (roster.length <= 1) returns the roster unchanged with no read.
// CTL-1091: exported so monitor.mjs can route its triage-dispatch ownership gate
// through the same surviving-roster read as the scheduler's new-work gate (both
// dispatch sites then agree with recovery on who is alive). Safe to import from
// monitor.mjs — this helper pulls in no bun:sqlite dependency (CTL-1397).
export function computeSurvivingRoster(
  roster,
  { readHeartbeats = readClusterHeartbeats, nowMs = Date.now() } = {}
) {
  if (!Array.isArray(roster) || roster.length <= 1) return roster;
  try {
    const lastSeen = readHeartbeats({ roster });
    const dead = deadHosts({ lastSeen, roster, graceMs: HEARTBEAT_GRACE_MS, nowMs });
    const alive = survivingRoster(roster, dead);
    return alive.length > 0 ? alive : roster;
  } catch {
    return roster;
  }
}

// CTL-1091 Phase 3: the RAW positively-live host set. Dispatch ownership requires
// POSITIVE liveness — a host must have been SEEN within grace to own new work —
// unlike computeSurvivingRoster's fail-OPEN deadHosts (an unseen host is "not
// proven dead" and stays a survivor). Returns `{ live }` where `live` is the
// filtered array (possibly EMPTY when nobody is positively live), or `{ live: null }`
// when the heartbeat read THREW. The empty/null distinction from "some hosts live"
// is what lets callers tell a total feed outage apart from a partial one — the
// fail-safe (degrade to the full roster) must fire only on a genuine outage.
function readPositiveLive(
  roster,
  { readHeartbeats = readClusterHeartbeats, nowMs = Date.now(), graceMs = HEARTBEAT_GRACE_MS } = {}
) {
  try {
    const lastSeen = readHeartbeats({ roster });
    const cutoff = nowMs - graceMs;
    const live = roster.filter((h) => {
      const seen = lastSeen[h];
      return typeof seen === "string" && seen.length > 0 && Date.parse(seen) >= cutoff;
    });
    return { live };
  } catch {
    return { live: null };
  }
}

// computeDispatchSurvivingRoster — the positive-liveness dispatch roster with the
// outage fail-safe folded in: sheds a NEVER-live rostered host (absent from
// lastSeen — the CTL-1057 permanently-offline case) so its HRW slice fails over,
// but degrades to the FULL roster when NOBODY is positively live (a total feed
// outage) so the board is never stranded. Single-host (roster.length <= 1) is a
// no-op with no read. The recovery side deliberately keeps the fail-open deadHosts
// (it must NOT reclaim a never-seen host's non-existent work); see docs/architecture.md.
export function computeDispatchSurvivingRoster(roster, opts = {}) {
  if (!Array.isArray(roster) || roster.length <= 1) return roster;
  const { live } = readPositiveLive(roster, opts);
  return live && live.length > 0 ? live : roster;
}

// resolveDispatchRoster — the SINGLE source of truth for the dispatch-ownership
// roster, shared by BOTH dispatch sites (scheduler new-work `_dispatchRoster` and
// monitor `dispatchTriage`) so they can never drift into split-brain (CTL-1091
// cleanup #1). Composes positive-liveness → restore deflap → outage fail-safe:
//
//  1. Read the raw positively-live set once.
//  2. TOTAL OUTAGE (read threw, or NOBODY positively live) → degrade to the FULL
//     roster and DO NOT mutate the deflap observation state (we learned nothing
//     this tick). This preserves the "outage → full roster, never re-home" invariant
//     that a naive deflap-on-fail-open-roster would violate: without this guard a
//     just-departed host (prevState liveSince:null) would be held out and its slice
//     re-homed to a peer during an outage (CTL-1091 correctness review #1).
//  3. Otherwise apply the restore deflap (computeDispatchRoster) on the live set;
//     `persist` writes the next observation state atomically (scheduler is the SOLE
//     writer; monitor passes persist:false and reads the same file read-only).
//
// Single-host (roster.length <= 1) is a strict no-op with no read. Injectable
// readHeartbeats/holdMs for tests.
export function resolveDispatchRoster({
  roster,
  orchDir,
  self,
  nowMs = Date.now(),
  persist = false,
  readHeartbeats = readClusterHeartbeats,
  holdMs = HEARTBEAT_RESTORE_HOLD_MS,
} = {}) {
  if (!Array.isArray(roster) || roster.length <= 1) return roster;
  const prevState = readDeflapState(orchDir);
  const { live } = readPositiveLive(roster, { readHeartbeats, nowMs });
  if (!live || live.length === 0) {
    // Total outage → full roster, observation state untouched.
    if (persist) writeDeflapState(orchDir, prevState);
    return roster;
  }
  const { dispatchRoster, nextState } = computeDispatchRoster({
    survivingRoster: live,
    roster,
    prevState,
    holdMs,
    nowMs,
    self,
  });
  if (persist) writeDeflapState(orchDir, nextState);
  return dispatchRoster;
}

// CTL-1004/CTL-1056 Bug 2: dispatchFailureDiag — extract the diagnostic fields
// from a dispatch result (r = { code, stderr, spawnError, signal }) for the
// "dispatch failed" log + the phase.dispatch.failed event. The scheduler used to
// log a BARE { ticket, code } and the event dropped stderr entirely, leaving
// tonight's dispatch failures undiagnosable. Returns only the keys that carry
// signal — an empty stderr / absent spawnError|signal produce NO key, so the
// happy/empty case stays noise-free. The stderr tail is the last ~500 chars,
// trimmed (the diagnostic is at the end: the failure ladder / exec error message).
const DISPATCH_STDERR_TAIL_MAX = 500;
export function dispatchFailureDiag(r = {}) {
  const out = {};
  const raw = typeof r.stderr === "string" ? r.stderr.trim() : "";
  if (raw.length > 0) out.stderr_tail = raw.slice(-DISPATCH_STDERR_TAIL_MAX);
  if (r.spawnError != null && r.spawnError !== "") out.spawn_error = r.spawnError;
  if (r.signal != null && r.signal !== "") out.signal = r.signal;
  return out;
}

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
// `.estimate` (CTL-751, CTL-954). Validation logic:
//
//   1. triage.json has an explicit `.estimate` value:
//      a. triage.json also carries `.estimateMethod` (set by an Opus-mode pass
//         that already fetched the team method) → validate against that scale.
//      b. Otherwise: validate against the live team method from
//         getEstimationMethod (lazy-cached, fail-open).  If the team method
//         is unavailable, fall back to the Fibonacci set {1,3,5,8,13} so
//         pre-CTL-954 triage.json files continue to work unchanged.
//
//   2. triage.json has NO `.estimate` but has `.estimateMethod` + `.estimated_scope`:
//      An Opus-mode pass set the method but didn't compute the numeric estimate —
//      derive it via mapScopeToEstimate(scope, method).
//
//   3. triage.json has `.estimated_scope` only (bash-body path, no Opus):
//      Attempt lazy derivation via getEstimationMethod + mapScopeToEstimate.
//      Fail-open: if the team method is unavailable, return null (the scheduler
//      skips the Linear write for this ticket; forward progress is unaffected).
//
// Returns null on missing file, unparseable JSON, absent/invalid estimate,
// or "notUsed" team method.  Never throws.
const FIBONACCI_ALLOWED_SET = new Set([1, 3, 5, 8, 13]);
function readTriageEstimate(orchDir, ticket) {
  try {
    const raw = readFileSync(join(orchDir, "workers", ticket, "triage.json"), "utf8");
    const triage = JSON.parse(raw);
    const { estimate, estimateMethod, estimated_scope } = triage;

    const hasEstimate = estimate !== undefined && estimate !== null;

    if (hasEstimate) {
      // --- Path 1: explicit estimate value in triage.json ---

      // Resolve method type: from triage.json first (no network), else lazy fetch.
      let methodType = estimateMethod ?? null;
      if (!methodType) {
        const teamKey = teamOf(ticket);
        const m = teamKey ? getEstimationMethod(teamKey) : null;
        methodType = m?.type ?? null;
      }

      if (methodType) {
        const scale = scaleForMethod(methodType);
        if (scale.length > 0) {
          return scale.includes(estimate) ? estimate : null;
        }
        // methodType is "notUsed" → team doesn't use estimates → skip.
        return null;
      }

      // No method info at all: fall back to Fibonacci (backward-compat).
      return FIBONACCI_ALLOWED_SET.has(estimate) ? estimate : null;
    }

    // --- Path 2 / 3: no explicit estimate — attempt scope derivation ---
    if (!estimated_scope) return null;

    // Use the method recorded in triage.json if present (avoids network).
    let methodType = estimateMethod ?? null;
    if (!methodType) {
      const teamKey = teamOf(ticket);
      const m = teamKey ? getEstimationMethod(teamKey) : null;
      methodType = m?.type ?? null;
    }
    if (!methodType) return null; // fail-open

    return mapScopeToEstimate(estimated_scope, methodType);
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

// readClusterGeneration / writeClusterGeneration (CTL-864 remediation) — the
// persisted cross-host fence token for a ticket.
//
// Why persist-and-reinject. The won cross-host claim generation is captured ONCE
// at the new-work claim (the ONLY claimDispatch site, schedulerTick new-work
// pull). The 5 guarded phase skills, however, run as LATER phases dispatched by
// the advancement + revive sweeps — which never re-forward the token, so the
// CTL-864 fence was inert in production. We persist the won generation here so
// those later sweeps can re-inject the SAME token into each guarded worker's
// CATALYST_CLUSTER_GENERATION env.
//
// Critically, we re-inject the generation THIS host *won* — NOT a fresh read of
// the current Linear generation. A takeover (CTL-863) bumps the Linear
// generation; the re-injected (now-stale) token no longer matches and the
// worker's cluster-fence-guard bows out. Reading the *current* generation here
// would always match and silently defeat the fence — so the persisted value is
// written once at claim-win and only ever read back, never refreshed.
//
// Single-host installs never win a claim → never write the file → reads return
// null → the dispatch forwards no token → exact no-op (matches CTL-864's gate).
export function readClusterGeneration(orchDir, ticket) {
  try {
    const raw = readFileSync(join(orchDir, "workers", ticket, "cluster-generation.json"), "utf8");
    const g = JSON.parse(raw);
    return Number.isFinite(g?.generation) ? g.generation : null;
  } catch {
    return null;
  }
}

// Idempotent overwrite via tmp+rename. A non-finite generation (single-host /
// null claim) is never persisted, so a later read stays a clean no-op. Silently
// no-ops on a missing worker dir or I/O failure (best-effort, like
// writeWorkerPriority) — call only after the dispatch verified the signal exists.
export function writeClusterGeneration(orchDir, ticket, generation) {
  if (!Number.isFinite(generation)) return;
  const p = join(orchDir, "workers", ticket, "cluster-generation.json");
  try {
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ generation }));
    renameSync(tmp, p);
  } catch {
    // best-effort — missing worker dir or I/O failure; the later sweep forwards null
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

// CTL-1323: the set of REAL pipeline phases — a signal whose phase is one of these
// represents genuine pipeline work occupying a slot. Phases NOT in this set (e.g.
// "recovery-pass", the board-health delegate's inspection sweep) are transient
// artifacts, not pipeline work.
const REAL_PIPELINE_PHASES = new Set([...PHASES, ...ANCILLARY_PHASES]);

// CTL-1323: the terminal-SUCCESS statuses that mean a non-pipeline signal is truly
// inert — no live worker, and no pending operator decision. ONLY these make a dir
// phantom. We deliberately use a POSITIVE allow-list (not "anything not running"):
// a recovery-pass that ESCALATED (needs-human), PARKED (needs-input/turn-cap-exhausted),
// was PREEMPTED, or FAILED must stay held — it surfaces a Needs-You signal or is
// resumable, and re-pulling it would bury that pending state / abandon recovery context.
const PHANTOM_TERMINAL_STATUSES = new Set(["done", "complete", "skipped"]);

// CTL-1323: isPhantomWorkerDir — true when a worker dir is a PHANTOM: it carries
// signals, but NONE is a real pipeline phase AND every signal is terminal-success.
// The canonical case is a board-health recovery-pass that ran+completed, leaving only
// `phase-recovery-pass.json:done`. Such a dir is NOT pipeline work — yet bare
// directory-existence (listStartedTickets) excludes the ticket from the new-work pull
// FOREVER, and isTicketInFlight counts it as occupying a slot, so the ticket strands in
// Todo with no live worker (the CTL-1323 wedge: ADV-1398/1400/1306). Treating it as a
// phantom lets both list functions ignore it so the ticket is re-pulled fresh.
//
// A non-pipeline signal that is NOT terminal-success (dispatched/running/preempted/
// needs-human/needs-input/turn-cap-exhausted/failed/…) makes the dir NON-phantom — it
// holds a real slot or a pending operator/recovery state we must not clobber. An EMPTY
// signal set is NOT phantom (conservative — a bare/just-created dir we don't re-pull).
// Pure over a phase→status map; exported for the CI unit suite.
export function isPhantomWorkerDir(signals) {
  const entries = Object.entries(signals ?? {});
  if (entries.length === 0) return false;
  for (const [phase, status] of entries) {
    if (REAL_PIPELINE_PHASES.has(phase)) return false; // a genuine pipeline signal
    if (!PHANTOM_TERMINAL_STATUSES.has(status)) return false; // active / parked / escalated → not phantom
  }
  return true; // only terminal-success non-pipeline signals (e.g. recovery-pass:done)
}

// bgLivenessProtects — CTL-1336. The Pass 0a phantom-sweep decision: does the warm
// `claude agents` snapshot say a worker's bg job is alive (so the destructive quarantine
// must SKIP it), WITHOUT ever spawning `claude agents` on the synchronous tick? Pure +
// exported so it's unit-testable in isolation (driving the full tick with a bg signal also
// trips the reclaim/revive/terminal passes, which mask this decision).
//   • no bg id          → false (nothing to protect here; fall through to the Linear gate)
//   • snapshot NOT fresh → true  (cold/stale cache reports a live worker as dead — a boot-time
//                                 empty snapshot — so FAIL OPEN rather than mis-quarantine)
//   • snapshot fresh     → whatever the snapshot-backed isBgJobAlive says (zero-spawn)
export function bgLivenessProtects(bgId, snapshot, isBgJobAlive) {
  if (!bgId) return false;
  if (!snapshot?.isFresh) return true; // fail open on a cold/stale snapshot
  return Boolean(isBgJobAlive(bgId, { agents: snapshot.agents }));
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
    const signals = readPhaseSignals(orchDir, d.name);
    // CTL-1323: a phantom recovery-pass dir is not real in-flight work — skip it so it
    // isn't counted as occupying a slot (and so buildGlobalRanking doesn't list it both
    // as in-flight here AND as a fresh new-work candidate once listStartedTickets drops it).
    if (isTicketInFlight(signals) && !isPhantomWorkerDir(signals)) inFlight.add(d.name);
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
      { totalReserve, globalMax, perProject: coerced }
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
      { configuredCaps, globalMax }
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
      readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8")
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
    return sig.verify === "done" ? { phase: "verify", reason: "ctl-661-remediate-detour" } : null;
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
  { perProject = {}, inFlight = new Set() } = {}
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
        // CTL-1323: a phantom recovery-pass dir does NOT count as "started" — otherwise
        // the new-work pull (buildGlobalRanking) excludes the ticket forever and it
        // strands in Todo with no live worker. Dropping it here re-pulls it as fresh work.
        .filter((d) => !isPhantomWorkerDir(readPhaseSignals(orchDir, d.name)))
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
    latestStatus === "done" || (latestStatus === "skipped" && latest === "monitor-deploy");
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
  {
    writeFile = writeFileSync,
    readFile = readFileSync,
    // CTL-1064: optional seam to pre-compute the round-history summary so
    // the unstuck-sweep's escalation comment has it available on the signal.
    // Injected; undefined in production until a follow-up wires the real
    // events/YYYY-MM.jsonl scanner (explicitly out of scope for this plan).
    summarizeHistory = undefined,
  } = {}
) {
  if (signals.verify !== "done" || verdict !== "fail" || cycleCount < REMEDIATE_CYCLE_CAP) {
    return false;
  }
  const p = join(orchDir, "workers", ticket, "phase-verify.json");
  try {
    const cur = JSON.parse(readFile(p, "utf8"));
    if (cur.status === "stalled") return true; // idempotent
    let remediateSummary;
    if (typeof summarizeHistory === "function") {
      try {
        remediateSummary = summarizeHistory(ticket);
      } catch {
        /* best-effort */
      }
    }
    // CTL-1108: source the operator-facing explanation from the verify.json that
    // still exists on disk at cap-exhaustion time (HIGH findings + regression_risk).
    let verifyJson = null;
    try {
      verifyJson = JSON.parse(readFile(join(orchDir, "workers", ticket, "verify.json"), "utf8"));
    } catch {
      // verify.json absent/unreadable → mapper degrades to a valid generic explanation
    }
    const explanation = buildRemediateCapExplanation(verifyJson, { ticket, cycleCount });
    writeFile(
      p,
      JSON.stringify({
        ...cur,
        status: "stalled",
        stalledReason: "remediate-cycle-cap-exhausted",
        explanation,
        updatedAt: new Date().toISOString(),
        ...(remediateSummary !== undefined ? { remediateSummary } : {}),
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
    log.warn(
      { ...ctx, err: err.message },
      "scheduler: dispatch-lifecycle emit threw — continuing tick"
    );
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
// CTL-764 Phase 4: value renamed "waiting" → "queued" (identifier preserved for
// drift-guard imports). The HUD back-compat-maps legacy "waiting" so a mid-rollout
// board is never blank. All new writes apply "queued".
export const HELD_LABEL_WAITING = "queued";
// CTL-764 Phase 4: new disposition constants.
export const HELD_LABEL_NEEDS_INPUT = "needs-input";
export const HELD_LABEL_NEEDS_HUMAN = "needs-human";
// TICK_CONVERGED_DISPOSITIONS — the three dispositions that tick-converge via
// convergeDispositionLabel. needs-human is EXCLUDED (it is sticky via labelOnce).
const TICK_CONVERGED_DISPOSITIONS = [
  HELD_LABEL_BLOCKED,
  HELD_LABEL_WAITING,
  HELD_LABEL_NEEDS_INPUT,
];
// Keep HELD_LABELS for convergeHeldLabel (thin alias) backward compat.
const HELD_LABELS = [HELD_LABEL_BLOCKED, HELD_LABEL_WAITING];
// CTL-764 finding 1: the pre-migration disposition value. HELD_LABEL_WAITING now
// resolves to "queued", so the rename dropped the legacy "waiting" out of every
// removal loop — a ticket still carrying it kept rendering as queued via the board
// back-compat path and could exclusive-conflict with applying the new "queued".
// This value is NEVER APPLIED (only "queued" is); it lives in the REMOVABLE sets so
// clear-on-pickup / convergence keep draining it until historical labels are gone.
const LEGACY_HELD_LABEL_WAITING = "waiting";
// Removable superset = the applicable held labels PLUS the legacy value. Used only by
// the remove loops (removable ≠ applicable).
const HELD_LABELS_REMOVABLE = [...HELD_LABELS, LEGACY_HELD_LABEL_WAITING];

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
export function convergeHeldLabel(
  ticket,
  current,
  desired,
  writeStatus,
  { orchDir, now = Date.now, onRemoveResult } = {}
) {
  // CTL-834: back off if a recent apply of `desired` failed unrecoverably.
  if (orchDir && desired && inLabelCooldown(orchDir, ticket, desired, now())) {
    return 0;
  }
  const have = new Set(current ?? []);
  let writes = 0;
  // Remove any held label that is present but not desired. CTL-764 finding 1: the
  // removable set includes the legacy "waiting" so it is drained on clear-on-pickup.
  // CTL-764 r4: the removal result is captured directly (safeWrite discards it) and
  // surfaced via the optional onRemoveResult(label, removed) seam — removeLabel
  // reports failures as {removed:false} WITHOUT throwing, and clear emissions must
  // gate on a CONFIRMED removal. An undefined result (legacy/test stubs) counts as
  // success; a throw counts as failure. CTL-764 r5: the production removeLabel
  // (linear-write.mjs) is ASYNC while this converger (and schedulerTick) is sync —
  // a thenable result defers onRemoveResult to resolution instead of inspecting the
  // Promise (which read `.removed` as undefined and false-confirmed every removal);
  // the callback therefore fires post-tick in production and callers must not
  // assume it ran before this function returns.
  const settle = (label, res) => {
    if (res != null && typeof res.then === "function") {
      res.then(
        (r) => onRemoveResult?.(label, r?.removed !== false),
        (err) => {
          log.warn(
            { ticket, phase: "admission", err: err?.message },
            "scheduler: Linear write-back threw — continuing tick"
          );
          onRemoveResult?.(label, false);
        }
      );
      return;
    }
    onRemoveResult?.(label, res?.removed !== false);
  };
  for (const label of HELD_LABELS_REMOVABLE) {
    if (label !== desired && have.has(label)) {
      try {
        settle(label, writeStatus.removeLabel(ticket, label));
      } catch (err) {
        log.warn(
          { ticket, phase: "admission", err: err.message },
          "scheduler: Linear write-back threw — continuing tick"
        );
        onRemoveResult?.(label, false);
      }
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
      log.warn(
        { ticket, label: desired, err: err.message },
        "convergeHeldLabel: applyLabel threw — continuing tick"
      );
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
// "team-mismatch": CTL-1085 split it out of "missing-label" in classifyLabelFailure;
// it MUST stay in this set or convergeHeldLabel loses its cool-down on cross-team
// (ADV) label failures and re-introduces the CTL-834 per-tick retry storm.
const UNRECOVERABLE_LABEL_REASONS = new Set([
  "missing-label",
  "exclusive-conflict",
  "team-mismatch",
]);

// convergeDispositionLabel — generalised version of convergeHeldLabel covering the
// full worker-status disposition set (CTL-764 Phase 4). Like convergeHeldLabel it
// diffs current labels and applies/removes on change (steady-state zero writes),
// with the same CTL-834 cool-down gate on unrecoverable failures.
//
// KEY INVARIANTS:
//   • needs-human is NEVER tick-converged (it is sticky via labelOnce + .applied).
//   • Precedence: if the ticket already carries needs-human, make ZERO writes —
//     the lower dispositions are suppressed until needs-human is cleared by a
//     genuine resolution call (handleCommentWake → clearStalledLabel).
//   • NEVER issues removeLabel('needs-human') — only the three tick-converged
//     dispositions (queued/blocked/needs-input) are in the removable set.
//   • desired=null removes stale tick-converged labels but leaves needs-human alone.
export function convergeDispositionLabel(
  ticket,
  current,
  desired,
  writeStatus,
  { orchDir, now = Date.now } = {}
) {
  const have = new Set(current ?? []);
  // Precedence suppression: if needs-human is already applied AND desired is one of
  // the lower tick-converged dispositions (non-null), suppress ALL writes. The lower
  // disposition must not overwrite or coexist with needs-human.
  // When desired=null (clear-on-pickup), we still remove stale tick-converged labels
  // but leave needs-human alone (it is cleared only by genuine resolution).
  if (have.has(HELD_LABEL_NEEDS_HUMAN) && desired !== null && desired !== undefined) return 0;
  // CTL-834: back off if a recent apply of `desired` failed unrecoverably.
  if (orchDir && desired && inLabelCooldown(orchDir, ticket, desired, now())) {
    return 0;
  }
  let writes = 0;
  // Remove any tick-converged disposition label that is present but not desired.
  // needs-human is intentionally excluded from this removable set — it is sticky.
  // CTL-764 finding 1: the legacy "waiting" is drained here too (removable, never
  // applied) so a mid-rollout ticket cannot keep it alongside the new "queued".
  for (const label of [...TICK_CONVERGED_DISPOSITIONS, LEGACY_HELD_LABEL_WAITING]) {
    if (label !== desired && have.has(label)) {
      safeWrite(() => writeStatus.removeLabel(ticket, label), { ticket, phase: "admission" });
      writes++;
    }
  }
  // Apply the desired label if not already present.
  if (desired && !have.has(desired)) {
    let res;
    try {
      res = writeStatus.applyLabel({ ticket, label: desired });
    } catch (err) {
      log.warn(
        { ticket, label: desired, err: err.message },
        "convergeDispositionLabel: applyLabel threw — continuing tick"
      );
    }
    writes++;
    if (orchDir && res && res.applied === false && UNRECOVERABLE_LABEL_REASONS.has(res.reason)) {
      recordLabelCooldown(orchDir, ticket, desired, now());
      log.warn(
        { ticket, label: desired, reason: res.reason },
        "ctl-764: disposition-label apply unrecoverable — backing off (cool-down)"
      );
    }
  }
  return writes;
}

// CTL-1068 — convergeStartedHeldLabels: retract orphaned held labels for a STARTED
// (already-admitted) ticket. The admission A.7 loop only converges the pre-pickup
// pool (triagedWaiting); a ticket that was picked up and then failed while wearing
// blocked/waiting is never revisited there. This is the converge-shaped retraction
// executor — for Stage 1b `desired` is always null (a started ticket has no valid
// hold); Stage 2 will pass a belief-derived desired and this same seam keeps that
// label while retracting the others.
//
// Mechanism mirrors the sibling needs-human clear (scheduler.mjs:4210-4216): guard on
// the once-marker so a no-marker tick fires ZERO removeLabel calls (steady-state-zero-
// writes), use clearStalledLabel so the marker is deleted only on confirmed removal
// (re-arming labelOnce). Fence-guarded for multi-host zombie safety (CTL-863).
export function convergeStartedHeldLabels(
  orchDir,
  ticket,
  writeStatus,
  {
    desired = null,
    multiHost = false,
    // CTL-863: threaded through for the Stage-1 projection-first fence read.
    gateway = undefined,
    self = undefined,
    emitStateWrite = null,
    onRetract = null,
    fenceGuard: fence = fenceGuard,
  } = {}
) {
  // CTL-764 finding 1: iterate the removable superset so a STARTED ticket still
  // wearing the legacy "waiting" (and its once-marker) has it retracted too.
  for (const label of HELD_LABELS_REMOVABLE) {
    if (label === desired) continue;
    const base = join(orchDir, "workers", ticket, `.linear-label-${label}`);
    if (!existsSync(`${base}.applied`) && !existsSync(`${base}.skipped`)) continue;
    if (!fence({ ticket, orchDir, multiHost, gateway, self })) {
      log.warn(
        { ticket, label },
        "ctl-1068: stale fence — suppressing held-label retraction (zombie guard)"
      );
      continue;
    }
    clearStalledLabel(orchDir, ticket, label, writeStatus, {
      onRemoved: () => {
        if (typeof emitStateWrite === "function") {
          emitStateWrite({
            writerResult: {
              applied: true,
              reason: "held-label-orphaned-in-flight",
              action: "remove-held-label",
            },
            ticket,
            phase: "held-label",
            source: "held-label-orphaned-in-flight",
            orchId: ticket,
          });
        }
        if (typeof onRetract === "function") onRetract(label);
      },
    });
  }
}

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

// CTL-768: hold-stop cooldown — prevents stop/revive thrash on a needs-input
// worker that re-parks immediately after a human-reply revive. Window: 3 ticks
// (90s default) — comfortably longer than one revive→re-park cycle, short
// enough to re-free the slot promptly. Env-overridable. File-backed (NOT an
// in-memory Map) so the guard survives a daemon restart (watch-mode crashes).
const HOLD_STOP_COOLDOWN_MS = Number(process.env.SCHEDULER_HOLD_STOP_COOLDOWN_MS) || 90_000;

// Marker lives under orchDir/.hold-stop-cooldowns/<ticket>-<phase>.json — outside
// workers/<T>/ (same reasoning as .dispatch-cooldowns, CTL-624: never manufacture
// a worker dir for a cooldown).
export function holdStopCooldownPath(orchDir, ticket, phase) {
  return join(orchDir, ".hold-stop-cooldowns", `${ticket}-${phase}.json`);
}

export function inHoldStopCooldown(orchDir, ticket, phase, now) {
  let stoppedAt;
  try {
    stoppedAt = JSON.parse(
      readFileSync(holdStopCooldownPath(orchDir, ticket, phase), "utf8")
    )?.stoppedAt;
  } catch {
    return false; // absent / malformed → not in cooldown
  }
  if (typeof stoppedAt !== "number") return false;
  return now - stoppedAt < HOLD_STOP_COOLDOWN_MS;
}

export function recordHoldStop(orchDir, ticket, phase, now) {
  try {
    mkdirSync(join(orchDir, ".hold-stop-cooldowns"), { recursive: true });
    writeFileSync(
      holdStopCooldownPath(orchDir, ticket, phase),
      JSON.stringify({ ticket, phase, stoppedAt: now })
    );
  } catch (err) {
    log.warn(
      { ticket, phase, err: err.message },
      "scheduler: hold-stop cooldown write failed — continuing"
    );
  }
}

export function clearHoldStopCooldown(orchDir, ticket, phase) {
  try {
    rmSync(holdStopCooldownPath(orchDir, ticket, phase), { force: true });
  } catch {
    /* best-effort */
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
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const reaped = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    let marker;
    try {
      marker = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    const phase = typeof marker?.phase === "string" ? marker.phase : null;
    let ticket = typeof marker?.ticket === "string" ? marker.ticket : null;
    if (!ticket && phase && f.endsWith(`-${phase}.json`)) {
      ticket = f.slice(0, f.length - `-${phase}.json`.length);
    }
    if (!ticket) continue;
    const expiresAt =
      typeof marker?.expiresAt === "number"
        ? marker.expiresAt
        : typeof marker?.failedAt === "number"
          ? marker.failedAt + DISPATCH_COOLDOWN_MS
          : null;
    if (expiresAt === null || now < expiresAt) continue;
    if (eligibleIdentifiers.has(ticket)) continue;
    try {
      rmSync(p, { force: true });
      reaped.push({ ticket, phase });
    } catch {
      /* best-effort */
    }
  }
  return reaped;
}

// CTL-713: consecutive-failure escalation. When a (ticket,phase) has failed N
// times in a row with the same code, apply needs-human via labelOnce and emit
// cooldown-escalated. labelOnce's .applied marker makes this idempotent.
// CTL-764 finding 13: returns whether the sticky needs-human label was actually
// written this call (false below threshold, on belief-owner deferral, or when
// labelOnce no-ops on a persisted marker) so the caller emits the worker.transition
// escalation only on a genuine label write — never a false escalation event.
export function maybeEscalateDispatchFailures(
  orchDir,
  marker,
  { writeStatus, appendEvent, env = process.env } = {}
) {
  if (!marker || marker.consecutiveFailures < DISPATCH_FAILURE_ESCALATION_THRESHOLD) return false;
  const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, marker.ticket, writeStatus, {
    env,
    site: "dispatch-failures",
    log,
  });
  appendEvent({
    ticket: marker.ticket,
    orchId: marker.ticket,
    target_phase: marker.phase,
    code: marker.code,
    consecutiveFailures: marker.consecutiveFailures,
  });
  return wrote;
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
  { writeFile = writeFileSync, readFile = readFileSync, code = null, cause = null } = {}
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
  // CTL-1130: DECISION — dispatch retries exhausted; re-dispatch vs abandon is a
  // priority call the scheduler cannot compute (D7). GATE 1 passes (re-dispatch
  // is possible), no single dominant option → tie-break is human preference.
  let explanation;
  const explanationFields = {
    escalation_type: "decision",
    problem: `${phase} dispatch retries exhausted (${cause ?? code})`,
    call_to_action: `${ticket}/${phase} dispatch has exhausted retries. Re-dispatch or abandon / re-scope?`,
    options: [
      {
        label: `re-dispatch ${ticket}/${phase}`,
        tradeoff: "may re-hit the same failure if root cause is unresolved",
      },
      {
        label: "abandon / re-scope",
        tradeoff: "loses partial progress toward current phase goals",
      },
    ],
    why_you: `after ${cause ?? code ?? "exhausted retries"}, re-dispatch vs abandon is a priority call the scheduler cannot compute`,
  };
  try {
    explanation = buildExplanation(explanationFields);
  } catch {
    // CTL-1130: degrade with the full assembled fields (not just { problem })
    // so the operator keeps the options/why_you decision context on the page.
    explanation = coerceExplanation(explanationFields, { ticket, phase });
  }
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
        dispatchFailureCode: code, // CTL-1045 Bug 2: exit code that exhausted retries (2 = prior_artifact_missing)
        dispatchFailureCause: cause, // CTL-1045 Bug 2: human-readable reason (observability)
        explanation,
        needsHumanSince: existing.needsHumanSince ?? new Date().toISOString(), // CTL-1131: preserve prior stamp
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
  // CTL-1130: every terminal stall carries a typed-union explanation so the inbox
  // shows a meaningful call_to_action. Callers may pass a richer typed explanation
  // via extra.explanation; fall back to a coerced decision generic.
  const explanation =
    extra.explanation ??
    coerceExplanation({ problem: `${phase} phase stalled: ${reason}` }, { ticket, phase });
  try {
    writeFile(
      p,
      JSON.stringify({
        ...cur,
        ...extra,
        status: "stalled",
        stalledReason: reason,
        explanation,
        needsHumanSince: cur.needsHumanSince ?? new Date().toISOString(), // CTL-1131: preserve prior stamp
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
    log.warn(
      { ticket, err: err.message },
      "scheduler: runaway-alert marker write failed — continuing"
    );
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

// CTL-1367 item E3: `requireBgJob` gates the bg_job_id check. The bg launch verb
// records a bg_job_id in the signal (the `claude --bg` job id); the SDK launch verb
// runs the worker IN-PROCESS and intentionally writes NO bg_job_id, so under
// executor=sdk requiring one demoted EVERY launch to verify_failed:bg_job_id_missing.
// dispatchAndVerify passes requireBgJob:false when the dispatch result was async
// (the SDK path — see settleDispatchSync), leaving bg verification (the default,
// requireBgJob:true) byte-identical. For the SDK path `done` is also a runnable
// terminal state (an idempotent duplicate dispatch of an already-completed phase).
export function verifyDispatchedSignal(orchDir, ticket, phase, { requireBgJob = true } = {}) {
  const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  let raw;
  try {
    raw = readFileSync(signalPath, "utf8");
  } catch {
    // CTL-1367 P2-G (SDK path only): a missing signal is NOT a failure when a
    // YOUNG single-flight claim exists — that is a benign claim-lost (a concurrent
    // dispatcher won the O_EXCL claim and is mid-dispatch; the loser writes no
    // signal). Treating it as a no-op success avoids recording
    // verify_failed:signal_missing + cooldown for a valid concurrent dispatch.
    // GATED on requireBgJob === false → bg verify is byte-identical (a bg dispatch
    // always writes its own signal, so this branch is sdk-only).
    if (requireBgJob === false && hasFreshClaim(orchDir, ticket, phase)) {
      return { ok: true };
    }
    return { ok: false, reason: "signal_missing" };
  }
  let signal;
  try {
    signal = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "signal_unparseable" };
  }
  const status = signal?.status;
  const runnable = requireBgJob
    ? status === "dispatched" || status === "running"
    : status === "dispatched" || status === "running" || status === "done";
  if (!runnable) {
    return { ok: false, reason: "status_not_runnable" };
  }
  if (requireBgJob) {
    const bgJob = signal?.bg_job_id;
    if (typeof bgJob !== "string" || bgJob.length === 0) {
      return { ok: false, reason: "bg_job_id_missing" };
    }
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
// CTL-764 Phase 4: added HELD_LABEL_NEEDS_INPUT to the required workspace set.
const REQUIRED_WORKSPACE_LABELS = [
  HELD_LABEL_NEEDS_HUMAN,
  HELD_LABEL_BLOCKED,
  HELD_LABEL_WAITING,
  HELD_LABEL_NEEDS_INPUT,
];

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
    logger.info({ err: err.message }, "scheduler: workspace-label preflight threw — swallowed");
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

// CTL-1329: fence-suppress cooldown. The terminal sweep revisits every started
// worker dir each tick. A stale-fenced dir (claimed generation missing, or no longer
// current on a multi-host cluster) has its needs-human write suppressed every tick,
// but the cheap-first terminal probe (a Linear `issues read`) and fenceGuard (a
// fence-check subprocess) re-run every tick regardless — so the dir burns Linear
// quota ~2x/sec forever (the 2026-06-23 incident: leftover ADV dirs drained the OAuth
// bucket → CTL-679 breaker → frozen dispatch). After a suppression we stamp this
// per-dir cooldown so the probe+write block is skipped for a window. The marker lives
// in the worker dir (reaped with it), mirroring .terminal-done.applied.
const FENCE_SUPPRESS_COOLDOWN_MS = (() => {
  const v = Number(process.env.CATALYST_FENCE_SUPPRESS_COOLDOWN_MS);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60_000;
})();

function fenceSuppressMarkerPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, ".fence-suppressed");
}

// stampFenceSuppress — record that we suppressed a fence-guarded write for this dir.
// Best-effort: a failed write just means we re-probe next tick (no worse than before).
function stampFenceSuppress(orchDir, ticket, nowMs) {
  try {
    writeFileSync(fenceSuppressMarkerPath(orchDir, ticket), JSON.stringify({ ts: nowMs }));
  } catch {
    /* best-effort — re-probe next tick */
  }
}

// isFenceSuppressFresh — true when a suppression was stamped within the cooldown
// window, so the caller should skip this dir's probe+write this tick. A missing or
// unparseable marker, or an expired one, returns false (re-probe), so a fence that
// becomes current again self-heals after at most one cooldown window.
function isFenceSuppressFresh(orchDir, ticket, nowMs) {
  try {
    const { ts } = JSON.parse(readFileSync(fenceSuppressMarkerPath(orchDir, ticket), "utf8"));
    return Number.isFinite(ts) && nowMs - ts < FENCE_SUPPRESS_COOLDOWN_MS;
  } catch {
    return false;
  }
}

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
export function terminalDoneOnce(
  orchDir,
  ticket,
  writeStatus,
  emitStateWrite,
  {
    multiHost = false,
    // CTL-863: threaded through for the Stage-1 projection-first fence read.
    gateway = undefined,
    self = undefined,
    checkOpenPrs,
    emitDoneWithOpenPr = appendRecoveryDoneOpenPrEvent,
    // CTL-1157 SLICE 3: the broad "Done-moves" emitter — fires on EVERY confirmed
    // terminal-sweep Done (not just the open-PR subset). Injectable for tests.
    emitDoneApplied = appendRecoveryDoneAppliedEvent,
    // CTL-1157 A1: injectable clock for the fence-suppress cooldown (deterministic
    // in tests). Defaults to the wall clock in production.
    now = Date.now,
    // CTL-1157 A1: injectable fence decision (deterministic in tests). Production
    // uses the real fenceGuard, which reads the cross-host claim generation.
    fence = fenceGuard,
  } = {}
) {
  const marker = join(orchDir, "workers", ticket, ".terminal-done.applied");
  // CTL-764 finding 7: return whether a REAL Done write landed (+ its from_state) so
  // the caller can emit the terminal worker.transition independently of any label
  // clear. `null` on every no-write path (marker present, fence-suppressed, fenced
  // out, idempotent skip, throw) — the caller only emits on a genuine Done write.
  if (existsSync(marker)) return null;
  // CTL-1329 (extended to the terminal-Done branch, CTL-1157 A1): if a prior tick
  // already fence-suppressed this dir, skip the fence-check subprocess (and the
  // Linear reads it fronts) for the cooldown window instead of re-probing ~2x/sec.
  // A genuinely-current fence self-heals after at most one window. Previously ONLY
  // the stalled/failed branch stamped this cooldown, so a stale terminal fence
  // burned unbounded — the CTL-1423 ~1,090/hr `stale fence` WARN storm.
  if (isFenceSuppressFresh(orchDir, ticket, now())) return null;
  if (!fence({ ticket, orchDir, multiHost, gateway, self })) {
    log.warn(
      { ticket },
      "ctl-863: stale fence — suppressing terminalDoneOnce write (zombie guard)"
    );
    // CTL-1329: arm the per-dir cooldown so subsequent ticks skip the probe+fence
    // for a window (bounds the burn to once-per-cooldown), the same rail the
    // stalled/failed branch uses immediately before its needs-human write.
    stampFenceSuppress(orchDir, ticket, now());
    return null;
  }
  // CTL-1157 (ALARM-NOT-BLOCK — THE REVERSAL): the terminal sweep writes Done
  // DIRECTLY (no agent to reason). The earlier behavior REFUSED the write when an
  // open PR existed, which could wedge the board on a phantom/non-standard PR. The
  // owner reversed that: this pure-code path now PROCEEDS — it never wedges, never
  // mechanically escalates — but it CONSULTS the open-PR enumerator and, when it
  // lands a Done while ≥1 OPEN PR still exists, emits the loud
  // `recovery.done-applied-with-open-pr` alarm so we get the signal that would
  // justify adding a real hard block later (held in reserve). The enumerator is
  // dep-injected: schedulerTick's permissive no-op default keeps bare unit ticks
  // silent; runTick arms the real defaultCheckOpenPrs in production. An unverifiable
  // enumeration (a `gh` failure, or the ticket's repo could not be derived) is no
  // longer FATAL — we still PROCEED (alarm-not-block) — but UNVERIFIABLE ≠ CLEAN: we
  // could not confirm zero open PRs, so we surface it via the loud alarm rather than
  // silently assuming an empty list.
  let openPrs = [];
  let unverifiable = false;
  if (typeof checkOpenPrs === "function") {
    try {
      const facts = checkOpenPrs(ticket, {});
      if (facts && facts.unverifiable) unverifiable = true;
      if (facts && Array.isArray(facts.prs)) openPrs = facts.prs;
    } catch {
      unverifiable = true; // could not confirm clean ⇒ surface (don't assume zero)
    }
  }
  try {
    const res = writeStatus.applyTerminalDone({ ticket });
    // CTL-757: audit the terminal Done write (source=terminal-sweep). Emit even
    // when res is undefined (test stub) is skipped — emitStateWrite no-ops on a
    // falsy writerResult, so a stub-undefined result simply emits nothing.
    if (typeof emitStateWrite === "function") {
      emitStateWrite({
        writerResult: res,
        ticket,
        phase: TERMINAL_PHASE,
        source: "terminal-sweep",
        orchId: ticket,
      });
    }
    // Write the marker only on a confirmed apply — a failed write is retried
    // next tick. Note applyTerminalDone returns applied:true even for the
    // already-Done `action:"skipped"` outcome, so the marker lands on the first
    // confirming tick. A fake that returns undefined (test stubs) is treated as
    // success so the once-semantics stay testable without a real result.
    if (res === undefined || res?.applied) {
      writeFileSync(marker, "");
      // CTL-1157 GROUP B (Done-event accuracy): only emit on a REAL Done write. An
      // idempotent terminal SKIP (Linear already Done) returns {applied:true,
      // action:"skipped"} and performs NO actual write — so emitting done-applied
      // here would corrupt OTEL's before/after Done-move counts, and the open-PR
      // alarm could fire for an already-Done ticket carrying a stale open PR. The
      // marker still lands above (once-semantics). A test-stub `undefined` result is
      // treated as a real write so the emit/alarm stay unit-testable.
      const realDoneWrite = res === undefined || res?.action !== "skipped";
      if (realDoneWrite) {
        // CTL-1157 SLICE 3 (Done-moves panel): the Done write LANDED — emit the broad
        // recovery.done-applied on EVERY terminal-sweep Done so OTEL charts the move
        // and watches the open_prs_at_done>0 red-line. This pure-code path has no agent
        // to reason about PRs, so prs_closed/prs_kept are 0; open_prs_at_done carries
        // the enumerated count (the red-line). Best-effort — never aborts the tick.
        try {
          emitDoneApplied({
            ticket,
            openPrsAtDone: openPrs.length,
            prsClosed: 0,
            prsKept: 0,
            recoveryMode: "enforce", // a real terminal-sweep write is always enforce
            by: "terminal-sweep",
          });
        } catch {
          /* observability must never break the sweep */
        }
        // CTL-1157 (ALARM-NOT-BLOCK): the Done write LANDED. Fire the loud alarm when
        // the ticket still has ≥1 open PR OR the open-PR check was UNVERIFIABLE (a Done
        // that landed without confirming the board was clean is the same silent-Done
        // risk this alarm exists to surface). Best-effort; never throws, never aborts
        // the tick. A clean, CONFIRMED Done (0 open PRs, verifiable) emits nothing.
        if (openPrs.length >= 1 || unverifiable) {
          try {
            emitDoneWithOpenPr({ ticket, openPrs, by: "terminal-sweep", unverifiable });
          } catch {
            /* observability must never break the sweep */
          }
          log.warn(
            { ticket, open_prs_count: openPrs.length, unverifiable },
            "ctl-1157: terminal-sweep wrote Done while an open PR still exists or the check was unverifiable — alarm emitted (recovery.done-applied-with-open-pr)"
          );
        }
        // CTL-764 finding 7: a genuine Done write landed → signal the caller to emit
        // the terminal worker.transition stage event.
        return { realDoneWrite: true, from_state: res?.from_state ?? null };
      }
    }
  } catch (err) {
    log.warn(
      { ticket, err: err.message },
      "scheduler: terminal-Done write-back threw — continuing tick"
    );
  }
  return null;
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
function reconcileTerminalBackstop(
  orchDir,
  ticket,
  signal,
  writeStatus,
  emitStateWrite,
  {
    cache,
    prAdapter,
    fetchState = fetchTicketState,
    multiHost = false,
    gateway = undefined,
    self = undefined,
  } = {}
) {
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
  // CTL-863: zombie guard — a post-takeover paused host must not re-Do a ticket.
  if (!fenceGuard({ ticket, orchDir, multiHost, gateway, self })) {
    log.warn(
      { ticket },
      "ctl-863: stale fence — suppressing reconcileTerminalBackstop write (zombie guard)"
    );
    return;
  }
  // Drift detected: force the forward Done write (the CTL-758 guard permits it).
  try {
    const res = writeStatus.applyTerminalDone({ ticket, cache });
    if (typeof emitStateWrite === "function") {
      emitStateWrite({
        writerResult: res,
        ticket,
        phase: TERMINAL_PHASE,
        source: "reconcile-backstop",
        orchId: ticket,
      });
    }
    log.warn(
      { ticket, driftedState: state },
      "ctl-758: reconcile backstop re-Done'd a merged ticket whose Linear state drifted back to non-terminal"
    );
  } catch (err) {
    log.warn(
      { ticket, err: err.message },
      "scheduler: reconcile-backstop Done write threw — continuing tick"
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

// defaultJanitorKillIntentRecorder — CTL-1004 J2's kill seam, backed by the
// CTL-936 intentDb (beliefs.db) already threaded into the tick. Mirrors
// recovery.mjs's intentAwareKill EXACTLY: it BOTH issues the real stop
// (killBgJob) AND records the pinned 'kill' intent in the same call.
//
// CTL-1004 J2-enforce DEFECT FIX (adversarial-review finding): the original
// recorder ONLY inserted an intent row and assumed the reconciler would execute
// the stop. It does NOT — reconcileIntents (beliefs/intent.mjs) is a
// postcondition VERIFIER (satisfied / retry / ineffective), not an executor; it
// never calls killBgJob. So the ghost session never died, and worse the intent
// aged to 'ineffective' and (under CATALYST_INTENTS_ENFORCE=1) recovery.mjs's
// isIntentEffective guard would then SUPPRESS a later legitimate kill on the
// same subject. The fix threads killBgJob in so the enforce path actually stops
// the ghost — exactly like intentAwareKill does for the revive path.
//
// The intent row is still recorded (pinned to bgJobId, sessionNotRegistered
// postcondition, open-intent de-dupe) so the reconciler can VERIFY the session
// left the agents listing next tick and so the CTL-936 retry-suppression
// bookkeeping stays consistent across both kill sites. When intentDb is null
// (CATALYST_BELIEFS_SHADOW=0) we still issue the kill (fail-open, the same
// direction as intentAwareKill's null-db fallback) and simply skip the record.
function defaultJanitorKillIntentRecorder(intentDb, killBgJob = defaultKillBgJob) {
  return ({ subject, bgJobId }) => {
    if (!subject || !bgJobId) return false;
    // CTL-1045 Bug 1: suppress the stop when the kill intent has plateaued
    // ineffective — mirrors intentAwareKill's isIntentEffective guard (recovery.mjs).
    // NOT additionally gated on CATALYST_INTENTS_ENFORCE: the J2 kill only fires
    // under CATALYST_STALL_JANITOR=enforce, and that mode must be storm-safe on its
    // own. Fail-open when intentDb is null.
    if (intentDb) {
      try {
        if (
          !isIntentEffective(intentDb, "kill", subject, { maxAttempts: getMaxAttempts(intentDb) })
        ) {
          log.warn(
            { subject, bgJobId },
            "stall-janitor: kill intent ineffective — skipping claude stop (CTL-1045 storm prevention)"
          );
          return false;
        }
      } catch (err) {
        log.warn(
          { subject, err: err?.message },
          "stall-janitor: isIntentEffective threw — continuing kill (CTL-1045)"
        );
      }
    }
    // Issue the real stop FIRST so a record-failure can never swallow the kill
    // (intentAwareKill records-then-kills, but its record path is best-effort and
    // never short-circuits the kill either — here the kill is the load-bearing act).
    let recorded = false;
    if (intentDb) {
      try {
        // Skip the INSERT if an open kill-intent already exists (idempotent).
        const open = intentDb
          .query(
            "SELECT 1 FROM intent WHERE kind = 'kill' AND subject = ? AND outcome IS NULL LIMIT 1"
          )
          .get(subject);
        const tickRow = open
          ? null
          : intentDb.query("SELECT tick_id FROM tick ORDER BY tick_id DESC LIMIT 1").get();
        if (!open && tickRow) {
          intentDb.run(
            `INSERT INTO intent (tick_id, kind, subject, belief_id, postcondition, attempts, outcome)
             VALUES (?, 'kill', ?, NULL, ?, 0, NULL)`,
            [
              tickRow.tick_id,
              subject,
              JSON.stringify({ kind: "kill", subject, bgJobId, sessionNotRegistered: true }),
            ]
          );
          recorded = true;
        }
      } catch (err) {
        log.warn(
          { subject, err: err?.message },
          "stall-janitor: recordKillIntent threw — continuing kill (CTL-1004)"
        );
      }
    }
    // Execute the stop — the actual ghost-session reap (mirrors intentAwareKill).
    try {
      killBgJob({ bgJobId });
    } catch (err) {
      log.warn(
        { subject, bgJobId, err: err?.message },
        "stall-janitor: killBgJob threw (CTL-1004)"
      );
      return recorded;
    }
    return true;
  };
}

// defaultClearStall — CTL-1005 J3's unstick seam. Clears a
// `prior-artifact-retry-exhausted` stall MINIMALLY and lets the scheduler's normal
// path re-dispatch: the stalled signal is the ONLY thing making isTicketInFlight
// false + tripping the needs-human terminal sweep, so deleting it (with the
// completed prior-phase signals still present) lets deriveAdvancement re-derive the
// next phase on the next tick. Mirrors clearDispatchCooldown's best-effort,
// never-throw discipline.
//
// The clear, per the CTL-1005 Gherkin:
//   1. delete the synthetic phase-<phase>.json stalled signal (the unstick);
//   2. clear the needs-human label + its .linear-label-needs-human.{applied,skipped}
//      marker (clearStalledLabel) so a future genuine escalation can re-apply;
//   3. delete .orphan-detected.applied (CTL-868) so a future stall re-emits the
//      orphan-detected event instead of being silently suppressed;
//   4. write the .janitor-cleared-<phase>.applied once-marker ON CONFIRMED label
//      removal only (CTL-1045 Bug 4). Scope is the worker-dir lifetime: file-backed,
//      survives daemon restarts, deleted only when the reaper removes the worker dir
//      or an operator re-arms via orch-monitor respond-ticket. Storm-prevention is
//      preserved — the marker is still written at most once; a failed clear is
//      intentionally left re-armable (a future genuine escalation must get through).
export function defaultClearStall(orchDir, writeStatus) {
  return ({ ticket, phase }) => {
    if (!ticket || !phase) return false;
    const workerDir = join(orchDir, "workers", ticket);
    // 1. delete the synthetic stalled signal (the actual unstick).
    try {
      rmSync(join(workerDir, `phase-${phase}.json`), { force: true });
    } catch (err) {
      log.warn(
        { ticket, phase, err: err?.message },
        "stall-janitor: stalled-signal delete failed (CTL-1005)"
      );
    }
    // 2. clear the needs-human label; write the once-marker ONLY on confirmed removal
    //    (CTL-1045 Bug 4 — a failed clear must NOT disarm future escalations).
    try {
      clearStalledLabel(orchDir, ticket, "needs-human", writeStatus, {
        onRemoved: () => {
          try {
            mkdirSync(workerDir, { recursive: true });
            // One clear per ticket per phase per worker-dir lifetime (CTL-1045 Bug 5).
            writeFileSync(join(workerDir, `.janitor-cleared-${phase}.applied`), "");
          } catch (err) {
            log.warn(
              { ticket, phase, err: err?.message },
              "stall-janitor: cleared-marker write failed (CTL-1005)"
            );
          }
        },
      });
    } catch (err) {
      log.warn(
        { ticket, phase, err: err?.message },
        "stall-janitor: needs-human clear failed (CTL-1005)"
      );
    }
    // 3. delete .orphan-detected.applied so a future stall re-emits (CTL-868).
    try {
      rmSync(join(workerDir, ".orphan-detected.applied"), { force: true });
    } catch {
      /* best-effort */
    }
    // 4. CTL-1442: re-arm the escalation ask budget. An operator re-arming a
    //    stalled ticket starts a FRESH cycle — without this, a retried phase
    //    that no-progresses again hits the spent ask-cap (askCount >= cap) and
    //    is suppressed without a fresh ask or re-stall (Codex P2 on #2590).
    try {
      rmSync(join(orchDir, ".escalation-cooldowns", `${ticket}-${phase}.json`), { force: true });
    } catch {
      /* best-effort */
    }
    return true;
  };
}

// CTL-1290: board-health throttle state (host-local, mirrors the unstuck-sweep /
// recovery-pass cadence vars). The single-LLM cadence floor lives in
// BOARD_HEALTH_INTERVAL_MS; this holds the last run ms across ticks.
let _boardHealthLastRunMs = 0;

// CTL-1290: bounded tail of the unified event log → the records board-health's
// deriveRing distills (recent dispatch ts, cache.reconcile summary, account
// rate-limit, reconcile-failing teams). This is the documented FALLBACK for the
// CTL-1257 shared ring (not yet threadable here). Best-effort: any read/parse
// error degrades to [] so the dependent invariants flag observable:false rather
// than throwing the tick.
function readBoardHealthEventTail(maxLines = 800) {
  try {
    const raw = readFileSync(getEventLogPath(), "utf8");
    const lines = raw.split("\n");
    const out = [];
    for (const line of lines.slice(-maxLines)) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a partial/garbled line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// CTL-1330 Tier 1 — per-pass tick timing. The scheduler tick is SYNCHRONOUS, so
// its wall-clock duration IS the Node event-loop block (and a tick that blocks
// longer than the 3s liveness-refresh deadline — claude-agents.mjs — starves the
// `claude agents` refresh → isFresh stays false → new-work admission held at 0
// slots: the 2026-06-24 dispatch wedge). makeTickTimer records monotonic
// performance.now() laps at each pass boundary so ONE structured line per tick
// shows WHERE the time goes. Pure arithmetic — no IO, negligible cost.
//
// Tier-1 timing is ON by default; CATALYST_TICK_TIMING=off disables it (the lap
// calls become `tick?.lap(...)` no-ops and the summary line is skipped).
let _tickSeq = 0;
export function makeTickTimer(now = () => performance.now(), wallNow = Date.now) {
  const t0 = now();
  // CTL-1330 Tier 3: wall-clock base so per-lap perf offsets convert to absolute epoch
  // ms for post-hoc span timestamps (the tick is synchronous — spans are reconstructed
  // AFTER it completes; see emitTickTrace). toEpoch maps a perf.now() reading to epoch ms.
  const startEpochMs = wallNow();
  const toEpoch = (perf) => Math.round(startEpochMs + (perf - t0));
  let last = t0;
  const passes = {};
  const spanLaps = []; // [{name, durationMs, startEpochMs, endEpochMs}] for the span tree
  // CTL-1364 Tier-3 grandchild tier: per-OP sub-laps inside a pass. The op() recorder
  // captures start at call time and returns a done() closure that captures end +
  // pushes one {pass, name, startEpochMs, endEpochMs, durationMs, attrs} entry. Same
  // pure-arithmetic cost shape as lap() — no IO, no span work in the synchronous tick;
  // emitTickTrace reconstructs the scheduler.op spans POST-HOC (threshold-gated, so a
  // healthy tick emits ZERO op spans). Tick may be null when timing is off, so every
  // call site uses tick?.op(...) and optional-chains the returned done.
  const spanOps = [];
  const round1 = (ms) => Math.round(ms * 10) / 10;
  return {
    tickId: ++_tickSeq,
    startEpochMs,
    // lap(label) — record ms elapsed since the previous lap (or tick start).
    lap(label) {
      const t = now();
      passes[label] = round1(t - last);
      spanLaps.push({
        name: label,
        durationMs: round1(t - last),
        startEpochMs: toEpoch(last),
        endEpochMs: toEpoch(t),
      });
      last = t;
    },
    // op(pass, name, attrsAtStart) — open one operation sub-lap inside `pass`.
    // Returns done(attrsAtEnd) which closes it. The op is recorded ONLY when done()
    // is called (a never-closed op is simply absent — no span). startEpochMs is
    // captured here so the op span nests correctly under its parent pass span.
    op(pass, name, attrsAtStart) {
      const opStart = now();
      const startE = toEpoch(opStart);
      let recorded = false;
      return (attrsAtEnd) => {
        if (recorded) return; // idempotent — a double-done never double-records
        recorded = true;
        const opEnd = now();
        spanOps.push({
          pass,
          name,
          startEpochMs: startE,
          endEpochMs: toEpoch(opEnd),
          durationMs: round1(opEnd - opStart),
          attrs: { ...(attrsAtStart || {}), ...(attrsAtEnd || {}) },
        });
      };
    },
    passes,
    spanLaps,
    spanOps,
    endEpochMs() {
      return toEpoch(now());
    },
    totalMs() {
      return round1(now() - t0);
    },
  };
}

// CTL-1330: Tier-1 timing gate. ON unless explicitly disabled — it is just
// better-structured logging shipped to Loki via the existing Alloy pipeline.
export function tickTimingEnabled(env = process.env) {
  return env.CATALYST_TICK_TIMING !== "off";
}

// CTL-1337: derive a DETERMINISTIC PER-TICK trace_id + span_id shared by the Tier-1
// `scheduler: tick timing` log line AND the Tier-3 `scheduler.tick` span, so trace↔logs
// round-trips both ways (Tempo filterByTraceID → the tick's Loki line; Loki line's
// trace_id → the Tempo trace). Computed ONCE per tick, BEFORE logging.
//
//   traceId = sha256(orchestratorId + ":tick:" + tick_id + ":" + node)[:32]   (32 hex)
//   spanId  = sha256(orchestratorId + ":tick:" + tick_id + ":" + node + ":span")[:16] (16 hex)
//
// We deliberately do NOT reuse canonical-event-shared's deriveTraceId: that id is
// sha256(orchestratorId)[:32] — PER-ORCHESTRATOR, so seeding every tick's span with it
// would collapse the daemon's whole lifetime into ONE trace (thousands of scheduler.tick
// spans under one trace_id — a span-hygiene blowout, per-tick flame graph gone). Folding
// `tick_id` (and `node`) into the seed makes each tick its OWN trace while staying
// deterministic, so the same id is reproducible at both the log and the span.
//
// CTL-1362 (OTL-30): `tick_id` RESETS to 1 on every daemon restart, so `tick 171` recurs
// across boots and collapses into ONE Tempo trace (observed: 10 scheduler.tick spans over
// 17.5h under a single trace, all tick_id=171) — exemplars/slow-tick profiling then link to
// a multi-tick pile, not the one slow tick. Folding a per-BOOT nonce in makes the id unique
// per (boot, tick) while staying reproducible at log+span (both get the SAME id, computed
// once per tick and threaded to both).
export function deriveTickTraceContext({ orchestratorId, tickId, node, bootNonce }) {
  const seed = `${orchestratorId ?? ""}:tick:${tickId}:${node ?? ""}:${bootNonce ?? ""}`;
  const traceId = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const spanId = createHash("sha256").update(`${seed}:span`).digest("hex").slice(0, 16);
  return { traceId, spanId };
}

// CTL-1362: a per-BOOT nonce captured ONCE at scheduler module load (= once per daemon
// boot — a fresh process/module load each restart). Stable within a boot so a tick's log
// line and span derive the SAME trace_id; distinct across boots so tick_id reuse can't
// collide. This is the daemon scheduler (NOT a workflow context), so Date.now()/pid are
// fine. Format is opaque — only its per-boot uniqueness + within-boot stability matter.
export const SCHEDULER_BOOT_NONCE = `${Date.now().toString(36)}.${process.pid.toString(36)}`;

// maybeEmitReplicaFreshness — CTL-1366. Emit the catalyst.linear.replica.staleness
// gauge (now − newest mirrored row) as a log.info line (the same log-line-only
// signaltometrics convention as cache.stats / reap stats). Metric-threshold
// alerting on this gauge is owned by Grafana, not in-code.
//
// FULLY FAIL-OPEN + NO-OP-when-off — this only EVER ADDS an emit:
//   - replica reader absent (default install / flag off) → silent no-op.
//   - freshness() undefined (no db / no rows / any throw) → silent no-op.
//   - any throw from the emit is swallowed — it must NEVER escape the
//     scheduler tick.
//
// `now`/`env`/`log` are injectable so the gauge is unit-testable without
// driving a whole tick.
export function maybeEmitReplicaFreshness({
  replica,
  now = Date.now,
  env = process.env,
  log: logger = log,
} = {}) {
  void env;
  // NO-OP when the replica tier is off (default for most installs).
  if (!replica || typeof replica.freshness !== "function") return;
  let fresh;
  try {
    fresh = replica.freshness();
  } catch {
    return; // fail-open: a freshness throw must never escape the tick
  }
  if (!fresh || typeof fresh.maxUpdatedAtMs !== "number") return; // fail-open MISS
  const stalenessSeconds = (now() - fresh.maxUpdatedAtMs) / 1000;
  try {
    logger.info(
      {
        "catalyst.linear.replica.staleness": stalenessSeconds,
        "catalyst.linear.replica.rows": fresh.rowCount,
      },
      "scheduler: replica freshness (CTL-1366)"
    );
  } catch {
    /* gauge emit must never wedge the tick */
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
    // CTL-1331: slot-reservation seams for the async board-health delegate queue.
    // countQueuedDelegates reserves a slot per queued/claimed intent (so the tick
    // can't admit real work into a slot a queued delegate will claim);
    // gcDelegateIntents releases terminal/stale reservations. Injectable so a unit
    // tick injects a deterministic count; the default reads the real
    // .delegate-queue. Empty queue → 0 → zero behavior change (Phase A inert).
    countQueuedDelegates = defaultCountQueuedDelegates,
    gcDelegateIntents = defaultGcDelegateIntents,
    // CTL-1367 P1: the executor=sdk occupancy reader — the in-process SDK-worker
    // analogue of liveBackgroundCount. An SDK phase worker has NO `claude --bg`
    // job, so liveBackgroundCount can't see it; without counting it the slot gate
    // sees zero occupied slots after an SDK launch and over-dispatches past
    // maxParallel. Counts dispatched/running nested phase signals with no bg_job_id
    // (the SDK worker shape). ONLY added to occupancy when dispatchMode === "sdk"
    // (see below), so it is provably inert under bg/oneshot-legacy. Injectable so a
    // unit tick injects a deterministic count.
    countSdkInflight = defaultCountSdkInflight,
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
    // CTL-1336: the warm `claude agents` snapshot for the Pass 0a phantom-sweep
    // bg-liveness gate ({ agents, isFresh }). Default reads getAgentsCached (a
    // never-blocking in-memory read); tests inject a deterministic snapshot so a
    // unit tick never shells out to `claude`. Only consulted when a worker has a
    // bg id (see Pass 0a), so a bare/unarmed tick never fetches it.
    getAgents = () => getAgentsCached(),
    // CTL-611: injectable verifier + audit-event emitter so tests can pin the
    // demotion path independently of fixture choice (fakeDispatch / recorder).
    verifyDispatched = verifyDispatchedSignal,
    appendDispatchFailedEvent = defaultAppendDispatchFailedEvent,
    // CTL-660: success-path lifecycle emitters. requested fires when the
    // scheduler DECIDES to dispatch; launched fires only after verifyDispatched
    // confirms a live worker. Both best-effort — no branch gates on the return.
    appendDispatchRequestedEvent = defaultAppendDispatchRequestedEvent,
    appendDispatchLaunchedEvent = defaultAppendDispatchLaunchedEvent,
    // CTL-1367 P1: failed-terminal backstop for a REJECTED async (sdk) dispatch
    // promise. undefined → backstopOnRejection applies the real defaultEmitBackstop;
    // tests inject a spy. A SYNC (bg) dispatch never reaches the detached settle
    // handler, so this is a pure no-op on the bg path.
    emitBackstop,
    // CTL-702: injectable yield-file-skip emitter. Deduped by observedYieldFiles
    // (module-level set) so only the first observation per daemon lifetime fires.
    appendYieldFileSkipEvent = defaultAppendYieldFileSkipEvent,
    // CTL-705: preemption seams — injectable for tests, default to real helpers.
    killBgJob = defaultKillBgJob,
    appendPreemptedEvent = defaultAppendPreemptedEvent,
    appendResumedAfterPreemptionEvent = defaultAppendResumedAfterPreemptionEvent,
    // CTL-768 held-worker stop seams.
    // livenessForHeld — idle/busy/absent on a needs-input bg process; the
    //   mid-turn guard. Default injects the warm getAgentsCached snapshot so the
    //   hot path never spawns `claude agents` per signal. Tests inject a stub.
    livenessForHeld = (bgJobId) =>
      defaultLivenessForBgJob(bgJobId, { agents: getAgentsCached().agents }),
    appendHeldStoppedEvent = defaultAppendHeldStoppedEvent,
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
    // CTL-764 Phase 5: unified worker.transition event emitter. Injectable for tests
    // (pass a spy to capture emitted transitions). Default no-op so bare unit ticks
    // that do not inject this seam are unaffected. Production wires the real
    // defaultAppendWorkerTransitionEvent via runTick.
    appendWorkerTransitionEvent = null,
    // CTL-642/758: PR-merged adapter for the recovery terminal short-circuit's
    // optional second check (merged-but-not-yet-Done zombie) AND the reconcile
    // backstop's gate-2 merged check. Default undefined here keeps every legacy
    // unit tick that doesn't thread it on the cheap Linear-terminal read ONLY;
    // PRODUCTION wires the real makePrView-backed adapter via startScheduler →
    // runningOpts.prAdapter → runTick, so both paths fire live. Injectable so
    // tests can exercise the pr-merged branch without shelling out to `gh`.
    prAdapter = undefined,
    // CTL-1157 (ALARM-NOT-BLOCK): the open-PR ENUMERATOR the terminal sweep's DIRECT
    // Done write (terminalDoneOnce) consults — it no longer refuses the write, it
    // only decides whether to fire the recovery.done-applied-with-open-pr alarm. The
    // DEFAULT here is a deliberately PERMISSIVE no-op (zero open PRs) so a bare unit
    // tick never shells out to `gh`/`catalyst-linear` and stays silent. PRODUCTION
    // wires the real defaultCheckOpenPrs via startScheduler → runningOpts.checkOpenPrs
    // → runTick. Injectable so the alarm branch is testable without shelling out.
    checkOpenPrs = () => ({ ok: true, prs: [] }),
    // CTL-1157: the alarm emitter for the terminal sweep (default = real append to
    // the unified event log). Injectable so tests record the alarm without writing.
    emitDoneWithOpenPr = appendRecoveryDoneOpenPrEvent,
    // CTL-1157 SLICE 3: the broad Done-moves emitter for the terminal sweep (fires on
    // EVERY confirmed Done, not just the open-PR subset). Injectable for tests.
    emitDoneApplied = appendRecoveryDoneAppliedEvent,
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
    // CTL-1410 Phase B: in-process SDK-worker probe for the sweep. The REAL
    // registry read is the safe default here — it is a local Map lookup in this
    // same process (never shells out), and an empty registry (bare unit tick)
    // protects nothing, which is exactly the pre-Phase-B behavior.
    isSdkWorkerLive = registrySdkWorkerLive,
    // CTL-823: the daemon's durable-descriptor-store reader; threaded into the
    // fetchState injections below. undefined in bare unit ticks (fail-open —
    // fetchTicketState without gateway behaves exactly as before).
    gateway = undefined,
    // CTL-1340: the daemon's read-replica tier reader (flag-gated, default off →
    // undefined). Threaded into the SAME fetchState injections below so a HIT in
    // the local Catalyst-Cloud replica resolves terminal-ness sub-ms; a MISS
    // falls through to gateway+live (fall-through-on-MISS). undefined → every
    // fetchTicketState skips the replica block and behaves exactly as before.
    replica = undefined,
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
    // CTL-1481: best-effort worker:<host> label stamp, fired right after a won
    // multi-host claim (same gate as emitFenceClaimed). Injectable so tests
    // drive/assert the stamp without touching Linear; production defaults to
    // the real linear-query/linear-write-backed implementation.
    stampWorkerLabel = defaultStampWorkerLabel,
    // CTL-1191: injectable surviving-roster computation for the recovery-pass HRW
    // gate (ownsForRecovery). Default undefined → computeSurvivingRoster(roster),
    // which reads heartbeats from the (test-redirected) event log. Tests inject a
    // fixed survivor set to drive the dead-owner-failover path deterministically
    // without writing heartbeat events. Single-host is still a no-op regardless.
    recoverySurvivingRoster = undefined,
    // CTL-1091: injectable surviving-roster computation for the NEW-WORK dispatch
    // HRW gate (the `ready` filter below), mirroring recoverySurvivingRoster.
    // Default undefined → computeSurvivingRoster(roster) (reads the test-redirected
    // event log). Tests inject a fixed survivor set to drive the offline-owner
    // failover deterministically without writing heartbeat events. Single-host is
    // still a no-op regardless (multiHost gate short-circuits before it is read).
    dispatchSurvivingRoster = undefined,
    // CTL-729: progress-watchdog seams. Defaults keep every existing bare unit
    // tick inert (null silence probe → predicate no-ops via "no-transcript").
    watchdog: {
      mode: _watchdogMode = undefined, // resolved inside the pass
      transcriptAgeMs: _transcriptAgeMs = defaultTranscriptAgeMs,
      progressMark: _progressMark = defaultProgressMark,
      killEscalate: _killEscalate = defaultKillEscalate,
      now: _watchdogNow = Date.now,
      emit: _watchdogEmit = emitReapIntent,
    } = {},
    // CTL-1137: cost-cap watcher seams (Pass 0c). Defaults wire the real Prom fetch +
    // terminal-write + reap; tests inject mocks + an override mode to drive the truth
    // table. Mode resolves from readCostCapConfig() (env > Layer-2 > shadow) unless
    // overridden here.
    costCap: {
      mode: _costCapMode = undefined, // resolved inside the pass
      fetchCost: _costCapFetch = fetchSessionCostUsd,
      now: _costCapNow = Date.now,
      markFailed: _costCapMarkFailed = markPhaseSignalFailed,
      reap: _costCapReap = emitReapIntent,
    } = {},
    // CTL-1004: stall-janitor seams (Pass 0j). Defaults keep the bare unit tick
    // inert — no census producers means nothing to collapse — so a direct
    // schedulerTick caller that does not opt in gets a no-op pass. Production wires
    // the real census (terminal-Done worktrees + idle ghost sessions) + the
    // emit / intent seams via startScheduler. Mode resolves from
    // readStallJanitorConfig() (env > Layer-2 > shadow) unless overridden here.
    stallJanitor: {
      mode: _janitorMode = undefined, // resolved inside the pass
      terminalIdleMs: _janitorTerminalIdleMs = undefined,
      collectOrphanCandidates: _collectOrphanCandidates = undefined,
      collectGhostCandidates: _collectGhostCandidates = undefined,
      // CTL-1005 J3: stall-clear census + unstick seams. Defaults undefined →
      // the pass collects no J3 candidates (a bare unit tick stays inert);
      // production wires defaultCollectStallClearCandidates + defaultClearStall
      // below. Tests inject stubs to drive J3 in isolation.
      collectStallClearCandidates: _collectStallClearCandidates = undefined,
      clearStall: _clearStall = undefined,
      // CTL-1242 J4: terminal/merged signal dir GC seams. Defaults undefined →
      // inert (bare unit tick has no census → skip cleanly); production wires
      // defaultCollectTerminalSignalGcCandidates + defaultGcTerminalSignals below.
      collectTerminalSignalGcCandidates: _collectTerminalSignalGcCandidates = undefined,
      gcTerminalSignals: _gcTerminalSignals = undefined,
      emit: _janitorEmit = emitReapIntent,
      recordKillIntent: _recordKillIntent = undefined,
      // CTL-1324: census-throttle seams. The J1/J3/J4 worktree censuses each fire
      // synchronous per-repo `git worktree list` + per-worktree `git status` probes;
      // on a many-worktree host that ~50–70s/tick blocks the event loop, ages the
      // node.heartbeat past the CTL-731 degraded threshold, and HOLDS new-work
      // dispatch. Throttle ONLY those three (default 15 min) — J2 ghost-session kill
      // is cheap (warm agents snapshot only) and stays every-tick. `censusIntervalMs`
      // / `nowMs` are injectable so the regression test drives a deterministic clock.
      censusIntervalMs: _janitorCensusIntervalMs = undefined,
      nowMs: _janitorNowMs = undefined,
    } = {},
    // CTL-1064: unstuck-sweep seams (Pass 0u). Mode resolves from
    // readUnstuckSweepConfig() (env > Layer-2 > 'off') unless overridden.
    // Defaults keep a bare tick fully inert — no census means nothing runs.
    // Production wires the real census + act seams via startScheduler.
    unstuckSweep: {
      mode: _unstuckMode = undefined,
      intervalMs: _unstuckIntervalMs = undefined,
      collectCandidates: _collectUnstuckCandidates = undefined,
      actByCategory: _unstuckActByCategory = undefined,
      escalate: _unstuckEscalate = undefined,
      // CTL-1064: the unstuck sweep's emit seam MUST be emitUnstuckEvent, NOT
      // emitReapIntent — the latter's closed vocabulary excludes unstuck.* and
      // throws, and the fire-and-forget path swallowed the rejection, silently
      // dropping every unstuck event. emitUnstuckEvent validates against the
      // sweep's own vocabulary and appends to the same unified log.
      emit: _unstuckEmit = emitUnstuckEvent,
      postComment: _unstuckPostComment = undefined,
      nowMs: _unstuckNowMs = undefined,
    } = {},
    // CTL-1176: Pass 0r — recovery-reasoning pass seams. Default undefined keeps
    // a bare tick fully inert. Production passes mode from env > Layer-2.
    recoveryPass: { mode: _recoveryPassMode = undefined } = {},
    // CTL-1290: board-health delegate seam. Threaded by the daemon (runTick) with
    // the real-IO seams (board snapshot / event-ring / reconcile markers) — mirrors
    // the stallJanitor census wiring. Undefined on a bare schedulerTick (unit
    // tests) → the pass is INERT (does no real IO, never emits). Mode resolves
    // inside the hook via readBoardHealthConfig (env > Layer-2 > "shadow") unless
    // the caller pins `boardHealth.mode`. `boardHealthPassFn` is the §9.4 test seam.
    boardHealth: _boardHealth = undefined,
    boardHealthPassFn = boardHealthPass,
    // CTL-1095: drain gate — node-level refusal of new-work admission. Default
    // reads the drain flag file from orchDir; tests inject a stub.
    isDraining = () => isDrainingDefault(orchDir),
    // CTL-1095: drained-sentinel emitter — fires once when draining && empty.
    emitDrained = () => defaultEmitDrainedEvent(),
    // CTL-936: closed-loop intent layer. When an open beliefs.db handle is
    // provided, kill actions in reclaimDeadWork are recorded as intents and
    // suppressed once ineffective. Default null → legacy behavior (all existing
    // tests unaffected). Production wires the module-level beliefs db handle
    // via startScheduler → runTick when CATALYST_BELIEFS_SHADOW=1.
    intentDb = null,
    // CTL-1150: injectable triage-artifact predicate for Pass 2. Default undefined
    // → the inline existsSync default applies inside the loop. Tests inject
    // `() => true` to opt out of the filesystem check when the subject is not
    // the triage gate itself.
    hasTriageArtifact = undefined,
    // CTL-1150: injectable listStartedTickets override. Default undefined → the
    // real listStartedTickets(orchDir) runs. Tests that seed triage.json (which
    // creates workers/<ticket>/) inject `() => new Set()` so the seeded ticket
    // is not excluded from Pass 2 by dir-existence before the guard fires.
    listStartedTickets: listStartedTicketsOpt = undefined,
    // CTL-1241: env binding for the three labelNeedsHumanUnlessBeliefOwner
    // escalation sites (dependency-cycle 3825, ctl-925-cycle 4530, terminal-sweep
    // 4913). Mirrors maybeEscalateDispatchFailures' `env = process.env` so the
    // belief-owner guard is injectable for tests; without it schedulerTick threw
    // `ReferenceError: env is not defined` and aborted the whole tick on any
    // escalation branch.
    env = process.env,
    // CTL-1365a: catalyst.dispatch.mode telemetry vocab ({phase-agents |
    // oneshot-legacy | sdk}) stamped on the CTL-1330 Tier-1 tick-timing line so
    // OTEL's ParseJSON(body)→signaltometrics leg labels the scheduler histograms
    // by dispatch mode. Default "phase-agents" = today's bg substrate; every
    // direct-call test keeps the stable label with no wiring.
    dispatchMode = "phase-agents",
    // CTL-1457 (N1): true when executorByPhase routes ANY phase to an in-process
    // executor (sdk|codex-exec) even though the NODE boot dispatchMode is bg —
    // the primary per-phase codex/sdk rollout. ORed into the occupancy gates below
    // (isInProcessDispatchMode(dispatchMode) || hasInProcessRoute) so a routed no-bg
    // worker on a bg node is counted (else it over-admits past maxParallel). Default
    // false → the bg node with no in-process route is byte-identical (countSdkInflight
    // is never called; and even when armed it is 0 on a node nothing routes in-process).
    hasInProcessRoute = false,
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
  // CTL-1057: loud one-time warning when this host is absent from a multi-host roster.
  const _smw = hostMembershipWarning(roster, self);
  if (_smw && !globalThis.__ctl1057_scheduler_warned) {
    globalThis.__ctl1057_scheduler_warned = true;
    log.warn({ roster, self }, _smw);
  }

  // CTL-1191: ownsForRecovery — the HRW ownership predicate for the three
  // recovery passes (Pass 0u unstuck-sweep, Pass 0r reasoning, diagnostician).
  // These passes classify-then-ACT (escalate / FIX / re-dispatch / comment) over
  // the stalled/failed/needs-human backlog. Before CTL-1191 they had NO ownership
  // gate, so on a 2-node cluster BOTH nodes acted on EVERY stalled ticket
  // (duplicate escalations, double Linear comments, racing re-dispatch).
  //
  // STRICT no-op at N=1: when !multiHost this is an identity (returns true for
  // every ticket) — the lone host keeps acting on all of its work exactly as
  // before. The surviving-roster read below NEVER runs single-host.
  //
  // DEAD-OWNER FAILOVER: at N>1 the HRW hash is computed over the SURVIVING
  // roster (roster minus dead hosts), NOT the raw roster. So when the ticket's
  // original owner has died, ownership re-homes to a LIVE survivor and that node
  // picks up the dead owner's stuck work instead of it stranding. Mirrors
  // reclaimDeadHostWork's `ownerForTicket(ticket, survivors)` gate exactly
  // (recovery.mjs:2983-2989) so the dispatch-side and recovery-side agree on who
  // owns a dead node's tickets.
  //
  // Computed lazily + memoized once per tick via the shared computeSurvivingRoster
  // helper: the heartbeat read only fires the first time a recovery pass actually
  // has candidates, and only when multiHost.
  let _survivorRoster = null;
  const _survivors = () => {
    if (_survivorRoster) return _survivorRoster;
    _survivorRoster = Array.isArray(recoverySurvivingRoster)
      ? recoverySurvivingRoster
      : computeSurvivingRoster(roster);
    return _survivorRoster;
  };
  const ownsForRecovery = (ticket) => !multiHost || ownedBy(ticket, _survivors(), self);

  // CTL-1091: the DISPATCH-time ownership roster = the live (positive-liveness +
  // restore-deflap) roster, so new eligible tickets whose HRW owner is OFFLINE
  // fail over to a live host instead of stranding in Todo. Memoized once per tick.
  // It performs its OWN positive-liveness heartbeat read (via resolveDispatchRoster)
  // — independent of recovery's fail-open computeSurvivingRoster read (_survivors),
  // by design: dispatch needs positive liveness, recovery needs fail-open. Both hit
  // the same cached feed. Injectable via dispatchSurvivingRoster for tests; a total
  // outage degrades to the full roster (never double-acts).
  let _dispatchRosterMemo = null;
  const _dispatchRoster = () => {
    if (_dispatchRosterMemo) return _dispatchRosterMemo;
    // Test override bypasses both the heartbeat read AND the deflap (tests
    // exercise the deflap directly via the pure computeDispatchRoster).
    if (Array.isArray(dispatchSurvivingRoster)) {
      _dispatchRosterMemo = dispatchSurvivingRoster;
      return _dispatchRosterMemo;
    }
    // Single-host is a strict no-op with NO heartbeat read (cheap guard first);
    // _dispatchRoster is only reached multiHost anyway (the ready filter short-
    // circuits single-host), but this keeps it safe if ever called otherwise.
    // Scheduler is the SOLE writer of .liveness-deflap.json (persist:true); monitor
    // reads it read-only. Shared with the triage gate via resolveDispatchRoster so
    // both dispatch sites can never drift out of sync.
    _dispatchRosterMemo = multiHost
      ? resolveDispatchRoster({ roster, orchDir, self, nowMs: now(), persist: true })
      : roster;
    return _dispatchRosterMemo;
  };
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
        // CTL-1023: post-triage state writes always have a classification.
        ticketType: resolveTicketType(orchDir, ticket),
      },
      { ticket, phase, source }
    );
  }

  // CTL-764 Phase 5: recordTransition — the per-tick sync chokepoint for worker
  // state transitions. Emits one worker.transition event per genuine change.
  // Disposition changes are guarded by lastDispositionEmit (only-on-change);
  // stage-only transitions always emit. Fail-open: never aborts the tick.
  // appendWorkerTransitionEvent is the injectable seam; null → silent no-op.
  function recordTransition({
    ticket,
    toStage = null,
    fromStage = null,
    fromDisposition = null,
    toDisposition, // undefined = stage-only (no guard needed; always emit)
    reason = null,
    attempt = null,
    reviveCount = null,
    source = null,
  }) {
    if (!appendWorkerTransitionEvent) return;
    // Disposition-only-on-change guard.
    if (toDisposition !== undefined) {
      const seen = lastDispositionEmit.has(ticket);
      const last = lastDispositionEmit.get(ticket);
      const normalizedTo = toDisposition ?? null;
      // CTL-764 finding 10: a daemon restart clears lastDispositionEmit, so the FIRST
      // confirmed clear after restart (toDisposition=null) would normalize last→null,
      // satisfy the only-on-change guard, and drop a GENUINE needs-*→cleared event.
      // Let it through when the ticket is first-seen this lifetime AND fromDisposition
      // proves the prior non-null state (the clear-path callers pass it).
      const firstSeenClear = !seen && normalizedTo === null && fromDisposition != null;
      // Only-on-change guard. Normalize a first-seen (undefined) last to null so
      // an initial null→null healthy tick emits nothing — one canonical event per
      // GENUINE change (verify CTL764-VER-6[low]: undefined===null was false, so a
      // first-seen never-held ticket fired one spurious null→null no-op).
      if ((last ?? null) === normalizedTo && !firstSeenClear) return;
      // CTL-764 Phase 5: needs-human is STICKY — cleared only by clearStalledLabel's
      // onRemoved (confirmed Linear label removal; sources terminal-done-clear /
      // no-stall-clear), NEVER by a steady-state admission clear-on-pickup or a
      // held-label convergence for a cycle member (which is STILL needs-human —
      // only its held label was cleared). Suppress the spurious needs-human→null
      // emit both paths would otherwise fire (the needs-human label is untouched),
      // and DO NOT advance lastDispositionEmit so the sticky state persists until
      // the genuine clear runs. Without cycle-member-clear here, a dep-cycle member
      // storms A.5(needs-human)→A.7(null) every tick (verify CTL764-VER-2[med]).
      if (
        normalizedTo === null &&
        last === "needs-human" &&
        (source === "scheduler-admission" || source === "cycle-member-clear")
      ) {
        return;
      }
      lastDispositionEmit.set(ticket, normalizedTo);
    }
    try {
      appendWorkerTransitionEvent({
        ticket,
        orchId: ticket,
        toStage,
        fromStage,
        fromDisposition: fromDisposition ?? null,
        toDisposition: toDisposition ?? null,
        reason,
        attempt,
        reviveCount,
        source,
        taskType: resolveTicketType(orchDir, ticket),
      });
    } catch (_err) {
      // fail-open
    }
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
      clusterGeneration, // CTL-864: optional cross-host fence token; dispatchTicket only adds the key when != null
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
      { orchId: ticket, orchDir, ticket, target_phase: phase, reason: requestedReason },
      { ticket, phase }
    );
    // Pass 1.5: reset the parked signal to "stalled" before dispatch; a false
    // return (reset write failed) aborts so the caller can `continue`.
    if (preDispatch && preDispatch() === false) return { aborted: true };

    // CTL-864: forward the cross-host fence token. dispatchTicket drops the key
    // when clusterGeneration == null (single-host / no persisted claim → no-op).
    // CTL-1367 P1: settle an async (executor=sdk) dispatch synchronously. The bg
    // path returns a plain object (settleDispatchSync passes it through unchanged →
    // byte-identical). The sdk path returns a Promise whose synchronous prelaunch has
    // ALREADY written the dispatched signal; settleDispatchSync attaches a detached
    // completion handler (the query runs detached; its terminal event wakes the
    // orchestrator) and returns a sync { code, async:true }. `dispatchWasAsync` then
    // selects the SDK-aware verifier (E3 — no bg_job_id required).
    const rawDispatch = dispatchTicket(orchDir, ticket, phase, {
      dispatch,
      resumeSession,
      clusterGeneration,
    });
    const dispatchWasAsync = isThenable(rawDispatch);
    // CTL-1367 P1: on a REJECTED async (sdk) dispatch the detached handler logs the
    // rejection AND emits the failed-terminal backstop (stalled signal +
    // phase.<phase>.failed) so the ticket can't strand at "dispatched" with no
    // bg_job_id/liveness probe. settleDispatchSync (verifySync omitted here on
    // purpose — see below) returns a provisional sync result; the REAL launch gate is
    // the verifyDispatched(requireBgJob:false) call below, which demotes a stale/
    // un-runnable prelaunch signal to a dispatch failure.
    const r = settleDispatchSync(rawDispatch, {
      onSettled: backstopOnRejection({ orchDir, ticket, phase, log }, { emitBackstop }),
    });
    if (r.code === 0) {
      // CTL-611: verify the dispatch actually produced a live worker before
      // declaring success. A --dry-run leak / mark_launch_failed half-write
      // returns rc=0 with no usable signal; !ok demotes to failure. CTL-1367 E3:
      // the SDK prelaunch signal has no bg_job_id, so the async path must not
      // require one.
      const v = verifyDispatched(orchDir, ticket, phase, { requireBgJob: !dispatchWasAsync });
      if (v.ok) {
        clearDispatchCooldown(orchDir, ticket, phase); // CTL-624: success clears any prior cool-down
        // CTL-660: record the VERIFIED launch. Re-read the signal for the
        // bg_job_id + worktreePath the launched worker wrote.
        const signal = readPhaseSignalRaw(orchDir, ticket, phase);
        safeEmit(
          appendDispatchLaunchedEvent,
          {
            orchId: ticket,
            orchDir,
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
        if (cd.consecutiveFailures >= getMaxDispatchRetries())
          escalateDispatchExhausted(orchDir, ticket, phase, { code: 0, cause: reason }); // CTL-712 terminal stop; CTL-1045 Bug 2
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
        if (
          maybeEscalateDispatchFailures(orchDir, cd, {
            writeStatus,
            appendEvent: appendCooldownEscalatedEvent,
          })
        ) {
          // CTL-764 finding 13: a ticket escalated to needs-human solely by
          // consecutive dispatch failures gets a worker.transition too — gated on the
          // actual sticky-label write (per finding 8) so a re-escalation is silent.
          recordTransition({ ticket, toDisposition: "needs-human", source: "dispatch-failures" });
        }
        log.warn(
          { ticket, phase, verifyReason: v.reason },
          "scheduler: dispatched signal verification failed"
        );
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
    // CTL-1004/CTL-1056 Bug 2: pull the captured stderr tail + spawn error/signal
    // off the dispatch result so the failure is diagnosable from BOTH the warn log
    // and the phase.dispatch.failed event (the old log was a bare {ticket,code}).
    const diag = dispatchFailureDiag(r);
    const cd = recordDispatchFailure(orchDir, ticket, phase, r.code, now()); // CTL-624: arm the cool-down window
    if (fullFailureLadder) {
      if (cd.consecutiveFailures >= getMaxDispatchRetries())
        escalateDispatchExhausted(orchDir, ticket, phase, { code: r.code, cause: reason }); // CTL-712 terminal stop; CTL-1045 Bug 2
      maybeTripCircuitBreaker(orchDir, ticket, phase); // CTL-671: trip same tick if at threshold
      // CTL-611 Gap 2: surface the silent drop as an event. CTL-1056: + diag.
      appendDispatchFailedEvent({
        orchId: ticket,
        ticket,
        target_phase: phase,
        code: r.code,
        reason,
        expiresAt: cd.expiresAt,
        consecutiveFailures: cd.consecutiveFailures,
        ...diag,
      });
      if (
        maybeEscalateDispatchFailures(orchDir, cd, {
          writeStatus,
          appendEvent: appendCooldownEscalatedEvent,
        })
      ) {
        // CTL-764 finding 13: emit the escalation transition on a genuine sticky-label
        // write (per finding 8) — a re-escalation on a persisted marker stays silent.
        recordTransition({ ticket, toDisposition: "needs-human", source: "dispatch-failures" });
      }
      if (failLogMsg) {
        log.warn(
          {
            ...(failLogIncludePhase ? { ticket, phase, code: r.code } : { ticket, code: r.code }),
            ...diag, // CTL-1056: stderr_tail / spawn_error / signal — diagnosable from the log
          },
          failLogMsg
        );
      }
    } else {
      appendDispatchFailedEvent({
        orchId: ticket,
        ticket,
        target_phase: phase,
        code: r.code,
        reason,
        ...diag,
      });
    }
    return { ok: false, code: r.code, reason, signal: r.signal ?? null };
  }

  // CTL-1330 Tier 1: start the per-pass timer at the top of the executable body
  // (everything above is param-default + closure definitions — negligible). Null
  // when timing is disabled, so every `tick?.lap(...)` below is a cheap no-op.
  const tick = tickTimingEnabled() ? makeTickTimer() : null;

  // CTL-671: compute the eligible set ONCE per tick. Consumed by the phantom
  // validity sweep (Pass 0a, below) and the new-work pull (Pass 2). readEligible
  // is the test injection seam; production reads all per-project eligible
  // projections (written exclusively from a live `linearis issues list`).
  const eligible = readEligible ? readEligible() : readAllEligibleTickets();
  const eligibleIds = new Set(eligible.map((t) => t.identifier));

  tick?.lap("eligible-read");

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
    // (c) live worker → skip the Linear probe + quarantine. CTL-1336: read the warm
    // getAgentsCached() snapshot (zero-spawn) instead of a timeout-less
    // execFileSync("claude agents") — a hung agents RPC would otherwise wedge the
    // synchronous tick unboundedly (the audit's finding #4). Two review-driven guards:
    //   • only consult the snapshot when there IS a bg id, so a bare/unarmed tick stays a
    //     true no-op (no snapshot fetch, no async `claude agents` warmer kick); and
    //   • only TRUST a fresh snapshot — a cold/stale cache (daemon boot) reports a live
    //     worker as DEAD, and quarantine is destructive, so fail OPEN (skip) when the
    //     snapshot isn't fresh rather than mis-quarantine a real in-flight worker.
    // Only fetch the snapshot when there IS a bg id → a bare/unarmed tick stays a true no-op
    // (no snapshot fetch, no async `claude agents` warmer kick). The skip decision (incl. the
    // cold-cache fail-open) lives in the pure, unit-tested bgLivenessProtects helper.
    if (bgId && bgLivenessProtects(bgId, getAgents(), isBgJobAlive)) continue;
    // (c-sdk) CTL-1410 Phase B: an in-process SDK worker has NO bg id, so the bg
    // gate above is blind to it — consult the in-process registry before probing
    // Linear. A live registry entry is a fact (same process as the dispatch), so
    // this can never mis-protect a phantom: phantoms are never registered.
    if (isSdkWorkerLive(sig.ticket)) continue;
    if (classifyResolution(sig.ticket, { exec }) !== "not-found") continue; // (b) definitive only
    if (maybeQuarantinePhantom(orchDir, sig.ticket, sig.phase)) {
      quarantinedPhantoms.push({ ticket: sig.ticket, phase: sig.phase });
      log.warn(
        { ticket: sig.ticket, phase: sig.phase },
        "scheduler: quarantined phantom worker dir (not-found + not-eligible + dead bg) — CTL-671"
      );
    }
  }

  tick?.lap("phantom-sweep");

  // (0w) CTL-729 progress-watchdog. Force-kill a worker that is running/dispatched
  // with a silent transcript and zero commits past its phase budget. Runs AFTER the
  // phantom sweep and BEFORE the reclaim sweep so a kill flips the signal terminal
  // first (the sync terminal write is the load-bearing state change — it frees the
  // slot via isTicketInFlight and prevents re-fire next tick when status:"failed").
  // Detection + IO ordering live here; side effects delegate to killEscalate.
  const watchdogKilled = [];
  const watchdogWouldKill = [];
  {
    const wcfg = readWatchdogConfig();
    const wdMode = _watchdogMode ?? wcfg.mode;
    if (wdMode !== "off") {
      for (const sig of readWorkerSignals(orchDir)) {
        if (!sig.ticket) continue;
        if (!isTicketInFlight(readPhaseSignals(orchDir, sig.ticket))) continue;
        if (sig.status === PREEMPTED_STATUS) continue;
        try {
          const startedAtMs = Date.parse(sig.raw?.startedAt ?? "");
          const silenceMs = wcfg.silenceThresholdMs;
          const budgetMs = phaseBudgetMs(sig.phase, sig.raw?.turnCap, wcfg);
          const ageMs = _transcriptAgeMs(sig, { now: _watchdogNow() });
          // Lazy git: only probe commits for a non-fanout worker already silent + over budget.
          const isFanout = sig.phase === "research" || sig.phase === "plan";
          const elapsed = _watchdogNow() - startedAtMs;
          let progress = 0;
          if (!isFanout && ageMs != null && ageMs > silenceMs && elapsed > budgetMs) {
            // CTL-729 remediate: defaultProgressMark resolves the ticket worktree
            // from repoRoot (work-done-probes.mjs:60 resolveWorktree), NOT from a
            // worktreePath — passing worktreePath was silently dropped, so the
            // probe always returned 0 and the commit gate could never spare a
            // committed-but-silent code worker. Resolve repoRoot exactly like the
            // reclaim sweep below (scheduler.mjs:2098).
            const team = teamOf(sig.ticket);
            const repoRoot = team ? (getProjectConfig(team)?.repoRoot ?? null) : null;
            progress = _progressMark({ ticket: sig.ticket, phase: sig.phase, repoRoot, orchDir });
          }
          const decision = evaluateHungWorker({
            ticket: sig.ticket,
            phase: sig.phase,
            status: sig.status,
            nowMs: _watchdogNow(),
            startedAtMs,
            transcriptAgeMs: ageMs,
            progressMark: progress,
            silenceMs,
            budgetMs,
          });
          if (decision.action !== "kill-escalate") continue;
          if (wdMode === "shadow") {
            watchdogWouldKill.push({ ticket: sig.ticket, phase: sig.phase });
            log.warn(
              { ticket: sig.ticket, phase: sig.phase, reason: decision.reason },
              "scheduler: progress-watchdog WOULD kill (shadow mode, no action) (CTL-729)"
            );
            continue;
          }
          // enforce: fire-and-forget (async kill, sync tick continues)
          void _killEscalate(orchDir, sig.ticket, sig, {
            elapsedMin: decision.elapsedMin,
            commitCount: progress,
            reviveBudget: wcfg.reviveBudget,
            now: _watchdogNow,
            emit: _watchdogEmit,
            writeStatus,
            // CTL-729 remediate: real revive dispatcher. The prior wiring passed
            // claimDispatch — the cross-host Linear claim soft-CAS, NOT a worker
            // re-dispatch — so an operator enabling reviveBudget>0 would mark a
            // hung worker "revived" while spawning NO replacement (a stuck slot).
            // Mirror the resume sweep (1.5, scheduler.mjs:2807): resolve the dead
            // bg job to a `claude --resume` UUID and re-dispatch the same phase
            // with --resume continuity. killHungWorker passes { ticket, phase,
            // attempt, bgJobId }; we ignore orchDir (closed over above).
            reviveDispatch: ({ ticket: rt, phase: rp, attempt, bgJobId }) => {
              const resumeSession = bgJobId ? (resolveSession(bgJobId) ?? undefined) : undefined;
              return dispatchTicket(orchDir, rt, rp, { dispatch, resumeSession, attempt });
            },
          }).catch((err) =>
            log.warn(
              { ticket: sig.ticket, phase: sig.phase, err: err.message },
              "scheduler: watchdog kill threw (CTL-729)"
            )
          );
          // CTL-729 remediate: watchdogKilled counts kill-attempts DISPATCHED this
          // tick, not confirmed kills. The kill is fire-and-forget (the sync tick
          // cannot await), so the resolved outcome — "escalated" vs "revived"
          // (reviveBudget>0) vs "already-terminal" (a worker that raced to terminal
          // between readWorkerSignals and the kill) — lands asynchronously via the
          // reap pipeline, not in this array. The terminal-signal write inside
          // killHungWorker is itself synchronous, so the slot is freed correctly
          // regardless; only this reporting field is attempt-granular.
          watchdogKilled.push({ ticket: sig.ticket, phase: sig.phase });
          log.warn(
            {
              ticket: sig.ticket,
              phase: sig.phase,
              reason: decision.reason,
              elapsedMin: decision.elapsedMin,
            },
            "scheduler: progress-watchdog kill dispatched for hung worker (CTL-729)"
          );
        } catch (err) {
          log.warn(
            { ticket: sig.ticket, step: "watchdog", err: err.message },
            "scheduler: per-worker watchdog step failed — continuing tick (CTL-729)"
          );
        }
      }
    }
  }

  tick?.lap("watchdog");

  // (0c) CTL-1137 cost-cap watcher. Out-of-process preemption (the daemon, NEVER the
  // worker — watcher-is-the-watched caused the 2026-06-14 outage) of an AUTONOMOUS
  // phase worker whose cumulative Claude-session cost (Prometheus = the single source
  // of truth) exceeds the per-session cap. SHADOW default → log "would-abort", mutate
  // nothing. FAIL-OPEN → a missing cost signal never aborts. Each check is async (Prom
  // HTTP) and fire-and-forget so the sync tick never blocks; a $40 overspend caught a
  // second later is fine (typical run < $3). Throttled per session (not every tick).
  {
    const ccfg = readCostCapConfig();
    const ccMode = _costCapMode ?? ccfg.mode;
    if (ccMode !== "off") {
      for (const sig of readWorkerSignals(orchDir)) {
        if (!sig.ticket) continue;
        // AUTONOMOUS phase-bg workers ONLY — never interactive sessions (the $300+ outliers).
        if (sig.layout !== "nested" || sig.liveness?.kind !== "bg") continue;
        if (!isTicketInFlight(readPhaseSignals(orchDir, sig.ticket))) continue;
        if (sig.status === PREEMPTED_STATUS) continue;
        const bgJobId = sig.liveness.value;
        if (!bgJobId) continue;
        // Throttle by bgJobId BEFORE the resolveSession fs read + Prom fetch, so a
        // worker is resolved + queried at most once per pollMs (not every tick).
        if (!shouldCheckNow(bgJobId, _costCapNow(), ccfg.pollMs)) continue;
        const sessionId = resolveSession(bgJobId);
        if (!sessionId) continue; // session unresolvable → fail-open (no cost signal to read)
        const { ticket, phase, status } = sig;
        // Fire-and-forget: the per-worker check is async (Prom HTTP) so the sync tick
        // never blocks. checkWorkerCost does fetch → decide → shadow-log | enforce-preempt
        // (terminal-write + reap). Any rejection fails OPEN (logged, no abort).
        void checkWorkerCost({
          orchDir,
          ticket,
          phase,
          status,
          sessionId,
          bgJobId,
          mode: ccMode,
          capUsd: ccfg.capUsd,
          promBaseUrl: ccfg.promBaseUrl,
          fetchCost: _costCapFetch,
          markFailed: _costCapMarkFailed,
          reap: _costCapReap,
          log,
        }).catch((err) =>
          log.warn(
            { ticket, step: "cost-cap", err: err?.message },
            "scheduler: per-worker cost-cap step failed — continuing (CTL-1137, fail-open)"
          )
        );
      }
    }
  }

  tick?.lap("cost-cap");

  // (0j) CTL-1004 stall-janitor. Collapse already-terminal, unambiguous leftovers
  // the event-driven reaper never names: J1 orphan worktrees (teardown=done +
  // .terminal-done.applied, on disk, no live session, clean, CTL-791 evidence) →
  // a TARGETED orphans.reap-requested (the REAPER owns removal); J2 idle ghost
  // sessions (terminal signal >=600s + an idle background session) → the janitor
  // issues killBgJob AND records a pinned kill-intent (mirrors recovery.mjs
  // intentAwareKill). The reconciler only VERIFIES the stop landed — it is a
  // postcondition verifier, never an executor, so the JANITOR performs the stop.
  // SHADOW-FIRST: default mode is "shadow" (emit janitor.would.*, mutate nothing).
  // The census producers + emit/intent seams are injected from startScheduler;
  // a bare unit tick that does not opt in collects nothing (empty census → no-op).
  // Mirrors Pass 0w: the report is built SYNCHRONOUSLY (emits are fire-and-forget),
  // so the tick can read it in the same pass. Wrapped so a census/seam throw never
  // aborts the tick.
  let janitorReaped = [];
  let janitorWouldReap = [];
  let janitorKillIntents = [];
  let janitorWouldKill = [];
  let janitorDeferred = [];
  let janitorStallsCleared = [];
  let janitorWouldClear = [];
  let janitorSignalsGcd = [];
  let janitorWouldGc = [];
  // CTL-1064: Pass 0u report arrays (populated below if the pass runs).
  let unstuckActed = [];
  let unstuckWouldAct = [];
  let unstuckEscalated = [];
  let unstuckWouldEscalate = [];
  {
    const jcfg = readStallJanitorConfig();
    const jMode = _janitorMode ?? jcfg.mode;
    // Only run when an opt-in census producer is wired (production via
    // startScheduler, or a test injecting it). A bare tick has none → skip cleanly.
    if (
      jMode !== "off" &&
      (_collectOrphanCandidates ||
        _collectGhostCandidates ||
        _collectStallClearCandidates ||
        _collectTerminalSignalGcCandidates)
    ) {
      // CTL-1324: throttle the EXPENSIVE worktree censuses (J1 orphan, J3
      // stall-clear, J4 terminal-signal GC) off the per-tick hot path. Each of
      // those `collect*` seams fires a synchronous `git worktree list` per repo +
      // a `git status` per terminal worktree; on a many-worktree host that
      // ~50–70s of blocking spawnSync per tick ages node.heartbeat past the
      // CTL-731 degraded threshold and HOLDS new-work dispatch. We run them on a
      // 15-min cadence instead — when throttled, the three census seams are
      // replaced with `() => []`, so runStallJanitorPass shells out to NO git.
      // The CHEAP J2 ghost-session census (warm agents snapshot only) is NOT
      // throttled: it stays every-tick so urgent stall-recovery is never delayed.
      // Logic is UNCHANGED — only the FREQUENCY of the heavy censuses. The clock
      // + lastRun are injectable (CTL-1064 Pass 0u idiom) for a deterministic test.
      const jCensusIntervalMs = _janitorCensusIntervalMs ?? jcfg.censusIntervalMs;
      const jNowMs = typeof _janitorNowMs === "function" ? _janitorNowMs() : Date.now();
      const runHeavyCensus = !isThrottled(_stallJanitorCensusLastRunMs, jCensusIntervalMs, jNowMs);
      if (runHeavyCensus) _stallJanitorCensusLastRunMs = jNowMs;
      try {
        const jreport = runStallJanitorPass({
          mode: jMode,
          terminalIdleMs: _janitorTerminalIdleMs ?? jcfg.terminalIdleMs,
          // CTL-1324: J1 orphan-worktree census — git-heavy → throttled.
          collectOrphanCandidates: runHeavyCensus
            ? (_collectOrphanCandidates ?? (() => []))
            : () => [],
          // J2 ghost-session census — cheap (warm agents snapshot only) → every tick.
          collectGhostCandidates: _collectGhostCandidates ?? (() => []),
          // CTL-1005 J3: stall-clear census (git-heavy) → throttled; unstick seam unchanged.
          collectStallClearCandidates: runHeavyCensus
            ? (_collectStallClearCandidates ?? (() => []))
            : () => [],
          // Default clear seam: deletes the synthetic stalled signal, clears
          // needs-human (+ marker) + .orphan-detected.applied, writes the
          // .janitor-cleared-<phase>.applied once-marker, and lets the scheduler's
          // normal path re-dispatch. writeStatus carries the removeLabel seam.
          clearStall: _clearStall ?? defaultClearStall(orchDir, writeStatus),
          // CTL-1242 J4: terminal/merged signal dir GC census (git-heavy) → throttled.
          collectTerminalSignalGcCandidates: runHeavyCensus
            ? (_collectTerminalSignalGcCandidates ?? (() => []))
            : () => [],
          gcTerminalSignals: _gcTerminalSignals ?? (() => false),
          emit: _janitorEmit,
          // Default kill seam: BOTH issues killBgJob AND records the pinned
          // intent (mirrors recovery.mjs intentAwareKill). CTL-1004 J2-enforce
          // defect fix — the reconciler is a verifier, not an executor, so the
          // janitor itself must issue the stop. killBgJob is the same tick seam
          // the reclaim path uses (defaultKillBgJob in production, a spy in tests).
          recordKillIntent:
            _recordKillIntent ?? defaultJanitorKillIntentRecorder(intentDb, killBgJob),
        });
        janitorReaped = jreport.reaped;
        janitorWouldReap = jreport.wouldReap;
        janitorKillIntents = jreport.killIntents;
        janitorWouldKill = jreport.wouldKill;
        janitorDeferred = jreport.deferred;
        janitorStallsCleared = jreport.stallsCleared;
        janitorWouldClear = jreport.wouldClear;
        janitorSignalsGcd = jreport.signalsGcd;
        janitorWouldGc = jreport.wouldGc;
        if (
          janitorReaped.length ||
          janitorKillIntents.length ||
          janitorWouldReap.length ||
          janitorWouldKill.length ||
          janitorStallsCleared.length ||
          janitorWouldClear.length ||
          janitorSignalsGcd.length ||
          janitorWouldGc.length
        ) {
          log.info(
            {
              mode: jMode,
              reaped: janitorReaped.length,
              wouldReap: janitorWouldReap.length,
              killIntents: janitorKillIntents.length,
              wouldKill: janitorWouldKill.length,
              deferred: janitorDeferred.length,
              stallsCleared: janitorStallsCleared.length,
              wouldClear: janitorWouldClear.length,
              signalsGcd: janitorSignalsGcd.length,
              wouldGc: janitorWouldGc.length,
            },
            "scheduler: stall-janitor pass (CTL-1004/CTL-1005/CTL-1242)"
          );
        }
      } catch (err) {
        log.warn(
          { step: "stall-janitor", err: err.message },
          "scheduler: stall-janitor pass failed — continuing tick (CTL-1004)"
        );
      }
    }
  }

  tick?.lap("stall-janitor");

  // CTL-1064: Pass 0u — throttled unstuck-sweep. Low-frequency (default 15 min)
  // classify-then-act pass over the stalled/needs-human ticket backlog. A bare tick
  // has no census producer → skip cleanly. Mode='off' by default; operators opt in
  // via env (CATALYST_UNSTUCK_SWEEP=shadow / =enforce) or Layer-2 config.
  {
    const ucfg = readUnstuckSweepConfig();
    const uMode = _unstuckMode ?? ucfg.mode;
    const uIntervalMs = _unstuckIntervalMs ?? ucfg.intervalMs;
    const nowMs = typeof _unstuckNowMs === "function" ? _unstuckNowMs() : Date.now();
    if (
      uMode !== "off" &&
      _collectUnstuckCandidates &&
      !isThrottled(_unstuckLastRunMs, uIntervalMs, nowMs)
    ) {
      _unstuckLastRunMs = nowMs;
      try {
        const ureport = runUnstuckSweepPass({
          mode: uMode,
          // CTL-1191: HRW-gate the unstuck candidate census over the SURVIVING
          // roster. The unstuck pass escalates / acts on stalled tickets; on a
          // 2-node cluster only the owning node should act so two nodes don't
          // both post escalation comments / race a clear on the same ticket. A
          // dead owner's stuck tickets re-home to a live survivor. STRICT no-op
          // at N=1 (ownsForRecovery is identity → the census is unchanged).
          collectCandidates: () =>
            (_collectUnstuckCandidates() ?? []).filter((c) => ownsForRecovery(c.ticket)),
          actByCategory: _unstuckActByCategory ?? {},
          escalate: _unstuckEscalate ?? (() => {}),
          emit: _unstuckEmit,
          recordIntent: intentDb
            ? (kind, subject) => {
                try {
                  // Dedup: skip the INSERT when an open intent already exists for
                  // this kind/subject (mirrors the stall-janitor recorder at
                  // scheduler.mjs:2199-2206). Without this, every pass would insert
                  // a duplicate intent row for the same subject (CTL-1064).
                  const open = intentDb
                    .query(
                      "SELECT 1 FROM intent WHERE kind = ? AND subject = ? AND outcome IS NULL LIMIT 1"
                    )
                    .get(kind, subject);
                  if (open) return;
                  // intent.tick_id is NOT NULL — the prior tickId:null always
                  // failed the insert (the intent was never recorded, so the gate
                  // never suppressed re-acting). Anchor to the latest tick row,
                  // exactly as the stall-janitor recorder does (CTL-1064).
                  const tickRow = intentDb
                    .query("SELECT tick_id FROM tick ORDER BY tick_id DESC LIMIT 1")
                    .get();
                  if (!tickRow) return; // no tick yet → cannot anchor the intent
                  recordIntentBelief(intentDb, {
                    tickId: tickRow.tick_id,
                    kind,
                    subject,
                    postcondition: { kind: "unstuck-sweep", subject },
                  });
                } catch {
                  /* best-effort */
                }
              }
            : () => {},
          // CTL-1064: the driver gate is act-once-then-skip (unstuck-sweep.mjs:257
          // — true = an open intent already exists → skip). That is NOT
          // isIntentEffective's semantics: isIntentEffective returns true for a
          // FRESH subject with no intent (viable channel), which would skip the
          // very first act; the prior `!isIntentEffective` instead returned false
          // while open-under-cap, RE-ACTING every pass until the cap. Probe for an
          // open intent directly so pass 1 acts (no open row yet) and every later
          // pass skips while the intent stays open — pairs with the recordIntent
          // dedup above (same `outcome IS NULL` predicate).
          isIntentEffective: intentDb
            ? (kind, subject) => {
                try {
                  const open = intentDb
                    .query(
                      "SELECT 1 FROM intent WHERE kind = ? AND subject = ? AND outcome IS NULL LIMIT 1"
                    )
                    .get(kind, subject);
                  return open != null;
                } catch {
                  return false;
                }
              }
            : () => false,
          postComment: _unstuckPostComment ?? (() => {}),
        });
        unstuckActed = ureport.acted;
        unstuckWouldAct = ureport.wouldAct;
        unstuckEscalated = ureport.escalated;
        unstuckWouldEscalate = ureport.wouldEscalate;
        if (
          ureport.acted.length ||
          ureport.wouldAct.length ||
          ureport.escalated.length ||
          ureport.wouldEscalate.length
        ) {
          log.info(
            {
              mode: uMode,
              acted: ureport.acted.length,
              wouldAct: ureport.wouldAct.length,
              escalated: ureport.escalated.length,
              wouldEscalate: ureport.wouldEscalate.length,
              skipped: ureport.skipped.length,
              failed: ureport.failed.length,
            },
            "scheduler: unstuck-sweep pass (CTL-1064)"
          );
        }
      } catch (err) {
        log.warn(
          { step: "unstuck-sweep", err: err.message },
          "scheduler: unstuck-sweep pass failed — continuing tick (CTL-1064)"
        );
      }
    }
  }

  tick?.lap("unstuck-sweep");

  // CTL-1176: Pass 0r — LLM reasoning recovery pass. Low-frequency autonomous
  // triage of the stalled/failed/needs-human/UNKNOWN backlog. Mode resolves from
  // readRecoveryPassConfig() (env CATALYST_RECOVERY_PASS > Layer-2
  // .catalyst.recovery.pass.mode > 'off'). Ships off by default (ADR-023);
  // operators opt in via CATALYST_RECOVERY_PASS=shadow then =enforce.
  {
    const rcfg = readRecoveryPassConfig();
    const rMode = _recoveryPassMode ?? rcfg.mode;
    if (rMode !== "off") {
      try {
        const rSigs = readWorkerSignals(orchDir)
          .filter(
            (sig) =>
              sig.status === "needs-human" ||
              sig.status === "failed" ||
              sig.status === "stalled" ||
              resolveTicketType(orchDir, sig.ticket) === "unknown"
          )
          // CTL-1191: HRW ownership gate over the SURVIVING roster. On a 2-node
          // cluster only the node that OWNS a stalled ticket reasons over it, so
          // the pass no longer double-acts (duplicate escalations / racing
          // re-dispatch). A dead owner's tickets re-home to a live survivor.
          // STRICT identity at N=1 (ownsForRecovery → !multiHost short-circuit).
          .filter((sig) => ownsForRecovery(sig.ticket))
          // CTL-1191: terminal-state filter (PR #2163 verify flag). Stop reasoning
          // over a ticket that already reached a terminal Linear state or whose PR
          // already merged — the pipeline (or a human) finished it; reasoning over
          // it just burns cooldown + re-posts diagnoses. Cheap-first cached Linear
          // read; fail-open (a thrown/unreadable read → NOT terminal → kept).
          // Threads the SAME per-tick TTL state cache + gateway the reclaim/advance
          // paths use (≤1 Linear read per ticket per tick).
          .filter((sig) => {
            // CTL-1364 Tier-3: record a scheduler.op[terminal-read] sub-lap for THIS
            // signal's terminal check — but ONLY for the read that actually shells out
            // (cache+gateway+replica miss → live linearis exec). A hit returns early
            // and the onExec seam never fires, so `done` is never called → no op span
            // (matches the "cache hits emit no op span" acceptance criterion). The op
            // is the HIGHEST-VALUE span: it pins a 15s recovery-filter spike to the
            // exact ticket + source. tick may be null (timing off) → tick?.op no-op.
            const done = tick?.op("recovery-pass", "terminal-read", {
              "op.sweep": "recovery-filter",
              "catalyst.ticket": sig.ticket,
            });
            const result = isTicketTerminalOrMerged({
              ticket: sig.ticket,
              signal: sig,
              cache,
              fetchState: (id, o = {}) =>
                fetchTicketState(id, {
                  ...o,
                  cache,
                  gateway,
                  replica,
                  // CTL-1451 (A4 "then widen", final site): the recovery backlog
                  // re-reads its stuck cohort EVERY tick — a replica-hole ticket
                  // whose live read fails (ADV-1433: ~700 failed reads/hr) must
                  // back off like the terminal-sweep/census callers, not retry
                  // per tick. Fail-open toward not-terminal, retried after the
                  // negative-cache TTL (never-cache-null preserved for
                  // blocker-hydration callers — this flag is per-site).
                  probeBackoff: true,
                  onExec: done
                    ? ({ source, execMs, result: r, timedOut }) =>
                        done({
                          "recovery.terminal.source": source,
                          "recovery.terminal.cache_hit": false,
                          "op.exec_ms": execMs,
                          "recovery.terminal.result": r ?? "null",
                          "op.timed_out": timedOut === true,
                        })
                    : undefined,
                }),
            });
            return !result.terminal;
          });
        // CTL-1241: buildRecoveryItems attaches the current-tick escalate_human
        // belief (if any) as evidence.beliefState so the structurally-dead R12
        // branch in recovery-reasoning.mjs is revived.
        // getBeliefsDb() returns null when beliefs are disabled → no query.
        const rItems = buildRecoveryItems(rSigs, {
          db: getBeliefsDb(),
          getBeliefs: getEscalateHumanBelief,
        });
        // CTL-1440 (P0b): terminal-state policy — attempts-exhausted intents
        // escalate LOUDLY (ledger escalated:true + needs-human + curated brief +
        // app-actor comment + recovery.escalated event) instead of silently
        // latching forever (audit RC1: nothing un-latched an attempts-exhausted
        // open ticket). Runs BEFORE the per-item pass so a freshly-escalated
        // ticket is skipped as "escalated" (B1's TTL governs re-entry) rather
        // than "attempts-exhausted". Enforce-only — shadow must not write
        // labels/comments. Idempotent: escalated:true excludes future scans.
        // Codex R1: board-health is independently operator-gated — an exhausted
        // board-health candidate must escalate loudly even when the per-item
        // recovery pass is off (the new all-candidates-exhausted reason is
        // excluded from C2's wedge set, so WITHOUT this sweep nothing would
        // ever surface those tickets).
        const _bhModeForSweep = readBoardHealthConfig().mode;
        if (rMode === "enforce" || _bhModeForSweep === "enforce") {
          try {
            escalateExhaustedIntents(orchDir, {
              labelNeedsHuman: (dir, t) =>
                labelNeedsHumanUnlessBeliefOwner(dir, t, writeStatus, {
                  site: "attempts-exhausted",
                }),
              // Codex R1: a finished ticket's stale ledger is forgotten by the
              // terminal cleanup LATER in the tick — never page a human for it.
              // Cached/replica-first read; fail-open toward active.
              isActive: (t) =>
                !isTicketTerminalOrMerged({
                  ticket: t,
                  cache,
                  fetchState: (id, o = {}) =>
                    fetchTicketState(id, { ...o, cache, gateway, replica, probeBackoff: true }),
                })?.terminal,
            });
          } catch (err) {
            log.warn(
              { err: err?.message },
              "ctl-1440: exhausted-intent sweep threw — continuing tick"
            );
          }
        }
        if (rItems.length > 0) {
          // CTL-1176: BIND the host-local ledger + act-seams to THIS tick's real
          // orchDir. Without this the defaults call resolveOrchDir() →
          // process.env.CATALYST_ORCHESTRATOR_DIR, which the daemon never sets on
          // its own process → orchDir=null → cooldown/max-attempts/escalated-latch
          // all inert and shadow re-posts every item every tick. orchDir is the
          // tick's first arg (schedulerTick(orchDir, …)), so it's already in scope.
          const rResult = reasoningRecoveryPass(rItems, {
            mode: rMode,
            shouldSkipItem: (ticket) => recoveryShouldSkipItem(ticket, { orchDir }),
            recordIntent: (ticket, intent) => recoveryRecordIntent(ticket, intent, { orchDir }),
            // CTL-1157 Workstream C: write the curated 6-field explanation signal
            // on enforce escalates (bound to this tick's orchDir).
            writeEscalationSignal: (ticket, payload) =>
              recoveryWriteEscalationSignal(ticket, payload, { orchDir }),
            // CTL-1157 Workstream B: read prior attempts so a defer marker pins
            // them (no auto-increment, no budget burn).
            readIntentAttempts: (ticket) => recoveryReadIntentAttempts(ticket, { orchDir }),
            invokeSeam: (ticket, seamId, brief) =>
              recoveryInvokeSeam(ticket, seamId, brief, { orchDir }),
            // CTL-1176 rung 3: dispatch the recovery-pass skill for the
            // bounded-LLM path (was recoveryInvokeRemediateCapped → phase-remediate).
            // CTL-1331 FU-1: ENQUEUE the dispatch instead of running the synchronous
            // createWorktree + spawnSync on the tick — that prelude was ~99% of the
            // recovery-pass lap (CTL-1330). The detached delegate runner drains the
            // intent and calls recoveryInvokeRecoveryPass with the SAME briefObj off
            // the daemon loop. attemptFix reads `.success`: a fresh enqueue OR an
            // idempotent no-op (already-pending / a recovery-pass worker already
            // live) both mean recovery is in flight. The runner is auto-enabled
            // whenever CATALYST_RECOVERY_PASS=enforce (readDelegateRunnerConfig
            // coupling), so the intents always drain.
            invokeRecoveryPass: (ticket, briefObj) =>
              enqueueRecoveryItemDelegate(ticket, briefObj, {
                orchDir,
                // Thread the real (warm-snapshot) bg-liveness probe so the
                // enqueue-time worker-live idempotency guard actually fires — skip
                // queuing a redundant intent when a recovery-pass worker for this
                // ticket is already live. The runner re-checks + supersedes at drain
                // time too, but this avoids the wasted enqueue→claim→supersede and a
                // transient slot reservation.
                isBgJobAlive: (id) => isBgJobAlive(id, { agents: getAgents().agents }),
                // CTL-1157 (GROUP-3 #2): make the enqueue-time worker-live probe
                // sdk-aware so a dispatched|running sdk recovery-pass worker (no
                // bg_job_id) dedups a re-enqueue instead of double-dispatching. Inert
                // under bg/oneshot-legacy (executor stays null → byte-identical).
                executor: dispatchMode === "sdk" ? "sdk" : null,
              }),
          });
          if (rResult.processed > 0) {
            log.info(
              {
                mode: rMode,
                processed: rResult.processed,
                results: rResult.results.length,
              },
              "scheduler: recovery-reasoning pass (CTL-1176)"
            );
          }
        }
      } catch (err) {
        log.warn(
          { step: "recovery-pass", err: err.message },
          "scheduler: recovery-reasoning pass failed — continuing tick (CTL-1176)"
        );
      }
    }
  }

  // CTL-1331 follow-up: close the "recovery-pass" lap HERE so it measures ONLY the
  // Pass 0r recovery-reasoning pass (the LLM-recovery DECISION + the now-async
  // enqueue, FU-1). The reclaim sweep below — reclaimDeadWork per in-flight signal,
  // each a fetchTicketState Linear terminal-check — was previously CONFLATED into
  // this lap and is the actual multi-second cost; it gets its own "reclaim" lap.
  tick?.lap("recovery-pass");

  // CTL-644: per-tick approval poll — dispatch any gated tickets that now have an
  // approval sentinel. Cheap (directory scan + existsSync per worker); no API calls
  // unless a dispatch fires. Runs before the reclaim sweep so an approved ticket
  // can advance in the same tick it's dispatched.
  // CTL-1367 P2-C: thread the resolved scheduler `dispatch` so a mid-run approval
  // launches via the SAME executor the daemon resolved (the boot-time call in
  // daemon.mjs already does this). Without it the per-tick poll fell back to
  // processApprovedResumes' default defaultDispatch and launched via `claude --bg`
  // even under executor=sdk — a split-brain that depended on whether the approval
  // sentinel existed at boot or appeared later. Under bg `dispatch === defaultDispatch`
  // so this is byte-identical to the prior call.
  processApprovedResumes({ orchDir, dispatch });

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
  // CTL-935 Phase 3: capture raw reclaim outcomes per subject (ticket/phase) BEFORE
  // the lossy switch — the switch coarsens outcomes into HUD buckets, losing the
  // raw string needed by the reclaim shadow comparator.
  const reclaimOutcomes = new Map();
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
  // CTL-1331 follow-up: the reclaim terminal-check trusts the read-replica's
  // last-known state regardless of age (default unbounded) so STUCK tickets — whose
  // descriptors age past the 60s default because they get no webhooks — stop forcing
  // a per-tick `linearis` exec (the reclaim-lap spike). Resolved once per tick.
  const reclaimGatewayFreshMs = readReclaimGatewayFreshMs();

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
    // CTL-768: a needs-input worker that was intentionally stopped by the
    // held-stop sweep (stoppedForHold: true) must not be reclaimed — its slot
    // is already freed and it will be revived with --resume by handleCommentWake
    // when the human replies. Reclaiming it here would re-spawn the worker and
    // defeat the slot-freeing mechanism entirely.
    if (sig.status === "needs-input" && sig.raw?.stoppedForHold) continue;
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
      // CTL-1364 Tier-3: open one scheduler.op[terminal-read, reclaim-sweep] sub-lap
      // for this signal's reclaim. Its terminal short-circuit calls fetchState, which
      // shells out ONLY on a cache+gateway+replica miss — exactly the slow path. The
      // onExec seam fires only on that live exec; we stash its exec_ms/timed_out and
      // close the op AFTER reclaimDeadWork returns (so the op can carry the reclaim
      // outcome). A cache/gateway hit never fires onExec, so `_reclaimExecFired` stays
      // false and the op is never closed → no span (cache hits emit no op span). tick
      // may be null (timing off) → tick?.op no-op.
      const reclaimOpDone = tick?.op("reclaim", "terminal-read", {
        "op.sweep": "reclaim-sweep",
        "catalyst.ticket": sig.ticket,
      });
      let _reclaimExecMs = null;
      let _reclaimTimedOut = false;
      let _reclaimExecFired = false;
      const reclaimOpts = {
        repoRoot,
        cache,
        fetchState: (id, o = {}) =>
          fetchTicketState(id, {
            ...o,
            gateway,
            replica,
            // CTL-1451: same per-tick class as the recovery filter above — the
            // reclaim terminal short-circuit runs per stuck signal per tick;
            // fail toward not-terminal and back off (matches the terminal-Done
            // sweep's flag).
            probeBackoff: true,
            gatewayFreshMs: reclaimGatewayFreshMs,
            onExec: reclaimOpDone
              ? ({ execMs, timedOut }) => {
                  _reclaimExecFired = true;
                  _reclaimExecMs = execMs;
                  _reclaimTimedOut = timedOut === true;
                }
              : undefined,
          }),
        prAdapter,
        // CTL-809 — thread the warm agents snapshot so the reclaim alive-branch can
        // cross-check a jobLifecycle-alive-but-process-gone ghost (getAgentsCached is
        // already imported at scheduler.mjs:81).
        agentsSnapshot: getAgentsCached,
        // CTL-936: thread the beliefs.db handle for kill-intent recording + stop-storm
        // suppression. null when CATALYST_BELIEFS_SHADOW=0 (the default — legacy tests
        // unaffected; intentAwareKill falls through to plain killBgJob).
        intentDb,
        // CTL-863: thread this tick's live cluster gate + host identity so
        // reclaimDeadWork's postReclaimMirror fence zombie-guard is armed on a real
        // ≥2-host cluster (roster resolved per-tick above → no boot-time staleness).
        multiHost,
        self,
        gateway,
      };
      // CTL-736 Phase 3: no per-tick revive budget is threaded — the progress gate
      // (revive only while progressing; stop on zero progress) + the Phase-1 O_EXCL
      // claim bound the mass-revive storm structurally.
      const r = reclaimDeadWork(orchDir, sig, reclaimOpts);
      // CTL-1364: close the reclaim terminal-read op ONLY when the live exec fired
      // (a cache/gateway/replica hit never set _reclaimExecFired → no span). The op
      // carries the reclaim outcome so a slow reclaim-sweep spike attributes to the
      // exact ticket + outcome + exec_ms in the flame graph.
      if (reclaimOpDone && _reclaimExecFired) {
        reclaimOpDone({
          "recovery.reclaim.outcome": r ?? "null",
          "op.exec_ms": _reclaimExecMs,
          "op.timed_out": _reclaimTimedOut,
        });
      }
      // CTL-935 Phase 3: record raw outcome before the switch coarsens it.
      try {
        reclaimOutcomes.set(`${sig.ticket}/${sig.phase}`, r);
      } catch {
        /* isolation */
      }
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
        "scheduler: per-worker step failed — skipping signal, continuing tick (CTL-702)"
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
  // CTL-1331 follow-up: this lap now measures the RECLAIM sweep (+ the cheap CTL-644
  // approval poll) — reclaimDeadWork per in-flight worker signal, each doing a
  // fetchTicketState Linear terminal-check that falls back to a slow `linearis` exec
  // on a gateway/cache miss (stuck / foreign-team tickets like ADV-*). This is the
  // real multi-second driver previously hidden inside the "recovery-pass" lap.
  tick?.lap("reclaim");

  const liveCount = liveBackgroundCount();

  // CTL-1331: a board-health delegate runs async — the tick enqueues an intent and
  // a detached runner does the heavy spawn later. A queued/claimed intent has
  // RESERVED a slot it has not yet filled (its `claude --bg` isn't live, so
  // liveBackgroundCount can't see it). Reserve it here — GC terminal/stale
  // reservations first — so new-work/promotion/resume admission can't over-fill
  // past maxParallel into a slot a queued delegate will claim. The reservation
  // only ever LOWERS freeSlots (conservative-only, §3b); with an empty queue both
  // calls return 0, so occupiedCount === liveCount (Phase A inert: zero change).
  try {
    // CTL-1157 (GROUP-3 #2): pass the resolved executor so the GC keeps a launched
    // sdk delegate intent (in-process query(), no bg_job_id) LIVE instead of dropping
    // it as a dead bg job — dropping it would free the reservation/existence guard and
    // let the next scan re-dispatch the same in-flight ticket. Inert under bg (executor
    // null → the no-bg_job_id launched intent still drops exactly as today).
    gcDelegateIntents(orchDir, now(), { executor: dispatchMode === "sdk" ? "sdk" : null });
  } catch {
    /* GC is best-effort — never block the tick */
  }
  let queuedDelegates = 0;
  try {
    queuedDelegates = countQueuedDelegates(orchDir);
  } catch {
    /* reservation read is best-effort — fall back to 0 reserved */
  }
  // CTL-1367 P1: under executor=sdk the in-process SDK workers have NO `claude --bg`
  // job, so liveCount is blind to them. Add their occupancy (dispatched/running
  // nested signals with no bg_job_id) so the slot gate counts them like bg jobs and
  // can't admit MORE tickets past maxParallel (each queuing behind the SDK
  // semaphore). CTL-1457 (T2): codex-exec prelaunches write the SAME no-bg_job_id
  // "dispatched" signals and queue behind their own semaphore, so a codex node must
  // count them too — gate on isInProcessDispatchMode (sdk OR codex-exec). Under
  // bg/oneshot-legacy the term is 0 (countSdkInflight is never called), so
  // occupiedCount is byte-identical to today.
  // CTL-1457 (N1): ALSO arm when executorByPhase routes ANY phase to an in-process
  // executor while the NODE mode is still bg (hasInProcessRoute) — the per-phase
  // rollout's routed no-bg worker must be counted too. countSdkInflight stays 0 on a
  // node nothing routes in-process, so a bg node with an empty map is unchanged.
  let sdkInflight = 0;
  if (isInProcessDispatchMode(dispatchMode) || hasInProcessRoute) {
    try {
      sdkInflight = countSdkInflight(orchDir);
    } catch {
      /* best-effort — never block the tick on a signal-scan failure */
    }
  }
  // `let` (not const): a successful board-health enforce dispatch below reserves a
  // slot by incrementing this AFTER the sample — see the board-health pass (CTL-1157
  // Codex round-5). Every other read of occupiedCount is downstream of that point.
  let occupiedCount = liveCount + queuedDelegates + sdkInflight;

  tick?.lap("liveness-read");

  // CTL-1290: board-health delegate cadence hook — SHADOW-FIRST. Runs ONLY when
  // the daemon threads the `boardHealth` seam (its real-IO readers); a bare
  // schedulerTick (unit test) passes none → the pass is inert and does zero real
  // IO. Every snapshot var is already in scope here (eligible above, roster/self/
  // multiHost at tick top, maxParallel/liveCount just above) — no re-query.
  // CTL-1300: the optional `act` seam is threaded too — supplied ONLY by the
  // daemon binding (the holistic recovery-pass dispatcher) and reached ONLY in
  // enforce; a bare tick / shadow passes none → mutation-free. Wrapped in
  // try/catch: a board-health failure must never break the tick. Throttled
  // internally to BOARD_HEALTH_INTERVAL_MS.
  if (_boardHealth) {
    const _bhMode = _boardHealth.mode ?? readBoardHealthConfig().mode;
    if (_bhMode !== "off") {
      try {
        const _bhResult = boardHealthPassFn({
          mode: _bhMode,
          orchDir,
          getBoard: _boardHealth.getBoard,
          getWorkerSignals: () => readWorkerSignals(orchDir),
          getEligible: () => eligible, // already read this tick
          roster,
          self,
          multiHost,
          capacity: {
            maxParallel,
            liveCount,
            freeSlots: computeFreeSlots(maxParallel, occupiedCount),
          },
          readEventRing: _boardHealth.readEventRing,
          ownerForTicket,
          // CTL-1157 (Codex #4): ticket→owner/repo resolver for the composite
          // (repo, number) PR-status lookup. Daemon-bound below; a bare tick
          // passes none → null → number-only fallback (N=1 byte-identical).
          repoForTicket: _boardHealth.repoForTicket,
          getReconcileMarkers: _boardHealth.getReconcileMarkers,
          getDeferredBoardHealthTickets: _boardHealth.getDeferredBoardHealthTickets, // CTL-1432 (B2)
          sanctionedNeedsHuman: _boardHealth.sanctionedNeedsHuman, // CTL-1432 (B3)
          // CTL-1157: thread the PR-status reader + the provably-dead host set.
          // Both are daemon-bound (the binding below); a bare tick passes neither
          // → empty-Map / empty-array defaults keep the new invariants
          // observable:false and the holistic failover unreachable (shadow-safe).
          getPrStatusMap: _boardHealth.getPrStatusMap,
          deadHosts: _boardHealth.deadHosts ? _boardHealth.deadHosts(roster) : [],
          lastRunMs: _boardHealthLastRunMs,
          // emit defaults to defaultEmitEvent. CTL-1300: thread the optional `act`
          // seam — supplied ONLY by the daemon binding (the holistic recovery-pass
          // dispatcher) and reached ONLY in enforce. A bare schedulerTick / shadow
          // mode passes no `act` → mutation-free (the shadow-first guarantee).
          act: _boardHealth.act,
          log: (o, m) => log.warn?.(o, m),
          now,
        });
        if (_bhResult?.ran) _boardHealthLastRunMs = _bhResult.ranAtMs;
        // CTL-1157 (Codex round-5): a successful board-health ENFORCE dispatch enqueued
        // a recovery-pass delegate intent AFTER occupiedCount was sampled (queuedDelegates
        // is now stale by one). RESERVE that slot here so the same tick's resume + new-work
        // admission (every computeFreeSlots(maxParallel, occupiedCount) below) cannot fill
        // the slot board-health just claimed — otherwise at maxParallel=1 with one free
        // slot the tick launches board-health's delegate AND promotes/admits another worker,
        // overrunning the limit. holisticBoardHealthAct dispatches exactly ONE per scan, so
        // reserve one. shadow/off never reach `act` → dispatched is never true → no reserve.
        if (_bhResult?.act?.dispatched === true) occupiedCount += 1;
      } catch (err) {
        log.warn?.(
          { step: "board-health", err: err.message },
          "scheduler: board-health pass failed — continuing tick (CTL-1290)"
        );
      }
    }
  }

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
            if (fenceGuard({ ticket: member, orchDir, multiHost, gateway, self })) {
              const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, member, writeStatus, {
                env,
                site: "dependency-cycle",
                log,
              });
              // CTL-764 finding 8: emit only on an actual label write (a persisted
              // marker after restart / belief-owner deferral is not a fresh escalation).
              if (wrote) {
                recordTransition({
                  ticket: member,
                  toDisposition: "needs-human",
                  source: "dependency-cycle",
                });
              }
            } else {
              log.warn(
                { ticket: member },
                "ctl-863: stale fence — suppressing labelOnce(needs-human/cycle) write (zombie guard)"
              );
            }
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
        ? Math.max(0, computeFreeSlots(maxParallel, occupiedCount))
        : 0;
      const readyCandidates = rankTickets(admissionPool.filter((t) => readyIds.has(t.identifier)));
      const admittedSlice = selectDispatchablePerProject(
        readyCandidates,
        new Set(),
        freeSlotsForPromotion,
        { perProject: concurrency?.perProject, inFlight: inFlightTickets }
      );
      admittedThisTick = new Set(
        admittedSlice.filter((t) => triagedWaiting.includes(t.identifier)).map((t) => t.identifier)
      );

      // A.7 — held-indicator convergence (CTL-755 ADDENDUM). For each candidate,
      // compute the desired held label and converge ON A DIFF (steady-state tick
      // = zero writes). Emit phase.advance.held only-on-state-change.
      const edges = buildDependencyEdges(admissionPool, {
        externalIds: Object.keys(admissionBlockerStates),
      });
      const poolById = new Map(
        admissionPool.filter((t) => t?.identifier).map((t) => [t.identifier, t])
      );
      for (const ticket of triagedWaiting) {
        if (cycleMembers.has(ticket)) {
          // Cycle member → owned by needs-human (labelOnce above). Clear any
          // stale held label so it doesn't double-signal, and drop its held
          // emit-state so a future non-cycle hold re-emits.
          convergeHeldLabel(ticket, labelsByTicket.get(ticket), null, writeStatus, {
            orchDir,
            now,
          });
          lastHeldEmitState.delete(ticket);
          // CTL-764 Phase 5: cycle member superseded by needs-human → clear disposition.
          recordTransition({ ticket, toDisposition: null, source: "cycle-member-clear" });
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

        // CTL-764 findings B + F: the worker.transition emission must reflect the
        // ticket's TRUE disposition. needs-human is sticky + exclusive, so when it is
        // already on the ticket the lower held dispositions (blocked/queued) cannot
        // apply — recording one would falsely downgrade the two-axis stream (finding B).
        // On a clear, pass the held label as fromDisposition so a genuine
        // blocked/queued→cleared still emits after a daemon restart, where
        // lastDispositionEmit is empty and recordTransition's first-seen-clear allowance
        // needs a proven prior (finding F). needs-human clears are owned by
        // clearStalledLabel, so the admission loop never emits them.
        const currentLabelSet = new Set(labelsByTicket.get(ticket) ?? []);
        const hasNeedsHuman = currentLabelSet.has(HELD_LABEL_NEEDS_HUMAN);

        // CTL-764 r4 finding 1 + r5: the clear emission lives INSIDE the removal
        // callback so it fires only on a CONFIRMED removal — and, because the
        // production removeLabel is async while this tick is sync, it fires when the
        // write RESOLVES (post-tick) rather than false-confirming off a Promise. A
        // transient failure emits nothing (Linear still wears the label; a later tick
        // re-converges). recordTransition's only-on-change guard dedupes the rare
        // double-callback (a ticket wearing two stale held labels). Legacy "waiting"
        // normalizes to the canonical "queued" (finding 2) so the stream never carries
        // a fifth disposition value.
        convergeHeldLabel(ticket, labelsByTicket.get(ticket), desired, writeStatus, {
          orchDir,
          now,
          onRemoveResult: (label, removed) => {
            if (desired !== null || !removed || hasNeedsHuman) return;
            const fromHeld = label === LEGACY_HELD_LABEL_WAITING ? HELD_LABEL_WAITING : label;
            recordTransition({
              ticket,
              fromDisposition: fromHeld,
              toDisposition: null,
              source: "scheduler-admission",
            });
          },
        });

        if (desired) {
          // Only-on-state-change emission: skip if the same held class already
          // emitted for this ticket since it was last cleared/admitted.
          if (lastHeldEmitState.get(ticket) !== desired) {
            lastHeldEmitState.set(ticket, desired);
            safeEmit(
              appendPhaseAdvanceHeldEvent,
              { orchId: ticket, ticket, reason, blockers },
              { ticket, phase: "advance" }
            );
          }
          // CTL-764 Phase 5: emit worker.transition for disposition hold — finding B
          // suppresses it while needs-human is present (the lower disposition never lands).
          if (!hasNeedsHuman) {
            recordTransition({
              ticket,
              toDisposition: desired,
              reason,
              source: "scheduler-admission",
            });
          }
        } else {
          // Admitted (or no longer held) → reset so a future re-hold re-emits.
          // The clear emission itself lives in the onRemoveResult callback above
          // (r4 finding 1 + r5): confirmed-removal-gated, async-write-safe.
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
      const descriptorByTicket = new Map(waitingDescriptors.map((d) => [d.identifier, d]));
      // CTL-925 Gap 2: full-graph edge set for the transitive cycle guard below.
      // waitingDescriptors carry relations/inverseRelations (inSet = the pool),
      // so buildDependencyEdges yields the canonical {from,to} edges the detector
      // uses. Built once and reused per (candidate, dep). The 2-node
      // candidateBlocks.has shortcut remains as a backstop for direct out-of-pool
      // back-edges; wouldCreateCycle adds transitive coverage over the pool.
      const poolEdges = buildDependencyEdges(waitingDescriptors);
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
              "ctl-878 step-e: skipping dependency that is the candidate's parent epic"
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
              "ctl-838 step-e: skipping cross-team dependency (daemon cannot work it)"
            );
            continue;
          }
          if (candidateBlocks.has(dep) || wouldCreateCycle(poolEdges, dep, candidate)) {
            // Persisting blocked_by(candidate ← dep) would close a cycle of
            // any length (2-node direct OR transitive through pool edges).
            // CTL-925 supersedes the CTL-755 direct-only check with full
            // reachability via wouldCreateCycle. candidateBlocks remains as a
            // backstop for direct out-of-pool back-edges.
            log.warn(
              { candidate, dep },
              "ctl-925 step-e: skipping dependency that would close a cycle (transitive)"
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

          if (fenceGuard({ ticket: candidate, orchDir, multiHost, gateway, self })) {
            safeWrite(
              () => writeStatus.applyBlockedByRelation({ ticket: candidate, blockedBy: dep }),
              { ticket: candidate, phase: "triage-deps" }
            );
          } else {
            log.warn(
              { ticket: candidate },
              "ctl-863: stale fence — suppressing applyBlockedByRelation(triage-deps) write (zombie guard)"
            );
          }
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

  tick?.lap("board-health");

  // (0.5) Preemption sweep — if slots are saturated AND the top-ranked queued
  // ticket out-ranks the lowest-ranked preemptable in-flight worker, stop that
  // worker and park it for resume when a slot frees. Safety guards prevent
  // thrash: non-preemptable phases, 60s min-runtime, implement quiet-window,
  // 30s hysteresis. Runs after reclaim (so a just-reclaimed slot is counted)
  // and before advancement (so a preempted signal isn't falsely advanced).
  {
    if (computeFreeSlots(maxParallel, occupiedCount) <= 0) {
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
          const signalPath = join(
            orchDir,
            "workers",
            candidate.identifier,
            `phase-${activePhase}.json`
          );
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
        const signalPath = join(
          orchDir,
          "workers",
          candidate.identifier,
          `phase-${activePhase}.json`
        );
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

  // (0.75) CTL-768 held-worker stop sweep — free the slot held by an idle
  // needs-input worker so other work can proceed while it awaits a human reply.
  // Runs AFTER preemption (never double-kill a just-parked worker) and BEFORE
  // advancement. Status stays "needs-input" (reclaim/advancement/in-flight
  // guards already cover it); a stoppedForHold marker tells handleCommentWake to
  // revive with --resume. Natural idempotency: a stopped process reads "absent",
  // so the idle gate skips it next tick; the cooldown guards the snapshot-lag race.
  let heldStopCount = 0;
  {
    const nowMs = now();
    for (const sig of readWorkerSignals(orchDir)) {
      if (!inFlightTickets.has(sig.ticket)) continue;
      if (sig.status !== "needs-input") continue;
      const bgJobId = sig.raw?.bg_job_id ?? null;
      if (!bgJobId) continue; // no process to stop
      if (inHoldStopCooldown(orchDir, sig.ticket, sig.phase, nowMs)) continue;
      if (livenessForHeld(bgJobId) !== "idle") continue; // mid-turn / absent guard

      // CTL-768 (verify remediation): persist the durable stoppedForHold marker
      // BEFORE the irreversible kill so the sweep is crash-safe. If the marker
      // write throws, we `continue` while the worker is STILL alive+idle (it is
      // simply retried next tick) — rather than killing first and stranding a
      // markerless needs-input worker that handleCommentWake would later revive
      // COLD (no --resume), silently defeating the CTL-768 warm-revive contract
      // and losing the paused turn context. A persisted marker GUARANTEES the
      // --resume path. Marker-on-still-running is safe: status stays needs-input
      // so no other sweep acts on it, and killBgJob is idempotent.
      const signalPath = join(orchDir, "workers", sig.ticket, `phase-${sig.phase}.json`);
      try {
        const updated = {
          ...sig.raw, // preserves bg_job_id
          stoppedForHold: true,
          holdStoppedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        const tmp = `${signalPath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(updated));
        renameSync(tmp, signalPath); // atomic
      } catch (err) {
        log.warn(
          { ticket: sig.ticket, phase: sig.phase, err: err.message },
          "scheduler: held-stop signal write failed — skipping (CTL-768)"
        );
        continue;
      }
      recordHoldStop(orchDir, sig.ticket, sig.phase, nowMs);

      killBgJob({ bgJobId });

      safeEmit(
        appendHeldStoppedEvent,
        { orchId: sig.ticket, ticket: sig.ticket, phase: sig.phase, bgJobId },
        { ticket: sig.ticket, phase: sig.phase }
      );
      heldStopCount++;
      log.info(
        { ticket: sig.ticket, phase: sig.phase, bgJobId },
        "scheduler: held needs-input worker stopped to free slot (CTL-768)"
      );
    }
  }

  tick?.lap("preemption-sweep");

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
    if (next === NEW_WORK_ENTRY_PHASE && signals.triage === "done" && !admittedThisTick.has(ticket))
      continue;
    if (inDispatchCooldown(orchDir, ticket, next, now())) continue; // CTL-624: throttle refused re-dispatch
    // CTL-671: circuit breaker — once consecutiveFailures has crossed the
    // threshold, quarantine to terminal `stalled` and stop re-dispatching.
    if (maybeTripCircuitBreaker(orchDir, ticket, next)) continue;
    // CTL-826: the dispatch→verify core is shared (requested-emit, dispatch,
    // verify, success cooldown-clear + launched-emit, full failure ladder). The
    // advance-specific follow-ups stay here, keyed off the returned result.
    // CTL-864 remediation: re-inject the cross-host fence token won at new-work
    // claim. The 4 advancement-dispatched guarded phases (implement/pr/
    // monitor-merge/monitor-deploy) need it to fence themselves; without this the
    // CTL-864 guard was inert. Multi-host only; null on single-host or when no
    // claim was persisted → dispatchTicket drops the key (exact no-op).
    const clusterGeneration = multiHost ? readClusterGeneration(orchDir, ticket) : null;
    const dv = dispatchAndVerify(orchDir, ticket, next, {
      dispatch,
      clusterGeneration,
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
          emitStateWrite({
            writerResult: wr,
            ticket,
            phase: next,
            source: "scheduler-advance",
            orchId: ticket,
          });
          // CTL-764 Phase 5: emit worker.transition for stage change.
          recordTransition({
            ticket,
            toStage: next,
            fromStage: wr?.from_state ?? null,
            source: "scheduler-advance",
          });
        },
        { ticket, phase: next }
      );
      // CTL-751: on triage→research advance, write the reference-class
      // estimate to Linear if triage.json carries a valid numeric `.estimate`.
      if (next === "research") {
        const est = readTriageEstimate(orchDir, ticket);
        if (est !== null) {
          if (fenceGuard({ ticket, orchDir, multiHost, gateway, self })) {
            safeWrite(() => writeStatus.applyEstimate({ ticket, estimate: est }), {
              ticket,
              phase: next,
            });
          } else {
            log.warn(
              { ticket },
              "ctl-863: stale fence — suppressing applyEstimate write (zombie guard)"
            );
          }
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
    let resumeSlots = Math.max(0, computeFreeSlots(maxParallel, occupiedCount) - promotedCount);
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
        // CTL-864 remediation: re-inject the won fence token on resume too — a
        // parked guarded phase (e.g. monitor-merge) resumed after preemption must
        // still bow out if a takeover superseded this host. Multi-host only; null
        // → dispatchTicket drops the key (single-host / no persisted claim no-op).
        const clusterGeneration = multiHost ? readClusterGeneration(orchDir, pd.identifier) : null;
        const dv = dispatchAndVerify(orchDir, pd.identifier, parkedPhase, {
          dispatch,
          resumeSession,
          clusterGeneration,
          requestedReason: "resume-after-preemption",
          fullFailureLadder: false,
          preDispatch: () => {
            // Reset the signal to "stalled" so phase-agent-dispatch's idempotency
            // guard does not block re-dispatch (mirrors defaultReviveDispatch).
            const signalPath = join(orchDir, "workers", pd.identifier, `phase-${parkedPhase}.json`);
            try {
              const tmp = `${signalPath}.tmp.${process.pid}`;
              writeFileSync(
                tmp,
                JSON.stringify({
                  ...(signalRaw ?? {}),
                  status: "stalled",
                  attentionReason: "resume-after-preemption",
                  updatedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
                })
              );
              renameSync(tmp, signalPath);
            } catch (err) {
              log.warn(
                { ticket: pd.identifier, phase: parkedPhase, err: err.message },
                "scheduler: resume signal reset failed"
              );
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
            {
              orchId: pd.identifier,
              ticket: pd.identifier,
              phase: parkedPhase,
              resumeSession: resumeSession ?? null,
            },
            { ticket: pd.identifier, phase: parkedPhase }
          );
          if (fenceGuard({ ticket: pd.identifier, orchDir, multiHost, gateway, self })) {
            safeWrite(
              () => {
                // CTL-757: audit the resume-after-preemption status write.
                const wr = writeStatus.applyPhaseStatus({
                  ticket: pd.identifier,
                  phase: parkedPhase,
                  cache,
                });
                emitStateWrite({
                  writerResult: wr,
                  ticket: pd.identifier,
                  phase: parkedPhase,
                  source: "preemption-resume",
                  orchId: pd.identifier,
                });
                // CTL-764 Phase 5: emit worker.transition for resume stage change.
                recordTransition({
                  ticket: pd.identifier,
                  toStage: parkedPhase,
                  fromStage: wr?.from_state ?? null,
                  source: "preemption-resume",
                });
              },
              { ticket: pd.identifier, phase: parkedPhase }
            );
          } else {
            log.warn(
              { ticket: pd.identifier },
              "ctl-863: stale fence — suppressing preemption-resume applyPhaseStatus write (zombie guard)"
            );
          }
          resumeSlots--;
          resumedCount++;
        }
      }
    }
  }

  tick?.lap("advancement");

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
  // CTL-1366: read-replica freshness gauge (catalyst.linear.replica.staleness).
  // Metric-threshold alerting is owned by Grafana (OTL-36), not the daemon — no
  // in-code alert here. NO-OP when the replica tier is off (default install —
  // `replica` undefined) and fully fail-open (never throws out of the tick).
  // Same log-line-only signaltometrics path as cache.stats above.
  maybeEmitReplicaFreshness({ replica, now, env });
  // CTL-925 Gap 1: a ring among ELIGIBLE tickets (not yet triaged-waiting) lands
  // all members in `blocked`, none in `ready` — computeReadyTickets would
  // silently skip them. Surface the anomalies here and escalate each cycle
  // member to needs-human (labelOnce, apply-once), mirroring STEP A.5.
  // Pure computeReadyTickets stays unchanged.
  const eligibleGraph = analyzeDependencyGraph(eligible, { blockerStates });
  if (eligibleGraph.anomalies.length > 0) {
    const eligibleIds = new Set(eligible.map((t) => t.identifier).filter(Boolean));
    for (const anomaly of eligibleGraph.anomalies) {
      for (const member of anomaly.members) {
        if (eligibleIds.has(member)) {
          log.warn(
            { member, members: anomaly.members },
            "ctl-925 sweep-2: eligible ticket in dependency cycle → needs-human"
          );
          // CTL-863 fence: external Linear write — a zombie host that lost its
          // claim must not label after takeover (mirrors the A.5 cycle site).
          if (fenceGuard({ ticket: member, orchDir, multiHost, gateway, self })) {
            const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, member, writeStatus, {
              env,
              site: "ctl-925-cycle",
              log,
            });
            // CTL-764 finding 8: emit only on an actual label write (a persisted
            // marker after restart / belief-owner deferral is not a fresh escalation).
            if (wrote) {
              recordTransition({
                ticket: member,
                toDisposition: "needs-human",
                source: "ctl-925-cycle",
              });
            }
          }
        }
      }
    }
  }
  // CTL-850/CTL-1057: HRW ownership filter — keep only the tickets THIS host owns
  // under the cluster roster so freeSlots + per-project caps compute over owned
  // work only. Applied to `ready` (NOT the raw `eligible`, whose `eligibleIds`
  // drives the phantom-quarantine sweep above — narrowing that would mis-quarantine
  // a sibling host's worker dirs). Single-host (multiHost===false) is a TRUE no-op
  // regardless of whether the lone roster entry string-matches the resolved
  // hostName (stale/aliased hosts.json). HRW filtering engages only when a 2nd
  // host actually joins (roster.length > 1).
  const ready = computeReadyTickets(eligible, { blockerStates }).filter(
    // CTL-1091: hash ownership over the LIVE (surviving) roster, not the raw
    // roster, so an offline owner's slice fails over to a live host.
    (t) => !multiHost || ownedBy(t.identifier, _dispatchRoster(), self)
  );
  // CTL-657: the in-flight count is the live `background` claude-agents count,
  // not listInFlightTickets(orchDir).size. A worker that leaked (signal terminal
  // but process alive) still consumes a slot; a duplicate spawn is counted.
  // CTL-705: reuse the tick-hoisted liveCount (a single `claude agents --json`
  // read) instead of re-shelling-out — `claude stop` does not deregister within
  // the same tick, so the count is stable since sweep 0.5.
  const inFlightCount = occupiedCount; // CTL-1331: + queued delegate slot reservations
  // CTL-1367 P2 (item b): re-sample SDK occupancy AFTER the advancement (sweep 1) +
  // resume (sweep 1.5) sweeps so the new-work budget below reflects SAME-TICK SDK
  // dispatches. The tick-top `sdkInflight` sample (folded into occupiedCount /
  // inFlightCount above) predates those sweeps; under executor=sdk each advance/resume
  // writes a fresh `dispatched` nested signal (no bg_job_id) synchronously in its
  // prelaunch (dispatch.mjs settleDispatchSync), so without this re-sample a non-research
  // advance (e.g. research→plan) PLUS a new-work pull could BOTH fire in one tick at
  // maxParallel=1 — a 2nd SDK signal beyond parallelism for one tick. The predecessor
  // teardown via emitPredecessorReap is async, so the just-finished predecessor signal is
  // still on disk this tick — but it is terminal (done/skipped) and countSdkInflight only
  // counts dispatched|running, so the re-sample is never inflated by it. CTL-1457 (T2):
  // gate on isInProcessDispatchMode so codex-exec re-samples its no-bg occupancy the same
  // way sdk does; the bg/oneshot-legacy path never recomputes (sdkInFlightCount stays
  // === inFlightCount) and keeps the byte-identical freeSlots formula below. CTL-1457
  // (N1): also re-sample when a per-phase in-process route is armed on a bg node.
  let sdkInFlightCount = inFlightCount;
  if (isInProcessDispatchMode(dispatchMode) || hasInProcessRoute) {
    let resampledSdkInflight = sdkInflight;
    try {
      resampledSdkInflight = countSdkInflight(orchDir);
    } catch {
      /* best-effort — never block the tick on a signal-scan failure (mirrors tick-top) */
    }
    sdkInFlightCount = liveCount + queuedDelegates + resampledSdkInflight;
  }
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
  // CTL-1095: drain gate — refuse all new-work admission while draining.
  const draining = isDraining();
  // CTL-755: also subtract promotedCount — the triage→research promotions STEP B
  // dispatched this tick took slots that liveCount (read before STEP B) does not
  // yet reflect, so without this term sweep 2 over-admits into them (the same
  // double-fill class CTL-705's resumedCount term fixed; one symmetric extra term).
  // CTL-768 (verify remediation): do NOT subtract heldStopCount here. resumedCount
  // and promotedCount correct for NEW same-tick spawns NOT yet in liveCount — a
  // subtract is right. A held-stop is a KILL that is STILL in liveCount this tick
  // (`claude stop` does not deregister within the same tick — scheduler.mjs:2525-2527),
  // so computeFreeSlots(maxParallel, inFlightCount) already withholds its slot;
  // subtracting heldStopCount removed that slot a SECOND time, over-suppressing
  // genuinely-free capacity at maxParallel>=2 (a transient single-tick throughput
  // loss; the slot frees naturally next tick via getAgentsCached deregistration).
  const freeSlots =
    livenessFresh && !draining
      ? // CTL-1457 (N1): the in-process budget formula also applies when a per-phase
        // route arms in-process occupancy on a bg node (hasInProcessRoute).
        isInProcessDispatchMode(dispatchMode) || hasInProcessRoute
        ? // CTL-1367 P2 (item b): under executor=sdk take the MIN of two budgets so
          // whichever formula correctly accounts for the slot the other missed wins:
          //  (1) the re-sampled SDK count (sdkInFlightCount) — catches same-tick
          //      NON-research advances (research→plan, …) that wrote a `dispatched`
          //      signal but that promotedCount (triage→research only) never tracks;
          //  (2) the original tick-top budget minus resumedCount/promotedCount —
          //      catches a CLAIM-ONLY promotion success (Codex P2): when a
          //      triage→research SDK promotion LOSES the single-flight race,
          //      verifyDispatchedSignal still counts it (promotedCount++) but the
          //      WINNER writes the phase signal, so countSdkInflight (hence the
          //      re-sample) cannot see it. Without this floor sdkInFlightCount stays
          //      0 and a new ticket is admitted while the winner takes the slot.
          // min is conservative (never over-admits) and never double-subtracts — it
          // picks ONE budget, not their sum. Math.max(0,…) clamps.
          Math.max(
            0,
            Math.min(
              computeFreeSlots(maxParallel, sdkInFlightCount),
              computeFreeSlots(maxParallel, inFlightCount) - resumedCount - promotedCount
            )
          )
        : Math.max(0, computeFreeSlots(maxParallel, inFlightCount) - resumedCount - promotedCount)
      : 0;
  if (!livenessFresh) {
    log.warn(
      { maxParallel, inFlightCount, resumedCount, promotedCount, heldStopCount },
      "scheduler: liveness snapshot stale/cold — holding new-work dispatch (CTL-731)"
    );
  }
  if (draining) {
    log.info({ inFlightCount }, "scheduler: node draining — holding new-work dispatch (CTL-1095)");
  }
  // CTL-1095: drained sentinel. Once draining and nothing in flight, emit
  // node.drain.drained exactly once per episode via a marker file. Clears
  // the marker when drain turns off so a subsequent episode re-arms.
  const drainedMarker = getDrainedMarkerPath(orchDir);
  if (draining) {
    if (listInFlightTickets(orchDir).size === 0 && !existsSync(drainedMarker)) {
      emitDrained();
      try {
        writeFileSync(drainedMarker, "");
      } catch {
        /* best-effort */
      }
      log.info({}, "scheduler: node drained — all in-flight work landed (CTL-1095)");
    }
  } else if (existsSync(drainedMarker)) {
    try {
      rmSync(drainedMarker, { force: true });
    } catch {
      /* best-effort */
    }
  }
  // CTL-1150: resolve injectable seams before Pass 2 selection + dispatch loop.
  // _hasTriageArtifact: default reads filesystem (mirroring monitor.mjs:667-669).
  //   Kept inline (not imported from monitor.mjs) to avoid coupling two daemons.
  //   Tests inject `() => true` to bypass when the subject is not the triage gate.
  // _listStartedTickets: default is the real dir-scan. Tests seeding triage.json
  //   (which creates workers/<ticket>/) inject `() => new Set()` to prevent the
  //   seeded ticket from being excluded by dir-existence before the guard fires.
  const _hasTriageArtifact =
    hasTriageArtifact ?? ((dir, ticket) => existsSync(join(dir, "workers", ticket, "triage.json")));
  const _listStartedTickets = listStartedTicketsOpt ?? listStartedTickets;

  // CTL-706: per-project caps + reserves gate selection AFTER ranking. With
  // no perProject config this is byte-for-byte selectDispatchable.
  // inFlightTickets was already computed above for the reclaim sweep.
  const selected = selectDispatchablePerProject(ready, _listStartedTickets(orchDir), freeSlots, {
    perProject: concurrency?.perProject,
    inFlight: inFlightTickets,
  });
  // CTL-706: per-project slot-usage gauge (dashboarding). log-line-only,
  // matching the cache.stats() per-tick metric convention.
  if (concurrency?.perProject && Object.keys(concurrency.perProject).length > 0) {
    log.info(
      buildPerProjectGauge(inFlightTickets, concurrency.perProject, freeSlots),
      "scheduler: per-project slots"
    );
  }

  const dispatched = [];
  for (const t of selected) {
    // CTL-1150: hold an eligible candidate whose triage hasn't produced
    // triage.json yet. The monitor defers triage under slot pressure
    // (computeTriageBudget, CTL-716) and sweepMissingTriage retries; until then
    // dispatching research trips phase-agent-dispatch's prior-artifact guard
    // (research requires signal:triage.json) and emits spurious
    // phase.research.failed + phase.dispatch.failed. Silent hold — no cooldown
    // marker, no failure event — mirroring the CTL-781 assignee-unreadable hold.
    // The candidate stays in the eligible set and dispatches next tick once
    // triage.json lands.
    if (!_hasTriageArtifact(orchDir, t.identifier)) {
      log.debug(
        { ticket: t.identifier },
        "ctl-1150: new-work candidate not yet triaged (no triage.json) — holding"
      );
      continue;
    }
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
        // CTL-925 Gap 3: guard each sequencing write against closing a cycle.
        // Build seqEdges from the candidate's relations (always available) plus
        // any in-flight descriptor in the cache (best-effort transitive coverage).
        // Raw edge extraction — no inSet filter, so candidate→in-flight edges
        // survive even when the in-flight ticket is not in the eligible pool.
        const seqRaw = [];
        const addRawBlocks = (issue) => {
          const self = issue?.identifier;
          if (!self) return;
          for (const node of issue?.relations?.nodes ?? []) {
            const peer = node?.relatedIssue?.identifier;
            if (node?.type === "blocks" && peer) seqRaw.push({ from: self, to: peer });
          }
        };
        addRawBlocks(t);
        for (const ifId of inFlightTickets) {
          const d = cache?.get?.(ifId) ?? null;
          if (d) addRawBlocks({ identifier: ifId, ...d });
        }
        for (const dep of validDeps) {
          if (wouldCreateCycle(seqRaw, dep.blocked_by, dep.candidate)) {
            log.warn(
              { candidate: dep.candidate, blockedBy: dep.blocked_by },
              "ctl-925 sequencing: skipping hard_dependency that would close a cycle"
            );
            continue;
          }
          if (fenceGuard({ ticket: dep.candidate, orchDir, multiHost, gateway, self })) {
            safeWrite(
              () =>
                writeStatus.applyBlockedByRelation({
                  ticket: dep.candidate,
                  blockedBy: dep.blocked_by,
                }),
              { ticket: dep.candidate, phase: "sequencing" }
            );
          } else {
            log.warn(
              { ticket: dep.candidate },
              "ctl-863: stale fence — suppressing applyBlockedByRelation(sequencing) write (zombie guard)"
            );
          }
        }
        continue; // hold — D5 enforces the new edge next tick
      }
      if (verdict?.verdict === "hold") continue; // soft conflict — no cooldown marker
      // "go" → fall through to existing dispatch
    }
    // CTL-671: circuit breaker — stop re-dispatching a new-work ticket that has
    // failed its entry-phase dispatch THRESHOLD times in a row.
    if (maybeTripCircuitBreaker(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE)) continue;
    // CTL-781/CTL-1174: respect-assignment + delegate gate.
    // Claim only when assignee ∈ {null,bot} AND delegate ∈ {null,bot}.
    // Gateway-first (rate-free); live read on a miss. An unreadable
    // assignee or delegate HOLDS the candidate this tick (fail-safe) — no
    // cooldown marker, no failure event. Empty/absent botUserIds disables
    // the gate (CTL-749 fail-open convention).
    if (botUserIds instanceof Set && botUserIds.size > 0) {
      const a = fetchAssignee(t.identifier, { gateway, exec, replica });
      if (!a.known) {
        log.debug(
          { ticket: t.identifier },
          "ctl-1174: delegate unreadable — holding candidate this tick"
        );
        continue;
      }
      if (a.delegate == null) {
        // CTL-1174 delegate-on-Todo: claim by delegating to the orchestrator now
        // (assignee is irrelevant); HOLD this tick — dispatches once the
        // delegate lands in the cache (webhook-projected). Best-effort.
        safeWrite(() => writeStatus.applyAssignee?.({ ticket: t.identifier, userId: botWriteId }), {
          ticket: t.identifier,
          phase: "delegate-on-todo",
        });
        log.debug(
          { ticket: t.identifier },
          "ctl-1174: undelegated — delegated to orchestrator, holding this tick"
        );
        continue;
      }
      if (!isClaimable(a.assignee, a.delegate, botUserIds)) {
        log.debug(
          { ticket: t.identifier, delegate: a.delegate },
          "ctl-1174: delegated to another actor — skipping"
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
    let clusterGeneration = null; // CTL-864: forwarded only when a multi-host claim is won
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
      clusterGeneration = claim.generation; // CTL-864: the fencing token for this worker
    }
    // CTL-826: shared dispatch→verify core (requested-emit "new-work", dispatch,
    // verify, success cooldown-clear + launched-emit, full failure ladder). The
    // new-work-specific success follow-ups stay here. Pass 2's original rc!=0 log
    // omits the phase field (failLogIncludePhase:false) to stay byte-identical.
    // CTL-864: forward the won cross-host fence token through the shared helper
    // into the worker's CATALYST_CLUSTER_GENERATION env (null on single-host →
    // dispatchTicket drops the key → exact no-op).
    const dv = dispatchAndVerify(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, {
      dispatch,
      clusterGeneration,
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
      // CTL-864 remediation: persist the won cross-host fence token now that the
      // worker dir provably exists (dispatchAndVerify's verify passed). The
      // advancement + revive sweeps re-inject it into later guarded phases. No-op
      // on single-host (clusterGeneration === null → writeClusterGeneration skips).
      writeClusterGeneration(orchDir, t.identifier, clusterGeneration);
      // CTL-863: emit the authoritative fence.claimed event (Linear-free local
      // append) so the broker projects this claim into ticket_state's fence
      // columns — the durable, event-log-derived source the fence guard reads.
      // Multi-host only (clusterGeneration non-null); single-host never fences.
      if (clusterGeneration != null) {
        emitFenceClaimed({
          ticket: t.identifier,
          owner_host: self,
          generation: clusterGeneration,
          phase: NEW_WORK_ENTRY_PHASE,
        });
      }
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
          emitStateWrite({
            writerResult: wr,
            ticket: t.identifier,
            phase: NEW_WORK_ENTRY_PHASE,
            source: "scheduler-advance",
            orchId: t.identifier,
          });
          // CTL-764 Phase 5: emit worker.transition for new-work entry-phase.
          recordTransition({
            ticket: t.identifier,
            toStage: NEW_WORK_ENTRY_PHASE,
            fromStage: wr?.from_state ?? null,
            source: "scheduler-advance",
          });
        },
        { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE }
      );
      // CTL-781 + CTL-1011: self-assign the Catalyst bot. Always invoked so a
      // null botWriteId surfaces the deduped config-missing warn instead of a
      // silent skip. Best-effort (safeWrite) — never blocks the pipeline.
      safeWrite(() => writeStatus.applyAssignee?.({ ticket: t.identifier, userId: botWriteId }), {
        ticket: t.identifier,
        phase: "assignment",
      });
      // CTL-1481: best-effort worker:<host> label stamp — a visibility
      // projection of the claim we just won, NEVER the claim arbiter itself.
      // Multi-host only (same gate as emitFenceClaimed). Placed AFTER the
      // applyPhaseStatus/applyAssignee writes so a stamp-tripped breaker can
      // never starve the Axis-1 status write within the same tick. Own
      // try/catch (mirrors convergeHeldLabel's applyLabel catch shape) so a
      // throw only logs and never unwinds the dispatch success path.
      if (clusterGeneration != null) {
        try {
          stampWorkerLabel({
            ticket: t.identifier,
            hostName: self,
            knownHosts: roster,
            replica,
            applyLabel: writeStatus.applyLabel,
            removeLabel: writeStatus.removeLabel,
            log,
          });
        } catch (err) {
          log.warn(
            { ticket: t.identifier, err: err.message },
            "scheduler: stampWorkerLabel threw — continuing tick"
          );
        }
      }
    }
  }

  tick?.lap("new-work-pull");

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
  // CTL-1079: serve removeLabel's read-before-mutate from the broker projection so
  // the retraction sweep stops spending live Linear API read budget. The live read
  // (readTicketLabels) remains the fallback on any cache miss. Staleness is
  // fail-safe: removeLabel is idempotent on an already-absent label. When no gateway
  // is injected the bare writeStatus is used unchanged (back-compat).
  const retractionWriteStatus = gateway
    ? {
        ...writeStatus,
        removeLabel: (t, l, opts = {}) =>
          writeStatus.removeLabel(t, l, {
            ...opts,
            readLabels:
              opts.readLabels ??
              ((tk, ro = {}) => gatewayLabelsHit(gateway, tk) ?? readTicketLabels(tk, ro)),
          }),
      }
    : writeStatus;

  for (const ticket of _listStartedTickets(orchDir)) {
    const signals = readPhaseSignals(orchDir, ticket);
    // CTL-703: the terminal phase is now `teardown` (not `monitor-deploy`) —
    // read via the descriptor's TERMINAL_PHASE so a future pipeline change
    // can't silently bypass this sweep (redispatch research F2).
    // When the terminal phase completes, the pipeline is done — write Linear Done.
    // CTL-597: once-marker guards the per-tick Linear read (was safeWrite-only).
    // CTL-757: thread emitStateWrite so the terminal Done write is audited.
    if (signals[TERMINAL_PHASE] === "done") {
      // CTL-863: thread multiHost so terminalDoneOnce's internal fence guard
      // suppresses a post-takeover zombie's terminal Done write on a multi-host
      // cluster (no-op single-host: multiHost=false → guard always passes).
      const doneResult = terminalDoneOnce(orchDir, ticket, writeStatus, emitStateWrite, {
        multiHost,
        gateway,
        self,
        checkOpenPrs,
        emitDoneWithOpenPr,
        emitDoneApplied,
      });
      // CTL-764 finding 7: emit the terminal Done stage transition on a REAL Done
      // write — independent of the needs-human clear below (a normally-completed
      // ticket has no needs-human marker, so the onRemoved hook never fires). Gated
      // on the actual write so a per-tick re-visit of an already-Done dir emits once.
      if (doneResult?.realDoneWrite) {
        recordTransition({
          ticket,
          toStage: "done",
          fromStage: doneResult.from_state,
          source: "terminal-done",
        });
      }
      // CTL-646: terminal Done unconditionally clears needs-human (belt + teardown path).
      // CTL-703: worktree teardown is now the `teardown` FSM phase (teardownWorktreeOnce
      // removed) — only the label clear remains inline here.
      clearStalledLabel(orchDir, ticket, "needs-human", retractionWriteStatus, {
        onRemoved: () => {
          // CTL-764 Phase 5: emit worker.transition for needs-human clear on Done.
          recordTransition({
            ticket,
            fromDisposition: "needs-human",
            toDisposition: null,
            source: "terminal-done-clear",
          });
        },
      });
    }
    // CTL-758: reconcile backstop — re-Done a merged ticket whose Linear state
    // drifted back to non-terminal (a late echo). Gated by the .terminal-done.applied
    // marker + merged PR + non-terminal live state, so it is a no-op in the common
    // case and inert without a prAdapter.
    reconcileTerminalBackstop(
      orchDir,
      ticket,
      signalByTicket.get(ticket),
      writeStatus,
      emitStateWrite,
      {
        cache,
        prAdapter,
        // CTL-1437 (A4 follow-up): the terminal-Done sweep runs EVERY tick per started
        // ticket; probeBackoff backs off a replica-MISS ticket whose live terminal read
        // fails so it isn't re-probed every tick (the CTL-1329 ~2x/sec flap driver).
        fetchState: (id, o = {}) =>
          fetchTicketState(id, { ...o, gateway, replica, probeBackoff: true }),
        multiHost,
        gateway,
        self,
      }
    );
    const anyStalled = Object.values(signals).some((s) => s === "stalled");
    const anyFailed = Object.values(signals).some((s) => s === "failed");
    // CTL-1180: pipeline-done already clears needs-human in the TERMINAL_PHASE block
    // above; never (re)apply for a genuinely-shipped ticket (the Done false positive).
    const pipelineDone = signals[TERMINAL_PHASE] === "done";
    if ((anyStalled || anyFailed) && !pipelineDone) {
      // CTL-1329: a stale-fenced worker dir (its claimed generation is missing or no
      // longer current on a multi-host cluster) re-runs this whole block every tick —
      // the cheap-first terminal probe is a Linear `issues read`, and fenceGuard below
      // spawns a fence-check — yet the needs-human write is always suppressed, so the
      // work is pure waste. In the 2026-06-23 incident five leftover ADV dirs looped
      // ~2x/sec, draining the daemon's OAuth bucket until the CTL-679 breaker froze
      // dispatch fleet-wide. After a fence-suppression we stamp a cooldown and skip the
      // probe+write block for a window, bounding the burn to once-per-cooldown. The
      // fence itself is still checked at the original site (immediately before the
      // write, below) — NOT reordered — so a takeover mid-probe is still caught and no
      // fence-check runs before we've proven a write is needed.
      if (isFenceSuppressFresh(orchDir, ticket, now())) {
        // Still surface the orphan once for the dashboard (the probe/write is what we
        // skip, not the visibility signal).
        emitOrphanDetectedOnce(orchDir, ticket, signals, appendOrphanDetectedEvent);
      } else {
        // CTL-1242: a merged/terminal-Linear ticket that skipped teardown must NOT be
        // re-flagged needs-human. Cheap-first terminal probe (cached Linear read, then
        // optional gh PR view) runs ONLY on this narrow stalled/failed-not-done set, so
        // the steady-state-zero-writes invariant holds.
        const term = isTicketTerminalOrMerged({
          ticket,
          signal: signalByTicket.get(ticket),
          // CTL-1437 (A4 follow-up): the cheap-first terminal probe on the stalled/failed
          // set runs EVERY tick — CTL-1329's documented ~2x/sec `issues read` burn. probeBackoff
          // backs a replica-MISS ticket off (5-min negTTL) after a failed live read instead of
          // re-probing every tick, so the CTL-679 breaker stops flapping on it.
          fetchState: (id, o = {}) =>
            fetchTicketState(id, { ...o, cache, gateway, replica, probeBackoff: true }),
          cache,
          prAdapter,
        });
        if (term.terminal) {
          // Terminal/merged but teardown never ran → clear the marker+label instead of
          // re-applying. Marker-guarded so a no-marker terminal ticket fires zero API calls.
          const base = join(orchDir, "workers", ticket, ".linear-label-needs-human");
          if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) {
            clearStalledLabel(orchDir, ticket, "needs-human", retractionWriteStatus, {
              onRemoved: () => {
                // CTL-764 Phase 5: emit worker.transition for needs-human clear on terminal.
                recordTransition({
                  ticket,
                  fromDisposition: "needs-human",
                  toDisposition: null,
                  source: "terminal-sweep-clear",
                });
              },
            });
          }
          // CTL-1242 (corrected scope): also forget the host-local recovery-intent
          // latch so a finished ticket's escalated/cooldown ledger entry doesn't
          // linger (hygiene — the recovery router already drops terminal tickets).
          recoveryForgetIntent(ticket, { orchDir });
        } else {
          // Non-terminal stalled/failed ticket → apply the belief-aware needs-human
          // label (CTL-1241: skipped when the belief engine owns the reclaim).
          if (fenceGuard({ ticket, orchDir, multiHost, gateway, self })) {
            const wrote = labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, writeStatus, {
              env,
              site: "terminal-sweep",
              log,
            });
            // CTL-764 finding 8: emit worker.transition ONLY when the label write
            // actually occurred. A persisted .linear-label-needs-human marker after a
            // daemon restart (labelOnce no-ops) or a belief-owner deferral changes no
            // label — recording a fresh needs-human transition there is a false escalation.
            if (wrote) {
              recordTransition({ ticket, toDisposition: "needs-human", source: "terminal-sweep" });
            }
          } else {
            log.warn(
              { ticket },
              "ctl-863: stale fence — suppressing labelOnce(needs-human/failed-or-stalled) write (zombie guard)"
            );
            // CTL-1329: arm the cooldown so the next ticks skip this dir's probe+fence
            // instead of re-burning Linear quota every tick until the dir is reaped.
            stampFenceSuppress(orchDir, ticket, now());
          }
          // CTL-868 route (B): emit a canonical orphan-detected event (once) so a
          // non-terminal stalled/failed-no-recovery ticket is visible on the dashboard
          // (runs regardless of fence, matching main; the terminal branch above is
          // excluded so a finished ticket is never re-surfaced as an orphan).
          emitOrphanDetectedOnce(orchDir, ticket, signals, appendOrphanDetectedEvent);
        }
      }
    } else {
      // No failed/stalled phase (or pipeline done) → clear the ratchet if the marker exists.
      // Guard on marker presence so a no-stall/no-fail, no-marker tick fires zero
      // removeLabel API calls (steady-state-zero-writes invariant).
      const base = join(orchDir, "workers", ticket, ".linear-label-needs-human");
      if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) {
        clearStalledLabel(orchDir, ticket, "needs-human", retractionWriteStatus, {
          onRemoved: () => {
            // CTL-764 Phase 5: emit worker.transition for needs-human clear.
            recordTransition({
              ticket,
              fromDisposition: "needs-human",
              toDisposition: null,
              source: "no-stall-clear",
            });
          },
        });
      }
    }
    // CTL-1068 — retract orphaned held labels for STARTED (admitted) tickets. The
    // admission A.7 loop only converges the pre-pickup pool; a ticket that was picked
    // up and then failed wearing blocked/waiting is never revisited there, so its label
    // lingers and WHAT'S WAITING shows a dead row forever. Gate on the pre-pickup
    // predicate (A.1, scheduler.mjs:3113-3115) so we NEVER fight A.7 over a ticket it
    // still owns. desired=null: a started ticket has no legitimate hold.
    const isPrePickup =
      signals.triage === "done" &&
      !("research" in signals) &&
      !Object.values(signals).some((v) => v === PREEMPTED_STATUS);
    if (!isPrePickup) {
      convergeStartedHeldLabels(orchDir, ticket, retractionWriteStatus, {
        desired: null,
        multiHost,
        gateway,
        self,
        emitStateWrite,
        onRetract: () => lastHeldEmitState.delete(ticket),
      });
    }
    // CTL-764 finding 5: converge the durable needs-input disposition label for a
    // parked worker. convergeDispositionLabel is the sole applier/remover of the
    // needs-input label — without this a needs-input park changes only the local
    // signal and the Linear label never lands. Current labels come from the CTL-1079
    // broker projection (the same cheap read the retraction sweep uses), so steady
    // state is zero-write and needs-human precedence is honored inside the converger;
    // a projection miss skips this tick rather than blind-applying (no write storm).
    // The genuine needs-input→cleared emission is owned by the daemon comment-wake
    // path (finding 11); here we keep the only-on-change map honest so a later re-park
    // re-emits.
    if (Object.values(signals).some((s) => s === "needs-input")) {
      const hit = gatewayLabelsHit(gateway, ticket);
      if (hit && fenceGuard({ ticket, orchDir, multiHost, gateway, self })) {
        const writes = convergeDispositionLabel(
          ticket,
          hit.labels,
          HELD_LABEL_NEEDS_INPUT,
          retractionWriteStatus,
          { orchDir, now }
        );
        if (writes > 0) {
          recordTransition({
            ticket,
            toDisposition: HELD_LABEL_NEEDS_INPUT,
            source: "needs-input-park",
          });
        }
      }
    } else if (lastDispositionEmit.get(ticket) === HELD_LABEL_NEEDS_INPUT) {
      // Daemon comment-wake cleared the label out-of-band; reset the dedup (no emit —
      // finding 11 already recorded the clear) so a future re-park re-emits.
      lastDispositionEmit.set(ticket, null);
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

  tick?.lap("terminal-sweep");

  // (4) Cooldown GC sweep (CTL-713) — reap expired markers for tickets that
  // have left the eligible set so .dispatch-cooldowns/ self-cleans instead of
  // accumulating orphans. Runs last: GC must not influence this tick's dispatch
  // decisions. `eligibleIds` is computed once at the top of the tick (CTL-671
  // phantom-sweep block) and is already in scope here.
  for (const { ticket, phase } of gcDispatchCooldowns(orchDir, eligibleIds, now())) {
    appendCooldownGcEvent({ ticket, orchId: ticket, target_phase: phase });
  }

  // CTL-1330 Tier 1: one structured line per tick. total_ms IS the synchronous
  // event-loop block; pass_durations attributes it; free_slots/liveness_fresh
  // expose whether new-work admission was held this tick (the wedge symptom).
  // Loki: {service_name="catalyst.execution-core"} | json | total_ms > 3000
  if (tick) {
    tick.lap("cooldown-gc");
    // CTL-1330: flat slowest-pass fields turn "which pass dominated this tick"
    // into a one-line Loki→Prometheus label (OTL-25 health dashboards) without
    // unwrapping the nested pass_durations map.
    let slowest_pass = null;
    let slowest_pass_ms = 0;
    for (const [name, ms] of Object.entries(tick.passes)) {
      if (ms > slowest_pass_ms) {
        slowest_pass_ms = ms;
        slowest_pass = name;
      }
    }
    // CTL-1337: ONE deterministic per-tick trace/span id, computed BEFORE logging so the
    // Tier-1 line below and the Tier-3 span below carry the SAME ids. orchestratorId is
    // the daemon's service identity; `self` is this node (already resolved once per tick).
    // Folding tick_id in means every tick is its own trace (no per-orchestrator collapse).
    const { traceId, spanId } = deriveTickTraceContext({
      orchestratorId: "catalyst.execution-core",
      tickId: tick.tickId,
      node: self,
      bootNonce: SCHEDULER_BOOT_NONCE, // CTL-1362: unique per (boot, tick) — tick_id resets each restart
    });
    log.info(
      {
        tick_id: tick.tickId,
        // CTL-1337: stamp the per-tick ids so Loki log→trace (filterByTraceID) resolves
        // the exact Tempo trace for THIS tick, and Tempo trace→logs lands on THIS line.
        trace_id: traceId,
        span_id: spanId,
        total_ms: tick.totalMs(),
        pass_durations: tick.passes,
        slowest_pass,
        slowest_pass_ms,
        free_slots: freeSlots,
        // CTL-1330: eligible_count lets the highest-severity alert require
        // "new-work held WITH work waiting" (held + eligible_count>0) — the exact
        // condition that masked the week-long wedge when the board was drained.
        eligible_count: eligible.length,
        liveness_fresh: livenessFresh,
        beliefs_shadow: process.env.CATALYST_BELIEFS_SHADOW === "1",
        // CTL-1365a: the dispatch-mode dimension. Dotted JSON key so Loki `| json`
        // + the OTEL signaltometrics leg both yield the frozen metric label
        // `catalyst_dispatch_mode` (dots→underscores) that the OTEL "Execution-model
        // A/B" dashboard splits `by (catalyst_dispatch_mode)`.
        "catalyst.dispatch.mode": dispatchMode,
      },
      "scheduler: tick timing (CTL-1330)"
    );

    // CTL-1330 Tier 3: post-hoc span tree for this tick (no-op unless
    // CATALYST_TRACING=on). Reconstructed from the recorded lap timings — zero
    // per-span work inside the synchronous hot loop. Root scheduler.tick + a
    // scheduler.pass child per pass over the slow threshold (the flame graph).
    // CTL-1337: seed the root span with the SAME per-tick trace_id/span_id stamped on
    // the log line above, so the span and the line share one id (trace↔logs round-trip).
    emitTickTrace({
      tickId: tick.tickId,
      traceId,
      spanId,
      startEpochMs: tick.startEpochMs,
      endEpochMs: tick.endEpochMs(),
      laps: tick.spanLaps,
      // CTL-1364: the scheduler.op grandchild tier. Threshold-gated (default 50ms,
      // env CATALYST_TRACING_OP_THRESHOLD_MS) inside emitTickTrace — a healthy tick
      // (all cache/gateway hits, no slow op) carries an empty spanOps → ZERO op spans.
      ops: tick.spanOps,
      attrs: {
        "catalyst.scheduler.total_ms": tick.totalMs(),
        "catalyst.scheduler.slowest_pass": slowest_pass,
        "catalyst.scheduler.slowest_pass_ms": slowest_pass_ms,
        "catalyst.scheduler.free_slots": freeSlots,
        "catalyst.scheduler.eligible_count": eligible.length,
        "catalyst.scheduler.liveness_fresh": livenessFresh,
        "catalyst.scheduler.beliefs_shadow": process.env.CATALYST_BELIEFS_SHADOW === "1",
      },
    });
  }

  return {
    reclaimed,
    revived,
    reviveSuppressed,
    noProgressStopped,
    escalated,
    quarantinedPhantoms, // CTL-671 — phantom worker dirs stalled this tick
    watchdogKilled, // CTL-729 — kill-attempts DISPATCHED this tick (enforce mode); not confirmed kills (see Pass 0w)
    watchdogWouldKill, // CTL-729 — workers that WOULD be killed (shadow mode)
    janitorReaped, // CTL-1004 — targeted orphan reap-requests EMITTED this tick (enforce)
    janitorWouldReap, // CTL-1004 — orphan worktrees that WOULD be reap-requested (shadow)
    janitorKillIntents, // CTL-1004 — ghost-session kill-intents RECORDED this tick (enforce)
    janitorWouldKill, // CTL-1004 — ghost sessions that WOULD get a kill-intent (shadow)
    janitorDeferred, // CTL-1004 — dirty worktrees deferred (no removal, no queue)
    janitorStallsCleared, // CTL-1005 — prior-artifact-retry-exhausted stalls CLEARED this tick (enforce)
    janitorWouldClear, // CTL-1005 — stalls that WOULD be cleared (shadow)
    janitorSignalsGcd, // CTL-1242 — terminal signal dirs GC'd this tick (enforce)
    janitorWouldGc, // CTL-1242 — signal dirs that WOULD be GC'd (shadow)
    unstuckActed, // CTL-1064 — Pass 0u actions taken this tick (enforce)
    unstuckWouldAct, // CTL-1064 — Pass 0u would-act (shadow)
    unstuckEscalated, // CTL-1064 — Pass 0u escalations this tick (enforce)
    unstuckWouldEscalate, // CTL-1064 — Pass 0u would-escalate (shadow)
    advanced,
    dispatched,
    freeSlots,
    // CTL-935 Phase 2: expose procedural inputs so runFreeSlotsShadow can
    // attribute the gap without re-reading scheduler internals.
    maxParallel,
    inFlightCount,
    livenessFresh,
    draining,
    // CTL-935 Phase 3: raw per-subject reclaim outcomes (before the lossy switch)
    // for the reclaim shadow comparator.
    reclaimOutcomes,
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
export const RUNAWAY_WINDOW_MS = Number(process.env.SCHEDULER_RUNAWAY_WINDOW_MS) || 10 * 60 * 1000;

// --- daemon module state ---
let tickTimer = null;
let debounceTimer = null;
let watcher = null;
let runningOpts = null;

// CTL-1330 Tier 1: process-wide event-loop delay histogram. Enabled by the
// daemon (startScheduler) when tick timing is on; null otherwise so direct
// schedulerTick callers (tests/CLI) never touch perf_hooks. Read+reset once per
// runTick so each line reports the lag accumulated since the previous tick —
// crucially the prior SYNCHRONOUS schedulerTick block, which libuv records only
// after control returns to the loop (i.e. after that tick returned).
let _eventLoopMonitor = null;

// emitEventLoopDelay — log p50/p99/max (ms) and reset. No-op until the daemon
// enables the monitor; skips the first, empty read (count 0). perf_hooks reports
// nanoseconds, so convert to ms for parity with the tick-timing line.
function emitEventLoopDelay() {
  const h = _eventLoopMonitor;
  if (!h) return;
  try {
    if (h.count === 0) return;
    const toMs = (ns) => Math.round((ns / 1e6) * 10) / 10;
    log.info(
      {
        event_loop_p50_ms: toMs(h.percentile(50)),
        event_loop_p99_ms: toMs(h.percentile(99)),
        event_loop_max_ms: toMs(h.max),
        samples: h.count,
      },
      "scheduler: event-loop delay (CTL-1330)"
    );
    h.reset();
  } catch (err) {
    // A runtime that constructed the monitor but can't read it (partial
    // perf_hooks support) — disable to avoid per-tick noise; tick-timing +
    // liveness lines are unaffected.
    log.warn(
      { err: err?.message },
      "scheduler: event-loop delay read failed — disabling (CTL-1330)"
    );
    try {
      h.disable?.();
    } catch {
      /* best-effort */
    }
    _eventLoopMonitor = null;
  }
}

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
// CTL-764 Phase 5: last-emitted disposition per ticket for the worker.transition
// only-on-change guard. Mirrors lastHeldEmitState but covers the full disposition set
// (null = no label / cleared). Cleared on daemon restart (via __resetForTests).
const lastDispositionEmit = new Map();

// CTL-1064: Pass 0u throttle — epoch-ms of the last unstuck-sweep run.
// Module-level so the 15-min gate persists across ticks without a db write.
// Reset to 0 on daemon restart (module reload) or via __resetForTests.
let _unstuckLastRunMs = 0;

// CTL-1324: Pass 0j heavy-census throttle — epoch-ms of the last run of the
// EXPENSIVE worktree censuses (J1 orphan / J3 stall-clear / J4 GC). Module-level
// so the 15-min gate persists across ticks without a db write. Reset to 0 on
// daemon restart (module reload) or via __resetForTests.
let _stallJanitorCensusLastRunMs = 0;

function runTick() {
  try {
    // CTL-1330 Tier 1: emit the event-loop delay accumulated since the previous
    // tick (which captures that tick's synchronous block) before doing this
    // tick's work, then reset. Cheap no-op when the monitor is disabled.
    emitEventLoopDelay();
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
          "scheduler: Layer-2 maxParallel overrides Layer-1 — autotune throttled below committed config (CTL-750)"
        );
      }
    } else {
      concurrency = runningOpts.concurrency;
    }
    // CTL-933: record this tick's liveness observations BEFORE the decisions run
    // (write-only shadow; own try/catch inside — never throws, never gates).
    // CTL-936: thread the event-log append seam so reconcileIntents can emit
    // intent.ineffective operator events when CATALYST_INTENTS_ENFORCE=1.
    const intentEventAppender =
      typeof runningOpts.appendIntentEvent === "function" ? runningOpts.appendIntentEvent : null;
    const beliefsRes = collectBeliefsTick({
      orchDir: runningOpts.orchDir,
      linearCache: runningOpts.cache,
      appendIntentEvent: intentEventAppender,
      // CTL-1063 remediate (verify high review collector.mjs:734): thread the
      // same event-log appender the adjacent executeEscalations/runAdvanceShadow
      // already receive, so the one-shot rules.version.changed boot event can
      // fire in the live daemon instead of staying dead behind a null appendEvent.
      appendEvent: intentEventAppender,
    });
    // CTL-937: bounded stall-diagnostician wake wiring (opt-in CATALYST_DIAGNOSTICIAN=1).
    // Reads wake_diagnostician beliefs for the current tick from the shared beliefs.db
    // handle (same connection — no second db open). Never throws. Only activates
    // when CATALYST_BELIEFS_SHADOW=1 (collector opened the db) AND
    // CATALYST_DIAGNOSTICIAN=1 (diagnostician gate).
    if (beliefsRes?.ok && beliefsRes?.tickId != null) {
      // CTL-1065: diagResult is populated by the diagnostician block below and
      // consumed by executeEscalations to enrich the escalation payload.
      let diagResult = null;

      try {
        const diagDb = getBeliefsDb();
        if (diagDb) {
          // CTL-962: the diagnostician supplies evidence only — it no longer
          // applies needs-human. The single label owner is executeEscalations
          // (beliefs/escalate.mjs), called immediately after, which pages off the
          // same R12 escalate_human beliefs exactly once.
          // CTL-1065: capture the result so escalated[].evidence can be threaded
          // into executeEscalations as evidenceBySubject.
          // CTL-1191: HRW-gate the diagnostician over the surviving roster — on a
          // multi-host cluster only the node that OWNS a stalled subject captures
          // evidence + escalates it, so two nodes don't double-page needs-human.
          // STRICT no-op at N=1: a single-host roster makes ownedBy an identity
          // (the lone host owns everything), so ownsSubject is always true.
          const diagRoster = getClusterHosts();
          const diagSelf = getHostName();
          const diagSurvivors =
            diagRoster.length > 1 ? computeSurvivingRoster(diagRoster) : diagRoster;
          const ownsSubject = (subject) =>
            diagRoster.length <= 1 ||
            ownedBy(String(subject).split("/")[0], diagSurvivors, diagSelf);
          diagResult = processDiagnosticianWakes(diagDb, beliefsRes.tickId, { ownsSubject });
        }
      } catch (diagErr) {
        try {
          log.warn(
            { err: diagErr?.message },
            "diagnostician: wake processing threw (tick unaffected)"
          );
        } catch {
          /* even logging must not break the tick */
        }
      }

      // CTL-962: escalate_human executor — the single owner of needs-human. Reads
      // R12 beliefs for this tick, pages once (label + escalate.human event) when
      // enforce is on, and flips the capped wake-diagnostician intent(s) to
      // 'escalated' so R11/R12 stop firing. Wrapped in its own guard, identical
      // to the diagnostician guard, so it never breaks the tick.
      try {
        const escDb = getBeliefsDb();
        if (escDb) {
          // CTL-1065: build evidenceBySubject from the diagnostician's escalated
          // subjects so the explanation payload carries real observed data.
          const evidenceBySubject = Object.fromEntries(
            (diagResult?.escalated ?? [])
              .filter((x) => x?.subject)
              .map((x) => [x.subject, x.evidence ?? {}])
          );
          executeEscalations(escDb, beliefsRes.tickId, {
            orchDir: runningOpts.orchDir,
            writeStatus: runningOpts.writeStatus,
            appendEvent: intentEventAppender,
            enforce: (process.env.CATALYST_INTENTS_ENFORCE ?? "0") === "1",
            env: process.env,
            evidenceBySubject,
          });
        }
      } catch (escErr) {
        try {
          log.warn({ err: escErr?.message }, "escalate: executor threw (tick unaffected)");
        } catch {
          /* even logging must not break the tick */
        }
      }

      // CTL-966 + CTL-935: advancement shadow comparator. For each in-flight
      // ticket compute the PROCEDURAL deriveAdvancement and compare it to the
      // DERIVE-ONLY advance_to / cycle_exhausted beliefs for this tick; log any
      // disagreement as a `beliefs.advance_shadow.disagree` operator event.
      // SHADOW ONLY — never dispatches, never writes a signal, never writes
      // Linear, never resets the cycle. Wrapped in its own guard so it can never
      // break the tick. Reads the SAME shared beliefs.db handle (no second open)
      // and the SAME procedural readers the advancement sweep below consumes.
      try {
        const advDb = getBeliefsDb();
        if (advDb) {
          runAdvanceShadow(advDb, beliefsRes.tickId, {
            orchDir: runningOpts.orchDir,
            listInFlight: (od) => listInFlightTickets(od),
            // CTL-1058: oracle inputs come from the tick-locked EDB snapshot (the SAME rows
            // the belief saw at collectBeliefsTick), not live disk — eliminates mid-tick
            // input-skew false disagreements. Disk seams remain test-override hooks.
            readSignals: (_od, ticket) => readSignalsFromEdb(advDb, beliefsRes.tickId, ticket),
            readVerdict: ({ ticket }) => readVerdictFromEdb(advDb, beliefsRes.tickId, ticket),
            countCycles: ({ ticket }) => readCycleFromEdb(advDb, beliefsRes.tickId, ticket),
            deriveAdvancement,
            cap: REMEDIATE_CYCLE_CAP,
            appendEvent: intentEventAppender,
            // Opt-in tick summary; off by default to keep the event log lean.
            emitTickSummary: (process.env.CATALYST_ADVANCE_SHADOW_SUMMARY ?? "0") === "1",
            // CTL-935: dual-write to beliefs.db so the weekly report has a
            // uniform durable corpus (event log stays the live operator feed).
            writeComparison: (rec) => recordShadowComparison(advDb, rec),
          });
        }
      } catch (advErr) {
        try {
          log.warn({ err: advErr?.message }, "advance-shadow: comparator threw (tick unaffected)");
        } catch {
          /* even logging must not break the tick */
        }
      }
    }
    // CTL-935 Phase 2: capture schedulerTick return so comparators can read
    // procedural values (freeSlots, maxParallel, inFlightCount, etc.) without
    // re-deriving them. The bare call is replaced by const tickResult = ...
    const tickResult = schedulerTick(runningOpts.orchDir, {
      readEligible: runningOpts.readEligible,
      dispatch: runningOpts.dispatch,
      dispatchMode: runningOpts.dispatchMode, // CTL-1365a: stamp the Tier-1 tick-timing line
      hasInProcessRoute: runningOpts.hasInProcessRoute, // CTL-1457 (N1): arm occupancy gates for a per-phase in-process route on a bg node
      exec: runningOpts.exec,
      writeStatus: runningOpts.writeStatus,
      cache: runningOpts.cache, // CTL-634: shared out-of-set blocker state cache
      gateway: runningOpts.gateway, // CTL-1240/823: enables tier-2 reads in reclaim + reasoning filter
      replica: runningOpts.replica, // CTL-1340: enables the flag-gated read-replica tier (undefined → inert)
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
        (runningOpts.liveBackgroundCount !== undefined
          ? () => true
          : () => getAgentsCached().isFresh),
      // CTL-537: production defaults to defaultCheckSequencing; tests inject via
      // startScheduler({ checkSequencing }) or directly into schedulerTick.
      checkSequencing: runningOpts.checkSequencing ?? defaultCheckSequencing,
      // CTL-755/784: admission-gate seams. Undefined here keeps schedulerTick's
      // production defaults (fetchTicketsBatch / defaultAppendPhaseAdvanceHeldEvent);
      // tests inject a stub through startScheduler so a daemon tick never shells out.
      fetchBatch: runningOpts.fetchBatch,
      appendPhaseAdvanceHeldEvent: runningOpts.appendPhaseAdvanceHeldEvent,
      // CTL-764 Phase 5: the LIVE worker.transition emitter (Sink-3, feeding OTLP
      // Sink-4 via otel-forward). schedulerTick defaults this to null, so a bare
      // unit tick stays silent; production MUST thread the real emitter here or
      // every recordTransition() early-returns and the two-axis model is dark in
      // prod (verify CTL764-VER-1). A test may inject its own via
      // startScheduler({ appendWorkerTransitionEvent }).
      appendWorkerTransitionEvent:
        runningOpts.appendWorkerTransitionEvent ?? defaultAppendWorkerTransitionEvent,
      // CTL-642/758: the LIVE PR-merged adapter. Without this the recovery
      // short-circuit's pr-merged branch (terminal-state.mjs) AND the reconcile
      // backstop (reconcileTerminalBackstop gate 2) are BOTH inert in production —
      // schedulerTick's `prAdapter` default is undefined. Built ONCE at boot
      // (startScheduler → runningOpts.prAdapter) so we don't re-wire gh every tick.
      // A test may inject its own via startScheduler({ prAdapter }); production
      // gets the real makePrView-backed adapter.
      prAdapter: runningOpts.prAdapter,
      // CTL-1157 (ALARM-NOT-BLOCK): arm the real open-PR ENUMERATOR in production so
      // the terminal sweep can fire the recovery.done-applied-with-open-pr alarm when
      // it lands a Done while a PR is still open (it no longer refuses the write). A
      // test may inject its own via startScheduler({ checkOpenPrs }); a bare unit tick
      // (no runningOpts override) gets schedulerTick's permissive no-op default.
      checkOpenPrs: runningOpts.checkOpenPrs ?? defaultCheckOpenPrs,
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
      // CTL-936: thread the beliefs db handle so intentAwareKill can record /
      // suppress kill-storm retries. getBeliefsDb() returns null when
      // CATALYST_BELIEFS_SHADOW=0 (collector never opened it) — intentAwareKill
      // falls back to plain killBgJob in that case, preserving legacy behaviour.
      intentDb: getBeliefsDb(),
      // CTL-1004: wire the read-only stall-janitor census so the daemon exercises
      // Pass 0j (SHADOW by default). The census producers are closures over the
      // warm agents snapshot + project registry + the orchDir's in-flight set, so
      // a single tick re-reads them lazily (the pass only invokes them when the
      // resolved mode is not "off"). Mode/emit/intent default inside schedulerTick.
      stallJanitor: runningOpts.stallJanitor ?? {
        collectOrphanCandidates: () =>
          defaultCollectOrphanCandidates({
            orchDir: runningOpts.orchDir,
            projects: listProjects(),
            agents: getAgentsCached().agents,
            inFlightTickets: listInFlightTickets(runningOpts.orchDir),
          }),
        collectGhostCandidates: () =>
          defaultCollectGhostCandidates({
            orchDir: runningOpts.orchDir,
            agents: getAgentsCached().agents,
          }),
        // CTL-1005 J3: wire the read-only stall-clear census + the production
        // unstick seam. The census only resolves Linear state for tickets that
        // ALREADY carry a prior-artifact-retry-exhausted stall (rare), so the
        // bounded extra fetchTicketState reads never storm the API. The clear
        // seam deletes the synthetic stalled signal + re-arms needs-human; the
        // scheduler's normal path re-dispatches next tick.
        collectStallClearCandidates: () =>
          defaultCollectStallClearCandidates({
            orchDir: runningOpts.orchDir,
            projects: listProjects(),
            agents: getAgentsCached().agents,
            isLinearTerminal: (id) => {
              // CTL-1240: 3-tier read (cache → gateway/filter-state.db → live linearis),
              // matching the reclaim + reasoning-pass paths. TTL/gateway hits suppress
              // the live `linearis issues read` storm this census otherwise caused.
              // CTL-1340: + the flag-gated read-replica tier (undefined → inert).
              const state = fetchTicketState(id, {
                cache: runningOpts.cache,
                gateway: runningOpts.gateway,
                replica: runningOpts.replica,
                probeBackoff: true, // CTL-1436 (A4): a replica-MISS ticket whose live read fails backs off (breaker-flap mitigation)
              });
              return state != null && isLinearTerminal(state);
            },
          }),
        clearStall: defaultClearStall(runningOpts.orchDir, runningOpts.writeStatus ?? linearWrite),
        // CTL-1242 J4: wire the read-only GC census + the production rmSync seam.
        // The census only probes tickets whose workers/<T>/ dir exists AND whose
        // Linear state is provably terminal (Done/Canceled). Mode is the existing
        // jMode (readStallJanitorConfig() → default 'shadow') so J4 runs in shadow
        // by default; no new config knob needed.
        collectTerminalSignalGcCandidates: () => {
          // CTL-1315: read the agents snapshot ONCE and pass both its array and its
          // freshness. liveSessionInWorktree (the sole live-worker fence for a
          // terminal ticket once the inFlight gate is relaxed) is only trustworthy
          // when the snapshot is fresh; on a cold/stale snapshot the census collects
          // nothing and defers the reap (see defaultCollectTerminalSignalGcCandidates).
          const agentsSnap = getAgentsCached();
          return defaultCollectTerminalSignalGcCandidates({
            orchDir: runningOpts.orchDir,
            agents: agentsSnap.agents,
            agentsFresh: agentsSnap.isFresh,
            inFlightTickets: listInFlightTickets(runningOpts.orchDir),
            // CTL-1315: 3-tier read (cache → gateway → live linearis), matching the
            // J3/unstuck/reclaim censuses. The original J4 probe called
            // fetchTicketState(id) with NO cache/gateway — a live `linearis issues read`
            // per terminal dir per tick (the comment that claimed "cache-first" was
            // wrong). The cache/gateway tiers also make the terminal verdict resilient
            // to a transient live-read miss.
            isLinearTerminalOrMerged: (id) => {
              // CTL-1340: + the flag-gated read-replica tier (undefined → inert).
              const state = fetchTicketState(id, {
                cache: runningOpts.cache,
                gateway: runningOpts.gateway,
                replica: runningOpts.replica,
                probeBackoff: true, // CTL-1436 (A4): a replica-MISS ticket whose live read fails backs off (breaker-flap mitigation)
              });
              return state != null && isLinearTerminal(state);
            },
            // CTL-1315: thread the worktree resolver so liveSessionInWorktree is a
            // REACHABLE live-worker fence. It was previously omitted → defaulted to
            // () => null → liveSessionInWorktree always false. That fence is now
            // load-bearing: relaxing the in-flight gate (classifyTerminalSignalGc)
            // means a Linear-terminal ticket with a genuinely-running late-phase
            // worker (e.g. teardown, whose cwd is its worktree per CTL-1105) is
            // protected ONLY by this live-session check. Mirrors the unstuck-sweep
            // resolver below.
            resolveWorktreePath: (ticket) => {
              for (const sig of readWorkerSignals(runningOpts.orchDir)) {
                if (sig.ticket === ticket && sig.worktreePath) return sig.worktreePath;
              }
              return null;
            },
          });
        },
        gcTerminalSignals: defaultGcTerminalSignals(runningOpts.orchDir),
      },
      // CTL-1064: wire the unstuck-sweep census (Pass 0u). The census collects
      // stalled/failed workers lazily; the pass only runs when mode !== 'off'
      // AND the 15-min throttle window has elapsed. Mode defaults to 'off' so
      // a plain startScheduler caller gets a fully inert pass unless explicitly
      // opted in via env (CATALYST_UNSTUCK_SWEEP=shadow / =enforce) or Layer-2.
      unstuckSweep: runningOpts.unstuckSweep ?? {
        collectCandidates: () =>
          defaultCollectUnstuckCandidates({
            orchDir: runningOpts.orchDir,
            agentsSnapshot: getAgentsCached().agents,
            isLinearTerminal: (id) => {
              // CTL-1240: 3-tier read (cache → gateway → live linearis). Matches
              // the stall-clear census path above and the reclaim/reasoning paths.
              // CTL-1340: + the flag-gated read-replica tier (undefined → inert).
              const state = fetchTicketState(id, {
                cache: runningOpts.cache,
                gateway: runningOpts.gateway,
                replica: runningOpts.replica,
                probeBackoff: true, // CTL-1436 (A4): a replica-MISS ticket whose live read fails backs off (breaker-flap mitigation)
              });
              return state != null && isLinearTerminal(state);
            },
            // CTL-1064: thread the worktree resolver from each worker's signal so
            // the live-session gate (unstuck-sweep.mjs:118) and the classifier's
            // live-session short-circuit are reachable in production. Without it
            // resolveWorktreePath defaulted to () => null and worktreePath was
            // always null, making the live-session skip dead (a latent footgun
            // once act seams are enabled). Mirrors the prAdapter closure below.
            resolveWorktreePath: (ticket) => {
              for (const sig of readWorkerSignals(runningOpts.orchDir)) {
                if (sig.ticket === ticket && sig.worktreePath) return sig.worktreePath;
              }
              return null;
            },
          }),
        // CTL-1219: wire the real per-category enforcement seams. These act ONLY
        // when the unstuck-sweep mode resolves to 'enforce' (the driver looks up
        // actByCategory[decision.category] solely on the enforce branch); the mode
        // gate (readUnstuckSweepConfig, default 'off') is UNTOUCHED, so production
        // stays inert until an operator opts in — enforce is an operator decision
        // per ADR-023. Operators can still fully override via
        // runningOpts.unstuckActByCategory (e.g. a partial registry during staged
        // rollout, or {} to preserve the prior shadow-/escalate-only posture); the
        // ?? precedence keeps every existing scheduler test that injects
        // unstuckActByCategory:{} working unchanged. The seams are pure-cored +
        // injectable; here we bind the production deps already in scope.
        actByCategory:
          runningOpts.unstuckActByCategory ??
          buildUnstuckActSeams({
            orchDir: runningOpts.orchDir,
            // re-arm seam: deletes the stalled signal so the phase re-dispatches.
            clearStall: defaultClearStall(
              runningOpts.orchDir,
              runningOpts.writeStatus ?? linearWrite
            ),
            // label-removal seam for the stale-label category.
            writeStatus: runningOpts.writeStatus ?? linearWrite,
            // resolvePrState: normalize the live PR view ("MERGED" | other) for the
            // orphan-stale gate. Reuses the SAME prAdapter the recovery short-circuit
            // + reconcile backstop use (built once at boot, gh only fires inside
            // prView). Inert when no prAdapter / PR number is wired.
            resolvePrState: (ticket) => {
              const adapter = runningOpts.prAdapter;
              if (!adapter || typeof adapter.prView !== "function") return null;
              let pr = null;
              for (const sig of readWorkerSignals(runningOpts.orchDir)) {
                if (sig.ticket === ticket) {
                  pr = sig.raw?.pr ?? sig.pr ?? null;
                  if (pr?.number) break;
                }
              }
              if (!pr?.number) return null;
              try {
                const view = adapter.prView(ticket, pr);
                if (view && (view.state === "MERGED" || view.mergedAt != null)) return "MERGED";
                return view?.state ?? null;
              } catch {
                return null; // fail-closed: a gh error is never treated as MERGED.
              }
            },
            // jobLifecycle: the same bg-liveness probe the reclaim sweep uses; bound
            // to the warm agents snapshot. Inert (→ not-alive) without isBgJobAlive.
            jobLifecycle: (bgJobId) => {
              if (typeof runningOpts.isBgJobAlive !== "function" || !bgJobId) return false;
              try {
                return Boolean(
                  runningOpts.isBgJobAlive(bgJobId, { agents: getAgentsCached().agents })
                );
              } catch {
                return false;
              }
            },
            // runGit / fs primitives / emitPhaseComplete fall back to real defaults
            // inside unstuck-act-seams.mjs (git, node:fs, phase-agent-emit-complete).
          }),
        // emit: the dedicated unstuck unified-log emitter (NOT emitReapIntent,
        // whose closed vocabulary throws on unstuck.* — CTL-1064). Explicit here
        // so the production wiring does not silently depend on the schedulerTick
        // default.
        emit: emitUnstuckEvent,
        // postComment: intentionally unwired in this rollout (no Linear audit
        // comment) unless an operator injects runningOpts.unstuckPostComment —
        // defaultPostUnstuckComment is NOT closed over orchDir here. Mirrors the
        // intentional actByCategory no-op above.
        postComment:
          typeof runningOpts.unstuckPostComment === "function"
            ? runningOpts.unstuckPostComment
            : undefined,
      },
      // CTL-1150: thread the triage-artifact predicate (undefined → inline
      // existsSync default in schedulerTick; test seam via startScheduler).
      hasTriageArtifact: runningOpts.hasTriageArtifact,
      // CTL-1290: thread the board-health delegate's real-IO seams. Like the
      // stallJanitor/unstuckSweep censuses above, these are bound ONLY in the
      // daemon — a bare schedulerTick (unit test) passes no `boardHealth` so the
      // pass is inert (no real broker-DB / event-log / reconcile reads). Mode
      // resolves inside the hook via readBoardHealthConfig (env > Layer-2 >
      // "shadow"), so the daemon ships shadow-on by default while tests stay
      // quiet. Operators kill it with CATALYST_BOARD_HEALTH=0/off.
      //
      // CTL-1300: the HOLISTIC `act` seam — bound ONLY here (the daemon) and
      // reached ONLY in enforce (operator-gated via CATALYST_BOARD_HEALTH=enforce;
      // shadow never calls it). On a proceeding board scan it dispatches ONE
      // recovery-pass delegate, anchored to board-health's chosen ticket and
      // carrying the whole-board boardContext, by reusing the audited-real, capped,
      // cooldown'd defaultInvokeRecoveryPass (recoveryInvokeRecoveryPass) — NOT a
      // new mutator. The brief's boardContext gives the dispatched delegate
      // whole-board eyes (printDispatchedBrief renders it; the recovery-pass skill
      // consumes it as its Step -1 board scan).
      //
      // The executor reuses the SAME host-local cooldown ledger the per-item
      // recovery path uses (recoveryShouldSkipItem/recoveryRecordIntent, the 30-min
      // RECOVERY_COOLDOWN_MS window): board-health's 5-min interval throttle alone
      // would re-dispatch a chronically-flagged anchor every 5 min, and the
      // recovery-pass cap only counts `.complete` events so a repeatedly-FAILING
      // anchor never trips it. Gating the anchor on the cooldown ledger (skip when
      // already acted within the window; record the intent after dispatching) bounds
      // re-dispatch of one anchor to once per cooldown window, exactly like the
      // per-item path (scheduler.mjs recovery block).
      boardHealth: runningOpts.boardHealth ?? {
        // CTL-1157 (Codex round-6, P1): OPEN the broker DB handle before any reader.
        // getAllTicketDescriptors + getAllPrStatuses both go through broker-state's
        // ensure(), which THROWS when the module-level handle was never opened — and
        // the exec-core daemon never opens it here (only the separate reconcile timer
        // does, on a boot-order that isn't guaranteed before the first board-health
        // tick). assembleBoardState swallows the throw, so the board AND the PR-status
        // map silently come back empty and the phantom-merged / orphaned-open-PR cohorts
        // this change adds are unobservable in BOTH shadow and enforce. openBrokerStateDb
        // is idempotent (returns the existing handle) and read-safe under WAL, so calling
        // it per reader is cheap and correct whether or not another opener ran first.
        getBoard: () => {
          try {
            openBrokerStateDb();
          } catch {
            /* best-effort — empty board on open failure */
          }
          return getAllTicketDescriptors({ includeRemoved: false });
        },
        readEventRing: () => readBoardHealthEventTail(),
        getReconcileMarkers: () => readReconcileHealthMarkers({}),
        // CTL-1432 (B2): deferred board-health intents → first-class anchor candidates
        // (retires the dormant delegate-mini session). (B3): the sanctioned needs-human
        // allowlist (env CATALYST_BH_SANCTIONED_LATCHES / Layer-2 config), suppressed
        // from proposeMoves so the genuinely-stuck tickets stop being drowned each scan.
        getDeferredBoardHealthTickets: () => readDeferredBoardHealthIntents(runningOpts.orchDir),
        sanctionedNeedsHuman: readSanctionedNeedsHuman(),
        // CTL-1157 (A11): the filter_state PR-status reader (phantom/orphaned-PR
        // invariants) + the provably-dead host set for the HRW-safe holistic
        // failover. computeSurvivingRoster already exists (scheduler.mjs) and
        // returns the roster unchanged for roster ≤ 1 → empty dead set at N=1.
        getPrStatusMap: () => {
          try {
            openBrokerStateDb();
          } catch {
            /* best-effort — empty PR map on open failure */
          }
          return getAllPrStatuses();
        },
        // CTL-1157 (Codex #4): resolve a stuck ticket → its GitHub "owner/repo" so
        // the phantom/orphaned-PR cohorts disambiguate a cross-repo #-collision by
        // the ticket's repo (registry repoRoot → ownerRepoFromRepoRoot) instead of
        // skipping it and hiding a genuine orphaned open PR. NEVER bare linearis
        // (QUOTA rule): teamOf + the local registry only. Null when the team/
        // repoRoot is unknown or the path carries no /github/<owner>/<repo> segment
        // (the documented true residual → number-only/ambiguous fallback).
        repoForTicket: (ticket) => {
          try {
            const team = teamOf(ticket);
            if (!team) return null;
            return ownerRepoFromRepoRoot(getProjectConfig(team)?.repoRoot ?? null);
          } catch {
            return null;
          }
        },
        deadHosts: (roster) => roster.filter((h) => !computeSurvivingRoster(roster).includes(h)),
        // CTL-1157 (MUST-FIX 2): iterate the ordered candidate list and dispatch
        // the FIRST actionable (non-cooldown/non-latched) candidate — instead of
        // returning {dispatched:false} on the first skip, which wedged the whole
        // holistic pass on one latched anchor and starved the rest of the cohort.
        // The per-candidate cooldown gate + the recovery-pass intent ledger
        // (decision:"fix" auto-increments attempts; cap 2 + 30-min cooldown) are
        // preserved verbatim inside the loop — still exactly ONE dispatch per scan.
        // CTL-1157 (F1): thread the executor-resolved dispatch fn (runningOpts.dispatch)
        // through dispatchTicket so a delegate launches under the node's executor
        // (sdk vs bg) instead of a hardcoded claude --bg. On a bg fleet this is a
        // pure no-op (dispatchForExecutor("bg") === defaultDispatch).
        act: ({ anchor, candidates = [], boardContext, decision }) => {
          const deps = {
            orchDir: runningOpts.orchDir,
            dispatchTicket: (o, t, p) =>
              dispatchTicket(o, t, p, { dispatch: runningOpts.dispatch }),
          };
          return holisticBoardHealthAct(
            { anchor, candidates, boardContext, decision },
            {
              // CTL-1440 (Codex R1): holistic:true — a board-health defer is
              // gated on its FROZEN deferredSince anchor here (an aged deferred
              // anchor stays actionable even when the per-item pass re-deferred
              // it moments ago); the per-item pass keeps the lastTs throttle.
              shouldSkipItem: (cand) => recoveryShouldSkipItem(cand, { ...deps, holistic: true }),
              skipReason: (cand) => recoverySkipReason(cand, { ...deps, holistic: true }), // CTL-1440 (P0b)
              invokeRecoveryPass: (cand, ctx) => recoveryInvokeRecoveryPass(cand, ctx, deps),
              recordIntent: (cand, intent) => recoveryRecordIntent(cand, intent, deps),
            }
          );
        },
      },
    });
    // CTL-935 Phase 2: free-slots / R8 shadow comparator. Runs AFTER schedulerTick
    // (which produces the authoritative freeSlots value) — apples-to-apples because
    // the R8 belief was derived at collectBeliefsTick BEFORE schedulerTick modified
    // any state. Guard mirrors the advance-shadow guard above.
    if (beliefsRes?.ok && beliefsRes?.tickId != null) {
      try {
        const fsDb = getBeliefsDb();
        if (fsDb) {
          runFreeSlotsShadow(fsDb, beliefsRes.tickId, {
            proceduralFreeSlots:
              typeof tickResult?.freeSlots === "number" ? tickResult.freeSlots : null,
            proceduralInputs: tickResult
              ? {
                  maxParallel: tickResult.maxParallel,
                  inFlightCount: tickResult.inFlightCount,
                  livenessFresh: tickResult.livenessFresh,
                  draining: tickResult.draining,
                }
              : null,
            appendEvent: intentEventAppender,
            writeComparison: (rec) => recordShadowComparison(fsDb, rec),
            emitTickSummary: (process.env.CATALYST_FREE_SLOTS_SHADOW_SUMMARY ?? "0") === "1",
          });
        }
      } catch (fsErr) {
        try {
          log.warn(
            { err: fsErr?.message },
            "free-slots-shadow: comparator threw (tick unaffected)"
          );
        } catch {
          /* even logging must not break the tick */
        }
      }
    }
    // CTL-935 Phase 3: reclaim-verdict / R4-R7 shadow comparator. Runs AFTER
    // schedulerTick (which produces reclaimOutcomes with raw guard strings before
    // the lossy switch). Guard mirrors the Phase 2 free-slots guard above.
    if (beliefsRes?.ok && beliefsRes?.tickId != null) {
      try {
        const rcDb = getBeliefsDb();
        if (rcDb && tickResult?.reclaimOutcomes?.size) {
          const recordReclaim = makeReclaimShadowRecorder(rcDb, beliefsRes.tickId, {
            appendEvent: intentEventAppender,
            writeComparison: (rec) => recordShadowComparison(rcDb, rec),
          });
          recordReclaim(tickResult.reclaimOutcomes);
        }
      } catch (rcErr) {
        try {
          log.warn({ err: rcErr?.message }, "reclaim-shadow: comparator threw (tick unaffected)");
        } catch {
          /* even logging must not break the tick */
        }
      }
    }
    // CTL-863: host-death takeover sweep — complement to worker-death reclaim.
    // Skip entirely on single-host installs (no-op inside the function, but the
    // pre-check avoids the call to stay zero-cost on the common case).
    if (getClusterHosts().length > 1) {
      // CTL-1481: thread the replica (second arg — the seams object) so the
      // takeover stamp's label read stays off live Linear (replica-first, loud
      // live fallback inside the stamp).
      reclaimDeadHostWork({ orchDir: runningOpts.orchDir }, { replica: runningOpts.replica }).catch((err) => {
        log.warn({ err: err?.message }, "ctl-863: reclaimDeadHostWork tick failed — continuing");
      });
    }
  } catch (err) {
    // A tick must never crash the daemon — log and let the next tick retry.
    log.error({ err: err.message }, "scheduler: tick failed");
  }
}

function scheduleDebouncedTick(debounceMs) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runTick, debounceMs);
}

// holisticBoardHealthAct — CTL-1157 (MUST-FIX 2 + GROUP-3 #3): the board-health
// holistic `act` loop, extracted pure so it is unit-testable (the daemon wiring
// binds the real recovery seams around it). Walk the ordered candidate cohort and
// perform EXACTLY ONE real recovery-pass dispatch per scan. A candidate is SKIPPED
// (continue to the next) when EITHER:
//   (a) the intent-LEDGER cooldown/attempts gate latches it (shouldSkipItem), OR
//   (b) the invoke RESULT is a NON-dispatch — recovery-pass-cycle-cap-exhausted /
//       latched / no-op. The ledger gate (a) does NOT see the event-counted recovery
//       cycle cap, so a candidate can pass (a) yet not dispatch; returning that result
//       would wedge the whole pass on one cap-exhausted anchor and starve the cohort.
// recordIntent starts the cooldown window on EVERY real invoke attempt (success or
// non-dispatch) so a chronically-flagged anchor isn't re-hammered next scan. Only a
// REAL dispatch (r.dispatched) ends the scan. Returns the dispatching candidate's
// result, or {dispatched:false, reason:"all-candidates-cooldown"} when none dispatched.
export function holisticBoardHealthAct(
  { anchor = null, candidates = [], boardContext, decision } = {},
  { shouldSkipItem, invokeRecoveryPass, recordIntent, skipReason = null } = {}
) {
  const ordered = candidates.length ? candidates : anchor ? [anchor] : [];
  // CTL-1440 (P0b): track WHY candidates were ledger-skipped so the no-dispatch
  // return distinguishes "everything is terminally attempts-exhausted" (a
  // truthful non-wedge — the exhaustion sweep has escalated them to a human)
  // from a genuine retryable cooldown (the old blanket "all-candidates-cooldown"
  // misnomer that made C1/C2 lie — audit RC1).
  let ledgerSkips = 0;
  let terminalSkips = 0;
  let invoked = 0;
  // Codex R1: the terminal set includes "escalated" (the exhaustion sweep runs
  // BEFORE this act and rewrites exhausted ledgers to escalated — the cohort is
  // human-owned either way) and "leave-alone" (verified healthy). All three are
  // truthful non-wedges; only genuine cooldown/defer skips stay retryable.
  const TERMINAL_SKIPS = new Set(["attempts-exhausted", "escalated", "leave-alone"]);
  for (const cand of ordered) {
    // (a) cooldown/attempts-latched → try the next candidate (MUST-FIX 2).
    if (shouldSkipItem(cand)) {
      ledgerSkips += 1;
      if (TERMINAL_SKIPS.has(skipReason?.(cand))) terminalSkips += 1;
      continue;
    }
    invoked += 1;
    const r = invokeRecoveryPass(cand, {
      boardContext,
      reason: `board-health: ${decision?.gate?.reason ?? "board anomaly"} — holistic recovery-pass delegate`,
    });
    // Start the cooldown window on a dispatch attempt (success OR failure).
    // CTL-1439 (P0a): this is a DISPATCH marker, not a verdict — the session's
    // actual conclusion (fixed / leave-alone / escalate) arrives later via
    // recovery-emit.mjs → recordVerdict. Hardcoding decision:"fix" here was RC2's
    // "act-and-discard": the ledger claimed a fix verdict before the pass ran.
    try {
      recordIntent(cand, {
        type: "recovery-pass",
        decision: "dispatched",
        fix_class: "board-health",
        outcome: !!r?.dispatched,
        source: "board-health",
      });
    } catch {
      /* ledger write is best-effort — never block the tick */
    }
    // (b) a NON-dispatch RESULT is a SKIP, not this scan's dispatch — CONTINUE.
    if (!r?.dispatched) continue;
    // CTL-1435 (C1): surface WHICH candidate actually dispatched (may not be the
    // [0] anchor if earlier candidates were cooldown-skipped) so the board-scan
    // event's act.anchor records the real dispatch handle.
    return { ...r, candidate: cand }; // exactly ONE real dispatch per scan
  }
  // EVERY candidate was a terminal ledger skip (exhausted / escalated /
  // leave-alone) and NONE was invoked → the cohort is truthfully done (C2
  // non-wedge). Any invoke (even a non-dispatch result — cycle cap, latched)
  // or any retryable skip keeps the cooldown reason (Codex R1: an actionable
  // candidate that merely failed to dispatch is NOT a terminal cohort).
  return {
    dispatched: false,
    reason:
      invoked === 0 && ledgerSkips > 0 && terminalSkips === ledgerSkips
        ? "all-candidates-exhausted"
        : "all-candidates-cooldown",
  };
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
  // CTL-1365a: the catalyst.dispatch.mode telemetry vocab ({phase-agents |
  // oneshot-legacy | sdk}) resolved once by the daemon from the executor flag.
  // Threaded into runningOpts → the Tier-1 tick-timing log field AND the OTLP
  // resource attr (initTracing). Default "phase-agents" keeps every direct-call
  // test + standalone main() on today's label with no wiring.
  dispatchMode = "phase-agents",
  // CTL-1457 (N1): true when the node's executorByPhase routes ANY phase to an
  // in-process executor (sdk|codex-exec) while the node boot dispatchMode is still
  // bg. Threaded into runningOpts → the schedulerTick occupancy gates so a routed
  // no-bg worker is counted on a bg node. Default false → byte-identical for a node
  // with no in-process route (the common case).
  hasInProcessRoute = false,
  readEligible,
  exec,
  writeStatus,
  cache, // CTL-634: shared out-of-set blocker state cache (from startDaemon)
  gateway, // CTL-1240/823: durable filter-state.db reader; threaded into runningOpts → schedulerTick
  replica, // CTL-1340: flag-gated read-replica reader (undefined unless on); threaded into runningOpts → schedulerTick
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
  // CTL-764 Phase 5: optional worker.transition emitter override (test seam).
  // Undefined → runTick threads the real defaultAppendWorkerTransitionEvent into
  // the per-tick schedulerTick opts (production). A test injects a spy here to
  // capture transitions through the production runTick path.
  appendWorkerTransitionEvent,
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
  // CTL-1157 (ALARM-NOT-BLOCK): optional override for the terminal-sweep open-PR
  // enumerator. Undefined → runTick arms the real defaultCheckOpenPrs (production);
  // a test may inject its own to exercise the alarm branch hermetically.
  checkOpenPrs,
  // CTL-671: phantom-sweep seams. Undefined → schedulerTick's safe no-op
  // defaults (hermetic for unit tests that call startScheduler directly). The
  // real daemon (startDaemon) and the standalone main() pass the real impls.
  classifyResolution,
  isBgJobAlive,
  // CTL-781: respect-assignment + self-assign. Undefined → gate off (fail-open).
  botUserIds,
  botWriteId,
  // CTL-936: operator-event seam for intent.ineffective. When provided AND
  // CATALYST_INTENTS_ENFORCE=1, reconcileIntents emits events through this fn
  // instead of logging silently. Null/undefined → legacy shadow-only behavior.
  appendIntentEvent,
  // CTL-1150: injectable triage-artifact predicate (test seam). Undefined →
  // schedulerTick's inline existsSync default applies. Tests that are not
  // exercising the triage gate inject () => true to unblock Pass 2 dispatch.
  hasTriageArtifact = undefined,
  tickIntervalMs = TICK_INTERVAL_MS,
  debounceMs = TICK_DEBOUNCE_MS,
} = {}) {
  if (!orchDir) throw new Error("startScheduler: orchDir is required");
  runningOpts = {
    orchDir,
    dispatch,
    dispatchMode, // CTL-1365a: threaded to schedulerTick (tick-timing log field)
    hasInProcessRoute, // CTL-1457 (N1): per-phase in-process route arms the occupancy gates on a bg node
    readEligible,
    exec,
    writeStatus,
    cache,
    gateway, // CTL-1240: thread the durable descriptor reader into the per-tick options
    replica, // CTL-1340: thread the flag-gated read-replica reader into the per-tick options
    concurrency,
    configPath, // CTL-676: per-tick Layer-1 re-read source
    layer2Path, // CTL-678: per-tick Layer-2 re-read source (host-wide override)
    liveBackgroundCount, // CTL-676: test seam
    livenessIsFresh, // CTL-731: optional override (default getAgentsCached().isFresh)
    checkSequencing, // CTL-537: optional override (default defaultCheckSequencing)
    fetchBatch, // CTL-755/784: optional admission-gate batch hydration seam
    appendPhaseAdvanceHeldEvent, // CTL-755: optional held-indicator emit seam
    appendWorkerTransitionEvent, // CTL-764: optional worker.transition emitter override (test seam; runTick defaults to defaultAppendWorkerTransitionEvent)
    prAdapter, // CTL-642/758: live PR-merged adapter (built once above), threaded per-tick
    checkOpenPrs, // CTL-1157: optional terminal-sweep open-PR gate override (runTick arms the real one)
    classifyResolution, // CTL-671: optional phantom-sweep Linear-probe seam
    isBgJobAlive, // CTL-671: optional phantom-sweep bg-liveness seam
    botUserIds, // CTL-781: respect-assignment predicate membership set
    botWriteId, // CTL-781: orchestrator bot UUID to write as assignee on claim
    appendIntentEvent, // CTL-936: operator-event seam for intent.ineffective
    hasTriageArtifact, // CTL-1150: triage-artifact predicate for Pass 2
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

  // CTL-1330 Tier 1 wiring (ON by default).
  if (tickTimingEnabled()) {
    // Liveness-refresh observability is independent of perf_hooks — wire it
    // unconditionally so it survives a runtime that lacks monitorEventLoopDelay.
    setLivenessLogger((rec) => log.info(rec, "liveness: refresh (CTL-1330)"));
    // CTL-1330 Tier 3: also feed the liveness.refresh span sink (no-op when tracing off).
    setLivenessSpanSink((rec) => emitLivenessRefreshSpan(rec));
    // Process-wide event-loop delay monitor. perf_hooks.monitorEventLoopDelay is
    // NOT implemented in every runtime — Bun throws "Not implemented" on some
    // versions, and the daemon runs under Bun (CTL-1330 review, P1). Guard it so
    // a missing API degrades to "no event-loop-delay line" instead of crashing
    // the daemon on boot — the tick-timing total_ms already measures the
    // synchronous event-loop block directly.
    if (!_eventLoopMonitor) {
      try {
        const mon = monitorEventLoopDelay({ resolution: 20 });
        mon.enable();
        _eventLoopMonitor = mon;
      } catch (err) {
        _eventLoopMonitor = null;
        log.warn(
          { err: err?.message },
          "scheduler: event-loop delay monitor unavailable in this runtime — continuing without it (CTL-1330)"
        );
      }
    }
  }

  // CTL-1330 Tier 3: bring up OTLP tracing (OFF unless CATALYST_TRACING=on). Async
  // and fire-and-forget — never blocks startup; emitTickTrace no-ops until the
  // provider is ready, and a failed init degrades to "no spans". BatchSpanProcessor
  // only, so the exporter never blocks the tick.
  initTracing({ serviceName: "catalyst.execution-core", dispatchMode })
    .then((on) => {
      if (on) log.info({}, "scheduler: OTLP tracing enabled (CTL-1330 Tier 3)");
    })
    .catch(() => {});

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
  // CTL-1330: tear down the event-loop monitor + liveness sink so a restart
  // re-arms cleanly (and tests don't leak the pino sink across cases).
  if (_eventLoopMonitor) {
    _eventLoopMonitor.disable();
    _eventLoopMonitor = null;
  }
  setLivenessLogger(null);
  setLivenessSpanSink(null);
  // CTL-1330 Tier 3: flush + tear down tracing so a wedge tick's spans aren't lost
  // and a restart re-inits cleanly. Fire-and-forget (stopScheduler is sync).
  shutdownTracing().catch(() => {});
}

// __resetForTests — clear daemon state between unit tests. Not part of the
// public contract; the index.mjs barrel does not re-export it.
export function __resetForTests() {
  stopScheduler();
  observedYieldFiles.clear(); // CTL-702: reset per-lifetime dedup set between tests
  lastHeldEmitState.clear(); // CTL-755: reset held-event only-on-change dedup
  lastDispositionEmit.clear(); // CTL-764 Phase 5: reset worker.transition only-on-change dedup
  _unstuckLastRunMs = 0; // CTL-1064: reset Pass 0u throttle between tests
  _stallJanitorCensusLastRunMs = 0; // CTL-1324: reset Pass 0j census throttle between tests
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
