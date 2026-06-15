import { describe, expect, it } from "bun:test";
import { boardMinWidth } from "./Swimlane";

describe("boardMinWidth", () => {
  it("sums tracks + gaps + side padding", () => {
    // CTL-1168: tighter Linear gutters — COL_GAP 16→10, PAD_X 16→12.
    expect(boardMinWidth(5)).toBe(5 * 300 + 4 * 10 + 2 * 12); // 1564
    expect(boardMinWidth(1)).toBe(1 * 300 + 0 * 10 + 2 * 12); // 324
  });
  it("never goes negative for 0 columns", () => {
    expect(boardMinWidth(0)).toBeGreaterThanOrEqual(0);
  });
});
