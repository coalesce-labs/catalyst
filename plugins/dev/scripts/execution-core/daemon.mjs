#!/usr/bin/env bun
// daemon.mjs — the execution-core composing daemon (CTL-554). Wires the
// CTL-539 recovery contract, the CTL-535 Todo-state monitor, and the CTL-536
// pull-loop scheduler into one long-lived machine-level process, and owns the
// fs.watch on the enrollment directory that CTL-535 left to CTL-554.
//
// `orchDir` for all three composed functions is a single machine-level
// directory — getExecutionCoreDir() (~/catalyst/execution-core/). The daemon
// idempotently ensures a minimal <orchDir>/state.json so the CTL-536 scheduler
// has a maxParallel value to read.

import { watch, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getExecutionCoreDir, getEnrollmentDir, log, EVENT_DEBOUNCE_MS } from "./config.mjs";
import {
  recoverStartup,
  startMonitor,
  stopMonitor,
  startScheduler,
  stopScheduler,
  reconcileAll,
} from "./index.mjs";

const DEFAULT_MAX_PARALLEL = 3;

let _watcher = null;
let _stopMonitor = null;
let _stopScheduler = null;
let _pidFile = null;

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
  watchEnrollment = true,
  debounceMs = EVENT_DEBOUNCE_MS,
  pidFile = null,
} = {}) {
  const orchDir = getExecutionCoreDir();
  ensureState(orchDir);
  _stopMonitor = stopMonitorFn;
  _stopScheduler = stopSchedulerFn;

  recover({ orchDir }); // CTL-539 — rebuild routing + worker state on boot
  monitorFn(); // CTL-535 — Todo-state monitor + event tailer
  schedulerFn({ orchDir }); // CTL-536 — pull-loop scheduler

  if (watchEnrollment) {
    // The fs.watch target must exist — the daemon may boot before any project
    // has enrolled, so create the enrollment dir first.
    mkdirSync(getEnrollmentDir(), { recursive: true });
    let timer = null;
    _watcher = watch(getEnrollmentDir(), () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        log.info("execution-core daemon: enrollment dir changed — reconciling");
        try {
          reconcile();
        } catch (err) {
          log.warn({ err: err.message }, "reconcile failed");
        }
      }, debounceMs);
    });
  }

  if (pidFile) {
    _pidFile = pidFile;
    const tmp = `${pidFile}.tmp`;
    writeFileSync(tmp, String(process.pid));
    renameSync(tmp, pidFile);
  }
  log.info({ orchDir }, "execution-core daemon started");
}

// stopDaemon — tear down the watcher, the composed monitor + scheduler, and
// the PID file. Idempotent and safe to call when nothing is running.
export function stopDaemon() {
  if (_watcher) {
    try {
      _watcher.close();
    } catch {
      /* watcher already closed */
    }
    _watcher = null;
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
  startDaemon({ pidFile });
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
