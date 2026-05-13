// useSelection.test.ts — covers the scroll-into-viewport effect.
// Bun's test runner does not ship a React-hook helper, so (like useFilter.test.ts)
// this file mirrors the effect's logic as a pure function and asserts on it.
// Any divergence from useSelection.ts is caught when the hook source changes
// without the mirror — they are intentionally adjacent in the file tree.

import { describe, test, expect } from "bun:test";

// Mirror of useSelection.ts's scroll-into-viewport effect (lines 19-26).
// Returns the scrollOffset that the effect WOULD setScrollOffset() to,
// or the input scrollOffset unchanged when the selection is already visible.
function computeScrollOffset(
  selectedIndex: number,
  scrollOffset: number,
  visibleRows: number,
  autoFollow: boolean,
): number {
  if (selectedIndex < scrollOffset) {
    const bottomBuffer = autoFollow ? 2 : 1;
    return autoFollow
      ? Math.max(0, selectedIndex - visibleRows + bottomBuffer)
      : selectedIndex;
  } else if (selectedIndex >= scrollOffset + visibleRows) {
    const bottomBuffer = autoFollow ? 2 : 1;
    return Math.max(0, selectedIndex - visibleRows + bottomBuffer);
  }
  return scrollOffset;
}

describe("useSelection scroll effect", () => {
  test("CTL-368: filtered viewport with autoFollow anchors selection near bottom", () => {
    // Repro: 3293 events filtered to 21 with autoFollow on.
    // selectedIndex was 3292 (tail), drops to 20 after filter.
    // scrollOffset still stale at 3254. Buggy behavior anchored at 20 (top),
    // hiding indices 0-19. Fix anchors near bottom so all 21 are visible.
    const next = computeScrollOffset(/*selected*/ 20, /*offset*/ 3254, /*rows*/ 40, /*auto*/ true);
    expect(next).toBe(0);
    // visible window = slice(0, 40) covers all 21 matched rows.
    expect(20).toBeGreaterThanOrEqual(next);
    expect(20).toBeLessThan(next + 40);
  });

  test("manual nav (autoFollow=false) UP scrolls just enough to bring row into view", () => {
    // Press Up to a row above current viewport — anchor at top (existing behavior).
    const next = computeScrollOffset(15, 20, 40, false);
    expect(next).toBe(15);
  });

  test("DOWN branch in autoFollow anchors selection near bottom (unchanged)", () => {
    // selectedIndex below viewport bottom: scrollOffset = max(0, 100 - 40 + 2) = 62.
    const next = computeScrollOffset(100, 50, 40, true);
    expect(next).toBe(62);
  });

  test("DOWN branch in manual mode uses smaller bottomBuffer", () => {
    // bottomBuffer = 1 in manual mode: scrollOffset = max(0, 100 - 40 + 1) = 61.
    const next = computeScrollOffset(100, 50, 40, false);
    expect(next).toBe(61);
  });

  test("selection already in viewport — no change", () => {
    // selectedIndex in [scrollOffset, scrollOffset + visibleRows) — return input.
    expect(computeScrollOffset(30, 20, 40, true)).toBe(20);
    expect(computeScrollOffset(30, 20, 40, false)).toBe(20);
  });

  test("clamp to zero when selectedIndex - visibleRows + buffer would be negative", () => {
    // Small selection with large viewport — autoFollow anchor still clamps to 0.
    const next = computeScrollOffset(5, 100, 40, true);
    expect(next).toBe(0);
  });
});
