// Unit tests for the in-process TTL cache primitive (CTL-634 Tier 1).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-cache.test.mjs
//
// The cache is the single-ticket-state read cache shared by the scheduler's
// out-of-set blocker hydration and the monitor's state_changed write-through.
// Time is controlled with an injectable numeric `now` — the only time-control
// pattern in the repo (no fake-timer lib), per scheduler.test.mjs:282-288.

import { describe, it, expect } from "bun:test";
import { createTicketStateCache } from "./linear-cache.mjs";

describe("createTicketStateCache", () => {
  it("returns undefined on a cold miss", () => {
    const c = createTicketStateCache({ now: () => 1000 });
    expect(c.get("CTL-1")).toBeUndefined();
  });

  it("returns a set value within the TTL window", () => {
    let t = 1000;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.set("CTL-1", "Done");
    t = 1000 + 59_000;
    expect(c.get("CTL-1")).toBe("Done");
  });

  it("expires a value past the TTL window (returns undefined)", () => {
    let t = 1000;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.set("CTL-1", "Done");
    t = 1000 + 60_001;
    expect(c.get("CTL-1")).toBeUndefined();
  });

  it("set refreshes the expiry (write-through resets TTL)", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.set("CTL-1", "Ready");
    t = 59_000;
    c.set("CTL-1", "PR"); // write-through at 59s
    t = 100_000; // 41s after the refresh — still fresh
    expect(c.get("CTL-1")).toBe("PR");
  });

  it("invalidate drops an entry", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.set("CTL-1", "Done");
    c.invalidate("CTL-1");
    expect(c.get("CTL-1")).toBeUndefined();
  });

  it("never stores null or undefined (fail-safe: a failed read is not cacheable)", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.set("CTL-1", null);
    c.set("CTL-2", undefined);
    expect(c.get("CTL-1")).toBeUndefined();
    expect(c.get("CTL-2")).toBeUndefined();
  });

  it("stats counts hits and misses and computes hitRate", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.get("CTL-1"); // miss
    c.set("CTL-1", "Done");
    c.get("CTL-1"); // hit
    c.get("CTL-1"); // hit
    const s = c.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it("an expired get counts as a miss", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 1000 });
    c.set("CTL-1", "Done");
    t = 2000;
    expect(c.get("CTL-1")).toBeUndefined();
    expect(c.stats().misses).toBe(1);
  });

  it("hitRate is 0 when there are zero lookups (no divide-by-zero)", () => {
    const c = createTicketStateCache({ now: () => 0 });
    expect(c.stats().hitRate).toBe(0);
  });
});
