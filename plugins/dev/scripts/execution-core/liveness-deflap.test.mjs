// liveness-deflap.test.mjs — CTL-1091 Phase 2. Unit tests for the pure
// restore-side deflap that layers on top of the surviving roster: a host that
// transitioned dead→live must be observed continuously live for holdMs before it
// re-enters the DISPATCH roster, so a flapping laptop (lid open/close) does not
// grab-then-strand new work.

import { describe, test, expect } from "bun:test";
import { computeDispatchRoster } from "./liveness-deflap.mjs";

describe("computeDispatchRoster — restore deflap (CTL-1091)", () => {
  const HOLD = 600_000; // HEARTBEAT_RESTORE_HOLD_MS

  test("keeps a freshly-restored host OUT until continuously live for the hold", () => {
    // prevState marks laptop as previously dead (liveSince:null). It is live now
    // (in survivingRoster) → first live observation → liveSince=nowMs, elapsed
    // 0 < HOLD → excluded from the dispatch roster.
    const { dispatchRoster, nextState } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: null } },
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster).toEqual(["mini"]);
    expect(nextState.laptop.liveSince).toBe(1_000);
  });

  test("admits the host once liveSince is older than the hold", () => {
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 1_000 + HOLD + 1,
    });
    expect(dispatchRoster).toEqual(["mini", "laptop"]);
  });

  test("still holds the host the tick BEFORE the hold elapses (boundary)", () => {
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 1_000 + HOLD - 1,
    });
    expect(dispatchRoster).toEqual(["mini"]);
  });

  test("preserves a continuously-live host's liveSince across ticks", () => {
    const { nextState } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 50_000,
    });
    expect(nextState.laptop.liveSince).toBe(1_000);
  });

  test("resets liveSince when the host drops out of the surviving roster (flap)", () => {
    // laptop had a live-hold running, now it is NOT in survivingRoster (shed) →
    // liveSince resets to null so a re-join restarts the whole hold.
    const { nextState, dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 5_000,
    });
    expect(nextState.laptop.liveSince).toBeNull();
    expect(dispatchRoster).toEqual(["mini"]);
  });

  test("never delays the SELF host, even if it looks freshly restored", () => {
    // A host never defers taking its OWN work — self is admitted regardless of hold.
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { mini: { liveSince: null } },
      holdMs: HOLD,
      nowMs: 1_000,
      self: "mini",
    });
    expect(dispatchRoster).toContain("mini");
  });

  test("cold start (no prior state) admits every live host — no transient shed", () => {
    // First run / absent .liveness-deflap.json: a live host with no prior
    // observation is treated as already past the hold, NOT newly-restored, so a
    // cold start does not transiently shed every host (migration note).
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: {},
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster.slice().sort()).toEqual(["laptop", "mini"]);
  });

  test("fail-safe: an all-newly-restored fleet degrades to the surviving roster (never strands)", () => {
    // Pathological: every live host looks newly-restored → the naive filter would
    // empty the dispatch roster. The backstop degrades to the surviving roster so
    // dispatch never strands the whole board.
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { mini: { liveSince: null }, laptop: { liveSince: null } },
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster.slice().sort()).toEqual(["laptop", "mini"]);
  });

  test("single-host roster admits the lone host unchanged", () => {
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["solo"],
      roster: ["solo"],
      prevState: {},
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster).toEqual(["solo"]);
  });
});
