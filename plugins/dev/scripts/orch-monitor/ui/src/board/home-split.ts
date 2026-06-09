// home-split.ts — the PURE floor math for the Inbox home's master-detail split
// (CTL-899 / HOME1). Kept React-/DOM-free (the same way list-order.ts / route-
// search.ts are) so the orch-monitor `bun test` suite can unit the iPad-floor
// clamp directly from outside the `ui/` DOM module graph — the DOM-touching
// ResizableSplit component imports these from here, so the floors it enforces and
// the floors the tests assert are ONE source.
//
// The CTL-899 "split survives an iPad-landscape width" Gherkin lives here: the
// list pane never shrinks below LIST_FLOOR_PX and the reading pane never below
// READING_FLOOR_PX, and the clamp never lets the split exceed the container
// width (so there is no horizontal overflow at any viewport).

/** Firm minimum widths (px) — the CTL-899 iPad-landscape floors. */
export const LIST_FLOOR_PX = 320;
export const READING_FLOOR_PX = 360;

/** Below this combined width the panes stack vertically instead of being
 *  crushed below their floors (portrait fallback; landscape stays side-by-side). */
export const STACK_BELOW_PX = LIST_FLOOR_PX + READING_FLOOR_PX;

/** The default list-pane width on first load (before any drag/persist). */
export const DEFAULT_LIST_PX = 420;

/**
 * Clamp the list-pane width so BOTH floors hold for the current container width:
 * the list gets at least LIST_FLOOR_PX, and at most `containerWidth -
 * READING_FLOOR_PX` so the reading pane keeps its floor too. When the container
 * is narrower than the combined floor there is no valid horizontal split — the
 * caller stacks instead — so this returns the list floor.
 *
 * PURE + total: never throws; the returned width is always ≥ LIST_FLOOR_PX and,
 * whenever the container can hold both floors, leaves the reading pane ≥
 * READING_FLOOR_PX and the whole split ≤ containerWidth (no overflow).
 */
export function clampListWidth(desiredPx: number, containerWidth: number): number {
  const maxList = containerWidth - READING_FLOOR_PX;
  if (maxList <= LIST_FLOOR_PX) return LIST_FLOOR_PX;
  return Math.min(maxList, Math.max(LIST_FLOOR_PX, desiredPx));
}

/** True when the container is too narrow to hold both floors side-by-side — the
 *  panes should stack vertically (portrait / phone) rather than be crushed. */
export function shouldStack(containerWidth: number): boolean {
  return containerWidth > 0 && containerWidth < STACK_BELOW_PX;
}
