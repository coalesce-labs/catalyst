// filter-chips.test.ts — verifies the unified active-filter chip logic
// introduced in CTL-389. Pure function tests; no Ink rendering required.

import { describe, test, expect } from "bun:test";
import { buildActiveChips, buildMetricsChips, formatEventCount } from "./PromptInput.tsx";

describe("buildActiveChips", () => {
  const none = { activeSinceLabel: null, filterText: "", dslActive: false, dslLabel: "", pivot: null };

  test("no active filters → zero chips", () => {
    expect(buildActiveChips(none)).toEqual([]);
  });

  test("all four filters active → four chips in order", () => {
    const chips = buildActiveChips({
      activeSinceLabel: "5m",
      filterText: "error",
      dslActive: true,
      dslLabel: "errors today",
      pivot: { type: "orch", id: "o-adv-944-946-947-949" },
    });
    expect(chips).toHaveLength(4);
    expect(chips[0]).toMatchObject({ label: "since: 5m", color: "cyan" });
    expect(chips[1]).toMatchObject({ label: "/error", color: "yellow" });
    expect(chips[2]).toMatchObject({ label: "NLQ: errors today", color: "magenta" });
    expect(chips[3]).toMatchObject({ color: "cyan" });
    expect(chips[3]?.label).toContain("orch:");
  });

  test("since chip only shows when activeSinceLabel is non-null", () => {
    const with_ = buildActiveChips({ ...none, activeSinceLabel: "24h" });
    expect(with_).toHaveLength(1);
    expect(with_[0]).toMatchObject({ label: "since: 24h", color: "cyan" });

    const without = buildActiveChips({ ...none, activeSinceLabel: null });
    expect(without).toHaveLength(0);
  });

  test("filter text chip only shows when filterText non-empty", () => {
    const with_ = buildActiveChips({ ...none, filterText: "foo" });
    expect(with_).toHaveLength(1);
    expect(with_[0]).toMatchObject({ label: "/foo", color: "yellow" });

    const without = buildActiveChips({ ...none, filterText: "" });
    expect(without).toHaveLength(0);
  });

  test("NLQ chip shows label and color when dslActive", () => {
    const with_ = buildActiveChips({ ...none, dslActive: true, dslLabel: "errors in prod" });
    expect(with_).toHaveLength(1);
    expect(with_[0]).toMatchObject({ label: "NLQ: errors in prod", color: "magenta" });
  });

  test("NLQ label truncates at 20 chars with ellipsis", () => {
    // "errors from orchestrators today in prod" → first 20 chars = "errors from orchestr"
    const chips = buildActiveChips({ ...none, dslActive: true, dslLabel: "errors from orchestrators today in prod" });
    expect(chips[0]?.label).toBe("NLQ: errors from orchestr…");
  });

  test("pivot chip renders type and truncated id", () => {
    const chips = buildActiveChips({
      ...none,
      pivot: { type: "trace", id: "abc1234567890xyz" },
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.label).toBe("trace: abc123456789…");
    expect(chips[0]?.color).toBe("cyan");
  });

  test("pivot id shorter than 12 chars renders without truncation ellipsis", () => {
    const chips = buildActiveChips({ ...none, pivot: { type: "orch", id: "short" } });
    expect(chips[0]?.label).toBe("orch: short");
  });

  test("since label truncates at 20 chars", () => {
    // sinceLabel exactly 20 chars → no truncation (chip label = "since: " + full spec)
    const exact = buildActiveChips({ ...none, activeSinceLabel: "a".repeat(20) });
    expect(exact[0]?.label).toBe("since: " + "a".repeat(20));

    // sinceLabel > 20 chars → truncated with ellipsis
    const long = buildActiveChips({ ...none, activeSinceLabel: "a".repeat(25) });
    expect(long[0]?.label).toBe("since: " + "a".repeat(20) + "…");
  });

  test("filter text chip truncates at 20 chars", () => {
    const chips = buildActiveChips({ ...none, filterText: "a".repeat(25) });
    expect(chips[0]?.label).toBe("/" + "a".repeat(20) + "…");
  });
});

describe("buildMetricsChips", () => {
  // CTL-435: status-line live operational metrics — always 4 chips, order
  // fixed (workers, orchs, hb, PRs). Non-zero workers/orchs/PRs render green;
  // hb is always gray (it's a cumulative counter, not an alert).
  const zero = { activeWorkers: 0, activeOrchestrators: 0, heartbeats: 0, openPRs: 0 };

  test("all zero → 4 chips, all gray", () => {
    const chips = buildMetricsChips(zero);
    expect(chips).toHaveLength(4);
    expect(chips.every((c) => c.color === "gray")).toBe(true);
    expect(chips.map((c) => c.label)).toEqual([
      "workers: 0",
      "orchs: 0",
      "hb: 0",
      "PRs: 0",
    ]);
  });

  test("non-zero workers/orchs/PRs → green; hb stays gray", () => {
    const chips = buildMetricsChips({
      activeWorkers: 3,
      activeOrchestrators: 1,
      heartbeats: 47,
      openPRs: 2,
    });
    expect(chips[0]).toMatchObject({ label: "workers: 3", color: "green" });
    expect(chips[1]).toMatchObject({ label: "orchs: 1", color: "green" });
    expect(chips[2]).toMatchObject({ label: "hb: 47", color: "gray" });
    expect(chips[3]).toMatchObject({ label: "PRs: 2", color: "green" });
  });

  test("only some metrics non-zero — colors flip per chip independently", () => {
    const chips = buildMetricsChips({
      activeWorkers: 0,
      activeOrchestrators: 1,
      heartbeats: 5,
      openPRs: 0,
    });
    expect(chips[0]).toMatchObject({ label: "workers: 0", color: "gray" });
    expect(chips[1]).toMatchObject({ label: "orchs: 1", color: "green" });
    expect(chips[2]).toMatchObject({ label: "hb: 5", color: "gray" });
    expect(chips[3]).toMatchObject({ label: "PRs: 0", color: "gray" });
  });

  test("hb is gray even when very large", () => {
    const chips = buildMetricsChips({ ...zero, heartbeats: 9999 });
    expect(chips[2]).toMatchObject({ label: "hb: 9999", color: "gray" });
  });
});

describe("formatEventCount", () => {
  test("equal counts → single number form (no filters active)", () => {
    expect(formatEventCount(5710, 5710)).toBe("5710 events");
  });

  test("unequal counts → slash form", () => {
    expect(formatEventCount(2700, 5710)).toBe("2700/5710 events");
  });

  test("zero filtered", () => {
    expect(formatEventCount(0, 100)).toBe("0/100 events");
  });

  test("all filtered out edge case (0 total)", () => {
    expect(formatEventCount(0, 0)).toBe("0 events");
  });
});
