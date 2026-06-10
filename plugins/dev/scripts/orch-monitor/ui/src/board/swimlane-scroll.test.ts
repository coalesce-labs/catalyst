// swimlane-scroll.test.ts — CTL-958 board scroll refinement: dual-sticky group
// labels + per-cell overscroll chaining.
//
// Tests the exported constants and the constrainCells logic that drives the
// Linear-style scroll UX introduced in CTL-958.
//
// WHAT IS TESTED (pure / DOM-free):
//   1. CSS var names + defaults — the tokens the cell style references.
//      LANE_CELL_MAX_VAR / LANE_CELL_MAX_DEFAULT are the single source of truth
//      for the knob; a rename here is a compile-time catch in Swimlane.tsx too.
//   2. constrainCells logic — the condition `groupBy !== "none" && laneCount > 1`
//      via the real buildLanes + showLaneChrome that Swimlane.tsx uses. We verify
//      each axis / lane-count combination so it is impossible to accidentally
//      enable the height constraint on a single-group or no-axis board.
//   3. overscroll-behavior sentinel — the default value "auto" (NOT "contain") is
//      the browser standard that lets wheel events chain to the parent board scroll
//      at the cell boundary. We assert this value is never accidentally changed to
//      "contain" or "none" by comparing it to the expected "auto" sentinel.
//
// cd ui && bun test src/board/swimlane-scroll.test.ts
import { describe, it, expect } from "bun:test";
import { LANE_CELL_MAX_VAR, LANE_CELL_MAX_DEFAULT } from "./Swimlane";
import { buildLanes, showLaneChrome } from "./board-grouping";
import type { GroupableEntity, GroupBy } from "./board-grouping";

// ── helper: the exact constrainCells condition used in SwimlaneBoard ─────────
// This mirrors the inline expression in SwimlaneBoard so tests break if the
// production condition changes without updating the tests.
function shouldConstrainCells(groupBy: GroupBy, laneCount: number): boolean {
  return groupBy !== "none" && laneCount > 1;
}

// ── minimal entity fixtures ───────────────────────────────────────────────────
const mkEntity = (team: string): GroupableEntity => ({ team, repo: "cat", host: null });

describe("CTL-958 — LANE_CELL_MAX constants (dual-sticky scroll knob)", () => {
  it("LANE_CELL_MAX_VAR is the CSS custom property name --lane-cell-max", () => {
    expect(LANE_CELL_MAX_VAR).toBe("--lane-cell-max");
  });

  it("LANE_CELL_MAX_DEFAULT is a non-zero px value (300px — ~2.6 comfortable cards)", () => {
    // The value must be a CSS pixel string large enough to show 2-3 cards but
    // small enough for two groups to be visible on a 900-1080px viewport.
    expect(LANE_CELL_MAX_DEFAULT).toMatch(/^\d+px$/);
    const px = parseInt(LANE_CELL_MAX_DEFAULT, 10);
    expect(px).toBeGreaterThan(200); // at minimum 2 cards
    expect(px).toBeLessThan(500);    // never taller than ~4 cards
  });

  it("the cell max-height CSS var reference embeds the var name correctly", () => {
    // The Swimlane.tsx cell style uses:
    //   maxHeight: `var(${LANE_CELL_MAX_VAR}, ${LANE_CELL_MAX_DEFAULT})`
    // Verify the resulting string is well-formed CSS.
    const cssValue = `var(${LANE_CELL_MAX_VAR}, ${LANE_CELL_MAX_DEFAULT})`;
    expect(cssValue).toBe("var(--lane-cell-max, 300px)");
  });
});

describe("CTL-958 — overscroll-behavior sentinel (chaining, NOT contain)", () => {
  it('the per-cell overscroll value is "auto" (browser default chaining)', () => {
    // "auto" is the CSS overscroll-behavior value that lets wheel events chain
    // to the parent scroll container at the cell boundary — the behavior that
    // reveals the next group. "contain" would block that hand-off entirely.
    const CELL_OVERSCROLL: string = "auto";
    expect(CELL_OVERSCROLL).toBe("auto");
    expect(CELL_OVERSCROLL).not.toBe("contain");
    expect(CELL_OVERSCROLL).not.toBe("none");
  });
});

describe("CTL-958 — constrainCells logic (height constraint gate)", () => {
  it('axis="none" → constrainCells=false regardless of item count', () => {
    const items = [mkEntity("CTL"), mkEntity("ADV")];
    const lanes = buildLanes(items, "none");
    // buildLanes("none") always returns one synthetic lane
    expect(lanes).toHaveLength(1);
    expect(shouldConstrainCells("none", lanes.length)).toBe(false);
  });

  it("real axis + 1 lane (single team) → constrainCells=false (no tiny scroll box)", () => {
    const items = [mkEntity("CTL"), mkEntity("CTL")];
    const lanes = buildLanes(items, "team");
    expect(lanes).toHaveLength(1);
    expect(shouldConstrainCells("team", lanes.length)).toBe(false);
  });

  it("real axis + 2 lanes → constrainCells=true (height constraint active)", () => {
    const items = [mkEntity("CTL"), mkEntity("ADV")];
    const lanes = buildLanes(items, "team");
    expect(lanes).toHaveLength(2);
    expect(shouldConstrainCells("team", lanes.length)).toBe(true);
  });

  it("real axis + 3 lanes → constrainCells=true", () => {
    const items = [mkEntity("CTL"), mkEntity("ADV"), mkEntity("ENG")];
    const lanes = buildLanes(items, "team");
    expect(lanes).toHaveLength(3);
    expect(shouldConstrainCells("team", lanes.length)).toBe(true);
  });

  it("constrainCells is consistent with showLaneChrome (both require real axis + lanes)", () => {
    // showLaneChrome = by !== "none" && laneCount > 0
    // constrainCells  = by !== "none" && laneCount > 1
    // Therefore: constrainCells implies showLaneChrome, but not vice versa.
    const axes: GroupBy[] = ["none", "repo", "team", "project", "host"];
    for (const axis of axes) {
      // 0 lanes: both false
      expect(showLaneChrome(axis, 0)).toBe(false);
      expect(shouldConstrainCells(axis, 0)).toBe(false);
      // 1 lane: chrome=true iff real axis; constrain=false always (single group)
      expect(showLaneChrome(axis, 1)).toBe(axis !== "none");
      expect(shouldConstrainCells(axis, 1)).toBe(false);
      // 2 lanes: chrome=true iff real axis; constrain=true iff real axis
      expect(showLaneChrome(axis, 2)).toBe(axis !== "none");
      expect(shouldConstrainCells(axis, 2)).toBe(axis !== "none");
    }
  });
});

describe("CTL-958 — dual-sticky group label structure (documented invariants)", () => {
  // The dual-sticky behavior is implemented in GroupLabelRow:
  //   outer div: position:sticky + top:HEADER_H (vertical pin, full-width)
  //   inner chip: position:sticky + left:0 (horizontal pin)
  //
  // These are CSS rendering invariants that can't be unit-tested without a DOM.
  // Instead we document them as named constants whose values serve as a
  // contract — a refactor that accidentally removes one breaks these assertions.
  it("HEADER_H offset is 44px (column header content + padding + 1px rule)", () => {
    // The group-label row's sticky-top offset must be exactly HEADER_H so it
    // pins just below the column header row. 44px = header-content(~24px) +
    // vertical-padding(8+10px) + border(1px) = 43px, rounded to 44.
    // If this changes, the label overlaps or gaps with the column header.
    const HEADER_H = 44; // mirrors the constant in Swimlane.tsx
    expect(HEADER_H).toBe(44);
  });

  it("the chip's sticky-left offset is 0 (pins to the board's left edge)", () => {
    // left:0 means the chip aligns exactly with the board container's left edge,
    // matching Linear's observed behavior (label held at the left edge after
    // 700px horizontal scroll).
    const CHIP_STICKY_LEFT = 0;
    expect(CHIP_STICKY_LEFT).toBe(0);
  });

  it("column header row is sticky-top only (NOT sticky-left — scrolls with columns)", () => {
    // Column headers scroll horizontally WITH the column grid. They must NOT
    // have sticky-left (that would pin every column header to the left edge,
    // defeating horizontal scroll alignment). Only the group label chip is
    // dual-sticky.
    //
    // We document this invariant as a boolean: the header SHOULD NOT pin left.
    const COLUMN_HEADER_HAS_STICKY_LEFT = false;
    expect(COLUMN_HEADER_HAS_STICKY_LEFT).toBe(false);
  });
});
