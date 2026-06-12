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
  getRegistryPath,
  getEventLogPath,
  log,
  EVENT_DEBOUNCE_MS,
  TAILER_POLL_INTERVAL_MS,
  readWaitWatcherConfig,
  readMemorySamplerConfig,
  readRatelimitPollerConfig,
  getHostName,      // CTL-862
  getClusterHosts,  // CTL-862
} from "./config.mjs";
import { ownedBy } from "./hrw.mjs"; // CTL-862: HRW ownership filter
import { startWaitWatcher as realStartWaitWatcher } from "./wait-watcher.mjs";
import { startMemorySampler as realStartMemorySampler } from "./memory-sampler.mjs";
import { startRatelimitPoller as realStartRatelimitPoller } from "./ratelimit-poller.mjs";
import { listProjects as realListProjects } from "./registry.mjs"; // CTL-854: boot health check
import { startHeartbeat as realStartHeartbeat } from "./heartbeat-event.mjs"; // CTL-859: node.heartbeat emitter
import {
  recoverStartup,
  startMonitor,
  stopMonitor,
  startScheduler,
  stopScheduler,
  reconcileAll,
  createTicketStateCache,
} from "./index.mjs";
import { Reaper, defaultReadActivePhaseSignal, defaultReadSignalBgJobId } from "./reaper.mjs";
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";
import {
  startWorktreeRefreshTimer,
  readWorktreeRefreshConfig,
} from "./worktree-refresh-timer.mjs";
import {
  startStalePrRescueTimer,
  readStalePrRescueConfig,
} from "./stale-pr-rescue-timer.mjs";
import { DEFAULTS as RESCUE_DEFAULTS } from "./stale-pr-rescue.mjs";
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
import { dispatchTicket } from "./dispatch.mjs"; // CTL-549: comment-wake re-dispatch
import { removeLabel as defaultRemoveLabel } from "./linear-write.mjs"; // CTL-549: clear needs-human on resume
// CTL-671: the real phantom-sweep seams. startScheduler defaults them to safe
// no-ops (hermetic for direct-call unit tests); the REAL daemon arms them here
// so the phantom worker-dir validity sweep is operative in production.
import { classifyTicketResolution } from "./linear-query.mjs";
import { createGatewayReader } from "./gateway-read.mjs";
import { isBgJobAlive, refreshAgents } from "./claude-agents.mjs";

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
// CTL-782: periodic stale/conflicting-PR rescue timer.
let _stalePrRescueTimer = null;
// CTL-650: the push-based session wait-state watcher handle.
let _waitWatcher = null;
// CTL-685: per-worker memory sampler handle.
let _memorySampler = null;
// CTL-787: account-level rate-limit usage poller handle.
let _ratelimitPoller = null;
// CTL-859: node-heartbeat emitter handle (distributed-coordination foundation).
let _heartbeat = null;
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
  // CTL-650: the session wait-state watcher. Injectable for tests; gated by a
  // config knob (default-on, CATALYST_WAIT_WATCHER=0 disables) like the reaper.
  startWaitWatcher = realStartWaitWatcher,
  enableWaitWatcher = readWaitWatcherConfig().enabled,
  // CTL-685: per-worker memory sampler. Injectable for tests; gated by a config
  // knob (default-on, CATALYST_MEMORY_SAMPLER=0 disables) like the wait-watcher.
  startMemorySampler = realStartMemorySampler,
  enableMemorySampler = readMemorySamplerConfig().enabled,
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
  try {
    // CTL-539 — rebuild routing + worker state on boot. CTL-654: capture the
    // RecoveryReport (previously discarded) so the boot-resume pass can consume
    // its `coldStart` verdict + worker buckets.
    const report = recover({ orchDir });
    // CTL-654: boot-resume — on a cold start, re-dispatch in-flight tickets whose
    // worktree has no live --bg worker, BEFORE the monitor/scheduler start. This
    // bypasses the per-tick reclaim sweep's revive budget (a clean reboot is not
    // a chronic-failure storm) and is bounded by maxParallel so a reboot never
    // spawns a worker storm. Synchronous and inside the same try/catch so a throw
    // still triggers PID-file cleanup. A non-cold-start restart is a no-op.
    reconcileBoot({ orchDir, report, concurrency }); // CTL-665: config-first boot-resume ceiling
    // CTL-644: dispatch any gated tickets that already have an approval sentinel on disk
    // (operator may have dropped the sentinel while the daemon was down).
    processApprovedResumes({ orchDir });
    // CTL-634: one shared TTL state cache. The monitor write-through populates
    // it on every state_changed event; the scheduler read path consults it
    // during out-of-set blocker hydration. A single instance threaded into
    // both is what turns a write-through into a guaranteed next-tick hit.
    const cache = createTicketStateCache();
    // CTL-823: readonly client over the broker's durable descriptor store
    // (~/catalyst/filter-state.db). Fail-open — see gateway-read.mjs.
    const gatewayReader = createGatewayReader();
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
    monitorFn({
      orchDir,
      cache,
      concurrency, // CTL-716: slot-gate uses the same ceiling as the scheduler
      botUserIds: linearBotUserIds, // CTL-781: respect-assignment gate
      botWriteId: linearBotWriteId, // CTL-781: self-assign on claim
      gateway: gatewayReader, // CTL-781: gateway-first assignee reads
      onComment: (parsed) => {
        commentInboxWriter(parsed); // CTL-749: write to inbox.jsonl for in-flight workers
        handleCommentWake(parsed, { orchDir, dispatch: dispatchTicket, removeLabel: defaultRemoveLabel, botUserId: linearBotUserIds, clearStall: defaultClearStall(orchDir, linearWrite) }); // CTL-549 + CTL-756: re-dispatch parked tickets; botUserId suppresses self-echo; CTL-1067: J3 stall-clear
      },
      onUpdate: createUpdateInboxWriter(orchDir, linearBotUserIds), // CTL-749
    }); // CTL-535 + CTL-565 + CTL-634 + CTL-549 + CTL-749 + CTL-716 + CTL-781
    // CTL-558: the scheduler writes Linear status via its default `writeStatus`
    // (linear-write.mjs) on every committed phase transition — no daemon wiring
    // needed; production uses the real module, tests inject fakes.
    schedulerFn({
      orchDir,
      cache,
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
      startReaperAndTimer({ orphanReaperConfig, worktreeRefreshConfig, stalePrRescueConfig, debounceMs, pollMs, orchDir, makeReaper });
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
      _heartbeat = startHeartbeat();
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

  // CTL-862: report HRW ownership at boot for multi-host observability.
  const bootRoster = bootHosts ?? getClusterHosts();
  const bootSelf = bootHostName ?? getHostName();
  const bootEligible = readAllEligible();
  const bootOwns = bootEligible.filter((t) => ownedBy(t.identifier, bootRoster, bootSelf)).length;
  log.info(
    { orchDir, host: bootSelf, owns: bootOwns, eligible: bootEligible.length, roster: bootRoster },
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
  _reaper = makeReaper({
    minIdleMs: (orphanReaperConfig?.minIdleSeconds ?? 900) * 1000,
    readActivePhaseSignal: (ticket) => defaultReadActivePhaseSignal(orchDir, ticket),
    readSignalBgJobId: (ticket, phase) => defaultReadSignalBgJobId(orchDir, ticket, phase),
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
  _orphanTimer = startOrphanReaperTimer({
    enabled: cfg.enabled !== false,
    intervalSeconds: cfg.intervalSeconds ?? 600,
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
  if (_stalePrRescueTimer) {
    try {
      _stalePrRescueTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _stalePrRescueTimer = null;
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
  // CTL-665 / CTL-678: resolve the executionCore concurrency knobs once here
  // and thread them into startDaemon → scheduler + boot-resume. The
  // machine-canonical Layer-2 file (~/.config/catalyst/config.json) wins
  // per-field over the committed Layer-1 seed; absent/partial in both yields
  // {} → the scheduler falls back to state.json + the hardcoded default. The
  // env var CATALYST_LAYER2_CONFIG_FILE overrides the Layer-2 path for tests.
  const layer2Path =
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json");
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
    startDaemon({ pidFile, orphanReaperConfig, worktreeRefreshConfig, stalePrRescueConfig, concurrency, configPath, layer2Path }); // CTL-676 + CTL-678 + CTL-707 + CTL-782
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
