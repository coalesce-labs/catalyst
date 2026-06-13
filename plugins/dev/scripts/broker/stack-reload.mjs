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

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "./config.mjs";

// Trailing-edge debounce window. Coalesces merge-train bursts: three merges
// within this window produce exactly one reload after the last merge.
// Composes with the existing 60 s pull throttle: the throttle bounds *pulls*,
// the debounce bounds *reloads* — together they guarantee ≤1 reload per quiet
// window for any merge burst.
export const STACK_RELOAD_DEBOUNCE_MS = 30_000;

// Confirmation poll cadence/budget for performReload's NON-BLOCKING restart
// confirmation. CTL-1077 remediate (M3): confirmation used to block the
// single-threaded broker event loop with a synchronous `execSync("sleep 0.5")`
// poll loop (≤5 s per monitor reload, ~20 s with the retry path), stalling event
// tailing during every deploy. The poll now waits OFF the event loop via the
// injected setTimeoutFn between single, fast lsof probes. 10 × 500 ms ≈ 5 s wall
// clock, but the event loop stays responsive throughout.
export const STACK_RELOAD_CONFIRM_POLL_MS = 500;
export const STACK_RELOAD_CONFIRM_MAX_ATTEMPTS = 10;

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

// defaultSpawnFn — fire-and-forget detached restart. CTL-1077 remediate (M1/M2,
// silent-failure): the previous body wrapped spawn() in its own try/catch that
// swallowed every error, so a failed restart spawn was invisible AND the caller
// could never observe failure either (double-swallow). We now:
//   1. attach an `error` listener — spawn reports a missing binary / EACCES
//      asynchronously via the `error` event (NOT a synchronous throw), so this is
//      the only place an ENOENT restart failure can be surfaced; log.error makes
//      it observable instead of silently keeping stale code running.
//   2. let synchronous spawn errors propagate to the caller (trySpawn), which
//      maps them into the unconfirmed partition so a failed exec-core restart
//      lands in stack.reload.degraded instead of a false stack.reload.complete.
function defaultSpawnFn(cmd, args) {
  const child = spawn(resolveBin(cmd), args, { detached: true, stdio: "ignore" });
  child.once("error", (err) => {
    log.error({ err: err?.message, cmd }, "stack-reload: restart spawn failed (component may be running stale code)");
  });
  child.unref();
}

// trySpawn — run a spawn seam, returning false on a SYNCHRONOUS failure instead
// of swallowing it. Lets performReload treat a spawn that could not even start as
// an immediately-unconfirmed component (CTL-1077 remediate, M1).
function trySpawn(spawnFn, cmd, args) {
  try { spawnFn(cmd, args); return true; }
  catch { return false; }
}

// One-shot guard so a broken probe tool warns exactly once, not on every reload.
let _lsofUnavailableWarned = false;

// defaultConfirmReload — single, fast, NON-BLOCKING-friendly check that a
// restarted component actually came back up before we report success. CTL-1077
// remediate: the original code fired `stack.reload.complete` UNCONDITIONALLY
// right after a fire-and-forget detached `restart`; a restart that races its own
// stop hits EADDRINUSE and leaves the component DOWN (~90 s observed) while the
// event log falsely reports success. Only the monitor exposes a stable listen
// port we can probe from here. The waiting/polling between attempts lives in
// performReload's setTimeoutFn loop (off the event loop) — this function does a
// SINGLE probe and returns immediately, so it no longer blocks the daemon (M3).
function defaultConfirmReload(component) {
  if (!component || component.name !== "monitor") return true;
  const port = process.env.MONITOR_PORT || "7400";
  try {
    // execFileSync (no shell): lsof exits 0 only when a process is LISTENing on
    // the port — i.e. the restarted monitor rebound it. A missing lsof binary
    // surfaces as a real ENOENT here (a shell wrapper would mask it as exit 127).
    execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // CTL-1077 remediate (#7): distinguish "lsof missing" from "port down". When
    // the probe tool itself is absent, every reload would otherwise exhaust all
    // attempts and report a permanent false-degraded, training operators to ignore
    // the event. Warn ONCE and treat as best-effort confirmed so a broken probe is
    // observable rather than a silent permanent-degraded.
    if (err && err.code === "ENOENT") {
      if (!_lsofUnavailableWarned) {
        _lsofUnavailableWarned = true;
        log.warn({ port }, "lsof unavailable; monitor reload confirmation disabled (treating restarts as best-effort confirmed)");
      }
      return true;
    }
    return false; // not listening yet
  }
}

// pidFilePathForComponent — resolves the PID file path for a named component.
// Mirrors the bash wrappers' env overrides + default paths so JS and bash agree.
// Returns null for components with no probeable PID file (e.g. broker). (CTL-1089)
export function pidFilePathForComponent(name) {
  if (name === "monitor")
    return process.env.MONITOR_PID_FILE || resolve(homedir(), "catalyst", "monitor.pid");
  if (name === "execution-core")
    return process.env.EXECUTION_CORE_PID_FILE
      || resolve(homedir(), "catalyst", "execution-core", "daemon.pid");
  return null;
}

// defaultIsRunningFn — liveness probe via PID file + kill(pid, 0), the Node
// equivalent of the wrappers' `is_alive`. Conservative by design (CTL-1089):
// any uncertainty resolves to "not running" so hot-reload never starts a
// daemon the operator deliberately left stopped.
export function defaultIsRunningFn(component) {
  const pidPath = pidFilePathForComponent(component?.name);
  if (!pidPath || !existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws ESRCH if gone, EPERM if unsignalable
    return true;
  } catch {
    return false;
  }
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
  getByteOffsetFn,
  logPath,
  confirmFn = defaultConfirmReload,
  isRunningFn = defaultIsRunningFn,
  setTimeoutFn = setTimeout,
  confirmPollMs = STACK_RELOAD_CONFIRM_POLL_MS,
  confirmMaxAttempts = STACK_RELOAD_CONFIRM_MAX_ATTEMPTS,
}) {
  // CTL-1089: Partition reload candidates by running-state. Hot-reload must never
  // start a daemon the operator deliberately left stopped. Unknown liveness → skip.
  const toReload = [];
  const skipped = [];
  for (const c of decision.components) {
    let running = false;
    try { running = isRunningFn(c) !== false; } catch { running = false; }
    (running ? toReload : skipped).push(c);
  }

  emitFn?.({
    event: "stack.reload.started",
    orchestrator: null,
    worker: null,
    detail: { components: toReload.map((c) => c.name), skipped: skipped.map((c) => c.name), ts: now },
  });

  // CTL-1077 remediate: restart each component, then CONFIRM it came back before
  // reporting success. The prior code emitted `stack.reload.complete`
  // unconditionally right after the fire-and-forget spawn, so a restart that
  // raced its own stop (EADDRINUSE) left the component DOWN while the event log
  // falsely reported success. We now gate the complete event on confirmation.
  //
  // M1: trySpawn surfaces a synchronous spawn failure (e.g. exec-core binary
  // unresolvable) so a component that could not even start is partitioned
  // unconfirmed → degraded, not silently reported complete.
  // M3: confirmation polls NON-BLOCKINGLY via setTimeoutFn between single probes,
  // so the broker event loop stays responsive during a deploy instead of being
  // blocked by a synchronous sleep loop.
  const confirmed = [];
  const unconfirmed = [];
  const pending = [];
  for (const c of toReload) {
    if (trySpawn(spawnFn, c.cmd, ["restart"])) {
      pending.push({ c, attempts: 0, retried: false });
    } else {
      // Spawn threw synchronously — the restart never launched.
      unconfirmed.push(c);
    }
  }

  const finish = () => {
    if (unconfirmed.length === 0) {
      emitFn?.({
        event: "stack.reload.complete",
        orchestrator: null,
        worker: null,
        detail: {
          components: toReload.map((c) => ({
            name: c.name,
            old_sha: c.oldSha,
            new_sha: c.newSha,
          })),
          skipped: skipped.map((c) => ({ name: c.name, reason: "not_running" })),
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
          skipped: skipped.map((c) => ({ name: c.name, reason: "not_running" })),
        },
      });
    }
    maybeBrokerSelfReload();
  };

  // Broker self-reload: write tail-offset handoff then re-exec via catalyst-broker
  // restart. The handoff lets the successor pick up exactly where we left off
  // rather than reseeding to EOF and dropping events appended during the gap.
  const maybeBrokerSelfReload = () => {
    if (!decision.brokerSelfReload) return;
    try {
      // M5: capture the byte offset at handoff-WRITE time (now, after the debounce
      // + confirmation), not at processEvent time ~30 s earlier. Resuming from the
      // stale processEvent-time low-water offset re-processes ~30 s of events and
      // can double-fire non-idempotent handlers. getByteOffsetFn (when injected)
      // reads the live offset here; currentByteOffset is the static fallback.
      const byteOffset =
        typeof getByteOffsetFn === "function" ? getByteOffsetFn() : currentByteOffset;
      // Stamp ts at write time, not event-capture time: this handoff is written
      // ~STACK_RELOAD_DEBOUNCE_MS after the triggering merge (plus any merge-train
      // coalescing), and the successor's resolveBootByteOffset measures staleness
      // against its own boot clock. Using the event-capture `now` would burn most of
      // the maxAgeMs budget on the debounce window and reject otherwise-fresh handoffs.
      writeHandoffFn({ logPath, byteOffset, pid: process.pid, ts: nowFn() });
    } catch {
      // Handoff write failed — defaultWriteHandoffFn already log.error'd and
      // re-threw. Still attempt the restart below (best-effort): a successor that
      // reseeds from EOF beats a broker stuck on stale code.
    }
    // M2: detect a failed broker self-reload spawn instead of double-swallowing
    // it. If the restart spawn cannot launch, the broker keeps running stale code
    // silently with an orphan handoff on disk — emit a degraded event + log.error
    // so the stuck self-reload is observable.
    if (!trySpawn(spawnFn, "catalyst-broker", ["restart"])) {
      log.error(
        { component: "broker" },
        "broker self-reload restart spawn failed; broker still running stale code"
      );
      emitFn?.({
        event: "stack.reload.degraded",
        orchestrator: null,
        worker: null,
        detail: { reason: "broker_restart_failed", component: "broker" },
      });
    }
  };

  // Non-blocking confirmation poll. The FIRST tick runs synchronously (so the
  // happy path — everything confirmed immediately — completes without ever
  // touching setTimeoutFn, preserving deterministic synchronous behavior for
  // already-up components and tests). Only genuinely-unconfirmed components defer
  // subsequent probes onto the event loop via setTimeoutFn.
  const tick = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      let ok = false;
      try { ok = confirmFn(p.c) !== false; } catch { ok = false; }
      if (ok) {
        confirmed.push(p.c);
        pending.splice(i, 1);
        continue;
      }
      p.attempts++;
      // Retry the restart spawn exactly once (the recommendation's "retry once").
      if (!p.retried) {
        p.retried = true;
        trySpawn(spawnFn, p.c.cmd, ["restart"]);
      }
      if (p.attempts >= confirmMaxAttempts) {
        unconfirmed.push(p.c);
        pending.splice(i, 1);
      }
    }
    if (pending.length > 0) {
      setTimeoutFn(tick, confirmPollMs);
      return;
    }
    finish();
  };

  if (pending.length === 0) {
    // Every component failed to even spawn — go straight to the verdict.
    finish();
  } else {
    tick();
  }
}

// --- lifecycle ---------------------------------------------------------------

/**
 * handleStackReloadEvent — trailing-edge debounce wrapper around performReload.
 *
 * Accepts per-root refresh results from handlePluginRefreshEvent. On each
 * qualifying change, (re)arms a debounce timer so that a burst of rapid merges
 * produces exactly one reload after the last merge. The latest decision (newest
 * SHAs) always wins — EXCEPT brokerSelfReload, which is latched (OR-ed) across
 * coalesced decisions (CTL-1077 remediate, #6) so a true broker-self-reload from
 * an earlier decision in the window is never dropped by a later false one.
 *
 * Injected seams: spawnFn, confirmFn, isRunningFn, emitFn, writeHandoffFn,
 * setTimeoutFn, clearTimeoutFn, now, nowFn, currentByteOffset, getByteOffsetFn,
 * logPath — for deterministic testing. `now` is the event-capture instant (used for the
 * started-event detail); `nowFn` is evaluated at handoff-write time (after the
 * debounce) so the staleness ts reflects when the handoff was actually persisted.
 * `getByteOffsetFn` (when supplied) is evaluated at handoff-write time so the
 * successor resumes from the live tail offset, not a stale processEvent-time one.
 * `confirmFn(component) => boolean` gates the complete event on the restart
 * actually coming back up (CTL-1077 remediate).
 */
export function handleStackReloadEvent({
  results,
  loadedCommitRoot = null,
  spawnFn = defaultSpawnFn,
  confirmFn = defaultConfirmReload,
  isRunningFn = defaultIsRunningFn,
  emitFn,
  now = Date.now(),
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  writeHandoffFn = defaultWriteHandoffFn,
  currentByteOffset = 0,
  getByteOffsetFn,
  logPath = "",
} = {}) {
  try {
    const decision = decideStackReload({ results, loadedCommitRoot });
    if (!decision.shouldReload) return decision;

    // #6: latch brokerSelfReload across coalesced decisions. The latest SHAs still
    // win for the deploy event, but a broker self-reload demanded by ANY decision
    // in the debounce window must survive — a multi-root window where an earlier
    // decision set brokerSelfReload:true and a later one set false must NOT drop
    // the broker reload (it would otherwise keep running stale code).
    const prev = _pendingDecision;
    _pendingDecision = prev
      ? { ...decision, brokerSelfReload: prev.brokerSelfReload || decision.brokerSelfReload }
      : decision;

    // Cancel the outstanding timer with the clearFn that was used to set it.
    if (_pendingTimer != null && _pendingClearFn) {
      try { _pendingClearFn(_pendingTimer); } catch { /* ok */ }
    }

    // Capture closure seams for the debounce callback.
    const capturedSpawnFn = spawnFn;
    const capturedConfirmFn = confirmFn;
    const capturedIsRunningFn = isRunningFn;
    const capturedEmitFn = emitFn;
    const capturedNow = now;
    const capturedNowFn = nowFn;
    const capturedWriteHandoffFn = writeHandoffFn;
    const capturedByteOffset = currentByteOffset;
    const capturedGetByteOffsetFn = getByteOffsetFn;
    const capturedLogPath = logPath;
    const capturedSetTimeoutFn = setTimeoutFn;

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
          isRunningFn: capturedIsRunningFn,
          emitFn: capturedEmitFn,
          now: capturedNow,
          nowFn: capturedNowFn,
          writeHandoffFn: capturedWriteHandoffFn,
          currentByteOffset: capturedByteOffset,
          getByteOffsetFn: capturedGetByteOffsetFn,
          logPath: capturedLogPath,
          setTimeoutFn: capturedSetTimeoutFn,
        });
      }
    }, STACK_RELOAD_DEBOUNCE_MS);

    return decision;
  } catch {
    return { shouldReload: false, brokerSelfReload: false, components: [] };
  }
}
