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

import { openSync, closeSync, mkdirSync } from "node:fs";
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./config.mjs";
import { acquireRunnerLock } from "./delegate-runner-entry.mjs";

// The detached drainer entrypoint this timer spawns. Resolved relative to this
// module so it works regardless of cwd (mirrors worktree-refresh-timer's
// REFRESH_BIN resolution via import.meta.url).
const DELEGATE_RUNNER_ENTRY = fileURLToPath(
  new URL("./delegate-runner-entry.mjs", import.meta.url)
);
// CAT-39: the boot-time orphan sweep (reapOrphanedRunners) matches on this
// basename rather than the full resolved path — a prior daemon generation's
// checkout may have lived at a different absolute path (a hotpatch, a
// different pluginDirs resolution) than this one, but the entry file's name
// is stable across those.
const ENTRY_BASENAME = basename(DELEGATE_RUNNER_ENTRY);

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

// defaultCloseLogFd — close the PARENT's copy of the child log fd after the
// detached spawn has inherited (dup'd) it. CTL-1519: omitting this close leaked
// exactly one fd per tick (POSIX spawn() forks synchronously and dup's the fd
// into the child before returning, so the parent's copy is redundant). At the
// 15s cadence that is ~240 fds/hr, all pointing at delegate-runner.log, marching
// the long-lived daemon toward EMFILE. Injectable so tests assert the close
// without operating on a real fd (the fake fds tests inject, e.g. 5/77, must
// never reach the real closeSync).
function defaultCloseLogFd(fd) {
  closeSync(fd);
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

// CAT-39: grace window between SIGTERM and SIGKILL when reaping a runner that
// has outlived its deadline (see reapDeadlineMs below). Long enough for a
// process that isn't wedged in an uninterruptible syscall to exit cleanly;
// short enough that a genuinely stuck one is gone well within a few more ticks.
const DELEGATE_RUNNER_REAP_GRACE_MS = 30_000;

// defaultKillProcess — process.kill wrapper. Injectable for tests. Swallows
// ESRCH (already gone) — reaping a runner that exited between the deadline
// check and the kill call is a race, not an error.
function defaultKillProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err?.code !== "ESRCH") {
      log.warn({ pid, signal, err: err?.message }, "delegate-runner: kill failed");
    }
  }
}

// defaultListProcesses — `ps -axo pid=,ppid=,command=` parsed into
// [{pid, ppid, command}]. Injectable for tests (never spawns a real `ps`).
// Mirrors memory-sampler.mjs's defaultPsLines convention. Empty array on any
// failure — a boot-time sweep that can't enumerate processes skips, it never
// crashes daemon startup.
function defaultListProcesses() {
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

// reapOrphanedRunners — CAT-39 direction #3: on daemon boot, kill every
// delegate-runner-entry.mjs process already on the host. At boot THIS daemon
// has spawned none yet, so every match is by definition left over from a
// prior generation — the confirmed repro (CTL-1331 ticket) found one that had
// survived a daemon restart and outlived it by 23+ hours, reparented to PID 1,
// still holding a write handle on the shared delegate-runner.log. SIGTERM
// only (confirmed sufficient in the same repro) — this runs once at startup,
// not on a tight loop, so there is no cheap opportunity to check back for a
// SIGKILL escalation the way the per-tick reap below does.
export function reapOrphanedRunners(
  orchDir,
  { listProcesses = defaultListProcesses, killProcess = defaultKillProcess } = {},
) {
  if (!orchDir) return { reaped: 0 };
  let procs;
  try {
    procs = listProcesses();
  } catch (err) {
    log.warn({ err: err?.message }, "delegate-runner: orphan sweep process listing failed");
    return { reaped: 0 };
  }
  let reaped = 0;
  for (const proc of procs) {
    if (!proc?.command?.includes(ENTRY_BASENAME)) continue;
    try {
      log.warn(
        { pid: proc.pid, ppid: proc.ppid },
        "delegate-runner: reaping a delegate-runner-entry process left over from a prior daemon generation"
      );
      killProcess(proc.pid, "SIGTERM");
      reaped++;
    } catch (err) {
      log.warn({ pid: proc.pid, err: err?.message }, "delegate-runner: orphan reap kill failed");
    }
  }
  return { reaped };
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
 * @param {Function} [opts.closeLogFd]         injectable fd closer (CTL-1519: closes the parent copy post-spawn)
 * @param {Function} [opts.isRunnerRunning]    injectable single-instance probe
 * @param {number}   [opts.reapDeadlineMs=600000]  CAT-39: age past which a runner THIS timer
 *                                              spawned is reaped regardless of the lock
 *                                              (from readDelegateRunnerConfig)
 * @param {Function} [opts.killProcess]        injectable process.kill wrapper (CAT-39)
 * @param {Function} [opts.now]                injectable clock read, ms epoch (CAT-39)
 * @param {object}   [opts.clock]              fake-clock seam for tests
 *
 * NOTE (CAT-39): the boot-time orphan sweep (reapOrphanedRunners, exported
 * separately) is NOT called from here — it runs once, explicitly, from the
 * daemon's own startup sequence (daemon.mjs), before this timer starts. That
 * keeps a real `ps` scan + real SIGTERM out of every unit test that starts a
 * timer instance without injecting it, and out of the reach of a repeated
 * `startDelegateRunnerTimer` call within one process lifetime.
 */
export function startDelegateRunnerTimer({
  enabled = true,
  intervalMs = 15000,
  orchDir,
  entryPath = DELEGATE_RUNNER_ENTRY,
  spawn = nodeSpawn,
  openLogFd = defaultOpenLogFd,
  closeLogFd = defaultCloseLogFd,
  isRunnerRunning = defaultIsRunnerRunning,
  reapDeadlineMs = 600_000,
  killProcess = defaultKillProcess,
  now = () => Date.now(),
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };
  const ms = Math.max(1, intervalMs);
  const logPath = join(orchDir, "logs", "delegate-runner.log");

  // CAT-39: the pid + spawn time of the runner THIS timer instance last
  // spawned, so a later tick can reap it if it has outlived its deadline —
  // independent of whether the single-instance lock still shows it as "live"
  // (a hung runner IS still alive; that is exactly the failure this catches).
  // Cleared on the child's own 'exit' event, so the deadline check never
  // fires against a pid that has already finished. `detached`+`unref()`
  // only affects whether the event loop waits on the child; listening for
  // 'exit' on an unref'd child is safe (the daemon's own interval keeps the
  // loop alive regardless).
  let tracked = null; // { pid, spawnedAt, termSentAt }

  const handle = clock.setInterval(() => {
    try {
      // (0) Reap a tracked runner that has outlived its deadline. This is the
      //     ONLY path that can free a runner wedged in a blocking spawnSync
      //     call (confirmed in production — see delegate-runner-entry.mjs's
      //     header): the child's own event loop is blocked in that case, so
      //     an in-process timer inside it would never fire. Killing it from
      //     HERE, a separate process, is unaffected by that.
      if (tracked) {
        const age = now() - tracked.spawnedAt;
        if (age > reapDeadlineMs) {
          if (!tracked.termSentAt) {
            log.warn(
              { pid: tracked.pid, ageMs: age },
              "delegate-runner: spawned runner exceeded its deadline — sending SIGTERM"
            );
            killProcess(tracked.pid, "SIGTERM");
            tracked.termSentAt = now();
          } else if (now() - tracked.termSentAt > DELEGATE_RUNNER_REAP_GRACE_MS) {
            log.warn(
              { pid: tracked.pid },
              "delegate-runner: runner still alive after SIGTERM grace — sending SIGKILL"
            );
            killProcess(tracked.pid, "SIGKILL");
            tracked = null; // give up tracking past SIGKILL
          }
        }
      }

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
      try {
        const child = spawn(process.execPath, [entryPath], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          // CTL-1331 FU-1: the detached entry resolves its orchDir from
          // CATALYST_EXECUTION_CORE_DIR — pass it explicitly so the child drains the
          // correct queue even when the daemon's own env doesn't carry it.
          env: { ...process.env, CATALYST_EXECUTION_CORE_DIR: orchDir },
        });
        if (child && typeof child.unref === "function") child.unref();
        // CAT-39: track for the deadline-reap check above. A pid we can't
        // observe (spawn threw before assigning one) simply isn't tracked —
        // the existing lock-based guard is the only backstop for that case,
        // unchanged from before this fix.
        if (Number.isFinite(child?.pid)) {
          const spawnedPid = child.pid;
          tracked = { pid: spawnedPid, spawnedAt: now(), termSentAt: null };
          if (typeof child.on === "function") {
            child.on("exit", () => {
              if (tracked && tracked.pid === spawnedPid) tracked = null;
            });
          }
        }
      } finally {
        // (4) CTL-1519: close the PARENT's copy of the log fd. The detached
        //     child inherited its own dup of this fd (its stdout/stderr) during
        //     the synchronous POSIX fork, so the parent copy is redundant the
        //     instant spawn() returns. In `finally` so it also closes if spawn()
        //     throws (e.g. EAGAIN/EMFILE) — the very error path where leaking the
        //     just-opened fd would compound exhaustion. Append mode means the
        //     child's writes are unaffected for its whole lifetime.
        try {
          closeLogFd(logFd);
        } catch (err) {
          log.warn({ err: err?.message }, "delegate-runner: log fd close failed");
        }
      }
    } catch (err) {
      log.warn({ err: err?.message }, "delegate-runner: kick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return {
    stop: () => clock.clearInterval(handle),
  };
}
