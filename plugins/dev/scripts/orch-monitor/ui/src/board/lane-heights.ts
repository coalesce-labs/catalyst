// lane-heights.ts — CTL-1178 (revised) per-lane viewport cap for the grouped board.
//
// HISTORY: CTL-958/1010 distributed the board height across lanes by an equal-split
// WATER-FILL (viewport ÷ lane count, clamped to content). That made every lane
// cramped — 2–3 cards each — because the budget was SHARED. A first pass at CTL-1178
// removed the cap entirely (full tallest-column content), which over-grows a big
// group to thousands of px. Both are wrong.
//
// THE MODEL — PER-LANE CAP AT ≈ ONE VIEWPORT (reverse-engineered from Linear's live
// grouped board): each lane is INDEPENDENT and capped at one generous viewport-sized
// budget `capH` (NOT divided by lane count):
//   - a lane whose content fits within capH renders at its natural content height
//     (a small group stays short — no scroll box);
//   - a lane whose content exceeds capH is capped at capH and its columns scroll
//     INTERNALLY for the overflow;
//   - the whole board scrolls vertically BETWEEN lanes.
// So a big group fills ~one screen (columns scrolling inside it) and you scroll the
// board ~a page to the next group — exactly Linear's behavior. `capH` is computed by
// the caller from the live scroller height (see Swimlane.tsx useLaneCellHeights).
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
 * computeLaneHeights — CTL-1178 (revised): a PER-LANE cap at ≈ one viewport, NOT a
 * water-fill across lanes. Each lane is independent:
 *   - demand_i ≤ capH  → `null` (uncapped: the lane renders at its natural content
 *     height — a small group stays short, no scroll box);
 *   - demand_i > capH  → `capH` (the lane is capped at one viewport and its columns
 *     scroll INTERNALLY for the overflow).
 * The whole board then scrolls vertically BETWEEN lanes. This matches Linear's live
 * grouped board: a big group (e.g. 1,300 issues) fills ~one screen with the columns
 * scrolling inside it; you scroll the board ~a page to reach the next group.
 *
 * `capH` is one generous per-lane budget (the board's visible cell-area height for a
 * single lane), passed in by the caller — NOT divided by the lane count, which is
 * what the old CTL-958/1010 water-fill did and what made every lane cramped (only
 * ~2–3 cards). `minH` is gone: there is no per-lane floor anymore — a lane is either
 * its content height or exactly one viewport.
 *
 * Returns one entry per lane: `null` (uncapped) or `capH` (capped). Pure + DOM-free.
 */
export function computeLaneHeights(
  contentHeights: number[],
  capH: number,
): (number | null)[] {
  return contentHeights.map((h) => {
    const demand = Math.max(0, Math.ceil(h));
    return demand <= capH ? null : capH;
  });
}
