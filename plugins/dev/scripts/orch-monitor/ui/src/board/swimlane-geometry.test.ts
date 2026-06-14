import { describe, expect, it } from "bun:test";
import { boardMinWidth } from "./Swimlane";

describe("boardMinWidth", () => {
  it("sums tracks + gaps + side padding", () => {
    expect(boardMinWidth(5)).toBe(5 * 300 + 4 * 16 + 2 * 16); // 1596
    expect(boardMinWidth(1)).toBe(1 * 300 + 0 * 16 + 2 * 16); // 332
  });
  it("never goes negative for 0 columns", () => {
    expect(boardMinWidth(0)).toBeGreaterThanOrEqual(0);
  });
});
