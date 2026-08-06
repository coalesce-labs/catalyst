// accounts-timer.mjs — CTL-1653. A periodic driver that refreshes the Phase-1
// accounts cache and hands each fresh summary to onTick (which server.ts fans
// out to /api/accounts/stream SSE subscribers + the Phase-4 transition latch).
//
// Modeled on worktree-refresh-timer.mjs (injectable `clock` seam,
// handle.unref()) + service-health-monitor.ts (immediate first tick). A tick
// NEVER throws out of the interval — a probe rejection is swallowed so a flaky
// probe can't crash the interval or wedge the monitor.

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * createAccountsTimer — build the periodic accounts-probe driver.
 *
 * @param {object} o
 * @param {{get: (opts?: {refresh?: boolean}) => Promise<unknown>}} o.probe  the Phase-1 cache
 * @param {object}   [o.clock]        fake-clock seam for tests (setInterval/clearInterval)
 * @param {number}   [o.intervalMs]   probe cadence (default 5 min)
 * @param {Function} o.onTick         called with each fresh summary
 * @param {Function} [o.onError]      optional error sink (default console.error)
 * @returns {{start: () => void, stop: () => void}}
 */
export function createAccountsTimer({
  probe,
  clock = realClock(),
  intervalMs = 5 * 60 * 1000,
  onTick,
  onError = (err) => console.error("[accounts-timer] tick error:", err),
} = {}) {
  let handle = null;

  async function tick() {
    try {
      const summary = await probe.get({ refresh: true });
      onTick?.(summary);
    } catch (err) {
      // Swallow — a probe rejection must never escape the interval.
      onError?.(err);
    }
  }

  function start() {
    // Immediate first tick (service-health style) so a fresh connection has a
    // posture without waiting a whole interval. Fire-and-forget; tick() is
    // never-throw, so a synchronous scheduling error can't escape start().
    void tick();
    handle = clock.setInterval(() => {
      void tick();
    }, intervalMs);
    if (typeof handle?.unref === "function") handle.unref();
  }

  function stop() {
    if (handle) clock.clearInterval(handle);
    handle = null;
  }

  return { start, stop };
}
