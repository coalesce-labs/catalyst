// lane-heights.test.ts — CTL-1010 viewport-fitted swimlane height distribution.
//
// Pure / DOM-free unit tests for the equal-split water-fill model. The three
// cases mirror the ticket's Gherkin contract:
//   1. Σ demand ≤ avail → all null (uncapped — shows everything).
//   2. Σ floor ≤ avail < Σ demand → water-fill (lanes absorb the viewport, no
//      dead space, over-budget lanes capped).
//   3. Σ floor > avail → every lane gets its floor; the page scrolls.
//
// cd ui && bun test src/board/lane-heights.test.ts
import { describe, it, expect } from "bun:test";
import {
  computeLaneHeights,
  LANE_MIN_CELL_H,
  CARD_NOMINAL_H,
  CELL_CARD_GAP,
} from "./lane-heights";

const MIN = LANE_MIN_CELL_H("comfortable"); // 248

describe("CTL-1010 — LANE_MIN_CELL_H / nominal constants", () => {
  it("comfortable minimum is 248 (2×120 + 8)", () => {
    expect(LANE_MIN_CELL_H("comfortable")).toBe(248);
    expect(2 * CARD_NOMINAL_H.comfortable + CELL_CARD_GAP).toBe(248);
  });
  it("compact minimum is 148 (2×70 + 8)", () => {
    expect(LANE_MIN_CELL_H("compact")).toBe(148);
    expect(2 * CARD_NOMINAL_H.compact + CELL_CARD_GAP).toBe(148);
  });
});

describe("CTL-1010 — Case 1: Σ demand ≤ avail → all uncapped (null)", () => {
  it("empty lane list returns []", () => {
    expect(computeLaneHeights([], 900, MIN)).toEqual([]);
  });
  it("single lane that fits → [null]", () => {
    expect(computeLaneHeights([300], 900, MIN)).toEqual([null]);
  });
  it("two lanes that both fit → [null, null]", () => {
    expect(computeLaneHeights([300, 300], 900, MIN)).toEqual([null, null]);
  });
  it("empty-lane placeholder demand (~40px) fits → null", () => {
    // An empty cell renders the dashed "—" placeholder (~40px). It must never be
    // capped — it always fits and shows everything.
    expect(computeLaneHeights([40, 300], 900, MIN)).toEqual([null, null]);
  });
  it("exactly-equal sum (Σ demand == avail) is still all null (≤)", () => {
    expect(computeLaneHeights([450, 450], 900, MIN)).toEqual([null, null]);
  });
});

describe("CTL-1010 — Case 2: water-fill (Σ floor ≤ avail < Σ demand)", () => {
  it("two deep lanes, avail 758, demands [900,900] → [379,379] (50/50, Σ=avail)", () => {
    const out = computeLaneHeights([900, 900], 758, MIN);
    expect(out).toEqual([379, 379]);
    expect((out[0] as number) + (out[1] as number)).toBe(758);
  });

  it("short + deep [252, 890], avail 758 → [null, 506] (shrink-to-content + handoff)", () => {
    // ADV (252, 2 cards) fits inside its share and saturates → null (uncapped);
    // CTL absorbs ALL remaining height (758 - 252 = 506). Zero dead space — the
    // core no-dead-space mechanic from the screenshot.
    const out = computeLaneHeights([252, 890], 758, MIN);
    expect(out).toEqual([null, 506]);
    expect(252 + (out[1] as number)).toBe(758);
  });

  it("multi-iteration saturation: demands [100, 300, 2000], avail 900, minH 248 → [null, null, 500]", () => {
    // Lane 0 (100) and lane 1 (300) both fit and saturate; their unused share
    // recycles to lane 2, which takes 900 - 100 - 300 = 500.
    const out = computeLaneHeights([100, 300, 2000], 900, 248);
    expect(out).toEqual([null, null, 500]);
    expect(100 + 300 + (out[2] as number)).toBe(900);
  });

  it("leftover px are handed to hungry lanes in index order (Σ == avail)", () => {
    // avail 761 over two deep lanes: 761 - 2×248 = 265 rem → +132 each (1 leftover
    // px to lane 0). 248+132+1 = 381, 248+132 = 380. Σ = 761.
    const out = computeLaneHeights([900, 900], 761, MIN);
    expect(out).toEqual([381, 380]);
    expect((out[0] as number) + (out[1] as number)).toBe(761);
  });
});

describe("CTL-1010 — Case 3: Σ floor > avail → floors, page scrolls", () => {
  it("3 deep lanes, avail 500, minH 248 → [248,248,248] (Σ > avail; page scrolls)", () => {
    const out = computeLaneHeights([2000, 2000, 2000], 500, 248);
    expect(out).toEqual([248, 248, 248]);
  });

  it("six deep comfortable lanes (6×248 > 758) → all 248", () => {
    const out = computeLaneHeights([1000, 1000, 1000, 1000, 1000, 1000], 758, MIN);
    expect(out).toEqual([248, 248, 248, 248, 248, 248]);
  });

  it("a lane shorter than the floor among deep lanes is uncapped (null), not floored", () => {
    // Lane 1's demand (120) < floor (248) → it shows everything (null); the deep
    // lanes are floored at 248. Σ floor = 248 + 120 + 248 = 616 > 500 → case 3.
    const out = computeLaneHeights([2000, 120, 2000], 500, 248);
    expect(out).toEqual([248, null, 248]);
  });
});

describe("CTL-1010 — invariants over a grid of inputs (property-style)", () => {
  const demandsGrid = [
    [300],
    [300, 300],
    [252, 890],
    [900, 900],
    [100, 300, 2000],
    [2000, 2000, 2000],
    [40, 1500, 600, 2000],
    [1000, 1000, 1000, 1000, 1000, 1000],
  ];
  const avails = [200, 500, 758, 900, 1400];
  const mins = [148, 248];

  it("alloc ≤ demand; alloc ≥ min(demand,minH); integer; deterministic", () => {
    for (const demands of demandsGrid) {
      for (const avail of avails) {
        for (const minH of mins) {
          const out = computeLaneHeights(demands, avail, minH);
          const out2 = computeLaneHeights(demands, avail, minH);
          expect(out).toEqual(out2); // deterministic
          expect(out).toHaveLength(demands.length);
          out.forEach((a, i) => {
            const demand = Math.max(0, Math.ceil(demands[i]));
            if (a !== null) {
              expect(Number.isInteger(a)).toBe(true);
              expect(a).toBeLessThanOrEqual(demand); // alloc ≤ demand
              expect(a).toBeGreaterThanOrEqual(Math.min(demand, minH)); // alloc ≥ floor
            }
          });
        }
      }
    }
  });

  it("case 2: Σ(capped allocs + uncapped demands) ≤ avail (no overflow / dead space)", () => {
    for (const demands of demandsGrid) {
      for (const avail of avails) {
        for (const minH of mins) {
          const dem = demands.map((d) => Math.max(0, Math.ceil(d)));
          const sumDemand = dem.reduce((a, b) => a + b, 0);
          const floor = dem.map((d) => Math.min(d, minH));
          const sumFloor = floor.reduce((a, b) => a + b, 0);
          // Only case 2 carries the Σ ≤ avail invariant.
          if (sumDemand > avail && sumFloor <= avail) {
            const out = computeLaneHeights(demands, avail, minH);
            const total = out.reduce<number>(
              (acc, a, i) => acc + (a === null ? dem[i] : a),
              0,
            );
            expect(total).toBeLessThanOrEqual(avail);
          }
        }
      }
    }
  });
});
