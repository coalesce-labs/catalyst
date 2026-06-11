// recents.ts — the PURE recency-merge for the ⌘K RECENT group (CTL-882 / FND2).
// Split out of nav-store.ts (which imports jotai) so the orch-monitor `bun test`
// suite can unit-test the "CTL-845 then CTL-831 then reload → recency order"
// Gherkin directly, with no jotai / localStorage runtime in the import graph
// (the same dependency-free-so-it's-testable discipline as board-logic.ts).
// nav-store.ts's `recentlyViewedAtom` setter and `recordRecentAtom` both call
// `pushRecent`, so the persisted list and these units can never drift.

/** How many ids the ⌘K RECENT group keeps. */
export const RECENTLY_VIEWED_CAP = 20;

/** localStorage key for the persisted recents (used by `recentlyViewedAtom`). */
export const RECENTLY_VIEWED_KEY = "catalyst.recentlyViewed";

/**
 * Push `id` onto the front of the recents list, most-recent-first, de-duped,
 * capped at `cap`:
 *
 *   visit CTL-845 → ["CTL-845"]
 *   visit CTL-831 → ["CTL-831", "CTL-845"]    (most recent first)
 *   re-visit CTL-845 → ["CTL-845", "CTL-831"] (moves to front, no dup)
 *
 * An empty/whitespace id is ignored (returns a copy of the list unchanged) so a
 * cold-link with no resolved entity never pollutes recents. Never mutates the
 * input. A `cap <= 0` means "no cap" (keep everything).
 */
export function pushRecent(
  list: readonly string[],
  id: string,
  cap: number = RECENTLY_VIEWED_CAP,
): string[] {
  if (!id) return [...list];
  const next = [id, ...list.filter((x) => x !== id)];
  return cap > 0 ? next.slice(0, cap) : next;
}
