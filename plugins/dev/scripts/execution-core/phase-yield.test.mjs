// phase-yield.test.mjs — CTL-1854 option 3: the yielded-resumable state.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phase-yield.test.mjs
//
// ⚠️ JUDGED BY RATE, NOT REPRODUCTION. The defect is nondeterministic — same phase,
// same host, 13 minutes apart, one abandoned and one merged — so "it worked once"
// proves nothing about the fix. These tests pin the CONTRACT (what the runner may
// and may not do for each signal shape); the rate question is answered on the
// fleet, by counting abandonments after this ships.

import { describe, expect, test } from "bun:test";
import {
  YIELDED_STATUS,
  MAX_YIELD_MS,
  YIELD_EXPIRED_REASON,
  classifyYield,
  shouldFlipOnUndeclaredExit,
} from "../lib/phase-yield.mjs";

const T0 = Date.parse("2026-08-14T20:00:00Z");
const yielded = (over = {}) => ({
  status: YIELDED_STATUS,
  yieldedAt: new Date(T0).toISOString(),
  ...over,
});

describe("a live yield is protected", () => {
  test("within the deadline, the runner does NOT write a terminal", () => {
    const r = shouldFlipOnUndeclaredExit(yielded(), T0 + 60_000);
    expect(r.flip).toBe(false);
    expect(r.yield).toMatchObject({ yielded: true, expired: false, reason: "within-deadline" });
  });

  test("an agent may request LESS than the ceiling", () => {
    const sig = yielded({ yieldMs: 5 * 60_000 });
    expect(shouldFlipOnUndeclaredExit(sig, T0 + 4 * 60_000).flip).toBe(false);
    expect(shouldFlipOnUndeclaredExit(sig, T0 + 6 * 60_000).flip).toBe(true);
  });

  test("an agent may NOT request more than the ceiling", () => {
    // A yield outliving Linear's 30-minute session-stale deadline buys nothing.
    const sig = yielded({ yieldMs: 24 * 60 * 60 * 1000 });
    expect(shouldFlipOnUndeclaredExit(sig, T0 + MAX_YIELD_MS + 1).flip).toBe(true);
    expect(classifyYield(sig, T0 + MAX_YIELD_MS + 1).deadlineMs).toBe(T0 + MAX_YIELD_MS);
  });
});

describe("⚠️ the bound is the whole safety argument", () => {
  // isTicketInFlight returns FALSE only for failed|stalled|aborted, so ANY other
  // status holds the slot. An unbounded yield would strand the ticket exactly as
  // sdk-run-phase-agent's own comment warns. These are the tests that keep the
  // state from becoming the defect it replaces.
  test("past the deadline the runner writes a terminal, naming the broken promise", () => {
    const r = shouldFlipOnUndeclaredExit(yielded(), T0 + MAX_YIELD_MS + 1);
    expect(r.flip).toBe(true);
    expect(r.failureReason).toBe(YIELD_EXPIRED_REASON);
  });

  test("an unreadable yield start EXPIRES rather than granting an open permit", () => {
    for (const bad of [undefined, null, "", "not-a-date", {}, []]) {
      const r = shouldFlipOnUndeclaredExit(yielded({ yieldedAt: bad }), T0);
      expect({ bad: String(bad), flip: r.flip }).toEqual({ bad: String(bad), flip: true });
    }
  });

  test("a caller that cannot read the clock cannot extend the deadline", () => {
    expect(shouldFlipOnUndeclaredExit(yielded(), Number.NaN).flip).toBe(true);
  });

  test("exactly at the deadline is still live; one ms past is not", () => {
    expect(shouldFlipOnUndeclaredExit(yielded(), T0 + MAX_YIELD_MS).flip).toBe(false);
    expect(shouldFlipOnUndeclaredExit(yielded(), T0 + MAX_YIELD_MS + 1).flip).toBe(true);
  });
});

describe("⚠️ re-yielding cannot buy an unbounded hold", () => {
  // yieldedAt is rewritten on EVERY yield declaration. Without an episode anchor
  // an agent re-yielding at minute 29 earns a fresh 30 — the same unbounded hold,
  // reached in a loop instead of in one write.
  test("a re-yield inside the window does NOT extend past the episode ceiling", () => {
    const reYielded = {
      status: YIELDED_STATUS,
      firstYieldedAt: new Date(T0).toISOString(),
      yieldedAt: new Date(T0 + 29 * 60_000).toISOString(), // re-declared at minute 29
    };
    // Naive per-yield math would put the deadline at T0+59min. The episode bound
    // holds it at T0+30min.
    expect(classifyYield(reYielded, T0).deadlineMs).toBe(T0 + MAX_YIELD_MS);
    expect(shouldFlipOnUndeclaredExit(reYielded, T0 + MAX_YIELD_MS + 1)).toMatchObject({
      flip: true,
      failureReason: YIELD_EXPIRED_REASON,
    });
  });

  test("ten re-yields buy exactly as much as one", () => {
    let deadline = null;
    for (let i = 0; i < 10; i++) {
      deadline = classifyYield({
        status: YIELDED_STATUS,
        firstYieldedAt: new Date(T0).toISOString(),
        yieldedAt: new Date(T0 + i * 60_000).toISOString(),
      }, T0).deadlineMs;
    }
    expect(deadline).toBe(T0 + MAX_YIELD_MS);
  });

  test("no anchor (a first yield, or a pre-existing signal) anchors on yieldedAt", () => {
    // Backward compatibility: the bound is unchanged for a signal written before
    // the anchor existed, because for a single yield the two instants are equal.
    expect(classifyYield(yielded(), T0).deadlineMs).toBe(T0 + MAX_YIELD_MS);
  });

  test("a PRESENT but unreadable anchor expires; it never falls back to a fresh window", () => {
    for (const bad of ["not-a-date", {}, [], ""]) {
      const sig = { ...yielded(), firstYieldedAt: bad };
      expect({ bad: String(bad), flip: shouldFlipOnUndeclaredExit(sig, T0).flip })
        .toEqual({ bad: String(bad), flip: true });
    }
    // ...while an explicitly absent anchor still behaves as a first yield.
    expect(shouldFlipOnUndeclaredExit({ ...yielded(), firstYieldedAt: null }, T0).flip).toBe(false);
  });
});

describe("every other signal shape behaves exactly as before", () => {
  // The fix must be additive: if this state is not declared, the runner's
  // behaviour is unchanged. A regression here re-breaks CTL-1790.
  test("in-flight and terminal signals still flip", () => {
    for (const status of ["dispatched", "running", "failed", "done", "needs-input"]) {
      const r = shouldFlipOnUndeclaredExit({ status }, T0);
      expect({ status, flip: r.flip, reason: r.yield.reason }).toEqual({
        status,
        flip: true,
        reason: "not-yielded",
      });
    }
  });

  test("junk never throws and never buys a hold", () => {
    for (const junk of [null, undefined, 42, "str", [], true]) {
      expect(() => shouldFlipOnUndeclaredExit(junk, T0)).not.toThrow();
      expect(shouldFlipOnUndeclaredExit(junk, T0).flip).toBe(true);
    }
  });

  test("the yielded status is NOT needs-input", () => {
    // needs-input means waiting on a HUMAN and pages someone; this state waits on
    // a background job and must page nobody. Conflating them imports CTL-1850's
    // false-page defect into the fix for CTL-1854.
    expect(YIELDED_STATUS).not.toBe("needs-input");
    expect(classifyYield({ status: "needs-input" }, T0).yielded).toBe(false);
  });
});
