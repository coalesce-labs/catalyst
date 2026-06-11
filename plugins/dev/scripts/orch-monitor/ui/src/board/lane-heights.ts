// lane-heights.ts — CTL-1010 viewport-fitted swimlane height distribution.
//
// THE BUG (CTL-1010): with 2+ lanes every (lane × column) cell was hard-capped at
// LANE_CELL_MAX_DEFAULT = 300px (Swimlane.tsx), regardless of viewport — so two
// team lanes used ~600px of a ~900px board, cards hid behind cell scroll, and a
// dead band filled the bottom (direct violation of "never dead space while any
// lane has hidden cards").
//
// THE MODEL — EQUAL-SPLIT WATER-FILL (NOT content-proportional flex):
// Allocate the available cell-area height by EQUAL marginal shares, with each lane
// clamped to its measured content: a lane never receives more than it can use, and
// freed space is re-split equally among still-hungry lanes. Content-proportional
// grow (flex-grow ∝ card count) was rejected — a 30-card backlog lane would swallow
// the viewport and crush the 3-card live lane to its minimum. Equal shares read
// calmer (Linear-calm), satisfy "2 lanes → roughly 50/50" literally, and are stable
// (adding a card to a deep lane doesn't reshuffle every lane boundary).
//
// THREE CASES (exactly the ticket's Gherkin contract). Let
//   avail    = scroller cell-area height,
//   demand_i = lane i's measured content height,
//   minH     = per-density lane minimum,
//   floor_i  = min(demand_i, minH):
//   1. Σ demand ≤ avail → every lane uncapped (shows everything; trailing empty
//      space is fine — nothing is hidden).
//   2. Σ floor ≤ avail < Σ demand → water-fill: lanes absorb the viewport, the page
//      does NOT scroll vertically; over-budget lanes scroll internally. Σ alloc ==
//      avail (no dead space).
//   3. Σ floor > avail → every lane gets floor_i (≈2 card rows + header visible);
//      the page scrolls vertically for the rest.
//
// This module is pure + DOM-free (measurement lives in Swimlane.tsx's
// useLaneCellHeights hook); see lane-heights.test.ts.
import type { Density } from "./prefs-store";

/** Nominal single-card height per density — matches TicketCard padding/content
 *  math. Used ONLY to derive the lane MINIMUM (LANE_MIN_CELL_H); the real per-lane
 *  heights are MEASURED from the live DOM, never computed from this. */
export const CARD_NOMINAL_H = { comfortable: 120, compact: 70 } as const;

/** The vertical gap between stacked cards inside a LaneCardsRow cell (the flex
 *  `gap: 8` on the cell). One gap sits between the two rows the minimum guarantees. */
export const CELL_CARD_GAP = 8;

/** The per-density lane MINIMUM cell height — ≈ 2 card rows + the inter-card gap,
 *  so a degraded (page-scroll) lane still shows a couple of cards plus its header.
 *  comfortable → 248px (2×120 + 8); compact → 148px (2×70 + 8). */
export const LANE_MIN_CELL_H = (d: Density): number => 2 * CARD_NOMINAL_H[d] + CELL_CARD_GAP;

/**
 * computeLaneHeights — equal-split water-fill of `availH` over the lanes, clamped
 * to each lane's measured content (`contentHeights`), with a per-lane floor of
 * `min(demand_i, minH)`.
 *
 * Returns one entry per lane: a px cap (number) or `null` when the lane's
 * allocation reaches its demand (uncapped — it shows everything). All px are
 * deterministic integers.
 *
 * Invariants (case 2 / water-fill):
 *   - min(demand_i, minH) ≤ alloc_i ≤ demand_i for every lane,
 *   - Σ(non-null alloc + null demands) ≤ availH (no dead space, nothing overflows
 *     the viewport that didn't have to).
 */
export function computeLaneHeights(
  contentHeights: number[],
  availH: number,
  minH: number,
): (number | null)[] {
  const n = contentHeights.length;
  if (n === 0) return [];

  const demand = contentHeights.map((h) => Math.max(0, Math.ceil(h)));
  const sumDemand = demand.reduce((a, b) => a + b, 0);

  // ── Case 1: everything fits → no caps at all. ──────────────────────────────
  if (sumDemand <= availH) return demand.map(() => null);

  // floor_i = min(demand_i, minH): a lane can never be forced taller than its own
  // content, and never shorter than the per-density minimum (unless its content is
  // itself shorter than the minimum, in which case it just shows everything).
  const floor = demand.map((d) => Math.min(d, minH));
  const sumFloor = floor.reduce((a, b) => a + b, 0);

  // ── Case 3: even the floors don't fit → every lane gets its floor; page scrolls. ─
  if (sumFloor > availH) {
    // A lane whose demand ≤ its floor is fully shown — return null (uncapped) so it
    // never gets a needless scroll box; everything else is capped at floor_i.
    return demand.map((d, i) => (d <= floor[i] ? null : floor[i]));
  }

  // ── Case 2: water-fill. Start every lane at its floor, then hand out the
  //    remaining viewport in equal marginal shares to the still-hungry lanes,
  //    clamping each at its demand and recycling any excess. ────────────────────
  const alloc = floor.slice();
  let rem = availH - sumFloor;

  // Loop: split `rem` equally among lanes that still want more (alloc < demand).
  // Lanes that saturate (hit demand) return their unused share to `rem`, which is
  // re-split on the next pass. Terminates when no lane is hungry or `rem` is too
  // small to give each hungry lane at least 1px.
  for (;;) {
    const hungry: number[] = [];
    for (let i = 0; i < n; i++) if (alloc[i] < demand[i]) hungry.push(i);
    if (hungry.length === 0) break;

    const share = Math.floor(rem / hungry.length);
    if (share <= 0) break;

    let consumed = 0;
    for (const i of hungry) {
      const want = demand[i] - alloc[i];
      const give = Math.min(share, want);
      alloc[i] += give;
      consumed += give;
    }
    rem -= consumed;
    // If nothing could be consumed this pass (all hungry lanes saturated within
    // their share), stop — the integer leftover is distributed below.
    if (consumed === 0) break;
  }

  // Hand the integer leftover (rem < |hungry|) one px at a time to still-hungry
  // lanes in index order, so Σ alloc exactly equals availH with no dead space.
  if (rem > 0) {
    for (let i = 0; i < n && rem > 0; i++) {
      if (alloc[i] < demand[i]) {
        alloc[i] += 1;
        rem -= 1;
      }
    }
  }

  // Post-pass: a lane whose allocation reached its demand is uncapped (null) so it
  // shows everything with no scroll box; otherwise it's capped at its allocation.
  return alloc.map((a, i) => (a >= demand[i] ? null : a));
}
