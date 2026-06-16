import { describe, expect, it } from "bun:test";
import { boardMinWidth } from "./Swimlane";

describe("boardMinWidth", () => {
  it("sums tracks + gaps + side padding", () => {
    // CTL-1168: Linear-matched fixed columns — COL_W 348, COL_GAP 8, PAD_X 12.
    expect(boardMinWidth(5)).toBe(5 * 348 + 4 * 8 + 2 * 12); // 1796
    expect(boardMinWidth(1)).toBe(1 * 348 + 0 * 8 + 2 * 12); // 372
  });
  it("never goes negative for 0 columns", () => {
    expect(boardMinWidth(0)).toBeGreaterThanOrEqual(0);
  });
});
