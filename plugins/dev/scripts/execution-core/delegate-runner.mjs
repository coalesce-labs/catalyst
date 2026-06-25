// delegate-runner.mjs — CTL-1331. The in-daemon timer that drives the DETACHED
// delegate drainer (delegate-runner-entry.mjs).
//
// Structurally modeled on worktree-refresh-timer.mjs (startWorktreeRefreshTimer):
// enabled/interval/orchDir, an injectable fake-clock seam, handle.unref(), and a
// returned { stop } handle. The CRITICAL difference (design §4a): the timer
// callback body is ONLY a single-instance check + a DETACHED async spawn —
//
//   spawn(process.execPath, [ENTRY], { detached:true, stdio:["ignore",fd,fd] }).unref()
//
// It NEVER calls spawnSync and NEVER uses stdio:"ignore" for the child's output.
// The heavy work (worktree provision + claude --bg, 15-min ceiling) runs inside
// the disposable detached child, never on the daemon event loop. Redirecting the
// child's stdout/stderr to <orchDir>/logs/delegate-runner.log (instead of
// discarding it) leaves a post-mortem trail if the child wedges before reaching
// `claude --bg` (grafted from the minimal-fire-and-forget diagnosability fix).
//
// CONFIG SEPARATION: intervalMs / enabled come from opts. The daemon passes the
// values from readDelegateRunnerConfig (config.mjs) — this module deliberately
// does NOT import that reader (mirrors how worktree-refresh-timer keeps
// readWorktreeRefreshConfig out of the timer body; config lives in the caller).
//
// PHASE A — LAND INERT: the daemon starts this gated CATALYST_DELEGATE_RUNNER=off
// by default, so the timer never kicks and nothing drains. An empty queue means
// zero behavior change.
//
// NAMESPACE: this module emits NO events. Dispatch lifecycle events
// (phase.dispatch.*) are emitted by the detached drainer (delegate-runner-entry.mjs).

import { openSync, mkdirSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./config.mjs";
import { acquireRunnerLock } from "./delegate-runner-entry.mjs";

// The detached drainer entrypoint this timer spawns. Resolved relative to this
// module so it works regardless of cwd (mirrors worktree-refresh-timer's
// REFRESH_BIN resolution via import.meta.url).
const DELEGATE_RUNNER_ENTRY = fileURLToPath(
  new URL("./delegate-runner-entry.mjs", import.meta.url)
);

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

// defaultOpenLogFd — open (append, create) the child's combined stdout/stderr
// log at <orchDir>/logs/delegate-runner.log and return its fd. Injectable so
// tests assert the redirect target without touching the real fs.
function defaultOpenLogFd(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  return openSync(logPath, "a");
}

// defaultIsRunnerRunning — the single-instance guard the timer consults BEFORE
// kicking, so overlapping ticks don't stack detached runners. It checks the
// top-level lock the way the entry's acquireRunnerLock does, but WITHOUT taking
// the lock (the child takes it). Injectable for tests. A live lock-holder → true
// (skip the kick); no/stale lock → false (kick).
function defaultIsRunnerRunning(orchDir) {
  // acquireRunnerLock both probes AND (when free) takes the lock; we only want a
  // probe here, so we acquire-then-immediately-release. The detached child
  // re-acquires its own lock on start (the authoritative single-instance check);
  // this is a cheap pre-filter to avoid spawning a child that will just exit.
  let lock;
  try {
    lock = acquireRunnerLock(orchDir);
  } catch {
    return false; // lock probe failed → don't block the kick
  }
  if (!lock.acquired) return true; // a live runner holds it
  lock.release();
  return false;
}

/**
 * startDelegateRunnerTimer — start the in-daemon interval that kicks the
 * detached delegate drainer. Returns a { stop } handle.
 *
 * The callback body is ONLY: single-instance check + detached spawn().unref().
 * NO spawnSync, NO stdio:"ignore".
 *
 * @param {object} opts
 * @param {boolean}  [opts.enabled=true]
 * @param {number}   [opts.intervalMs=15000]   runner cadence (from readDelegateRunnerConfig)
 * @param {string}   [opts.orchDir]            execution-core orch dir
 * @param {string}   [opts.entryPath]          detached entrypoint (injectable for tests)
 * @param {Function} [opts.spawn]              injectable async spawn (NEVER spawnSync)
 * @param {Function} [opts.openLogFd]          injectable fd opener for the child log
 * @param {Function} [opts.isRunnerRunning]    injectable single-instance probe
 * @param {object}   [opts.clock]              fake-clock seam for tests
 */
export function startDelegateRunnerTimer({
  enabled = true,
  intervalMs = 15000,
  orchDir,
  entryPath = DELEGATE_RUNNER_ENTRY,
  spawn = nodeSpawn,
  openLogFd = defaultOpenLogFd,
  isRunnerRunning = defaultIsRunnerRunning,
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };
  const ms = Math.max(1, intervalMs);
  const logPath = join(orchDir, "logs", "delegate-runner.log");

  const handle = clock.setInterval(() => {
    try {
      // (1) Single-instance guard — never stack overlapping detached runners.
      if (isRunnerRunning(orchDir)) return;

      // (2) Open (or create) the child's combined stdout/stderr log fd. NEVER
      //     discard the child's output — a wedge before `claude --bg` must leave
      //     a trail, not silence.
      let logFd;
      try {
        logFd = openLogFd(logPath);
      } catch (err) {
        log.warn(
          { err: err?.message, logPath },
          "delegate-runner: log fd open failed; skipping kick"
        );
        return;
      }

      // (3) DETACHED spawn + unref. stdin ignored; stdout/stderr → the log fd.
      //     spawn (async) ONLY — never spawnSync (which would block the daemon
      //     loop, the exact thing this whole design moves work OFF of).
      const child = spawn(process.execPath, [entryPath], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      if (child && typeof child.unref === "function") child.unref();
    } catch (err) {
      log.warn({ err: err?.message }, "delegate-runner: kick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return {
    stop: () => clock.clearInterval(handle),
  };
}
