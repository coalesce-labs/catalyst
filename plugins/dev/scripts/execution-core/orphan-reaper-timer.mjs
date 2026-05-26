// orphan-reaper-timer.mjs — periodic emit of orphans.reap-requested events
// (CTL-649 Phase 9). Pure: clock and emit are injectable so tests use a fake
// clock; production wiring runs with setInterval and emitReapIntent.

import { emitReapIntent } from "./reap-intent.mjs";

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
 * @param {object}  [opts.clock=realClock()]       fake-clock seam for tests
 */
export function startOrphanReaperTimer({
  enabled = true,
  intervalSeconds = 600,
  emit = emitReapIntent,
  clock = realClock(),
} = {}) {
  if (!enabled) return { stop: () => {} };
  const ms = Math.max(1, intervalSeconds) * 1000;
  const handle = clock.setInterval(async () => {
    try {
      await emit("orphans.reap-requested", {});
    } catch {
      /* best-effort; next tick retries */
    }
  }, ms);
  // unref so the timer never keeps the process alive on its own
  if (typeof handle?.unref === "function") handle.unref();
  return {
    stop: () => clock.clearInterval(handle),
  };
}
