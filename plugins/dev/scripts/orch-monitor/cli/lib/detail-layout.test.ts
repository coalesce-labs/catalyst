// detail-layout.test.ts — verifies the layout math that decides how many rows
// the event list vs. the bottom overlay (detail pane, help panel) get when an
// overlay is open. Pure math, no Ink rendering required.

import { describe, test, expect } from "bun:test";
import {
  computeBottomOverlaySize,
  computeDetailLayout,
  reanchorListScrollOffset,
} from "./detail-layout.ts";

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

describe("computeBottomOverlaySize", () => {
  test("natural fit: pane gets full natural height, list takes the rest", () => {
    const r = computeBottomOverlaySize(80, 22);
    expect(r.paneRows).toBe(22);
    expect(r.listRows).toBe(58);
    expect(r.fits).toBe(true);
  });

  test("capped: pane bounded so list keeps minListRows", () => {
    const r = computeBottomOverlaySize(80, 200);
    // cappedMax = max(7, 80-5) = 75; pane = min(200, 75) = 75
    expect(r.paneRows).toBe(75);
    expect(r.listRows).toBe(5);
    expect(r.fits).toBe(false);
  });

  test("tiny terminal: minListRows + 2 floor keeps overlay visible", () => {
    const r = computeBottomOverlaySize(10, 30);
    // cappedMax = max(7, 5) = 7; pane = min(30, 7) = 7
    expect(r.paneRows).toBe(7);
    expect(r.listRows).toBe(3);
    expect(r.fits).toBe(false);
  });

  test("custom minListRows", () => {
    const r = computeBottomOverlaySize(40, 100, 10);
    // cappedMax = max(12, 30) = 30
    expect(r.paneRows).toBe(30);
    expect(r.listRows).toBe(10);
    expect(r.fits).toBe(false);
  });

  test("listRows floors at 1 when pane fills everything", () => {
    const r = computeBottomOverlaySize(10, 100, 3);
    // cappedMax = max(5, 7) = 7; pane = 7; list = 3 (above floor)
    expect(r.listRows).toBeGreaterThanOrEqual(1);
  });
});

describe("reanchorListScrollOffset", () => {
  test("selected already in view: offset clamped but unchanged otherwise", () => {
    const offset = reanchorListScrollOffset(50, 200, 71, 30);
    expect(offset).toBe(30);
  });

  test("selected falls off the bottom: recenter around selection", () => {
    // listRows=5, selected=70 not in [20, 25) → recenter to 70 - 2 = 68
    const offset = reanchorListScrollOffset(70, 200, 5, 20);
    expect(offset).toBe(68);
  });

  test("clamps to maxOffset when totalEvents is small", () => {
    // maxOffset = 100 - 71 = 29; selected=50 in [29, 100) → stays at 29
    const offset = reanchorListScrollOffset(50, 100, 71, 50);
    expect(offset).toBe(29);
  });

  test("negative currentScrollOffset is treated as 0", () => {
    const offset = reanchorListScrollOffset(3, 100, 71, -5);
    expect(offset).toBe(0);
  });

  test("listRows >= totalEvents: maxOffset is 0", () => {
    const offset = reanchorListScrollOffset(2, 5, 10, 7);
    expect(offset).toBe(0);
  });
});
