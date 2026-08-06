import { describe, it, expect } from "bun:test";
import { createAccountsTimer } from "../accounts-timer.mjs";

function fakeClock() {
  // injectable setInterval/clearInterval
  let fn = null;
  return {
    setInterval: (f) => {
      fn = f;
      return { unref() {} };
    },
    clearInterval: () => {
      fn = null;
    },
    tick: async () => {
      if (fn) await fn();
    },
  };
}

describe("createAccountsTimer", () => {
  it("probes immediately on start and on each interval, calling onTick with the summary", async () => {
    let n = 0;
    const clock = fakeClock();
    const probe = { get: async () => ({ node: "n", status: "ok", probedAt: n++ }) };
    const ticks = [];
    const t = createAccountsTimer({ probe, clock, onTick: (s) => ticks.push(s) });
    t.start(); // immediate tick
    await clock.tick(); // one interval
    // the immediate tick is async; let it settle
    await Promise.resolve();
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    t.stop();
  });
  it("stop() clears the interval and unsubscribes further ticks", async () => {
    const clock = fakeClock();
    const probe = { get: async () => ({ node: "n", status: "ok" }) };
    let count = 0;
    const t = createAccountsTimer({ probe, clock, onTick: () => (count += 1) });
    t.start();
    await Promise.resolve();
    const after = count;
    t.stop();
    await clock.tick();
    expect(count).toBe(after);
  });
  it("a probe rejection inside a tick is swallowed (never throws out of the interval)", async () => {
    const clock = fakeClock();
    const probe = {
      get: async () => {
        throw new Error("boom");
      },
    };
    const t = createAccountsTimer({ probe, clock, onTick: () => {}, onError: () => {} });
    expect(() => t.start()).not.toThrow();
    await clock.tick(); // must not reject
    t.stop();
  });
});
