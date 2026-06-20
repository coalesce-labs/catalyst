// board-health-seam.test.mjs — CTL-1290. The THIN scheduler-seam test (§9.4).
//
// Run: cd plugins/dev/scripts/execution-core && bun test board-health-seam.test.mjs
//
// Lives in its OWN file (not scheduler.test.mjs) so it runs in CI:
// scheduler.test.mjs is excluded from the CI allowlist for its real-timer /
// fs.watch "debounced tick" suite. These three cases call schedulerTick ONCE,
// synchronously, with injected stubs — no timers, no fs.watch — so they are
// CI-safe. The pass LOGIC is covered by board-health.test.mjs; here we assert
// ONLY the seam: the hook fires the injected boardHealthPassFn with the in-scope
// capacity + eligible when the daemon threads `boardHealth`, honors the mode
// gate, and is INERT on a bare tick (the property that keeps every other
// schedulerTick test from doing real board-health IO).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerTick } from "./scheduler.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "bh-seam-"));
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "bh-seam-cat-"));
  process.env.CATALYST_DIR = catalystDir; // getEventLogPath() resolves under the fixture
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

describe("schedulerTick — board-health seam (CTL-1290 §9.4)", () => {
  test("threads boardHealth → boardHealthPassFn called once with capacity + eligible", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [{ identifier: "CTL-1" }, { identifier: "CTL-2" }],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      concurrency: { maxParallel: 4 },
      liveBackgroundCount: () => 4, // freeSlots=0 → Pass 2 dispatch is a clean no-op
      boardHealth: { mode: "shadow" },
      boardHealthPassFn: (opts) => {
        calls.push(opts);
        return { ran: true, ranAtMs: 1 };
      },
    });
    expect(calls.length).toBe(1);
    const o = calls[0];
    expect(o.mode).toBe("shadow");
    expect(o.capacity).toEqual({ maxParallel: 4, liveCount: 4, freeSlots: 0 });
    expect(o.getEligible().map((e) => e.identifier)).toEqual(["CTL-1", "CTL-2"]);
    expect(typeof o.getWorkerSignals).toBe("function");
  });

  test("boardHealth.mode:off → boardHealthPassFn NOT called", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      liveBackgroundCount: () => 0,
      boardHealth: { mode: "off" },
      boardHealthPassFn: (opts) => calls.push(opts),
    });
    expect(calls.length).toBe(0);
  });

  test("no boardHealth seam (bare tick) → boardHealthPassFn NOT called (inert)", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      liveBackgroundCount: () => 0,
      boardHealthPassFn: (opts) => calls.push(opts),
    });
    expect(calls.length).toBe(0);
  });
});
