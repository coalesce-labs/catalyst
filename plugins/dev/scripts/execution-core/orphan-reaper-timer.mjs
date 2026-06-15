// orphan-reaper-timer.mjs — periodic emit of orphans.reap-requested events
// (CTL-649 Phase 9). Pure: clock and emit are injectable so tests use a fake
// clock; production wiring runs with setInterval and emitReapIntent.

import { readFileSync } from "node:fs";
import { emitReapIntent } from "./reap-intent.mjs";
import { sweepJobDirs } from "./job-dir-gc.mjs";
import { log } from "./config.mjs";

/**
 * readOrphanReaperConfig — pull { enabled, intervalSeconds, minIdleSeconds } out
 * of a project's .catalyst/config.json → catalyst.orchestration.orphanReaper.
 * Returns {} for a null/missing/unparseable file or absent key, so callers fall
 * back to the built-in defaults (enabled, 600s interval, 900s minIdle). Never
 * throws.
 */
export function readOrphanReaperConfig(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "orphan-reaper: config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.orphanReaper ?? {};
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * Start the periodic orphan-reaper timer. Returns a `{ stop }` handle.
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled=true]            disable to no-op the timer
 * @param {number}  [opts.intervalSeconds=600]     default 10 minutes
 * @param {Function}[opts.emit=emitReapIntent]     emitter seam for tests
 * @param {Function}[opts.jobGc=()=>sweepJobDirs()] CTL-1165 D3: job-dir GC seam
 * @param {object}  [opts.clock=realClock()]       fake-clock seam for tests
 */
export function startOrphanReaperTimer({
  enabled = true,
  intervalSeconds = 600,
  emit = emitReapIntent,
  jobGc = () => sweepJobDirs(),
  clock = realClock(),
} = {}) {
  if (!enabled) return { stop: () => {} };
  const ms = Math.max(1, intervalSeconds) * 1000;
  const handle = clock.setInterval(async () => {
    try {
      // CTL-661 hole #4: drive the per-ticket reconciliation sweep off the same
      // timer (no new daemon timer). A bare reconcile event — no bg_job_id — is
      // the TRIGGER the Reaper routes to its reconcile sweep; the sweep then
      // emits per-session phase.reconcile.reap-requested intents WITH a target.
      // Both emits are issued synchronously (before any await) so a single tick
      // fires both even when the producer is async.
      //
      // CTL-1165 D3: piggyback the ~/.claude/jobs/<id> dir GC on the same 600s
      // cadence (no new daemon timer). All three promises start synchronously
      // (the emits before any await) and share THIS try/catch, so a rejecting
      // jobGc cannot suppress the two reap emits — the emit calls have already
      // run by the time jobGc's rejection surfaces in the shared catch.
      await Promise.all([
        emit("orphans.reap-requested", {}),
        emit("phase.reconcile.reap-requested", {}),
        jobGc(),
      ]);
    } catch (err) {
      // CTL-649: a persistently-unwritable event log would make every tick
      // fail silently, turning the periodic orphan safety-net into a permanent
      // no-op with zero signal. Surface it; next tick still retries.
      log.warn({ err }, "orphan-reaper: periodic reap-intent emit failed");
    }
  }, ms);
  // unref so the timer never keeps the process alive on its own
  if (typeof handle?.unref === "function") handle.unref();
  return {
    stop: () => clock.clearInterval(handle),
  };
}
