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

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "./config.mjs";

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

// defaultConfirmReload — bounded check that a restarted component actually came
// back up before we report success. CTL-1077 remediate: the original code fired
// `stack.reload.complete` UNCONDITIONALLY right after a fire-and-forget detached
// `restart`. A restart that races its own stop hits EADDRINUSE on the listen port
// and leaves the component DOWN (~90 s observed) while the event log falsely
// reports success. Only the monitor exposes a stable listen port we can probe
// from here; the exec-core restart is confirmed best-effort by spawn success.
// Polls with a small budget to absorb the stop→start gap (the monitor start
// itself polls up to ~2 s for its pid file). Returns false if the port never
// comes back, so performReload can emit `stack.reload.degraded` instead of
// `complete` and retry once.
function defaultConfirmReload(component) {
  if (!component || component.name !== "monitor") return true;
  const port = process.env.MONITOR_PORT || "7400";
  const attempts = 10; // ≤ ~5 s total (10 × 500 ms) — covers stop + start
  for (let i = 0; i < attempts; i++) {
    try {
      // `lsof` exits 0 only when a process is LISTENing on the port — i.e. the
      // restarted monitor rebound it. EADDRINUSE-down state never satisfies this.
      execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: "ignore" });
      return true;
    } catch { /* not listening yet (or lsof missing) */ }
    try { execSync("sleep 0.5", { stdio: "ignore" }); } catch { /* ok */ }
  }
  return false;
}

function defaultHandoffPath() {
  return resolve(homedir(), "catalyst", "broker", "reload-handoff.json");
}

function defaultWriteHandoffFn({ logPath, byteOffset, pid, ts }) {
  const dir = resolve(homedir(), "catalyst", "broker");
  const path = defaultHandoffPath();
  const tmp = path + ".tmp." + process.pid;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ logPath, byteOffset, pid, ts }), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    // CTL-1077 remediate (silent-failure): a failed handoff write/rename used to
    // be swallowed by the caller's best-effort catch, so the successor silently
    // reseeded to EOF and dropped the restart-gap events with no trace. Surface
    // it, then re-throw to preserve the caller's best-effort restart fallback.
    log.error(
      { err: err?.message, handoffPath: path },
      "failed to write broker reload handoff; successor will reseed from EOF (possible gap re-process)"
    );
    throw err;
  }
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
  nowFn,
  writeHandoffFn,
  currentByteOffset,
  logPath,
  confirmFn = defaultConfirmReload,
}) {
  emitFn?.({
    event: "stack.reload.started",
    orchestrator: null,
    worker: null,
    detail: { components: decision.components.map((c) => c.name), ts: now },
  });

  // CTL-1077 remediate (high): restart each component, then CONFIRM it came back
  // before reporting success. The prior code emitted `stack.reload.complete`
  // unconditionally right after the fire-and-forget spawn, so a restart that
  // raced its own stop (EADDRINUSE) left the component DOWN while the event log
  // falsely reported success. We now gate the complete event on confirmation and
  // retry once before declaring a component degraded.
  const confirmed = [];
  const unconfirmed = [];
  for (const c of decision.components) {
    try { spawnFn(c.cmd, ["restart"]); } catch { /* best-effort per component */ }
    let ok = false;
    try { ok = confirmFn(c) !== false; } catch { ok = false; }
    if (!ok) {
      // Retry once before declaring failure (the recommendation's "retry once").
      try { spawnFn(c.cmd, ["restart"]); } catch { /* best-effort per component */ }
      try { ok = confirmFn(c) !== false; } catch { ok = false; }
    }
    (ok ? confirmed : unconfirmed).push(c);
  }

  if (unconfirmed.length === 0) {
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
  } else {
    // At least one component could not be confirmed back up — report degraded
    // (NOT complete) so the event log reflects reality and an operator/HUD can
    // see the stalled restart instead of a false success.
    emitFn?.({
      event: "stack.reload.degraded",
      orchestrator: null,
      worker: null,
      detail: {
        reason: "restart_not_confirmed",
        confirmed: confirmed.map((c) => c.name),
        unconfirmed: unconfirmed.map((c) => ({
          name: c.name,
          old_sha: c.oldSha,
          new_sha: c.newSha,
        })),
      },
    });
  }

  // Broker self-reload: write tail-offset handoff then re-exec via catalyst-broker restart.
  // The handoff lets the successor pick up exactly where we left off rather than
  // reseeding to EOF and dropping events appended during the restart gap.
  if (decision.brokerSelfReload) {
    try {
      // Stamp ts at write time, not event-capture time: this handoff is written
      // ~STACK_RELOAD_DEBOUNCE_MS after the triggering merge (plus any merge-train
      // coalescing), and the successor's resolveBootByteOffset measures staleness
      // against its own boot clock. Using the event-capture `now` would burn most of
      // the maxAgeMs budget on the debounce window and reject otherwise-fresh handoffs.
      writeHandoffFn({ logPath, byteOffset: currentByteOffset, pid: process.pid, ts: nowFn() });
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
 * Injected seams: spawnFn, confirmFn, emitFn, writeHandoffFn, setTimeoutFn,
 * clearTimeoutFn, now, nowFn, currentByteOffset, logPath — for deterministic testing.
 * `now` is the event-capture instant (used for the started-event detail); `nowFn` is
 * evaluated at handoff-write time (after the debounce) so the staleness ts reflects when
 * the handoff was actually persisted. `confirmFn(component) => boolean` gates the
 * complete event on the restart actually coming back up (CTL-1077 remediate).
 */
export function handleStackReloadEvent({
  results,
  loadedCommitRoot = null,
  spawnFn = defaultSpawnFn,
  confirmFn = defaultConfirmReload,
  emitFn,
  now = Date.now(),
  nowFn = Date.now,
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
    const capturedConfirmFn = confirmFn;
    const capturedEmitFn = emitFn;
    const capturedNow = now;
    const capturedNowFn = nowFn;
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
          confirmFn: capturedConfirmFn,
          emitFn: capturedEmitFn,
          now: capturedNow,
          nowFn: capturedNowFn,
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
