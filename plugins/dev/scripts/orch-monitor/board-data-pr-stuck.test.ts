// CTL-1158: unit tests for isPrStuck() and prStuckReason() — the pure helpers
// that drive the PR-stuck attention signal. A PR that has been DIRTY/BLOCKED/
// UNSTABLE for ≥ 300 s surfaces in the "Needs you" inbox with a PR-specific CTA.
// All tests are PURE: no fs/network, no assembleBoard.

import { describe, it, expect } from "bun:test";

const { isPrStuck, prStuckReason } = await import("./lib/board-data.mjs");

const NOW = Date.parse("2026-06-14T10:10:00Z");   // 10 min after start
const START = "2026-06-14T10:00:00Z";             // 600 s before NOW (≥ 300 s)
const FRESH = "2026-06-14T10:09:00Z";             // 60 s before NOW (< 300 s)

describe("isPrStuck — real-blocker merge state held ≥ 300 s", () => {
  for (const ms of ["DIRTY", "BLOCKED", "UNSTABLE"]) {
    it(`${ms} for ≥ 300 s → stuck`, () => {
      expect(isPrStuck({ mergeStateStatus: ms, state: "OPEN" }, START, NOW)).toBe(true);
    });
    it(`${ms} for < 300 s → NOT stuck (debounce)`, () => {
      expect(isPrStuck({ mergeStateStatus: ms, state: "OPEN" }, FRESH, NOW)).toBe(false);
    });
  }
  for (const ms of ["CLEAN", "BEHIND", "HAS_HOOKS", "UNKNOWN"]) {
    it(`${ms} → never stuck (not a real blocker)`, () => {
      expect(isPrStuck({ mergeStateStatus: ms, state: "OPEN" }, START, NOW)).toBe(false);
    });
  }
  it("a MERGED PR is never stuck", () => {
    expect(isPrStuck({ mergeStateStatus: "DIRTY", state: "MERGED" }, START, NOW)).toBe(false);
  });
  it("a CLOSED PR is never stuck", () => {
    expect(isPrStuck({ mergeStateStatus: "DIRTY", state: "CLOSED" }, START, NOW)).toBe(false);
  });
  it("null prStatus → not stuck (no throw)", () => {
    expect(isPrStuck(null, START, NOW)).toBe(false);
  });
  it("null prPhaseStartedAt → not stuck (no anchor, no throw)", () => {
    expect(isPrStuck({ mergeStateStatus: "DIRTY", state: "OPEN" }, null, NOW)).toBe(false);
  });
  it("UNKNOWN state is treated as OPEN (still may be stuck)", () => {
    expect(isPrStuck({ mergeStateStatus: "DIRTY", state: "UNKNOWN" }, START, NOW)).toBe(true);
  });
});

describe("prStuckReason — PR-specific operator CTA", () => {
  it("DIRTY → merge-conflict phrasing with PR number", () => {
    const reason = prStuckReason("DIRTY", 1158);
    expect(reason).toMatch(/#1158/);
    expect(reason).toMatch(/conflict/i);
  });
  it("BLOCKED → required-check or branch-protection phrasing", () => {
    const reason = prStuckReason("BLOCKED", 1158);
    expect(reason).toMatch(/#1158/);
    expect(reason).toMatch(/required|check|protection/i);
  });
  it("UNSTABLE → failing-check phrasing", () => {
    const reason = prStuckReason("UNSTABLE", 1158);
    expect(reason).toMatch(/#1158/);
    expect(reason).toMatch(/check/i);
  });
  it("CLEAN → null (not a blocker)", () => {
    expect(prStuckReason("CLEAN", 1158)).toBeNull();
  });
  it("BEHIND → null (not a blocker)", () => {
    expect(prStuckReason("BEHIND", 1158)).toBeNull();
  });
  it("HAS_HOOKS → null (not a blocker)", () => {
    expect(prStuckReason("HAS_HOOKS", 1158)).toBeNull();
  });
  it("UNKNOWN → null (not a blocker)", () => {
    expect(prStuckReason("UNKNOWN", 1158)).toBeNull();
  });
});
