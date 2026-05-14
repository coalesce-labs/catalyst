// filter-chips.test.ts — verifies the unified active-filter chip logic
// introduced in CTL-389. Pure function tests; no Ink rendering required.

import { describe, test, expect } from "bun:test";
import { buildActiveChips, formatEventCount } from "./FilterInput.tsx";

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
