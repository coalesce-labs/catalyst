// occupancy-arm.mjs — CTL-2116. `hasInProcessRoute` was boot-captured
// (daemon.mjs), which was correct while the routing map only changed with a
// restart-requiring plist edit. The fleet policy is LIVE (CTL-2116 Phases 1-3),
// so a stale `false` would let a newly-routed codex/sdk phase run uncounted ->
// over-admit past maxParallel. Accepts boolean | (() => boolean) so the ~20
// pass-through sites stay untouched; only the 4 USE sites
// (scheduler.mjs:6880,8473,8512, monitor.mjs:806) call this.
//
// isInProcessDispatchMode is the SAME predicate config.mjs already exports and
// scheduler.mjs/monitor.mjs (this module's only two callers) already import —
// re-deriving it here would create a second, silently-divergent copy of the
// sdk|codex-exec membership test.
import { isInProcessDispatchMode } from "./config.mjs";

// Fail direction: a throwing/unreadable probe returns TRUE. Over-counting
// occupancy under-admits (conservative); under-counting over-admits (the bug
// this predicate exists to close).
export function armsInProcessOccupancy(dispatchMode, hasInProcessRoute) {
  if (isInProcessDispatchMode(dispatchMode)) return true;
  if (typeof hasInProcessRoute === "function") {
    try {
      return Boolean(hasInProcessRoute());
    } catch {
      return true; // fail safe: an unreadable live route arms occupancy
    }
  }
  return Boolean(hasInProcessRoute);
}
