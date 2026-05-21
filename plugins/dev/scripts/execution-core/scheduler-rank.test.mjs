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
