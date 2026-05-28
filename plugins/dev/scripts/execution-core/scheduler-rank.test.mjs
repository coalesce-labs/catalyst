// Unit tests for the pull-loop scheduler priority ranking (CTL-536 Phase 2).
// Run: cd plugins/dev/scripts/execution-core && bun test scheduler-rank.test.mjs

import { describe, test, expect } from "bun:test";
import { priorityRank, compareTickets, rankTickets } from "./scheduler-rank.mjs";

const t = (id, priority, createdAt) => ({ identifier: id, priority, createdAt });

describe("priorityRank", () => {
  test("Urgent..Low map to 1..4; No priority (0) maps to 5", () => {
    expect([1, 2, 3, 4, 0].map((p) => priorityRank({ priority: p }))).toEqual([1, 2, 3, 4, 5]);
  });
  test("missing / non-numeric priority ranks as No priority (5)", () => {
    expect(priorityRank({})).toBe(5);
    expect(priorityRank({ priority: null })).toBe(5);
  });
});

describe("compareTickets", () => {
  test("more-urgent priority sorts first", () => {
    expect(compareTickets(t("A", 1, "x"), t("B", 3, "x"))).toBeLessThan(0);
  });
  test("No priority (0) sorts after Low (4)", () => {
    expect(compareTickets(t("A", 0, "x"), t("B", 4, "x"))).toBeGreaterThan(0);
  });
  test("equal priority: older createdAt sorts first (FIFO fairness)", () => {
    expect(
      compareTickets(t("A", 2, "2026-05-01T00:00:00Z"), t("B", 2, "2026-05-10T00:00:00Z"))
    ).toBeLessThan(0);
  });
  test("missing createdAt sorts last within equal priority", () => {
    expect(compareTickets(t("A", 2, null), t("B", 2, "2026-05-01T00:00:00Z"))).toBeGreaterThan(0);
  });
  test("identical priority + createdAt: identifier breaks the tie (total order)", () => {
    expect(compareTickets(t("ENG-1", 2, "x"), t("ENG-2", 2, "x"))).toBeLessThan(0);
  });
});

describe("rankTickets", () => {
  test("returns a new sorted array, does not mutate the input", () => {
    const input = [t("C", 3, "x"), t("A", 1, "x"), t("B", 1, "a")];
    const ranked = rankTickets(input);
    expect(ranked.map((x) => x.identifier)).toEqual(["B", "A", "C"]);
    expect(input.map((x) => x.identifier)).toEqual(["C", "A", "B"]); // unmutated
  });
  test("empty input yields empty output", () => {
    expect(rankTickets([])).toEqual([]);
  });
});

// CTL-705: stage-aware global comparator
describe("compareTickets stage key", () => {
  const ts = (id, priority, stage, createdAt) => ({ identifier: id, priority, stage, createdAt });

  test("backward compat — no stage field: sorts by createdAt (queued-vs-queued unchanged)", () => {
    const a = t("A", 2, "2026-05-01T00:00:00Z");
    const b = t("B", 2, "2026-05-10T00:00:00Z");
    expect(compareTickets(a, b)).toBeLessThan(0);
  });

  test("stage breaks a priority tie, descending (higher stage = closer to done)", () => {
    // Use identifiers where B < A to make identifier tie-break go the WRONG way,
    // proving the stage key is what drives the result.
    const a = ts("Z", 2, 5, "2026-05-01T00:00:00Z"); // higher stage, higher identifier
    const b = ts("A", 2, 2, "2026-05-01T00:00:00Z"); // lower stage, lower identifier
    expect(compareTickets(a, b)).toBeLessThan(0); // a (stage 5) sorts before b (stage 2)
  });

  test("priority dominates stage: Urgent@triage beats Low@monitor-deploy", () => {
    const urgent = ts("Z", 1, 0, "2026-05-01T00:00:00Z"); // higher identifier
    const low = ts("A", 4, 9, "2026-05-01T00:00:00Z");    // lower identifier
    expect(compareTickets(urgent, low)).toBeLessThan(0);
  });

  test("in-flight (stage ≥ 0) sorts before queued (stage -1) within same priority band", () => {
    // in-flight has higher identifier so identifier tie-break goes wrong way without stage
    const inFlight = ts("Z", 2, 3, "2026-05-01T00:00:00Z");
    const queued = ts("A", 2, -1, "2026-05-01T00:00:00Z");
    expect(compareTickets(inFlight, queued)).toBeLessThan(0);
  });

  test("stage undefined is treated as -1 (queued default)", () => {
    // withStage has higher identifier so identifier tie-break goes wrong way without stage
    const withStage = ts("Z", 2, 2, "2026-05-01T00:00:00Z");
    const withoutStage = t("A", 2, "2026-05-01T00:00:00Z"); // no stage field → treated as -1
    expect(compareTickets(withStage, withoutStage)).toBeLessThan(0);
  });

  test("rankTickets is still pure — input array not mutated", () => {
    const input = [ts("C", 2, 1, "x"), ts("A", 2, 5, "x"), ts("B", 2, -1, "x")];
    const copy = input.map((x) => ({ ...x }));
    rankTickets(input);
    expect(input).toEqual(copy);
  });
});
