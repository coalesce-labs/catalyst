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

// CTL-784 — the relations read-through store (getRelations / setRelations) lives
// in a SEPARATE map from the string-state store, with its own TTL. The state
// store (get/set/stats) contract above is unchanged by these.
describe("createTicketStateCache — relations store (CTL-784)", () => {
  const desc = (state, extra = {}) => ({
    state,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    priority: 2,
    labels: [],
    ...extra,
  });

  it("returns undefined on a cold relations miss", () => {
    const c = createTicketStateCache({ now: () => 0 });
    expect(c.getRelations("CTL-1")).toBeUndefined();
  });

  it("returns a set descriptor within the TTL window", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.setRelations("CTL-1", desc("Triage", { priority: 3 }));
    t = 59_000;
    const got = c.getRelations("CTL-1");
    expect(got.state).toBe("Triage");
    expect(got.priority).toBe(3);
    expect(got.relations).toEqual({ nodes: [] });
  });

  it("expires a descriptor past the TTL window (returns undefined)", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.setRelations("CTL-1", desc("Triage"));
    t = 60_001;
    expect(c.getRelations("CTL-1")).toBeUndefined();
  });

  it("setRelations primes the state cache so fetchTicketState-style get() hits", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.setRelations("CTL-1", desc("Done"));
    expect(c.get("CTL-1")).toBe("Done"); // state store primed
  });

  it("getRelations overlays the freshest state from the state cache (write-through wins)", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.setRelations("CTL-1", desc("Triage"));
    // monitor write-through updates the STATE on a state_changed event
    c.set("CTL-1", "In Progress");
    const got = c.getRelations("CTL-1");
    expect(got.state).toBe("In Progress"); // overlaid, not the stale "Triage"
    expect(got.relations).toEqual({ nodes: [] }); // edges still from the descriptor
  });

  it("getRelations falls back to the descriptor state when the state entry expired", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000 });
    c.setRelations("CTL-1", desc("Triage"));
    // advance past the state TTL but the relations entry was re-set later
    t = 30_000;
    c.setRelations("CTL-1", desc("Backlog"));
    t = 30_000 + 59_000; // state entry (set at 30_000) still fresh here
    expect(c.getRelations("CTL-1").state).toBe("Backlog");
  });

  it("never stores a null descriptor (fail-safe)", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.setRelations("CTL-1", null);
    c.setRelations("CTL-2", undefined);
    expect(c.getRelations("CTL-1")).toBeUndefined();
    expect(c.getRelations("CTL-2")).toBeUndefined();
  });

  it("invalidate drops BOTH the state and relations entries", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.setRelations("CTL-1", desc("Done"));
    c.invalidate("CTL-1");
    expect(c.getRelations("CTL-1")).toBeUndefined();
    expect(c.get("CTL-1")).toBeUndefined();
  });

  it("relationsStats counts relation hits/misses separately from stats()", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.getRelations("CTL-1"); // rel miss
    c.setRelations("CTL-1", desc("Done"));
    c.getRelations("CTL-1"); // rel hit
    const rs = c.relationsStats();
    expect(rs.hits).toBe(1);
    expect(rs.misses).toBe(1);
    expect(rs.hitRate).toBeCloseTo(1 / 2, 5);
    // state-store stats untouched by relation lookups (only the setRelations prime)
    expect(c.stats().hits).toBe(0);
  });

  // CTL-1436 (A4): the negative cache — a short backoff for probeBackoff callers.
  it("isNegativelyCached is false on a cold ticket; true within negTtlMs of setNegative", () => {
    let t = 1000;
    const c = createTicketStateCache({ now: () => t, negTtlMs: 300_000 });
    expect(c.isNegativelyCached("CTL-1")).toBe(false);
    c.setNegative("CTL-1");
    t = 1000 + 299_000;
    expect(c.isNegativelyCached("CTL-1")).toBe(true);
  });

  it("negative entry expires past negTtlMs", () => {
    let t = 1000;
    const c = createTicketStateCache({ now: () => t, negTtlMs: 300_000 });
    c.setNegative("CTL-1");
    t = 1000 + 300_001;
    expect(c.isNegativelyCached("CTL-1")).toBe(false);
  });

  it("a fresh success (set) clears the negative backoff", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.setNegative("CTL-1");
    expect(c.isNegativelyCached("CTL-1")).toBe(true);
    c.set("CTL-1", "Done"); // the ticket came back → drop the backoff
    expect(c.isNegativelyCached("CTL-1")).toBe(false);
  });

  it("invalidate clears the negative backoff too", () => {
    const c = createTicketStateCache({ now: () => 0 });
    c.setNegative("CTL-1");
    c.invalidate("CTL-1");
    expect(c.isNegativelyCached("CTL-1")).toBe(false);
  });

  it("negTtlMs is independent of the positive ttlMs", () => {
    let t = 0;
    const c = createTicketStateCache({ now: () => t, ttlMs: 60_000, negTtlMs: 300_000 });
    c.setNegative("CTL-1");
    t = 120_000; // past the 60s positive TTL, well within the 300s negative TTL
    expect(c.isNegativelyCached("CTL-1")).toBe(true);
  });
});
