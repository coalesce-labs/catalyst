// delegate-slot-reservation.test.mjs — CTL-1331. The scheduler-side slot
// reservation for the async board-health delegate queue (design §3, §10b).
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-slot-reservation.test.mjs
//
// In its OWN file (NOT scheduler.test.mjs — excluded from the CI allowlist for its
// real-timer / fs.watch "debounced tick" suite) so this runs in CI. Each case
// calls schedulerTick ONCE, synchronously, with injected
// countQueuedDelegates/gcDelegateIntents/liveBackgroundCount stubs — no timers, no
// fs.watch — and reads back the board-health capacity the tick computed (the
// tick's authoritative freeSlots view). It asserts the CTL-1331 invariant: a
// queued/claimed delegate RESERVES a slot (occupiedCount = liveCount +
// queuedDelegates), the reservation only ever LOWERS freeSlots (conservative-only,
// §3b), and an EMPTY queue is a strict no-op (Phase A inert: occupiedCount ===
// liveCount → zero behavior change). Mirrors board-health-seam.test.mjs's
// single-sync-tick discipline.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerTick, computeFreeSlots } from "./scheduler.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "delegate-slot-"));
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "delegate-slot-cat-"));
  process.env.CATALYST_DIR = catalystDir; // getEventLogPath() resolves under the fixture
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// Drive one tick with injected slot seams and return the capacity the board-health
// pass observed. The board-health capacity.freeSlots is computed from occupiedCount
// (scheduler.mjs §3a), so it is the cleanest observable of the reservation.
function tickCapacity({ maxParallel, live, queued, gcSpy }) {
  let captured = null;
  schedulerTick(orchDir, {
    readEligible: () => [],
    dispatch: () => ({ code: 0 }),
    writeStatus: () => {},
    reclaimDeadWork: () => "noop",
    concurrency: { maxParallel },
    liveBackgroundCount: () => live,
    countQueuedDelegates: () => queued,
    gcDelegateIntents: (dir, now) => {
      gcSpy?.(dir, now);
      return 0;
    },
    boardHealth: { mode: "shadow" },
    boardHealthPassFn: (opts) => {
      captured = opts.capacity;
      return { ran: true, ranAtMs: 1 };
    },
  });
  return captured;
}

describe("schedulerTick — CTL-1331 delegate slot reservation (§3/§10b)", () => {
  test("empty queue → occupiedCount === liveCount (Phase A inert: zero behavior change)", () => {
    const cap = tickCapacity({ maxParallel: 4, live: 2, queued: 0 });
    expect(cap.liveCount).toBe(2);
    // freeSlots identical to the pre-CTL-1331 value computeFreeSlots(4, liveCount).
    expect(cap.freeSlots).toBe(computeFreeSlots(4, 2));
    expect(cap.freeSlots).toBe(2);
  });

  test("N queued delegates reserve N slots → freeSlots drops by N", () => {
    const cap = tickCapacity({ maxParallel: 4, live: 1, queued: 2 });
    // occupiedCount = live(1) + queued(2) = 3 → freeSlots = 4 - 3 = 1.
    expect(cap.liveCount).toBe(1); // the reported live count is UNCHANGED…
    expect(cap.freeSlots).toBe(computeFreeSlots(4, 3)); // …only freeSlots reflects the reservation
    expect(cap.freeSlots).toBe(1);
  });

  test("conservative-only: a reservation never RAISES freeSlots vs no reservation (§3b)", () => {
    const withoutRes = tickCapacity({ maxParallel: 4, live: 2, queued: 0 });
    const withRes = tickCapacity({ maxParallel: 4, live: 2, queued: 1 });
    expect(withRes.freeSlots).toBeLessThanOrEqual(withoutRes.freeSlots);
  });

  test("over-reservation never drives freeSlots below 0 (clamped, never negative)", () => {
    const cap = tickCapacity({ maxParallel: 2, live: 2, queued: 5 });
    expect(cap.freeSlots).toBe(0);
  });

  test("gcDelegateIntents runs each tick (releases stale/terminal reservations before reserving)", () => {
    let gcCalls = 0;
    tickCapacity({ maxParallel: 4, live: 0, queued: 0, gcSpy: () => { gcCalls++; } });
    expect(gcCalls).toBe(1);
  });

  // The board-health capacity above proves occupiedCount reaches ONE consumer. The
  // new-work / promotion / resume gates all derive from inFlightCount =
  // occupiedCount (scheduler.mjs §3b). Assert the tick RESULT's inFlightCount
  // directly so a future regression that re-points only the new-work path back to
  // bare liveCount — which the capacity assertion alone would NOT catch — fails here.
  test("tick result inFlightCount reflects the reservation (new-work/resume gate lock)", () => {
    const tick = (queued) =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: () => ({ code: 0 }),
        writeStatus: () => {},
        reclaimDeadWork: () => "noop",
        concurrency: { maxParallel: 4 },
        liveBackgroundCount: () => 1,
        countQueuedDelegates: () => queued,
        gcDelegateIntents: () => 0,
      });
    expect(tick(0).inFlightCount).toBe(1); // empty queue → inFlightCount === liveCount (inert)
    expect(tick(2).inFlightCount).toBe(3); // live(1) + queued(2) reservations
    // …and the reservation withholds new-work headroom.
    expect(tick(2).freeSlots).toBeLessThan(tick(0).freeSlots);
  });
});
