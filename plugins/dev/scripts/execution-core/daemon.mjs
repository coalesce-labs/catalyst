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
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { getExecutionCoreDir, getEventLogPath, log, EVENT_DEBOUNCE_MS } from "./config.mjs";
import {
  recoverStartup,
  startMonitor,
  stopMonitor,
  startScheduler,
  stopScheduler,
  reconcileAll,
  createTicketStateCache,
} from "./index.mjs";
import { Reaper } from "./reaper.mjs";
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";

const DEFAULT_MAX_PARALLEL = 3;

let _watcher = null;
let _debounceTimer = null;
let _stopMonitor = null;
let _stopScheduler = null;
let _pidFile = null;
// CTL-649: reap-intent reconciler + periodic orphan-sweep timer.
let _reaper = null;
let _orphanTimer = null;
let _eventWatcher = null;
let _eventDebounceTimer = null;
let _eventLogCursor = 0;

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

// startDaemon — boot the composed daemon. Every composed function is an
// injectable dependency defaulting to the real barrel export, so production
// wiring needs no arguments and tests inject deterministic fakes.
export function startDaemon({
  recover = recoverStartup,
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
} = {}) {
  const orchDir = getExecutionCoreDir();
  ensureState(orchDir);
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
    recover({ orchDir }); // CTL-539 — rebuild routing + worker state on boot
    // CTL-634: one shared TTL state cache. The monitor write-through populates
    // it on every state_changed event; the scheduler read path consults it
    // during out-of-set blocker hydration. A single instance threaded into
    // both is what turns a write-through into a guaranteed next-tick hit.
    const cache = createTicketStateCache();
    // CTL-565: the monitor needs orchDir to one-shot-dispatch the triage phase
    // agent on a →Triage transition. `dispatch` stays an injectable default
    // (dispatch.mjs) so the daemon's fakes-pass-through pattern still holds.
    monitorFn({ orchDir, cache }); // CTL-535 + CTL-565 + CTL-634
    // CTL-558: the scheduler writes Linear status via its default `writeStatus`
    // (linear-write.mjs) on every committed phase transition — no daemon wiring
    // needed; production uses the real module, tests inject fakes.
    schedulerFn({ orchDir, cache }); // CTL-536 + CTL-634 — pull-loop scheduler

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
      startReaperAndTimer({ orphanReaperConfig, debounceMs });
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
function startReaperAndTimer({ orphanReaperConfig, debounceMs }) {
  const eventLogPath = getEventLogPath();
  _reaper = new Reaper({});

  // Boot replay: cover for any intents that landed while the daemon was down.
  _reaper.bootReplay(eventLogPath).catch((err) => {
    log.error({ err }, "reaper: bootReplay threw");
  });
  // Initialize the cursor to the current tail so the live-tail loop only
  // sees lines appended AFTER the replay completed.
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
      _eventDebounceTimer = setTimeout(consumeEventTail, debounceMs);
    });
  } catch (err) {
    log.error({ err }, "reaper: event-log watch failed — relying on boot replay only");
  }

  const cfg = orphanReaperConfig ?? {};
  _orphanTimer = startOrphanReaperTimer({
    enabled: cfg.enabled !== false,
    intervalSeconds: cfg.intervalSeconds ?? 600,
  });
}

// consumeEventTail — read bytes appended to the event log since the cursor
// last advanced, parse each line, and dispatch to the reaper.
function consumeEventTail() {
  if (!_reaper) return;
  const path = getEventLogPath();
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.size < _eventLogCursor) {
    // File rotated or truncated — restart from 0.
    _eventLogCursor = 0;
  }
  if (stats.size === _eventLogCursor) return;
  // Cheap-and-correct: read the whole file then slice from cursor. Event
  // logs typically stay under a few MB per month; this avoids fd juggling.
  let content;
  try {
    const full = readFileSync(path, "utf8");
    content = full.slice(_eventLogCursor);
  } catch (err) {
    log.error({ err }, "reaper: event-log read failed");
    return;
  }
  _eventLogCursor = stats.size;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    _reaper.handle(event).catch((err) => {
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
  _reaper = null;
  _eventLogCursor = 0;
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
    startDaemon({ pidFile, orphanReaperConfig });
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
