// occupancy-arm.test.mjs — CTL-2116 Phase 4. Pure leaf covering the live
// occupancy-arm predicate: hasInProcessRoute was boot-captured (daemon.mjs), but
// the CTL-2116 fleet policy is read LIVE, so a stale `false` would let a
// newly-routed codex/sdk phase run uncounted -> over-admit past maxParallel.
// Run: cd plugins/dev/scripts/execution-core && bun test occupancy-arm.test.mjs
import { describe, test, expect } from "bun:test";
import { armsInProcessOccupancy } from "./occupancy-arm.mjs";

describe("armsInProcessOccupancy (CTL-2116)", () => {
  test("is true when the node dispatch mode is in-process, regardless of route", () => {
    expect(armsInProcessOccupancy("sdk", false)).toBe(true);
    expect(armsInProcessOccupancy("codex-exec", false)).toBe(true);
  });

  test("accepts a boolean (byte-identical to today's call sites)", () => {
    expect(armsInProcessOccupancy("phase-agents", true)).toBe(true);
    expect(armsInProcessOccupancy("phase-agents", false)).toBe(false);
  });

  test("accepts a THUNK and calls it fresh each time (live policy)", () => {
    let v = false;
    const t = () => v;
    expect(armsInProcessOccupancy("phase-agents", t)).toBe(false);
    v = true;
    expect(armsInProcessOccupancy("phase-agents", t)).toBe(true);
  });

  test("fails SAFE (true) when the thunk throws — over-count under-admits; under-count over-admits", () => {
    expect(
      armsInProcessOccupancy("phase-agents", () => {
        throw new Error("x");
      }),
    ).toBe(true);
  });

  test("treats undefined/null as false (the existing default)", () => {
    expect(armsInProcessOccupancy("phase-agents", undefined)).toBe(false);
    expect(armsInProcessOccupancy("phase-agents", null)).toBe(false);
  });

  test("in-process dispatch mode wins even when a boolean route is false", () => {
    expect(armsInProcessOccupancy("sdk", false)).toBe(true);
  });

  test("oneshot-legacy/phase-agents (out-of-process) modes defer entirely to the route", () => {
    expect(armsInProcessOccupancy("oneshot-legacy", false)).toBe(false);
    expect(armsInProcessOccupancy("oneshot-legacy", true)).toBe(true);
  });
});
