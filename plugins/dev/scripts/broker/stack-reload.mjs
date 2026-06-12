// stack-reload.mjs — automatic hot-reload of the running stack on checkout advance (CTL-1077).
//
// Consumer of the CTL-993 refresh results. When a merge-to-main advances the
// plugin-source checkout, restarts the monitor and execution-core daemon (both
// proven-safe restart paths), records a deploy event with old/new SHAs per
// component, debounces under merge trains (trailing-edge coalesce), and — when
// the broker's own code changed — self-reloads via a gap-free tail-offset handoff.
//
// All OS/process/timer/clock interactions are injected seams so the decision
// core and lifecycle are deterministically testable without real processes,
// timers, or log files. Mirrors the plugin-refresh.mjs / gc-liveness.mjs
// seam-injection convention.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Trailing-edge debounce window. Coalesces merge-train bursts: three merges
// within this window produce exactly one reload after the last merge.
// Composes with the existing 60 s pull throttle: the throttle bounds *pulls*,
// the debounce bounds *reloads* — together they guarantee ≤1 reload per quiet
// window for any merge burst.
export const STACK_RELOAD_DEBOUNCE_MS = 30_000;

// Module-level pending debounce state. One active timer at most.
let _pendingTimer = null;
let _pendingDecision = null;
let _pendingClearFn = null;

export function __clearReloadStateForTest() {
  if (_pendingTimer != null && _pendingClearFn) {
    try { _pendingClearFn(_pendingTimer); } catch { /* ok */ }
  }
  _pendingTimer = null;
  _pendingDecision = null;
  _pendingClearFn = null;
}

// --- binary resolution -------------------------------------------------------

// resolveBin — prefer ~/.catalyst/bin/<cmd> over PATH, so operator-installed
// wrappers take precedence. Reused by the broker self-reload spawn (Phase 3).
function resolveBin(cmd) {
  const candidate = resolve(homedir(), ".catalyst", "bin", cmd);
  if (existsSync(candidate)) return candidate;
  return cmd;
}

// --- default seams -----------------------------------------------------------

function defaultSpawnFn(cmd, args) {
  try {
    spawn(resolveBin(cmd), args, { detached: true, stdio: "ignore" }).unref();
  } catch { /* best-effort — caller's try/catch also wraps this */ }
}

function defaultHandoffPath() {
  return resolve(homedir(), "catalyst", "broker", "reload-handoff.json");
}

function defaultWriteHandoffFn({ logPath, byteOffset, pid, ts }) {
  const dir = resolve(homedir(), "catalyst", "broker");
  mkdirSync(dir, { recursive: true });
  const path = defaultHandoffPath();
  const tmp = path + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify({ logPath, byteOffset, pid, ts }), "utf8");
  renameSync(tmp, path);
}

// --- pure decision core ------------------------------------------------------

/**
 * decideStackReload — maps per-root refresh results to which components to
 * reload and whether the broker must self-reload.
 *
 * @param {object} opts
 * @param {Array}  opts.results        — array from handlePluginRefreshEvent
 * @param {string} opts.loadedCommitRoot — the broker's own checkout toplevel
 * @returns {{ shouldReload, brokerSelfReload, components }}
 */
export function decideStackReload({ results = [], loadedCommitRoot = null } = {}) {
  const safe = Array.isArray(results) ? results : [];
  const changed = safe.filter((r) => r && r.changed);
  if (changed.length === 0) {
    return { shouldReload: false, brokerSelfReload: false, components: [] };
  }
  // Both monitor and exec-core run from the advanced checkout — reload both.
  const { oldSha = null, newSha = null } = changed[0];
  const components = [
    { name: "monitor", cmd: "catalyst-monitor", oldSha, newSha },
    { name: "execution-core", cmd: "catalyst-execution-core", oldSha, newSha },
  ];
  // brokerSelfReload only when restartNeeded for the broker's own checkout root.
  const brokerSelfReload = changed.some(
    (r) =>
      r.restartNeeded &&
      (loadedCommitRoot == null || r.root === loadedCommitRoot)
  );
  return { shouldReload: true, brokerSelfReload, components };
}

// --- reload execution --------------------------------------------------------

function performReload({
  decision,
  spawnFn,
  emitFn,
  now,
  writeHandoffFn,
  currentByteOffset,
  logPath,
}) {
  emitFn?.({
    event: "stack.reload.started",
    orchestrator: null,
    worker: null,
    detail: { components: decision.components.map((c) => c.name), ts: now },
  });

  for (const c of decision.components) {
    try { spawnFn(c.cmd, ["restart"]); } catch { /* best-effort per component */ }
  }

  emitFn?.({
    event: "stack.reload.complete",
    orchestrator: null,
    worker: null,
    detail: {
      components: decision.components.map((c) => ({
        name: c.name,
        old_sha: c.oldSha,
        new_sha: c.newSha,
      })),
    },
  });

  // Broker self-reload: write tail-offset handoff then re-exec via catalyst-broker restart.
  // The handoff lets the successor pick up exactly where we left off rather than
  // reseeding to EOF and dropping events appended during the restart gap.
  if (decision.brokerSelfReload) {
    try {
      writeHandoffFn({ logPath, byteOffset: currentByteOffset, pid: process.pid, ts: now });
      spawnFn("catalyst-broker", ["restart"]);
    } catch { /* best-effort — script-layer restart is the backstop */ }
  }
}

// --- lifecycle ---------------------------------------------------------------

/**
 * handleStackReloadEvent — trailing-edge debounce wrapper around performReload.
 *
 * Accepts per-root refresh results from handlePluginRefreshEvent. On each
 * qualifying change, (re)arms a debounce timer so that a burst of rapid merges
 * produces exactly one reload after the last merge. The latest decision (newest
 * SHAs) always wins.
 *
 * Injected seams: spawnFn, emitFn, writeHandoffFn, setTimeoutFn,
 * clearTimeoutFn, now, currentByteOffset, logPath — for deterministic testing.
 */
export function handleStackReloadEvent({
  results,
  loadedCommitRoot = null,
  spawnFn = defaultSpawnFn,
  emitFn,
  now = Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  writeHandoffFn = defaultWriteHandoffFn,
  currentByteOffset = 0,
  logPath = "",
} = {}) {
  try {
    const decision = decideStackReload({ results, loadedCommitRoot });
    if (!decision.shouldReload) return decision;

    // Last change wins — update to the newest decision (latest SHAs).
    _pendingDecision = decision;

    // Cancel the outstanding timer with the clearFn that was used to set it.
    if (_pendingTimer != null && _pendingClearFn) {
      try { _pendingClearFn(_pendingTimer); } catch { /* ok */ }
    }

    // Capture closure seams for the debounce callback.
    const capturedSpawnFn = spawnFn;
    const capturedEmitFn = emitFn;
    const capturedNow = now;
    const capturedWriteHandoffFn = writeHandoffFn;
    const capturedByteOffset = currentByteOffset;
    const capturedLogPath = logPath;

    _pendingClearFn = clearTimeoutFn;
    _pendingTimer = setTimeoutFn(() => {
      const d = _pendingDecision;
      _pendingDecision = null;
      _pendingTimer = null;
      _pendingClearFn = null;
      if (d) {
        performReload({
          decision: d,
          spawnFn: capturedSpawnFn,
          emitFn: capturedEmitFn,
          now: capturedNow,
          writeHandoffFn: capturedWriteHandoffFn,
          currentByteOffset: capturedByteOffset,
          logPath: capturedLogPath,
        });
      }
    }, STACK_RELOAD_DEBOUNCE_MS);

    return decision;
  } catch {
    return { shouldReload: false, brokerSelfReload: false, components: [] };
  }
}
