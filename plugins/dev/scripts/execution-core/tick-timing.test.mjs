// tick-timing.test.mjs — CTL-1330 Tier 1: the per-pass tick timer + its gate.
// These are pure functions (no timers / no fs.watch), so unlike the bulk of
// scheduler.test.mjs they are safe to run in the CI sandbox.

import { describe, test, expect } from "bun:test";
import { makeTickTimer, tickTimingEnabled } from "./scheduler.mjs";

describe("makeTickTimer (CTL-1330)", () => {
  test("lap records ms since the previous lap; totalMs is from tick start", () => {
    let t = 0;
    const now = () => t;
    const tick = makeTickTimer(now);
    t = 5;
    tick.lap("one");
    t = 12;
    tick.lap("two");
    expect(tick.passes).toEqual({ one: 5, two: 7 });
    t = 20;
    expect(tick.totalMs()).toBe(20);
  });

  test("durations round to 0.1ms", () => {
    let t = 0;
    const now = () => t;
    const tick = makeTickTimer(now);
    t = 1.234;
    tick.lap("x");
    expect(tick.passes.x).toBe(1.2);
  });

  test("tickId increments monotonically across timers", () => {
    const a = makeTickTimer(() => 0);
    const b = makeTickTimer(() => 0);
    expect(b.tickId).toBe(a.tickId + 1);
  });
});

describe("tickTimingEnabled (CTL-1330 gate — ON by default)", () => {
  test("ON when unset", () => {
    expect(tickTimingEnabled({})).toBe(true);
  });

  test("ON for any value other than the literal 'off'", () => {
    expect(tickTimingEnabled({ CATALYST_TICK_TIMING: "1" })).toBe(true);
    expect(tickTimingEnabled({ CATALYST_TICK_TIMING: "on" })).toBe(true);
  });

  test("OFF only when explicitly 'off'", () => {
    expect(tickTimingEnabled({ CATALYST_TICK_TIMING: "off" })).toBe(false);
  });
});
