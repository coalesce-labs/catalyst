// detail-layout.test.ts — verifies the layout math that decides how many rows
// the event list vs. the detail pane get when the detail pane is open. Pure
// math, no Ink rendering required.

import { describe, test, expect } from "bun:test";
import { computeDetailLayout } from "./detail-layout.ts";

describe("computeDetailLayout", () => {
  test("not in detail mode: list gets full visibleRows, scrollOffset unchanged", () => {
    const r = computeDetailLayout({
      visibleRows: 80,
      inDetailMode: false,
      detailLineCount: 0,
      selectedIndex: 10,
      totalEvents: 100,
      currentScrollOffset: 7,
    });
    expect(r).toEqual({
      detailPaneRows: 0,
      detailContentRows: 0,
      listRows: 80,
      listScrollOffset: 7,
    });
  });

  test("natural fit: 20-line event in a 93-row viewport leaves room for the list", () => {
    const r = computeDetailLayout({
      visibleRows: 93,
      inDetailMode: true,
      detailLineCount: 20,
      selectedIndex: 50,
      totalEvents: 200,
      currentScrollOffset: 30,
    });
    expect(r.detailPaneRows).toBe(22); // 20 lines + 2 borders
    expect(r.detailContentRows).toBe(19); // detailLineCount - 1 (title sticky)
    expect(r.listRows).toBe(71);
    // selected (50) is within [30, 30+71) so offset stays
    expect(r.listScrollOffset).toBe(30);
  });

  test("capped long event: pane is bounded so list keeps minListRows", () => {
    const r = computeDetailLayout({
      visibleRows: 93,
      inDetailMode: true,
      detailLineCount: 200,
      selectedIndex: 100,
      totalEvents: 500,
      currentScrollOffset: 98,
    });
    expect(r.detailPaneRows).toBe(88); // visibleRows - minListRows(5)
    expect(r.listRows).toBe(5);
    expect(r.detailContentRows).toBe(84); // paneRows - 4 (borders + title + scrollbar)
  });

  test("tiny terminal: minListRows + 2 floor keeps detail pane visible", () => {
    const r = computeDetailLayout({
      visibleRows: 10,
      inDetailMode: true,
      detailLineCount: 20,
      selectedIndex: 5,
      totalEvents: 30,
      currentScrollOffset: 0,
    });
    // cappedMax = max(minListRows+2=7, visibleRows-minListRows=5) = 7
    // natural   = 22
    // paneRows  = min(22, 7) = 7
    expect(r.detailPaneRows).toBe(7);
    expect(r.listRows).toBe(3); // 10 - 7
    expect(r.detailContentRows).toBe(3); // paneRows - 4 = 3
  });

  test("selected already in view: scrollOffset is clamped but otherwise unchanged", () => {
    const r = computeDetailLayout({
      visibleRows: 93,
      inDetailMode: true,
      detailLineCount: 20,
      selectedIndex: 50,
      totalEvents: 200,
      currentScrollOffset: 20,
    });
    expect(r.listScrollOffset).toBe(20);
  });

  test("selected falls off the bottom of the smaller list: recenter", () => {
    // Before detail opens, scrollOffset=20 was fine for visibleRows=93 list with sel=70.
    // After detail opens, listRows=5, so [20, 25) does NOT contain 70 → recenter.
    const r = computeDetailLayout({
      visibleRows: 93,
      inDetailMode: true,
      detailLineCount: 200, // forces capped pane → listRows=5
      selectedIndex: 70,
      totalEvents: 200,
      currentScrollOffset: 20,
    });
    expect(r.listRows).toBe(5);
    // recenter target = selectedIndex - floor(listRows/2) = 70 - 2 = 68
    // maxOffset = 200 - 5 = 195 → 68 stays
    expect(r.listScrollOffset).toBe(68);
    // selected (70) lands in [68, 73) ✓
    expect(70).toBeGreaterThanOrEqual(r.listScrollOffset);
    expect(70).toBeLessThan(r.listScrollOffset + r.listRows);
  });

  test("scrollOffset clamped to maxOffset when totalEvents is small", () => {
    const r = computeDetailLayout({
      visibleRows: 93,
      inDetailMode: true,
      detailLineCount: 20, // paneRows=22, listRows=71
      selectedIndex: 50,
      totalEvents: 100,
      currentScrollOffset: 50, // beyond maxOffset = 100-71 = 29
    });
    // maxOffset=29; selected(50) falls outside [50, 50+71)... actually 50 is between
    // 50 and 121 — but capped to 29 first, then 50 is in [29, 100), in view.
    expect(r.listScrollOffset).toBe(29);
  });

  test("negative currentScrollOffset is treated as 0", () => {
    const r = computeDetailLayout({
      visibleRows: 93,
      inDetailMode: true,
      detailLineCount: 20,
      selectedIndex: 3,
      totalEvents: 100,
      currentScrollOffset: -5,
    });
    expect(r.listScrollOffset).toBe(0);
  });
});
