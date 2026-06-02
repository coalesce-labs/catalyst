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
  getEventLogPath,
  log,
  EVENT_DEBOUNCE_MS,
  readWaitWatcherConfig,
  readMemorySamplerConfig,
} from "./config.mjs";
import { startWaitWatcher as realStartWaitWatcher } from "./wait-watcher.mjs";
import { startMemorySampler as realStartMemorySampler } from "./memory-sampler.mjs";
import {
  recoverStartup,
  startMonitor,
  stopMonitor,
  startScheduler,
  stopScheduler,
  reconcileAll,
  createTicketStateCache,
} from "./index.mjs";
import { Reaper, defaultReadActivePhaseSignal } from "./reaper.mjs";
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";
import {
  startWorktreeRefreshTimer,
  readWorktreeRefreshConfig,
} from "./worktree-refresh-timer.mjs";
import { reconcileBootResume } from "./boot-resume.mjs";
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
} from "./scheduler.mjs";
import { writeBootMarker, clearProgressMarks } from "./recovery.mjs"; // CTL-655: window the revive budget to this run; CTL-736: reset progress high-water
import { startAutoTuner } from "./autotune.mjs"; // CTL-684: side-car maxParallel auto-tuner
import { dispatchTicket } from "./dispatch.mjs"; // CTL-549: comment-wake re-dispatch
import { removeLabel as defaultRemoveLabel } from "./linear-write.mjs"; // CTL-549: clear needs-human/question on resume

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
// CTL-650: the push-based session wait-state watcher handle.
let _waitWatcher = null;
// CTL-685: per-worker memory sampler handle.
let _memorySampler = null;
// CTL-684: auto-tuner stop handle.
let _stopAutoTuner = null;
let _eventWatcher = null;
let _eventDebounceTimer = null;
let _eventLogCursor = 0;
// CTL-649: the trailing partial line carried across reads. _eventLogCursor is a
// BYTE offset; consumeEventTail reads only NEW bytes via a file descriptor and
// stitches the leftover onto the front so a line split across two writes (or a
// half-written line at read time) is parsed exactly once, never truncated.
let _eventLogLeftover = "";

// readLinearBotUserId — read catalyst.monitor.linear.botUserId from Layer 1
// config (.catalyst/config.json). Returns "" when absent/unreadable so callers
// can treat it as "no filter". Never throws. CTL-749.
function readLinearBotUserId(configPath) {
  if (!configPath) return "";
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const uid = parsed?.catalyst?.monitor?.linear?.botUserId;
    return typeof uid === "string" && uid.length > 0 ? uid : "";
  } catch {
    return "";
  }
}

// createCommentInboxWriter — factory for a per-daemon onComment subscriber.
// Appends a JSONL entry to ORCH_DIR/workers/<ticket>/inbox.jsonl when the
// ticket is in-flight (workers/ dir exists). Filters bot self-echo via
// botUserId. Exported for testing. CTL-749.
export function createCommentInboxWriter(orchDir, botUserId) {
  return function writeCommentToInbox(parsed) {
    const ticket = parsed.ticket ?? parsed.identifier ?? null;
    if (!ticket) return;
    if (botUserId && parsed.authorId === botUserId) return;
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
    if (botUserId && parsed.actorId === botUserId) return;
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
// each signal with status === "needs-input", removes the needs-human/question
// label and re-dispatches via dispatchTicket with the parked handoffPath.
// Fail-open throughout — a bad signal file or removeLabel failure is logged
// and skipped, never fatal.
export async function handleCommentWake(
  parsed,
  { orchDir, dispatch, removeLabel },
) {
  const { ticket } = parsed ?? {};
  if (!ticket) return;

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

    if (sig.status !== "needs-input") continue;

    const parkedPhase = sig.parkedFrom ?? sig.phase;
    const handoffPath = sig.handoffPath ?? undefined;

    try {
      await removeLabel(ticket, "needs-human/question");
    } catch {
      /* fail-open */
    }

    dispatch(orchDir, ticket, parkedPhase, { handoffPath });
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
  pidFile = null,
  // CTL-649: reaper + orphan-sweep timer. Disable via env knob for tests
  // that only exercise monitor + scheduler.
  enableReaper = process.env.EXECUTION_CORE_DISABLE_REAPER !== "1",
  orphanReaperConfig = null,
  // CTL-707: worktree refresh timer config (catalyst.orchestration.worktreeRefresh).
  worktreeRefreshConfig = null,
  // CTL-650: the session wait-state watcher. Injectable for tests; gated by a
  // config knob (default-on, CATALYST_WAIT_WATCHER=0 disables) like the reaper.
  startWaitWatcher = realStartWaitWatcher,
  enableWaitWatcher = readWaitWatcherConfig().enabled,
  // CTL-685: per-worker memory sampler. Injectable for tests; gated by a config
  // knob (default-on, CATALYST_MEMORY_SAMPLER=0 disables) like the wait-watcher.
  startMemorySampler = realStartMemorySampler,
  enableMemorySampler = readMemorySamplerConfig().enabled,
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
} = {}) {
  const orchDir = getExecutionCoreDir();
  ensureState(orchDir);
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
    // CTL-634: one shared TTL state cache. The monitor write-through populates
    // it on every state_changed event; the scheduler read path consults it
    // during out-of-set blocker hydration. A single instance threaded into
    // both is what turns a write-through into a guaranteed next-tick hit.
    const cache = createTicketStateCache();
    // CTL-565: the monitor needs orchDir to one-shot-dispatch the triage phase
    // agent on a →Triage transition. `dispatch` stays an injectable default
    // (dispatch.mjs) so the daemon's fakes-pass-through pattern still holds.
    // CTL-749: resolve the bot user ID from .catalyst/config.json so the inbox
    // writers can filter out self-echo comments (the bot posting mirror comments).
    const linearBotUserId = readLinearBotUserId(configPath);
    const commentInboxWriter = createCommentInboxWriter(orchDir, linearBotUserId);
    monitorFn({
      orchDir,
      cache,
      onComment: (parsed) => {
        commentInboxWriter(parsed); // CTL-749: write to inbox.jsonl for in-flight workers
        handleCommentWake(parsed, { orchDir, dispatch: dispatchTicket, removeLabel: defaultRemoveLabel }); // CTL-549: re-dispatch parked tickets
      },
      onUpdate: createUpdateInboxWriter(orchDir, linearBotUserId), // CTL-749
    }); // CTL-535 + CTL-565 + CTL-634 + CTL-549 + CTL-749
    // CTL-558: the scheduler writes Linear status via its default `writeStatus`
    // (linear-write.mjs) on every committed phase transition — no daemon wiring
    // needed; production uses the real module, tests inject fakes.
    schedulerFn({ orchDir, cache, concurrency, configPath, layer2Path }); // CTL-536 + CTL-634 + CTL-665 + CTL-676 + CTL-678 — pull-loop scheduler (configPath + layer2Path enable per-tick Layer-1+Layer-2 re-read)
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
      startReaperAndTimer({ orphanReaperConfig, worktreeRefreshConfig, debounceMs, orchDir });
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
  } catch (err) {
    stopDaemon();
    throw err;
  }

  log.info({ orchDir }, "execution-core daemon started");
}

// startReaperAndTimer — wire the Reaper (CTL-649 Phase 4) and the periodic
// orphan-reaper timer (CTL-649 Phase 9) into the daemon. The reaper consumes
// `*.reap-requested` lines appended to the canonical event log by yielding
// workers, supersede paths, abort-worker, and PR-merged cleanup — and runs
// the appropriate executor for each.
//
// Boot replay is best-effort: if it throws, log and continue with live
// consumption only.
function startReaperAndTimer({ orphanReaperConfig, worktreeRefreshConfig, debounceMs, orchDir }) {
  const eventLogPath = getEventLogPath();
  // CTL-649: the periodic sweep honors the configured recency floor
  // (minIdleSeconds, default 900s). includeInteractive stays at its safe
  // default false — the daemon never opts into reaping human sessions.
  // CTL-661: bind the per-ticket reconciler's canonical-owner reader to this
  // daemon's orchDir so the sweep resolves the authoritative active-phase
  // bg_job_id (falling back to newest-by-last_seen when no signal is found).
  _reaper = new Reaper({
    minIdleMs: (orphanReaperConfig?.minIdleSeconds ?? 900) * 1000,
    readActivePhaseSignal: (ticket) => defaultReadActivePhaseSignal(orchDir, ticket),
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
    startDaemon({ pidFile, orphanReaperConfig, worktreeRefreshConfig, concurrency, configPath, layer2Path }); // CTL-676 + CTL-678 + CTL-707
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
