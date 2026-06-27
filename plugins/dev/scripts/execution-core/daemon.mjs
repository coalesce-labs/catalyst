#!/usr/bin/env bun
// daemon.mjs — the execution-core composing daemon (CTL-554). Wires the
// CTL-539 recovery contract, the CTL-535 Todo-state monitor, and the CTL-536
// pull-loop scheduler into one long-lived machine-level process, and owns the
// fs.watch on the central registry.json (CTL-582 D4 — the single source of
// enrolled projects).
//
// `orchDir` for all three composed functions is a single machine-level
// directory — getExecutionCoreDir() (~/catalyst/execution-core/). The daemon
// idempotently ensures a minimal <orchDir>/state.json so the CTL-536 scheduler
// has a maxParallel value to read.

import {
  watch,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { parseEventTailChunk } from "./event-tail.mjs";
import {
  getExecutionCoreDir,
  applyBootDrainPolicy, // CTL-1321: boot accepting work by default
  getRegistryPath,
  getEventLogPath,
  getJobsRoot,      // CTL-1165 D3: job-dir GC root
  log,
  EVENT_DEBOUNCE_MS,
  TAILER_POLL_INTERVAL_MS,
  readWaitWatcherConfig,
  readMemorySamplerConfig,
  readFleetHealthConfig, // CTL-1165 D5: fleet-health guardrail config (selfHeal default OFF)
  readRatelimitPollerConfig,
  getHostName,      // CTL-862
  resolveClusterHosts, // CTL-1273/CTL-1271: roster + source + multiHost for the boot assertion
  getLivenessAnchorIssue, // CTL-1271: "multi-host was configured" detector
  getStaticRoster,        // CTL-1271: "multi-host was configured" detector
  CLUSTER_SYNC_INTERVAL_MS, // CTL-1274: cluster-repo auto-pull cadence
  isHostNamePinnedFromConfig, // CTL-1093
  getCatalystRepoDir,       // CTL-1093 sticky dir
  readDelegateRunnerConfig, // CTL-1331: async board-health delegate runner kill-switch
  readLinearReplica,        // CTL-1340: read-replica tier flag (inert; default off)
  getExecutor,              // CTL-1365a: phase-worker executor resolver (env→Layer-1→node-class default; all "bg" in Phase 1)
  dispatchModeForExecutor,  // CTL-1365a: executor → catalyst.dispatch.mode telemetry vocab
} from "./config.mjs";
import { resolveBootIdentity } from "./host-boot-identity.mjs"; // CTL-1093
import { readStickyIdentity, writeStickyIdentity } from "./host-sticky.mjs"; // CTL-1093
import { ownedBy } from "./hrw.mjs"; // CTL-862: HRW ownership filter
import { clusterSync as realClusterSync, pullClusterRepo as realPullClusterRepo } from "./cluster-sync.mjs"; // CTL-1274: cluster-repo auto-pull
import { startWaitWatcher as realStartWaitWatcher } from "./wait-watcher.mjs";
import { startMemorySampler as realStartMemorySampler } from "./memory-sampler.mjs";
import { startFleetHealthProbe as realStartFleetHealthProbe } from "./fleet-health-probe.mjs"; // CTL-1165 D5: pre-exhaustion fleet-health guardrail
import { startRatelimitPoller as realStartRatelimitPoller } from "./ratelimit-poller.mjs";
import { listProjects as realListProjects } from "./registry.mjs"; // CTL-854: boot health check
import { startHeartbeat as realStartHeartbeat } from "./heartbeat-event.mjs"; // CTL-859: node.heartbeat emitter
import { readAdmissionState } from "./admission-state.mjs"; // CTL-1322: live admission block for the heartbeat
import { startLivenessPublisher as realStartLivenessPublisher } from "./cluster-heartbeat-publisher.mjs"; // CTL-1090: cross-host liveness
import { emitBootEvent } from "./boot-event.mjs"; // CTL-1084: node.boot self-report
import {
  recoverStartup,
  startMonitor,
  stopMonitor,
  startScheduler,
  stopScheduler,
  reconcileAll,
  createTicketStateCache,
} from "./index.mjs";
import { Reaper, defaultReadActivePhaseSignal, defaultReadSignalBgJobId, defaultAssessWorktreeRemoval } from "./reaper.mjs";
import { listOrchDirs } from "./worktree-safety.mjs"; // CTL-1218: legacy-run provenance roots
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";
import { sweepJobDirs } from "./job-dir-gc.mjs"; // CTL-1165 D3: ~/.claude/jobs/<id> dir GC
import { sweepWorkerDirs } from "./worker-dir-gc.mjs"; // CTL-1205: execution-core/workers/<TICKET>/ GC
import { sweepWtCleanupQueue } from "./wt-cleanup-drain.mjs"; // CTL-1218: wt-cleanup-queue drain
import { ProcReaper } from "./proc-reaper.mjs"; // CTL-1165 D2: orphan child-process reaper (default shadow)
import {
  startWorktreeRefreshTimer,
  readWorktreeRefreshConfig,
} from "./worktree-refresh-timer.mjs";
// CTL-1331: the async board-health delegate runner timer (kicks the DETACHED
// drainer that does the heavy worktree-provision + `claude --bg` off the daemon
// event loop). Gated by readDelegateRunnerConfig; Phase A ships it inert.
import { startDelegateRunnerTimer } from "./delegate-runner.mjs";
import {
  startStalePrRescueTimer,
  readStalePrRescueConfig,
} from "./stale-pr-rescue-timer.mjs";
import { DEFAULTS as RESCUE_DEFAULTS } from "./stale-pr-rescue.mjs";
import {
  startOrphanPrSweepTimer,
  readOrphanPrSweepConfig,
} from "./orphan-pr-sweep-timer.mjs";
import { DEFAULTS as ORPHAN_DEFAULTS } from "./orphan-pr-sweep.mjs";
import {
  startLinearReconcileTimer,
  readLinearReconcileConfig,
} from "./linear-reconcile-timer.mjs";
import { reconcileBootResume, processApprovedResumes } from "./boot-resume.mjs";
// CTL-665: the committed executionCore concurrency reader — imported directly
// (not via the index.mjs barrel, mirroring the orphan-reaper-timer import) so
// main() can resolve the slot-ceiling config once and thread it into the
// scheduler + boot-resume.
// CTL-678: pair the Layer-1 reader with the Layer-2 reader + merger so the
// machine-canonical override (~/.config/catalyst/config.json) can win
// per-field over the committed seed.
import {
  readExecutionCoreConcurrency,
  readExecutionCoreConcurrencyLayer2,
  mergeExecutionCoreConcurrency,
  readAllEligibleTickets, // CTL-862: boot-log ownership count
  clearHoldStopCooldown, // CTL-768
  defaultClearStall, // CTL-1067: J3 stall-clear seam
} from "./scheduler.mjs";
import * as linearWrite from "./linear-write.mjs"; // CTL-1067: writeStatus for defaultClearStall
import { writeBootMarker, clearProgressMarks, resolvePhaseSessionId, defaultAppendOperatorEvent } from "./recovery.mjs"; // CTL-655: window the revive budget to this run; CTL-736: reset progress high-water; CTL-768: --resume; CTL-1044: operator-event appender for the scheduler's appendIntentEvent seam
import { startAutoTuner } from "./autotune.mjs"; // CTL-684: side-car maxParallel auto-tuner
import { dispatchTicket, dispatchForExecutor, makeCommentWakeDispatch } from "./dispatch.mjs"; // CTL-549: comment-wake re-dispatch; CTL-1365a/b: executor→dispatch selection at the launch seam + comment-wake executor binding
import { resolveSdkBootExecutor } from "./sdk-run-phase-agent.mjs"; // CTL-1367 item 9 + P3: boot auth gate (subscription-only) that degrades sdk→bg AND emits execution-core.executor.bg-fallback so the silent fallback is observable
import { removeLabel as defaultRemoveLabel } from "./linear-write.mjs"; // CTL-549: clear needs-human on resume
// CTL-671: the real phantom-sweep seams. startScheduler defaults them to safe
// no-ops (hermetic for direct-call unit tests); the REAL daemon arms them here
// so the phantom worker-dir validity sweep is operative in production.
import { classifyTicketResolution } from "./linear-query.mjs";
import { createGatewayReader } from "./gateway-read.mjs";
import { createReplicaReader } from "./replica-read.mjs"; // CTL-1340: read-replica tier reader
import { isBgJobAlive, refreshAgents, listClaudeAgentsResult } from "./claude-agents.mjs"; // CTL-1165 D3: fail-closed liveness reader for job-dir GC

const DEFAULT_MAX_PARALLEL = 3;

let _watcher = null;
let _debounceTimer = null;
let _stopMonitor = null;
let _stopScheduler = null;
let _pidFile = null;
// CTL-649: reap-intent reconciler + periodic orphan-sweep timer.
let _reaper = null;
let _orphanTimer = null;
// CTL-707: periodic background worktree refresh timer.
let _refreshTimer = null;
// CTL-1331: async board-health delegate runner timer (gated CATALYST_DELEGATE_RUNNER).
let _delegateRunnerTimer = null;
// CTL-782: periodic stale/conflicting-PR rescue timer.
let _stalePrRescueTimer = null;
// CTL-1175: periodic orphan-PR detect+notify sweep timer.
let _orphanPrSweepTimer = null;
// CTL-1371: periodic PR→Linear state reconcile timer.
let _linearReconcileTimer = null;
// CTL-650: the push-based session wait-state watcher handle.
let _waitWatcher = null;
// CTL-685: per-worker memory sampler handle.
let _memorySampler = null;
// CTL-1165 D5: pre-exhaustion fleet-health probe handle.
let _fleetHealthProbe = null;
// CTL-787: account-level rate-limit usage poller handle.
let _ratelimitPoller = null;
// CTL-859: node-heartbeat emitter handle (distributed-coordination foundation).
let _heartbeat = null;
// CTL-1090: cross-host liveness publisher handle (multi-host only; single-host no-op).
let _livenessPublisher = null;
// CTL-1274: cluster-repo auto-pull timer handle (git pull --ff-only on a cadence).
let _clusterSyncTimer = null;
// CTL-684: auto-tuner stop handle.
let _stopAutoTuner = null;
let _eventWatcher = null;
let _eventDebounceTimer = null;
let _eventPollTimer = null; // CTL-769: poll-fallback drain (fs.watch debounce never fires on the continuously-appended log)
// CTL-792: short-interval liveness-snapshot warmer. ~TTL/2 so the dispatch gate's
// staleMs (2×TTL ≈ 10s) window always sees a fresh snapshot regardless of the
// idle scheduler-tick cadence. Env-tunable.
const LIVENESS_WARM_INTERVAL_MS = Number(process.env.CATALYST_LIVENESS_WARM_MS) || 4_000;
let _livenessTimer = null;
let _eventLogCursor = 0;
// CTL-649: the trailing partial line carried across reads. _eventLogCursor is a
// BYTE offset; consumeEventTail reads only NEW bytes via a file descriptor and
// stitches the leftover onto the front so a line split across two writes (or a
// half-written line at read time) is parsed exactly once, never truncated.
let _eventLogLeftover = "";

// readLinearBotUserIds — collect all known Linear bot user UUIDs from both
// config layers so the self-echo guard covers every app-actor identity:
//   1. NEW:  ~/.config/catalyst/config.json  catalyst.linear.bot.worker.botUserId
//   2. NEW:  ~/.config/catalyst/config.json  catalyst.linear.bot.orchestrator.botUserId
//   3. OLD:  .catalyst/config.json           catalyst.monitor.linear.botUserId  (Layer-1)
// Returns a Set<string>. Empty set = no filter (fail-open). Never throws. CTL-749.
export function readLinearBotUserIds(layer1Path, layer2Path) {
  const ids = new Set();
  function addFromPath(path, extractor) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      extractor(parsed, ids);
    } catch { /* ignore unreadable / malformed files */ }
  }
  // NEW global path: both worker and orchestrator bot identities (Layer 2).
  addFromPath(layer2Path, (p, s) => {
    const bot = p?.catalyst?.linear?.bot;
    if (typeof bot?.worker?.botUserId === "string" && bot.worker.botUserId.length > 0)
      s.add(bot.worker.botUserId);
    if (typeof bot?.orchestrator?.botUserId === "string" && bot.orchestrator.botUserId.length > 0)
      s.add(bot.orchestrator.botUserId);
  });
  // OLD Layer-1 path: catalyst.monitor.linear.botUserId (back-compat). CTL-749.
  addFromPath(layer1Path, (p, s) => {
    const uid = p?.catalyst?.monitor?.linear?.botUserId;
    if (typeof uid === "string" && uid.length > 0) s.add(uid);
  });
  return ids;
}

// readLinearBotWriteId — the SINGLE bot UUID the daemon writes as assignee on
// claim (CTL-781): the orchestrator app-actor identity, preferred from Layer-2,
// falling back to the legacy Layer-1 monitor botUserId. Null = self-assign
// disabled (the respect-assignment predicate still runs off the Set). Never throws.
export function readLinearBotWriteId(layer1Path, layer2Path) {
  // Prefer Layer-2: catalyst.linear.bot.orchestrator.botUserId.
  if (layer2Path) {
    try {
      const p = JSON.parse(readFileSync(layer2Path, "utf8"));
      const id = p?.catalyst?.linear?.bot?.orchestrator?.botUserId;
      if (typeof id === "string" && id.length > 0) return id;
    } catch { /* ignore */ }
  }
  // Fallback: Layer-1 catalyst.monitor.linear.botUserId.
  if (layer1Path) {
    try {
      const p = JSON.parse(readFileSync(layer1Path, "utf8"));
      const id = p?.catalyst?.monitor?.linear?.botUserId;
      if (typeof id === "string" && id.length > 0) return id;
    } catch { /* ignore */ }
  }
  return null;
}

// _isBotId — returns true when actorId is in the bot-ids set or (for backward
// compat with tests that pass a plain string) equals the string directly.
// Centralises the "is this the bot?" check used in the three self-echo guards.
export function _isBotId(botUserId, actorId) {
  if (!botUserId || !actorId) return false;
  if (botUserId instanceof Set) return botUserId.has(actorId);
  return botUserId === actorId;
}

// createCommentInboxWriter — factory for a per-daemon onComment subscriber.
// Appends a JSONL entry to ORCH_DIR/workers/<ticket>/inbox.jsonl when the
// ticket is in-flight (workers/ dir exists). Filters bot self-echo via
// botUserId (string or Set<string>). Exported for testing. CTL-749.
export function createCommentInboxWriter(orchDir, botUserId) {
  return function writeCommentToInbox(parsed) {
    const ticket = parsed.ticket ?? parsed.identifier ?? null;
    if (!ticket) return;
    if (_isBotId(botUserId, parsed.authorId)) return;
    const workerDir = join(orchDir, "workers", ticket);
    if (!existsSync(workerDir)) return;
    const entry = JSON.stringify({
      kind: "comment",
      ticket,
      commentId: parsed.commentId,
      body: parsed.body,
      authorId: parsed.authorId,
      authorName: parsed.authorName ?? null,
      receivedAt: new Date().toISOString(),
    });
    appendFileSync(join(workerDir, "inbox.jsonl"), entry + "\n");
  };
}

// createUpdateInboxWriter — factory for a per-daemon onUpdate subscriber.
// Appends a JSONL entry only when descriptionChanged is true and the ticket is
// in-flight. Filters bot self-echo via botUserId. Exported for testing. CTL-749.
export function createUpdateInboxWriter(orchDir, botUserId) {
  return function writeUpdateToInbox(parsed) {
    if (!parsed.descriptionChanged) return;
    const ticket = parsed.ticket ?? parsed.identifier ?? null;
    if (!ticket) return;
    if (_isBotId(botUserId, parsed.actorId)) return;
    const workerDir = join(orchDir, "workers", ticket);
    if (!existsSync(workerDir)) return;
    const entry = JSON.stringify({
      kind: "description_changed",
      ticket,
      description: parsed.description ?? null,
      actorId: parsed.actorId ?? null,
      actorName: parsed.actorName ?? null,
      receivedAt: new Date().toISOString(),
    });
    appendFileSync(join(workerDir, "inbox.jsonl"), entry + "\n");
  };
}

// ensureState — idempotently write a minimal machine-level state.json so the
// CTL-536 scheduler has a maxParallel to read. Never overwrites an operator's
// existing file. Atomic tmp + renameSync, the same idiom as event-cursor.mjs.
function ensureState(orchDir) {
  mkdirSync(orchDir, { recursive: true });
  const statePath = resolve(orchDir, "state.json");
  if (!existsSync(statePath)) {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ maxParallel: DEFAULT_MAX_PARALLEL }, null, 2));
    renameSync(tmp, statePath);
  }
}

// handleCommentWake — CTL-549 re-dispatch hook. Called on each
// `linear.comment.created` event by the daemon's `onComment` callback wired
// into startMonitor. Scans all phase signals for the comment's ticket; for
// each signal with status === "needs-input", removes the needs-human label
// and re-dispatches via dispatchTicket with the parked handoffPath. For
// status === "stalled", clears the stall via the J3 seam (CTL-1067).
// Fail-open throughout — a bad signal file or clearStall failure is logged
// and skipped, never fatal.
export async function handleCommentWake(
  parsed,
  {
    orchDir, dispatch, removeLabel, botUserId,
    resolveSession = resolvePhaseSessionId,
    clearStall = () => false, // CTL-1067: J3 stall-clear seam; default no-op
  },
) {
  const { ticket } = parsed ?? {};
  if (!ticket) return;
  // CTL-756: self-echo guard — never re-dispatch on the bot's own comment
  // (e.g. the parking-question comment the parked worker just posted as the
  // Catalyst app actor). Fail-open when botUserId is unset. Mirrors the inbox
  // writers' guard. botUserId accepts a string or Set<string>.
  if (_isBotId(botUserId, parsed.authorId)) return;

  const workerDir = join(orchDir, "workers", ticket);
  let signalFiles;
  try {
    signalFiles = readdirSync(workerDir).filter(
      (f) => f.startsWith("phase-") && f.endsWith(".json"),
    );
  } catch {
    return;
  }

  for (const fname of signalFiles) {
    let sig;
    try {
      sig = JSON.parse(readFileSync(join(workerDir, fname), "utf8"));
    } catch {
      continue;
    }

    // CTL-1067: an operator answered a STALLED escalation row. Clear the stall via
    // the J3 seam (delete the synthetic stalled signal + remove the needs-human
    // label & markers + .orphan-detected). The scheduler re-derives advancement
    // from the preserved prior-done signal and re-dispatches the phase fresh.
    if (sig.status === "stalled") {
      const phase = fname.slice("phase-".length, -".json".length);
      try { clearStall({ ticket, phase }); }
      catch (err) {
        log.warn({ ticket, phase, err: err?.message }, "handleCommentWake: clearStall threw — skipping");
      }
      continue;
    }

    if (sig.status !== "needs-input") continue;

    const parkedPhase = sig.parkedFrom ?? sig.phase;
    const handoffPath = sig.handoffPath ?? undefined;

    // CTL-768: a held-stopped worker (process killed to free its slot) must be
    // revived with --resume so it continues the paused conversation. Reset the
    // signal to "stalled" first (so phase-agent-dispatch's idempotency guard
    // accepts the re-dispatch — mirrors defaultReviveDispatch) and clear the
    // marker so a future re-park starts clean. A still-alive worker
    // (stoppedForHold falsy) keeps the exact legacy path — no resume, no reset.
    let resumeSession;
    if (sig.stoppedForHold === true) {
      resumeSession = (sig.bg_job_id ? resolveSession(sig.bg_job_id) : null) ?? undefined;
      const signalPath = join(workerDir, fname);
      try {
        const updated = {
          ...sig, status: "stalled", stoppedForHold: false,
          attentionReason: "ctl-768-hold-wake",
          updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        const tmp = `${signalPath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(updated, null, 2));
        renameSync(tmp, signalPath);                            // atomic
      } catch (err) {
        log.warn({ ticket, phase: parkedPhase, err: err.message },
          "handleCommentWake: hold-wake signal reset failed — skipping");
        continue;
      }
      clearHoldStopCooldown(orchDir, ticket, parkedPhase);
    }

    try {
      await removeLabel(ticket, "needs-human"); // CTL-1067 Bug 3: was "needs-human/question"
    } catch {
      /* fail-open */
    }

    dispatch(orchDir, ticket, parkedPhase, { handoffPath, resumeSession });
  }
}

// startDaemon — boot the composed daemon. Every composed function is an
// injectable dependency defaulting to the real barrel export, so production
// wiring needs no arguments and tests inject deterministic fakes.
export function startDaemon({
  recover = recoverStartup,
  // CTL-654: synchronous boot-resume pass. Runs once between recover() and the
  // monitor, consuming recover()'s previously-discarded RecoveryReport.
  reconcileBoot = reconcileBootResume,
  startMonitor: monitorFn = startMonitor,
  startScheduler: schedulerFn = startScheduler,
  stopMonitor: stopMonitorFn = stopMonitor,
  stopScheduler: stopSchedulerFn = stopScheduler,
  reconcile = reconcileAll,
  watchRegistry = true,
  debounceMs = EVENT_DEBOUNCE_MS,
  // CTL-769: reaper poll-fallback interval. Injectable so tests can drive the
  // reap-intent drain deterministically; defaults to TAILER_POLL_INTERVAL_MS.
  pollMs = TAILER_POLL_INTERVAL_MS,
  pidFile = null,
  // CTL-649: reaper + orphan-sweep timer. Disable via env knob for tests
  // that only exercise monitor + scheduler.
  enableReaper = process.env.EXECUTION_CORE_DISABLE_REAPER !== "1",
  // CTL-769: reaper factory seam — defaults to the real Reaper; injectable so
  // tests can spy on reap dispatch driven by the poll fallback.
  makeReaper = (opts) => new Reaper(opts),
  orphanReaperConfig = null,
  // CTL-707: worktree refresh timer config (catalyst.orchestration.worktreeRefresh).
  worktreeRefreshConfig = null,
  // CTL-782: stale/conflicting-PR rescue timer config (catalyst.orchestration.stalePrRescue).
  stalePrRescueConfig = null,
  // CTL-1175: orphan-PR detect+notify sweep timer config (catalyst.orchestration.orphanPrSweep).
  orphanPrSweepConfig = null,
  // CTL-1371: PR→Linear state reconcile timer config (catalyst.orchestration.reconcile).
  linearReconcileConfig = null,
  // CTL-650: the session wait-state watcher. Injectable for tests; gated by a
  // config knob (default-on, CATALYST_WAIT_WATCHER=0 disables) like the reaper.
  startWaitWatcher = realStartWaitWatcher,
  enableWaitWatcher = readWaitWatcherConfig().enabled,
  // CTL-685: per-worker memory sampler. Injectable for tests; gated by a config
  // knob (default-on, CATALYST_MEMORY_SAMPLER=0 disables) like the wait-watcher.
  startMemorySampler = realStartMemorySampler,
  enableMemorySampler = readMemorySamplerConfig().enabled,
  // CTL-1165 D5: pre-exhaustion fleet-health probe. Injectable for tests; gated
  // by a config knob (default-on, CATALYST_FLEET_HEALTH=0 disables) like the
  // memory sampler. The probe is EMIT-ONLY by default (self-heal default OFF).
  startFleetHealthProbe = realStartFleetHealthProbe,
  // undefined → resolve from config (env + Layer-1 via configPath) in the boot
  // body below; tests may force true/false and that wins via `??`.
  enableFleetHealth = undefined,
  // CTL-787: account-level rate-limit usage poller. Injectable for tests; gated
  // by a config knob (default-on, CATALYST_RATELIMIT_POLLER=0 disables) like the
  // memory sampler.
  startRatelimitPoller = realStartRatelimitPoller,
  enableRatelimitPoller = readRatelimitPollerConfig().enabled,
  // CTL-859: node-heartbeat emitter. Injectable for tests; default-on, gated by
  // CATALYST_HEARTBEAT=0 (the test/opt-out knob, mirroring the other timers).
  // ADDITIVE/dormant — the heartbeat only appends observability events; nothing
  // in dispatch/claim consumes them in PR1.
  startHeartbeat = realStartHeartbeat,
  enableHeartbeat = process.env.CATALYST_HEARTBEAT !== "0",
  // CTL-1090: cross-host liveness publisher. Injectable for tests. Single-host
  // installs get an inert no-op handle from startLivenessPublisher itself.
  startLivenessPublisher = realStartLivenessPublisher,
  // CTL-1274: cluster-repo auto-pull. clusterSync runs once at boot (pull +
  // decrypt secrets); pullClusterRepo runs on a cadence so a roster change
  // committed on one node reaches every running daemon without a restart. Both
  // are FAIL-OPEN (a failure logs + continues, never breaks the daemon) and
  // injectable for hermetic tests. enableClusterSync=false disables both (test
  // default + a CATALYST_CLUSTER_SYNC=0 kill-switch).
  clusterSync = realClusterSync,
  pullClusterRepo = realPullClusterRepo,
  clusterSyncIntervalMs = CLUSTER_SYNC_INTERVAL_MS,
  enableClusterSync = process.env.CATALYST_CLUSTER_SYNC !== "0",
  // CTL-665: committed executionCore concurrency knobs resolved in main() from
  // .catalyst/config.json. Threaded into both the scheduler new-work pull and the
  // boot-resume ceiling. Empty {} (the test default) keeps the legacy state.json path.
  concurrency = {},
  // CTL-676: the resolved config path. Threaded only into startScheduler so the
  // scheduler can re-read concurrency knobs per tick (hot-reload). reconcileBoot
  // intentionally stays on the boot-captured `concurrency` object — it fires
  // once before the scheduler starts and never re-reads. Null in tests that
  // never resolve a config path.
  configPath = null,
  // CTL-678: machine-canonical Layer-2 path (~/.config/catalyst/config.json).
  // Threaded into startScheduler alongside configPath so the per-tick re-read
  // can apply Layer-2's per-field override on every tick (hot-reload of the
  // override). Null in tests; production main() resolves it from
  // CATALYST_LAYER2_CONFIG_FILE || ~/.config/catalyst/config.json.
  layer2Path = null,
  // CTL-684: auto-tuner injectable seams (production uses the real module;
  // tests inject spies). The stop handle is stored so stopDaemon can tear it
  // down symmetrically with the scheduler block.
  startAutoTuner: startAutoTunerFn = startAutoTuner,
  // CTL-854: injectable for the boot empty-registry health check. Tests inject
  // a deterministic fake; production uses the real registry reader.
  listProjects: listProjectsFn = realListProjects,
  // CTL-862: injectable seams for the ownership boot-log. Tests inject a fixed
  // roster and eligible list; production resolves them from the real modules.
  readAllEligible = readAllEligibleTickets,
  bootHosts = undefined,
  bootHostName = undefined,
  // CTL-1271: injectable roster-resolution seam for the boot assertion. Tests
  // inject a fixed { hosts, source, multiHost }; production resolves it from the
  // real config (resolveClusterHosts). Kept separate from bootHosts so the
  // CTL-862 ownership-log tests (which inject bootHosts directly) still pass.
  bootResolve = undefined,
} = {}) {
  const orchDir = getExecutionCoreDir();
  ensureState(orchDir);
  // CTL-862: write the resolved config path back into the env so downstream
  // callers (getClusterHosts → getCatalystRepoDir) resolve the right repo
  // regardless of the daemon's cwd. ||= preserves any launcher-provided value.
  if (configPath) process.env.CATALYST_CONFIG_FILE ||= configPath;
  // CTL-655: record this daemon process's start time so the first scheduler
  // tick's reclaimDeadWorkIfPossible can window the per-ticket revive budget to
  // the current run (a clean restart resets a budget burned by a prior storm).
  // Must precede schedulerFn (the first reclaim read). Fail-open internally.
  writeBootMarker(orchDir);
  // CTL-736 Phase 3: reset the per-(ticket, phase) progress high-water markers so a
  // stale mark from a prior daemon run cannot false-STOP the first death this run.
  clearProgressMarks(orchDir);
  // CTL-1321: boot accepting work by default — clear the persistent drain flag
  // (+ drain.drained sentinel) a prior drain left, so a quiesce→restart resumes
  // new-work admission instead of coming up silently drained. CATALYST_BOOT_DRAINED=1
  // re-arms drain for nodes deliberately kept out of rotation. Best-effort/fail-open;
  // grouped with the writeBootMarker/clearProgressMarks prior-run resets and ahead of
  // schedulerFn, the sole consumer of the `!draining` new-work gate.
  const _bootDrain = applyBootDrainPolicy(orchDir);
  log.info(
    { drained: _bootDrain.drained },
    _bootDrain.drained
      ? "boot: CATALYST_BOOT_DRAINED set — node boots drained, holding new-work admission (CTL-1321)"
      : "boot: drain flag cleared — node accepting work (CTL-1321)",
  );
  _stopMonitor = stopMonitorFn;
  _stopScheduler = stopSchedulerFn;

  // CTL-792: keep the liveness snapshot warm so an idle tick cadence doesn't hold
  // new-work dispatch forever on the staleMs gate. CTL-790 made the snapshot
  // POPULATE, but it is refreshed only LAZILY (once per scheduler tick) — and an
  // idle daemon ticks every ~15-30s while staleMs is short, so the snapshot is
  // always stale by the next gate check. A dedicated short-interval refresh keeps
  // _asyncSnap < staleMs old AND keeps the worker count ~TTL-accurate (over-spawn-
  // safe). UNCONDITIONAL — core to dispatch, must NOT depend on the optionally-
  // disabled reaper (its earlier placement inside startReaperAndTimer never ran).
  // Fire-and-forget + single-flight; unref'd; torn down in stopDaemon.
  _livenessTimer = setInterval(() => {
    try {
      Promise.resolve(refreshAgents()).catch((err) =>
        log.warn({ err: err?.message }, "liveness warmer: refresh failed"),
      );
    } catch (err) {
      log.warn({ err: err?.message }, "liveness warmer: threw");
    }
  }, LIVENESS_WARM_INTERVAL_MS);
  _livenessTimer.unref?.();

  // CTL-586: write the PID file BEFORE the synchronous boot work
  // (recover/monitor/scheduler each trigger a blocking reconcile that fans
  // out one spawnSync("linearis", ...) per registered team). The wrapper's
  // 2s PID-file poll (catalyst-execution-core:83-91) otherwise times out
  // and reports "may be hung mid-init" against a daemon that is in fact
  // booting normally. PID-file presence now means "process up" — callers
  // do `kill 0 <pid>` for liveness; the daemon stays the sole writer.
  if (pidFile) {
    _pidFile = pidFile;
    const tmp = `${pidFile}.tmp`;
    writeFileSync(tmp, String(process.pid));
    renameSync(tmp, pidFile);
  }

  // A throw from any composed boot step must not leave a stale PID file —
  // stopDaemon removes _pidFile via unlinkSync. Rethrow so the main()-level
  // try/catch logs and process.exit(1)s as before.
  // CTL-1084: hoisted so emitBootEvent at the boot-log site can reference them
  // after the try block completes without a throw.
  let _bootReport;
  let _bootResume;
  try {
    // CTL-539 — rebuild routing + worker state on boot. CTL-654: capture the
    // RecoveryReport (previously discarded) so the boot-resume pass can consume
    // its `coldStart` verdict + worker buckets.
    const report = recover({ orchDir });
    _bootReport = report;
    // CTL-1365a/b Stage C: resolve the phase-worker executor ONCE per boot (env →
    // Layer-1 catalyst.orchestration.executor → node-class default; every class
    // maps to "bg" in Phase 1, so an unset flag is a pure no-op) and select the
    // dispatch function threaded into ALL FOUR dispatch entry points — the
    // scheduler pull-loop, the monitor's →Triage one-shot, the comment-wake
    // re-dispatch, AND the boot-resume crash-recovery pass — so a node never
    // split-brains (some sites bg, others sdk). Resolved here, BEFORE reconcileBoot,
    // precisely so boot-resume honors the flag too. For executor=bg/oneshot-legacy
    // dispatchFn === defaultDispatch (byte-identical to today); "sdk" → sdkDispatch
    // (injects sdkRunPhaseAgent). dispatchMode is the catalyst.dispatch.mode
    // telemetry vocab ("phase-agents" for bg) for the scheduler's Tier-1 tick line.
    // CTL-1367 item 9 + P3: DAEMON-BOOT auth gate. assertSdkAuth also runs at
    // dispatch time (no claim, no signal on a bad env), but a boot-time check fails
    // LOUD once and gracefully degrades the WHOLE boot to bg rather than letting
    // every sdk dispatch silently meter / refuse. resolveSdkBootExecutor WARN-logs
    // AND emits execution-core.executor.bg-fallback to the unified event log (via
    // defaultAppendOperatorEvent) so the silent bg-fallback — which can diverge from
    // doctor's PASS when the daemon's launchd env lacks the OAuth token the operator
    // shell has — is visible in monitoring. For executor=bg/oneshot-legacy it is a
    // pure pass-through (no auth check, no event), byte-identical to today.
    const bootExec = resolveSdkBootExecutor(getExecutor(configPath), {
      env: process.env,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      emitEvent: defaultAppendOperatorEvent,
      log,
    });
    const executor = bootExec.executor;
    const dispatchFn = dispatchForExecutor(executor);
    const dispatchMode = dispatchModeForExecutor(executor);
    // CTL-1365b: the comment-wake re-dispatch binding — routes a parked ticket's
    // re-dispatch through the SAME resolved executor (no split-brain).
    const commentWakeDispatch = makeCommentWakeDispatch(dispatchFn);
    // CTL-654: boot-resume — on a cold start, re-dispatch in-flight tickets whose
    // worktree has no live --bg worker, BEFORE the monitor/scheduler start. This
    // bypasses the per-tick reclaim sweep's revive budget (a clean reboot is not
    // a chronic-failure storm) and is bounded by maxParallel so a reboot never
    // spawns a worker storm. Synchronous and inside the same try/catch so a throw
    // still triggers PID-file cleanup. A non-cold-start restart is a no-op.
    // CTL-1365b: dispatch === dispatchFn so the crash-recovery re-dispatch honors
    // the executor flag (defaultDispatch under bg — reconcileBootResume's own
    // default — so byte-identical to today).
    const bootResume = reconcileBoot({ orchDir, report, concurrency, dispatch: dispatchFn }); // CTL-665: config-first boot-resume ceiling
    _bootResume = bootResume;
    // CTL-644: dispatch any gated tickets that already have an approval sentinel on disk
    // (operator may have dropped the sentinel while the daemon was down).
    // CTL-1367 item E2: thread the resolved executor dispatch — this is the 5th
    // dispatch entry point and previously defaulted to defaultDispatch, so an
    // approved-resume ticket launched via bg even under executor=sdk (split-brain).
    processApprovedResumes({ orchDir, dispatch: dispatchFn });
    // CTL-634: one shared TTL state cache. The monitor write-through populates
    // it on every state_changed event; the scheduler read path consults it
    // during out-of-set blocker hydration. A single instance threaded into
    // both is what turns a write-through into a guaranteed next-tick hit.
    const cache = createTicketStateCache();
    // CTL-823: readonly client over the broker's durable descriptor store
    // (~/catalyst/filter-state.db). Fail-open — see gateway-read.mjs.
    const gatewayReader = createGatewayReader();
    // CTL-1340: flag-gated read-replica tier (INERT by default). Constructed
    // ONLY when CATALYST_LINEAR_REPLICA resolves to "on" — otherwise undefined,
    // so the scheduler's replica block is never reached and behavior is
    // byte-identical to pre-CTL-1340. HIT-only acceleration of the hot
    // per-signal terminal reads once a Catalyst-Cloud replica is seeded on host.
    const replicaReader =
      readLinearReplica().mode === "on" ? createReplicaReader() : undefined;
    // CTL-565: the monitor needs orchDir to one-shot-dispatch the triage phase
    // agent on a →Triage transition. `dispatch` stays an injectable default
    // (dispatch.mjs) so the daemon's fakes-pass-through pattern still holds.
    // CTL-749: resolve bot user IDs from both config layers (Layer-1 old path +
    // Layer-2 new global path) so inbox writers and the comment-wake guard
    // suppress self-echo from BOTH the worker app-actor AND the orchestrator
    // app-actor. Returns a Set<string> — empty = no filter (fail-open).
    const linearBotUserIds = readLinearBotUserIds(configPath, layer2Path);
    const linearBotWriteId = readLinearBotWriteId(configPath, layer2Path); // CTL-781
    const commentInboxWriter = createCommentInboxWriter(orchDir, linearBotUserIds);
    // CTL-1365a/b: executor + dispatchFn + dispatchMode + commentWakeDispatch are
    // resolved ONCE above (before reconcileBoot) and threaded into all four dispatch
    // entry points. The monitor receives dispatchFn for its →Triage one-shot, and
    // the onComment callback routes comment-wakes through commentWakeDispatch (the
    // same executor) — no split-brain.
    monitorFn({
      orchDir,
      cache,
      dispatch: dispatchFn, // CTL-1365a: →Triage one-shot dispatch substrate (bg today)
      dispatchMode, // CTL-1367 P1: gate the SDK-occupancy term in the →Triage budget (no-op under bg)
      concurrency, // CTL-716: slot-gate uses the same ceiling as the scheduler
      botUserIds: linearBotUserIds, // CTL-781: respect-assignment gate
      botWriteId: linearBotWriteId, // CTL-781: self-assign on claim
      gateway: gatewayReader, // CTL-781: gateway-first assignee reads
      onComment: (parsed) => {
        commentInboxWriter(parsed); // CTL-749: write to inbox.jsonl for in-flight workers
        handleCommentWake(parsed, { orchDir, dispatch: commentWakeDispatch, removeLabel: defaultRemoveLabel, botUserId: linearBotUserIds, clearStall: defaultClearStall(orchDir, linearWrite) }); // CTL-549 + CTL-756 + CTL-1365b: re-dispatch parked tickets through the resolved executor; botUserId suppresses self-echo; CTL-1067: J3 stall-clear
      },
      onUpdate: createUpdateInboxWriter(orchDir, linearBotUserIds), // CTL-749
    }); // CTL-535 + CTL-565 + CTL-634 + CTL-549 + CTL-749 + CTL-716 + CTL-781
    // CTL-558: the scheduler writes Linear status via its default `writeStatus`
    // (linear-write.mjs) on every committed phase transition — no daemon wiring
    // needed; production uses the real module, tests inject fakes.
    schedulerFn({
      orchDir,
      cache,
      dispatch: dispatchFn, // CTL-1365a: scheduler pull-loop dispatch substrate (bg today)
      dispatchMode, // CTL-1365a: catalyst.dispatch.mode for the Tier-1 tick line + OTLP resource attr
      concurrency,
      configPath,
      layer2Path,
      botUserIds: linearBotUserIds, // CTL-781: respect-assignment gate
      botWriteId: linearBotWriteId, // CTL-781: self-assign on claim
      // CTL-671: arm the phantom worker-dir validity sweep + bg-liveness reader.
      // CTL-823: the sweep's existence probe consults the durable broker
      // descriptor store first (gateway-read.mjs) — a fresh not-removed
      // descriptor short-circuits "exists" with ZERO subprocess/Linear cost;
      // removed/absent/stale always fall through to the live read
      // (fresh-before-quarantine). Fail-open: any store failure behaves
      // exactly like the pre-gateway path.
      // Spread order matters: the daemon's reader is AUTHORITATIVE — callers
      // (the sweep passes { exec }) cannot accidentally drop it.
      classifyResolution: (identifier, opts = {}) =>
        classifyTicketResolution(identifier, { ...opts, gateway: gatewayReader }),
      // CTL-823: thread the reader to the scheduler's internal fetchState
      // injections (reclaim + terminal backstop) so the 60s state window is
      // live in production, not just in unit tests.
      gateway: gatewayReader,
      // CTL-1340: thread the read-replica reader (undefined unless the flag is
      // on) so the scheduler's per-signal terminal checks can resolve
      // terminal-ness from the local Catalyst-Cloud replica. undefined → inert.
      replica: replicaReader,
      isBgJobAlive,
      // CTL-1044: provide the production operator-event appender for the
      // scheduler's `appendIntentEvent` seam (scheduler.mjs:4300). Without this
      // the seam is null and the advance-shadow comparator's disagree/tick
      // events (beliefs/advance-shadow.mjs:177-198), CTL-936 intent.ineffective,
      // and executeEscalations emissions all silently no-op — the bug this fixes
      // (zero beliefs.* events ever reached the log despite the shadow window
      // running live on mini). The seam contract is a raw
      // { "event.name": string, payload: object } object, which does NOT fit
      // buildEventEnvelope's phase/action schema — hence the dedicated
      // operator-event envelope builder in recovery.mjs. startScheduler keeps
      // its null default (CTL-936 chose silence for legacy/tests).
      appendIntentEvent: defaultAppendOperatorEvent,
    }); // CTL-536 + CTL-634 + CTL-665 + CTL-671 + CTL-676 + CTL-678 + CTL-1044 — pull-loop scheduler (configPath + layer2Path enable per-tick Layer-1+Layer-2 re-read; appendIntentEvent wires operator telemetry to the event log)
    // CTL-684: start the side-car auto-tuner AFTER the scheduler so the
    // scheduler's first tick runs with the operator's current Layer-2 value
    // before any auto-tune adjustments. configPath + layer2Path are threaded
    // so the tuner can re-read the merged concurrency on every sample.
    _stopAutoTuner = startAutoTunerFn({ configPath, layer2Path });

    if (watchRegistry) {
      // Watch the execution-core dir for registry.json changes — the registry is
      // the single source of enrolled projects (CTL-582 D4). ensureState already
      // created the dir. registry.mjs writes the registry tmp+rename, so the
      // directory watch sees the rename; the filename filter ignores the noisy
      // state.json / cursor.json writes that share the directory.
      _watcher = watch(getExecutionCoreDir(), (_eventType, filename) => {
        if (filename !== null && filename !== "registry.json") return;
        // _debounceTimer is module-scoped so stopDaemon can cancel a pending
        // reconcile that would otherwise fire after teardown.
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          log.info("execution-core daemon: registry changed — reconciling");
          try {
            reconcile();
          } catch (err) {
            // A reconcile failure means registry changes silently stop being
            // applied — newly registered projects are never picked up. Surface
            // it at error level with the full error, not a swallowed warning.
            log.error(
              { err },
              "execution-core daemon: reconcile failed — registry changes are NOT being applied"
            );
          }
        }, debounceMs);
      });
    }

    if (enableReaper) {
      startReaperAndTimer({ orphanReaperConfig, worktreeRefreshConfig, stalePrRescueConfig, orphanPrSweepConfig, linearReconcileConfig, configPath, debounceMs, pollMs, orchDir, makeReaper });
    }

    // CTL-650: start the push-based session wait-state watcher. Inside the same
    // try/catch so a throw triggers PID-file cleanup via stopDaemon.
    if (enableWaitWatcher) {
      _waitWatcher = startWaitWatcher({ intervalMs: readWaitWatcherConfig().intervalMs });
    }

    // CTL-685: start the per-worker memory sampler. Inside the same try/catch so
    // a throw triggers PID-file cleanup via stopDaemon.
    if (enableMemorySampler) {
      _memorySampler = startMemorySampler();
    }

    // CTL-1165 D5: start the pre-exhaustion fleet-health probe. EMIT-ONLY by
    // default (self-heal default OFF — first ship is a pure alert). Inside the
    // same try/catch so a throw triggers PID-file cleanup via stopDaemon. The
    // config is resolved WITH configPath (mirroring readOrphanReaperConfig) so
    // the documented Layer-1 catalyst.orchestration.fleetHealth knobs — enable,
    // thresholds, and selfHealEnabled — actually take effect in production, and
    // is passed to the probe so it reads the SAME resolved thresholds.
    const fleetHealthConfig = readFleetHealthConfig(configPath);
    if (enableFleetHealth ?? fleetHealthConfig.enabled) {
      _fleetHealthProbe = startFleetHealthProbe({ orchDir, config: fleetHealthConfig });
    }

    // CTL-787: start the account-level rate-limit usage poller. Inside the same
    // try/catch so a throw triggers PID-file cleanup via stopDaemon.
    if (enableRatelimitPoller) {
      _ratelimitPoller = startRatelimitPoller();
    }

    // CTL-859: start the node-heartbeat emitter. Appends a node.heartbeat event
    // to the unified event log every HEARTBEAT_INTERVAL_MS so a future liveness
    // reader (readClusterHeartbeats) can detect a dead node by heartbeat
    // silence. ADDITIVE/dormant — pure observability, no behavior consumes it
    // yet. Inside the same try/catch so a throw triggers PID-file cleanup.
    if (enableHeartbeat) {
      // CTL-1322: supply the live admission-state closure so each heartbeat carries
      // { accepting, holdReason, effectiveCapacity, activeWorkers } — computed from
      // the same gate source fns the scheduler enforces (orchDir + concurrency are
      // both in scope here). Fail-open: readAdmissionState never throws.
      _heartbeat = startHeartbeat({
        admissionFn: () => readAdmissionState({ orchDir, concurrency }),
      });
      // CTL-1090: cross-host liveness publisher (multi-host only; single-host no-op).
      // startLivenessPublisher self-gates on roster.length > 1, so this is always safe.
      _livenessPublisher = startLivenessPublisher({ orchDir });
    }

    // CTL-1274: cluster-repo auto-pull. Refresh the catalyst-cluster clone at boot
    // (clusterSync = pull + decrypt secrets) and then on a periodic timer
    // (pullClusterRepo = git pull --ff-only) so a roster change committed on one
    // node (cluster cli) propagates to this running daemon — the next scheduler
    // tick re-reads cluster.json.roster. FAIL-OPEN: both calls already swallow
    // errors and return a status object (never throw); the extra try/catch here
    // is belt-and-suspenders so a cluster-sync hiccup can NEVER abort daemon boot
    // or wedge a timer tick. A pull is a no-op ("not-a-clone") when no clone exists.
    if (enableClusterSync) {
      try {
        const bootSync = clusterSync();
        log.info({ pull: bootSync?.pull }, "execution-core daemon: cluster-repo synced at boot");
      } catch (err) {
        log.warn({ err: err?.message }, "execution-core daemon: boot cluster-sync threw (continuing)");
      }
      _clusterSyncTimer = setInterval(() => {
        try {
          pullClusterRepo();
        } catch (err) {
          log.warn({ err: err?.message }, "cluster-sync timer: pull threw (continuing)");
        }
      }, clusterSyncIntervalMs);
      _clusterSyncTimer.unref?.();
    }
  } catch (err) {
    stopDaemon();
    throw err;
  }

  // CTL-854: a fresh/headless host whose registry was never written boots a
  // perfectly healthy-looking daemon that dispatches NOTHING. Surface it once
  // at startup (not per-reconcile) with the recovery verb so the operator has
  // an actionable signal rather than a silent idle daemon.
  try {
    if (listProjectsFn().length === 0) {
      log.warn(
        { registry: getRegistryPath() },
        "execution-core daemon: registry has 0 projects — nothing will be dispatched. " +
          "Enroll a project: `catalyst-execution-core register --team <TEAM> --repo-root <path>`",
      );
    }
  } catch (err) {
    log.warn({ err }, "execution-core daemon: registry health check failed (continuing)");
  }

  // CTL-862 / CTL-1271: resolve + ANNOUNCE the cluster roster at boot. The
  // daemon partitions work by this roster, so it must state what it resolved AND
  // where that came from — and NEVER silently degrade to a one-node cluster (the
  // bug that quietly evicted mini-2). resolveClusterHosts returns the single
  // precedence (anchor → static → hosts-fallback → single-host) shared with
  // getClusterHosts, so the boot announcement can never disagree with what the
  // scheduler actually uses.
  //
  // bootHosts (the CTL-862 ownership-log test seam) wins when injected; bootResolve
  // is the CTL-1271 seam for asserting source/multiHost; otherwise resolve for real.
  const resolved =
    bootResolve ??
    (bootHosts
      ? { hosts: bootHosts, source: "injected", multiHost: bootHosts.length > 1 }
      : resolveClusterHosts());
  const bootRoster = resolved.hosts;
  const bootSource = resolved.source;
  const bootMultiHost = resolved.multiHost;
  // CTL-1093: resolve sticky/pinned identity before computing bootSelf so
  // every downstream emitter and child sees the converged coordination name.
  // Feeds off the CTL-1271 roster resolution above (bootMultiHost) so the
  // identity decision and the boot announcement share one source of truth.
  const _stickyDir = getCatalystRepoDir();
  const _ident = resolveBootIdentity({
    pinned: isHostNamePinnedFromConfig(),
    resolvedName: bootHostName ?? getHostName(),
    sticky: readStickyIdentity({ dir: _stickyDir }),
    multiHost: bootMultiHost,
  });
  if (_ident.warning) log.warn({ host: _ident.name, roster: bootRoster }, _ident.warning);
  if (_ident.action === "record" || _ident.action === "restore") {
    writeStickyIdentity({ dir: _stickyDir, name: _ident.name });
  }
  // Inject into env so phase-agent-dispatch (child process) inherits the pinned name
  // via CATALYST_HOST_NAME → catalyst_host_name (host-identity.sh). Only set when
  // not already env-pinned so an explicit operator override always wins and the
  // intentional per-tick getHostName() Layer-2 re-read is preserved. CTL-1093.
  if (_ident.action !== "noop" && !process.env.CATALYST_HOST_NAME) {
    process.env.CATALYST_HOST_NAME = _ident.name;
  }
  const bootSelf = _ident.action === "noop" ? (bootHostName ?? getHostName()) : _ident.name;
  const bootEligible = readAllEligible();
  const bootOwns = bootEligible.filter((t) => ownedBy(t.identifier, bootRoster, bootSelf)).length;

  // CTL-1271: a multi-host configuration that resolves to a single-host roster is
  // a SILENT eviction — every peer drops out of HRW and this node owns the whole
  // fleet's work. Detect "multi-host was EXPECTED" (an anchor or a static roster
  // is configured) but the resolution yielded single-host, and warn LOUDLY (not a
  // hard refuse — a transient Linear blip must not block boot; FAIL-OPEN already
  // kept the prior roster on the read seam). A legitimately single-host install
  // (no anchor, no static) stays SILENT — single-host is a valid, expected state.
  const anchorConfigured = Boolean(getLivenessAnchorIssue());
  const staticConfigured = Boolean(getStaticRoster());
  const multiHostExpected = anchorConfigured || staticConfigured;
  if (multiHostExpected && !bootMultiHost) {
    log.warn(
      {
        roster: bootRoster,
        source: bootSource,
        anchorConfigured,
        staticConfigured,
        host: bootSelf,
      },
      "execution-core daemon: multi-host was configured (cluster anchor / static roster) " +
        "but the roster resolved to a SINGLE host — this node will own the ENTIRE fleet's " +
        "work under HRW. Check the cluster anchor is reachable and enrolled " +
        "(`catalyst cluster status`).",
    );
  }
  // CTL-1084: emit a structured node.boot event so catalyst-stack status can
  // prove what the restart did (version, effective flags, adopted/cleared/rewalk counts).
  // Fail-open — emitBootEvent never throws. Kept alongside the pino log (not replacing it).
  emitBootEvent({
    summary: {
      adoptedWorkers:   _bootReport?.workers?.running?.length ?? 0,
      zombiesCleared:   (_bootReport?.workers?.dead?.length ?? 0) + (_bootReport?.workers?.unknown?.length ?? 0),
      rewalkPlanned:    _bootResume?.planned    ?? _bootResume?.dispatched ?? 0,
      rewalkDispatched: _bootResume?.dispatched ?? 0,
    },
  });
  // CTL-1271: announce roster + source + multiHost at boot so an operator can
  // always read what the daemon resolved and where it came from.
  log.info(
    {
      orchDir,
      host: bootSelf,
      owns: bootOwns,
      eligible: bootEligible.length,
      roster: bootRoster,
      source: bootSource,
      multiHost: bootMultiHost,
    },
    "execution-core daemon started"
  );
}

// startReaperAndTimer — wire the Reaper (CTL-649 Phase 4) and the periodic
// orphan-reaper timer (CTL-649 Phase 9) into the daemon. The reaper consumes
// `*.reap-requested` lines appended to the canonical event log by yielding
// workers, supersede paths, abort-worker, and PR-merged cleanup — and runs
// the appropriate executor for each.
//
// Boot replay is best-effort: if it throws, log and continue with live
// consumption only.
function startReaperAndTimer({
  orphanReaperConfig,
  worktreeRefreshConfig,
  stalePrRescueConfig,
  orphanPrSweepConfig,
  linearReconcileConfig,
  configPath,
  debounceMs,
  orchDir,
  // CTL-769: poll-fallback interval. Defaults to TAILER_POLL_INTERVAL_MS
  // (env-tunable via EXECUTION_CORE_TAILER_POLL_MS); injectable so tests can
  // drive the drain on a tiny interval deterministically.
  pollMs = TAILER_POLL_INTERVAL_MS,
  // CTL-769: reaper factory seam. Defaults to the real Reaper; injectable so a
  // test can observe that the poll-fallback timer (not an fs.watch event)
  // dispatched a reap-requested line into reaper.handle().
  makeReaper = (opts) => new Reaper(opts),
}) {
  const eventLogPath = getEventLogPath();
  // CTL-649: the periodic sweep honors the configured recency floor
  // (minIdleSeconds, default 900s). includeInteractive stays at its safe
  // default false — the daemon never opts into reaping human sessions.
  // CTL-661: bind the per-ticket reconciler's canonical-owner reader to this
  // daemon's orchDir so the sweep resolves the authoritative active-phase
  // bg_job_id (falling back to newest-by-last_seen when no signal is found).
  // CTL-1165 D2: construct the production orphan child-process reaper and inject
  // it into the Reaper. DEFAULT mode:"shadow" (emits procOrphans.would-reap, kills
  // NOTHING) so the allowlist + LIVE_TREE correlation bakes on mini before any
  // enforce flip — exactly like stall-janitor (CTL-1004) and cost-cap (CTL-1137).
  // mode/graceMs/worktreeRoot/allowlistPatterns come from
  // orphanReaper.procReaper; the daemon's own pid is on the never-kill list
  // (selfPid defaults to process.pid; broker/monitor are covered by the argv
  // allowlist patterns). A disabled config ("off") makes every sweep an empty
  // no-op.
  const procCfg = orphanReaperConfig?.procReaper ?? {};
  const procReaper = new ProcReaper({
    mode: procCfg.mode ?? "shadow",
    ...(procCfg.graceMs != null ? { graceMs: Number(procCfg.graceMs) } : {}),
    ...(procCfg.minEtimeSec != null ? { minEtimeSec: Number(procCfg.minEtimeSec) } : {}),
    ...(procCfg.worktreeRoot ? { worktreeRoot: procCfg.worktreeRoot } : {}),
    ...(Array.isArray(procCfg.allowlistPatterns)
      ? { allowlistPatterns: procCfg.allowlistPatterns }
      : {}),
    daemonPids: [process.pid],
    log,
  });

  _reaper = makeReaper({
    minIdleMs: (orphanReaperConfig?.minIdleSeconds ?? 900) * 1000,
    readActivePhaseSignal: (ticket) => defaultReadActivePhaseSignal(orchDir, ticket),
    readSignalBgJobId: (ticket, phase) => defaultReadSignalBgJobId(orchDir, ticket, phase),
    // CTL-1218 Part A: thread the LIVE orchDir (~/catalyst/execution-core) as a
    // provenance root alongside the legacy ~/catalyst/runs/ dirs. Without this the
    // gate scans only listOrchDirs() and reads every daemon-created worktree as
    // "unknown-provenance" → defer forever. ...listOrchDirs() preserves legacy
    // orchestrator-created provenance detection.
    assessWorktreeRemoval: (event) =>
      defaultAssessWorktreeRemoval(event, undefined, [orchDir, ...listOrchDirs()]),
    procReaper,
  });

  // Boot replay: cover for any intents that landed while the daemon was down.
  _reaper.bootReplay(eventLogPath).catch((err) => {
    log.error({ err }, "reaper: bootReplay threw");
  });
  // Initialize the cursor to the current tail so the live-tail loop only
  // sees lines appended AFTER the replay completed. Reset the leftover too, or
  // a stale partial line from a previous daemon run would be stitched onto the
  // first live read.
  _eventLogLeftover = "";
  try {
    if (existsSync(eventLogPath)) _eventLogCursor = statSync(eventLogPath).size;
  } catch {
    _eventLogCursor = 0;
  }

  // fs.watch the events dir; on rename/change to the current month's file,
  // debounce-read the new tail and hand each parsed line to reaper.handle().
  const eventsDir = dirname(eventLogPath);
  const targetName = basename(eventLogPath);
  try {
    mkdirSync(eventsDir, { recursive: true });
    _eventWatcher = watch(eventsDir, (_evt, filename) => {
      if (filename !== null && filename !== targetName) return;
      clearTimeout(_eventDebounceTimer);
      _eventDebounceTimer = setTimeout(() => consumeEventTail(), debounceMs);
    });
  } catch (err) {
    log.error({ err }, "reaper: event-log watch failed — relying on boot replay only");
  }

  // CTL-769: fs.watch + debounce is perpetually reset by the continuously-
  // appended unified event log, so consumeEventTail only fires during >5s idle
  // gaps — the reaper starves exactly when workers are busy and predecessors
  // accumulate. Mirror the new-work tailer's poll fallback (monitor.mjs:684-685,
  // CTL-711): a cheap, idempotent, cursor-based poll drains reap-intents in ~2s
  // instead of waiting up to the 600s reconcile sweep.
  if (pollMs > 0) {
    _eventPollTimer = setInterval(() => consumeEventTail(), pollMs);
  }

  const cfg = orphanReaperConfig ?? {};
  // CTL-1165 D3: bind the real ~/.claude/jobs/<id> dir GC onto the same 600s
  // orphan-reaper cadence (no new daemon timer). Default-on; an operator can
  // disable via .catalyst → orphanReaper.jobGc.enabled:false. retention/batchCap
  // come from config (env still wins inside sweepJobDirs's defaults). A no-op
  // async closure is bound when disabled so the timer's Promise.all stays
  // uniform.
  const jobGcCfg = cfg.jobGc ?? {};
  const jobGcEnabled = jobGcCfg.enabled !== false;
  const jobGc = jobGcEnabled
    ? () =>
        sweepJobDirs({
          jobsRoot: getJobsRoot(),
          readAgents: () => listClaudeAgentsResult(),
          ...(jobGcCfg.retentionSeconds != null
            ? { retentionMs: Number(jobGcCfg.retentionSeconds) * 1000 }
            : {}),
          ...(jobGcCfg.batchCap != null ? { batchCap: Number(jobGcCfg.batchCap) } : {}),
        })
    : async () => {};
  // CTL-1205: bind the real execution-core/workers/<TICKET>/ dir GC onto the same
  // 600s orphan-reaper cadence (no new daemon timer). Default-on; disable via
  // .catalyst → orphanReaper.workerGc.enabled:false. retention/batchCap come from
  // config (env CATALYST_WORKER_GC_RETENTION_SECONDS / CATALYST_WORKER_GC_BATCH_CAP
  // still win inside sweepWorkerDirs's defaults).
  const workerGcCfg = cfg.workerGc ?? {};
  const workerGcEnabled = workerGcCfg.enabled !== false;
  const workerGc = workerGcEnabled
    ? () =>
        sweepWorkerDirs({
          orchDir,
          readAgents: () => listClaudeAgentsResult(),
          ...(workerGcCfg.retentionSeconds != null
            ? { retentionMs: Number(workerGcCfg.retentionSeconds) * 1000 }
            : {}),
          ...(workerGcCfg.batchCap != null ? { batchCap: Number(workerGcCfg.batchCap) } : {}),
        })
    : async () => {};
  // CTL-1218 Part C: bind the wt-cleanup-queue drain onto the same 600s cadence (no
  // new daemon timer). Default-on; disable via .catalyst → orphanReaper.wtCleanupDrain
  // .enabled:false. The drain reads ~/catalyst/wt-cleanup-queue/*.json, clears markers
  // for already-gone worktrees, and re-runs the CTL-791 gated teardown (NEVER --force)
  // for survivors — confirming merge first (fail-closed).
  const drainCfg = cfg.wtCleanupDrain ?? {};
  const drainEnabled = drainCfg.enabled !== false;
  const wtCleanupDrain = drainEnabled
    ? () =>
        sweepWtCleanupQueue({
          orchDir,
          ...(drainCfg.batchCap != null ? { batchCap: Number(drainCfg.batchCap) } : {}),
        })
    : async () => {};
  _orphanTimer = startOrphanReaperTimer({
    enabled: cfg.enabled !== false,
    intervalSeconds: cfg.intervalSeconds ?? 600,
    jobGc,
    workerGc,
    wtCleanupDrain, // CTL-1218
  });

  // CTL-707: start the periodic worktree-refresh timer.
  const refreshCfg = worktreeRefreshConfig ?? {};
  if (refreshCfg.enabled !== false) {
    _refreshTimer = startWorktreeRefreshTimer({
      enabled: true,
      intervalSeconds: refreshCfg.intervalSeconds ?? 300,
      quietSeconds: refreshCfg.quietSeconds ?? 30,
      orchDir,
    });
  }

  // CTL-1331: start the async board-health delegate runner timer. Gated by
  // CATALYST_DELEGATE_RUNNER — readDelegateRunnerConfig().mode resolves "off"
  // unless board-health is enforce, so Phase A is inert: startDelegateRunnerTimer
  // returns a no-op { stop } handle and nothing drains. When "on" (Phase B), the
  // timer kicks a DETACHED child each interval that does the heavy
  // worktree-provision + `claude --bg` off the daemon event loop. (Phase B also
  // wires CATALYST_EXECUTION_CORE_DIR onto the child spawn so the entry resolves
  // orchDir; until then a forced-on child fails safe — "no orchDir" → exit 0.)
  const delegateRunnerCfg = readDelegateRunnerConfig();
  _delegateRunnerTimer = startDelegateRunnerTimer({
    enabled: delegateRunnerCfg.mode === "on",
    intervalMs: delegateRunnerCfg.intervalMs,
    orchDir,
  });

  // CTL-782: start the periodic stale/conflicting-PR rescue timer.
  // No orchId / linearWrite threading needed: the timer derives the per-ticket
  // orchestrator id from the phase signal's `.orchestrator` (orchId === ticket
  // convention — the daemon has no global orch id), and defaults linearWrite
  // to the real linear-write module so escalations reach the needs-human queue.
  const rescueCfg = stalePrRescueConfig ?? {};
  if (rescueCfg.enabled !== false) {
    _stalePrRescueTimer = startStalePrRescueTimer({
      enabled: true,
      intervalSeconds: rescueCfg.intervalSeconds ?? RESCUE_DEFAULTS.intervalSeconds,
      orchDir,
      config: rescueCfg,
    });
  }

  // CTL-1175: start the periodic orphan-PR detect+notify sweep timer.
  const orphanCfg = orphanPrSweepConfig ?? {};
  if (orphanCfg.enabled !== false) {
    _orphanPrSweepTimer = startOrphanPrSweepTimer({
      enabled: true,
      intervalSeconds: orphanCfg.intervalSeconds ?? ORPHAN_DEFAULTS.intervalSeconds,
      orchDir,
      config: orphanCfg,
    });
  }

  // CTL-1371: start the periodic PR→Linear state reconcile timer. OPT-IN
  // (default-off): unlike the read-only/notify twins above this can WRITE Linear
  // state, so it only starts when mode is explicitly 'notify' or 'write'. Runs on
  // the daemon event loop, fully separate from schedulerTick (cannot trip the
  // CTL-671 runaway guards). Ship 'notify' first; flip to 'write' once the
  // emitted drift events read clean.
  const reconcileCfg = linearReconcileConfig ?? {};
  const reconcileMode = reconcileCfg.mode ?? "off";
  if (reconcileMode === "notify" || reconcileMode === "write") {
    _linearReconcileTimer = startLinearReconcileTimer({
      enabled: true,
      mode: reconcileMode,
      intervalSeconds: reconcileCfg.intervalSeconds,
      orchDir,
      configPath,
      config: reconcileCfg,
    });
  }
}

// parseEventTailChunk — pure, deterministic split of a freshly-read byte chunk
// into complete JSON events plus the trailing partial line. CTL-673 moved the
// implementation to the leaf module event-tail.mjs (shared with event-scan.mjs
// and reaper.mjs). It is imported for consumeEventTail's local use AND
// re-exported here unchanged so daemon.test.mjs keeps importing it from daemon.mjs.
export { parseEventTailChunk };

// __resetEventTailCursorForTest — reset the module-level byte cursor + leftover
// so a test can drive consumeEventTail deterministically against a temp file
// from a known starting offset. Test-only; not used by production code.
export function __resetEventTailCursorForTest(cursor = 0, leftover = "") {
  _eventLogCursor = cursor;
  _eventLogLeftover = leftover;
}

// __getEventTailLeftoverForTest — inspect the carried partial line. Test-only.
export function __getEventTailLeftoverForTest() {
  return _eventLogLeftover;
}

// __getEventPollTimerForTest — inspect the CTL-769 poll-fallback interval handle
// so a test can pin its teardown directly (non-null while running, null after
// stopDaemon) instead of inferring it from drain side-effects, which the
// `_reaper = null` guard in stopDaemon would otherwise mask. Test-only.
export function __getEventPollTimerForTest() {
  return _eventPollTimer;
}

// consumeEventTail — read the NEW BYTES appended to the event log since the
// cursor last advanced (via a file descriptor, exactly like monitor.mjs's
// proven tailer), parse each complete line, and dispatch to the reaper.
//
// `path` and `reaper` are injectable for deterministic tests; production passes
// neither and falls back to the module-level event log + reaper instance.
export function consumeEventTail({ path = getEventLogPath(), reaper = _reaper } = {}) {
  if (!reaper) return;
  let fd;
  let size;
  try {
    fd = openSync(path, "r");
    size = fstatSync(fd).size;
  } catch {
    // Log file not yet created or a transient stat error — best-effort.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
    return;
  }

  if (size < _eventLogCursor) {
    // File rotated or truncated — restart from 0 and drop any partial line
    // stitched from the now-vanished bytes.
    _eventLogCursor = 0;
    _eventLogLeftover = "";
  }
  if (size === _eventLogCursor) {
    closeSync(fd);
    return;
  }

  let chunk;
  try {
    const newByteCount = size - _eventLogCursor;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, _eventLogCursor);
    closeSync(fd);
    chunk = buf.toString("utf8");
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* fd already gone */
    }
    log.error({ err }, "reaper: event-log read failed");
    return;
  }
  _eventLogCursor = size;

  const { events, leftover } = parseEventTailChunk(chunk, _eventLogLeftover);
  _eventLogLeftover = leftover;
  for (const event of events) {
    reaper.handle(event).catch((err) => {
      log.error({ err, event: event.event }, "reaper: handle threw");
    });
  }
}

// stopDaemon — tear down the watcher, the pending debounce, the composed
// monitor + scheduler, and the PID file. Idempotent and safe to call when
// nothing is running.
export function stopDaemon() {
  if (_watcher) {
    try {
      _watcher.close();
    } catch {
      /* watcher already closed */
    }
    _watcher = null;
  }
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_stopMonitor) {
    try {
      _stopMonitor();
    } catch {
      /* monitor not running */
    }
  }
  if (_stopScheduler) {
    try {
      _stopScheduler();
    } catch {
      /* scheduler not running */
    }
  }
  // CTL-649: tear down reaper + orphan timer + event-log watcher.
  if (_eventWatcher) {
    try {
      _eventWatcher.close();
    } catch {
      /* already closed */
    }
    _eventWatcher = null;
  }
  if (_eventDebounceTimer) {
    clearTimeout(_eventDebounceTimer);
    _eventDebounceTimer = null;
  }
  if (_eventPollTimer) {
    clearInterval(_eventPollTimer);
    _eventPollTimer = null;
  }
  if (_livenessTimer) {
    clearInterval(_livenessTimer);
    _livenessTimer = null;
  }
  if (_orphanTimer) {
    try {
      _orphanTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _orphanTimer = null;
  }
  if (_refreshTimer) {
    try {
      _refreshTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _refreshTimer = null;
  }
  // CTL-1331: stop the delegate runner timer (no-op handle when gated off).
  if (_delegateRunnerTimer) {
    try {
      _delegateRunnerTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _delegateRunnerTimer = null;
  }
  if (_stalePrRescueTimer) {
    try {
      _stalePrRescueTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _stalePrRescueTimer = null;
  }
  if (_orphanPrSweepTimer) {
    try {
      _orphanPrSweepTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _orphanPrSweepTimer = null;
  }
  if (_linearReconcileTimer) {
    try {
      _linearReconcileTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _linearReconcileTimer = null;
  }
  _reaper = null;
  // CTL-650: stop the wait-state watcher.
  if (_waitWatcher) {
    try {
      _waitWatcher.stop();
    } catch {
      /* watcher already stopped */
    }
    _waitWatcher = null;
  }
  // CTL-685: stop the per-worker memory sampler.
  if (_memorySampler) {
    try {
      _memorySampler.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: memory-sampler stop failed");
    }
    _memorySampler = null;
  }
  // CTL-1165 D5: stop the pre-exhaustion fleet-health probe.
  if (_fleetHealthProbe) {
    try {
      _fleetHealthProbe.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: fleet-health-probe stop failed");
    }
    _fleetHealthProbe = null;
  }
  // CTL-787: stop the account-level rate-limit usage poller.
  if (_ratelimitPoller) {
    try {
      _ratelimitPoller.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: ratelimit-poller stop failed");
    }
    _ratelimitPoller = null;
  }
  // CTL-859: stop the node-heartbeat emitter.
  if (_heartbeat) {
    try {
      _heartbeat.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: heartbeat stop failed");
    }
    _heartbeat = null;
  }
  // CTL-1090: stop the cross-host liveness publisher.
  if (_livenessPublisher) {
    try {
      _livenessPublisher.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: liveness-publisher stop failed");
    }
    _livenessPublisher = null;
  }
  // CTL-1274: stop the cluster-repo auto-pull timer.
  if (_clusterSyncTimer) {
    clearInterval(_clusterSyncTimer);
    _clusterSyncTimer = null;
  }
  // CTL-684: stop the auto-tuner.
  if (_stopAutoTuner) {
    try {
      _stopAutoTuner();
    } catch {
      /* tuner already stopped */
    }
    _stopAutoTuner = null;
  }
  _eventLogCursor = 0;
  _eventLogLeftover = "";
  if (_pidFile) {
    try {
      unlinkSync(_pidFile);
    } catch {
      /* pid file already gone */
    }
    _pidFile = null;
  }
  log.info("execution-core daemon stopped");
}

// resolveBootConcurrency — CTL-678. Build the concurrency object the daemon
// threads at boot by merging the committed Layer-1 seed under the
// machine-canonical Layer-2 override. Layer-2 wins per valid integer field;
// absent Layer-2 fields fall back to Layer-1; absent in both yields {} (the
// legacy empty-concurrency path preserved end-to-end). Pure helper — CTL-676's
// hot-reload work can re-invoke it from a watch handler without refactor.
export function resolveBootConcurrency({ layer1Path, layer2Path }) {
  const layer1 = readExecutionCoreConcurrency(layer1Path);
  const layer2 = readExecutionCoreConcurrencyLayer2(layer2Path);
  return mergeExecutionCoreConcurrency(layer1, layer2);
}

function main() {
  const idx = process.argv.indexOf("--pid-file");
  const pidFile = idx >= 0 ? process.argv[idx + 1] : null;

  // CTL-649 Phase 9: thread the periodic-reaper config from .catalyst/config.json
  // into the timer. Path is env-overridable (CATALYST_CONFIG_FILE); otherwise
  // the daemon reads the launch-cwd's config. Absent/partial config falls back
  // to the built-in defaults (enabled, 600s) inside startReaperAndTimer.
  const configPath =
    process.env.CATALYST_CONFIG_FILE || resolve(process.cwd(), ".catalyst", "config.json");
  const orphanReaperConfig = readOrphanReaperConfig(configPath);
  // CTL-707: read the worktree-refresh config from the same config file.
  const worktreeRefreshConfig = readWorktreeRefreshConfig(configPath);
  // CTL-782: read the stale-PR-rescue config from the same config file.
  const stalePrRescueConfig = readStalePrRescueConfig(configPath);
  // CTL-1175: read the orphan-PR sweep config from the same config file.
  const orphanPrSweepConfig = readOrphanPrSweepConfig(configPath);
  // CTL-665 / CTL-678: resolve the executionCore concurrency knobs once here
  // and thread them into startDaemon → scheduler + boot-resume. The
  // machine-canonical Layer-2 file (~/.config/catalyst/config.json) wins
  // per-field over the committed Layer-1 seed; absent/partial in both yields
  // {} → the scheduler falls back to state.json + the hardcoded default. The
  // env var CATALYST_LAYER2_CONFIG_FILE overrides the Layer-2 path for tests.
  const layer2Path =
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json");
  // CTL-1371: reconcile config is node-scoped — Layer-2 (+ CATALYST_RECONCILE_MODE
  // env) overrides the committed Layer-1 seed so an operator can flip the writer
  // off/notify/write per node.
  const linearReconcileConfig = readLinearReconcileConfig(configPath, layer2Path);
  const concurrency = resolveBootConcurrency({ layer1Path: configPath, layer2Path });
  log.info(
    { concurrency, layer2Present: existsSync(layer2Path) },
    "execution-core: resolved boot concurrency"
  );

  // A post-startup throw (a monitor/scheduler timer callback, the watcher)
  // must not leave a half-dead daemon holding a valid PID file — that makes
  // every health check lie. Exit non-zero with a tagged fatal log instead.
  const fatal = (label) => (err) => {
    log.error({ err }, `execution-core daemon: ${label} — exiting`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled rejection"));

  try {
    startDaemon({ pidFile, orphanReaperConfig, worktreeRefreshConfig, stalePrRescueConfig, orphanPrSweepConfig, linearReconcileConfig, concurrency, configPath, layer2Path }); // CTL-676 + CTL-678 + CTL-707 + CTL-782 + CTL-1175 + CTL-1371
  } catch (err) {
    log.error({ err }, "execution-core daemon: failed to start");
    process.exit(1);
  }

  const shutdown = (sig) => {
    log.info({ sig }, "execution-core daemon shutting down");
    stopDaemon();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run main() only on direct invocation, never when imported as a module
// (daemon.test.mjs imports startDaemon/stopDaemon without triggering main()).
if (import.meta.main) main();
