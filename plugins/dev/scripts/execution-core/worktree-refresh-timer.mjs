// worktree-refresh-timer.mjs — CTL-707 Layer 1 periodic background refresh.
// On each tick, rebases idle running worktrees onto origin/<base> so
// dispatch-time rebases stay trivial. Clean → emit auto-rebased(clean);
// conflict → leave alone + emit stale-base-detected. Pure: clock, signals,
// stat, and refresh are all injectable for deterministic tests.

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readWorkerSignals } from "./signal-reader.mjs";
import { isBgJobAlive } from "./claude-agents.mjs";
import { isSdkWorkerLive as registrySdkWorkerLive } from "./sdk-worker-registry.mjs";
import { log } from "./config.mjs";

const REFRESH_BIN = fileURLToPath(
  new URL("../lib/worktree-refresh.sh", import.meta.url)
);

/**
 * readWorktreeRefreshConfig — read catalyst.orchestration.worktreeRefresh.*
 * from .catalyst/config.json. Returns {} for missing/unreadable/absent key.
 */
export function readWorktreeRefreshConfig(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "worktree-refresh: config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.worktreeRefresh ?? {};
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

function spawnRefresh(worktreePath, base) {
  const res = spawnSync("bash", [REFRESH_BIN, worktreePath, base], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return res.status ?? 1;
}

/**
 * startWorktreeRefreshTimer — start the periodic background-refresh timer.
 * Returns a { stop } handle.
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled=true]
 * @param {number}  [opts.intervalSeconds=300]   default 5 minutes
 * @param {number}  [opts.quietSeconds=30]        skip if mtime < quietSeconds ago
 * @param {string}  [opts.orchDir]               execution-core orch dir
 * @param {Function}[opts.readSignals]            injectable signal reader
 * @param {Function}[opts.statWorktree]           injectable fs.statSync
 * @param {Function}[opts.isSessionLive]          injectable isBgJobAlive
 * @param {Function}[opts.isSdkWorkerLive]        injectable in-process registry probe (CTL-1410)
 * @param {Function}[opts.refresh]                injectable spawnRefresh
 * @param {Function}[opts.emit]                   optional telemetry emitter
 * @param {object}  [opts.clock]                  fake-clock seam for tests
 */
export function startWorktreeRefreshTimer({
  enabled = true,
  intervalSeconds = 300,
  quietSeconds = 30,
  orchDir,
  readSignals = readWorkerSignals,
  statWorktree = (p) => statSync(p),
  isSessionLive = isBgJobAlive,
  isSdkWorkerLive = registrySdkWorkerLive,
  refresh = spawnRefresh,
  emit,
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };
  const ms = Math.max(1, intervalSeconds) * 1000;
  const quietMs = Math.max(0, quietSeconds) * 1000;

  const handle = clock.setInterval(async () => {
    try {
      const now = Date.now();
      const signals = readSignals(orchDir);
      for (const signal of signals) {
        if (!["running", "dispatched"].includes(signal.status)) continue;
        if (!signal.worktreePath) continue;

        const bgJobId = signal.liveness?.value;
        if (bgJobId && isSessionLive(bgJobId)) continue;
        // CTL-1410 Phase B: an in-process SDK worker has NO bg id (liveness
        // value null), so the guard above is blind to it — without this check
        // the timer can rebase a worktree a LIVE worker is editing. The default
        // reads the in-process registry (same daemon process as the dispatch).
        if (isSdkWorkerLive(signal.ticket)) continue;

        let mtime;
        try {
          mtime = statWorktree(signal.worktreePath).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtime < quietMs) continue;

        const base = "main";
        const rc = refresh(signal.worktreePath, base);
        if (rc === 0) {
          emit?.(`phase.${signal.ticket}.auto-rebased.clean`, {
            ticket: signal.ticket,
          });
        } else {
          emit?.(`phase.${signal.ticket}.stale-base-detected`, {
            ticket: signal.ticket,
          });
        }
      }
    } catch (err) {
      log.warn({ err }, "worktree-refresh: tick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return {
    stop: () => clock.clearInterval(handle),
  };
}
