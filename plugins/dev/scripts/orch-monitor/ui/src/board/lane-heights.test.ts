// lane-heights.test.ts — CTL-1178 (revised) per-lane viewport cap.
//
// computeLaneHeights(contentHeights, capH) is now a PER-LANE cap, not a water-fill:
// each lane is independent — `null` (uncapped, content-height) when it fits within
// capH, else `capH` (capped at one viewport; its columns scroll internally). The
// whole board scrolls vertically between lanes. See lane-heights.ts.
//
// cd ui && bun test src/board/lane-heights.test.ts
import { describe, it, expect } from "bun:test";
import {
  computeLaneHeights,
  LANE_MIN_CELL_H,
  CARD_NOMINAL_H,
  CELL_CARD_GAP,
} from "./lane-heights";

describe("CTL-1178 — per-lane viewport cap", () => {
  it("empty lane list returns []", () => {
    expect(computeLaneHeights([], 900)).toEqual([]);
  });

  it("a lane shorter than capH is uncapped (null = content-height)", () => {
    expect(computeLaneHeights([300], 900)).toEqual([null]);
    expect(computeLaneHeights([300, 450], 900)).toEqual([null, null]);
  });

  it("a lane exactly at capH is uncapped (≤ is a fit)", () => {
    expect(computeLaneHeights([900], 900)).toEqual([null]);
  });

  it("a lane taller than capH is capped at capH (scrolls internally)", () => {
    expect(computeLaneHeights([2000], 900)).toEqual([900]);
  });

  it("each lane decides independently — small stays content-height, big caps", () => {
    // ADV (1 card, 120) stays null; CTL (34 cards, ~5000) caps at the viewport.
    expect(computeLaneHeights([120, 5000], 900)).toEqual([null, 900]);
    // Slides (1 card) short; two big groups each cap at capH and the board scrolls.
    expect(computeLaneHeights([5000, 80, 3000], 900)).toEqual([900, null, 900]);
  });

  it("an empty-lane placeholder (~40px) is never capped", () => {
    expect(computeLaneHeights([40, 5000], 900)).toEqual([null, 900]);
  });

  it("caps are integers and deterministic across a grid", () => {
    const grids = [[300], [300, 300], [120, 5000], [5000, 80, 3000], [40, 1500, 600, 9000]];
    const caps = [200, 500, 900, 1400];
    for (const demands of grids) {
      for (const capH of caps) {
        const out = computeLaneHeights(demands, capH);
        expect(out).toEqual(computeLaneHeights(demands, capH)); // deterministic
        expect(out).toHaveLength(demands.length);
        out.forEach((a, i) => {
          const demand = Math.max(0, Math.ceil(demands[i]));
          if (a === null) {
            expect(demand).toBeLessThanOrEqual(capH); // fits → uncapped
          } else {
            expect(Number.isInteger(a)).toBe(true);
            expect(a).toBe(capH); // capped exactly at the per-lane viewport budget
            expect(demand).toBeGreaterThan(capH); // only over-budget lanes cap
          }
        });
      }
    }
  });
});

// The min/nominal constants remain exported (used by other call sites / kept for
// reference) even though the per-lane floor they drove is gone with the water-fill.
describe("density nominal constants (still exported)", () => {
  it("comfortable minimum is 248 (2×120 + 8)", () => {
    expect(LANE_MIN_CELL_H("comfortable")).toBe(248);
    expect(2 * CARD_NOMINAL_H.comfortable + CELL_CARD_GAP).toBe(248);
  });
  it("compact minimum is 148 (2×70 + 8)", () => {
    expect(LANE_MIN_CELL_H("compact")).toBe(148);
    expect(2 * CARD_NOMINAL_H.compact + CELL_CARD_GAP).toBe(148);
  });
});
