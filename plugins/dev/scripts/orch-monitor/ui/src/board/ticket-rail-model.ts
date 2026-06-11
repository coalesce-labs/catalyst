// ticket-rail-model.ts — the PURE (DOM-free) helpers behind the floating rail
// cards (CTL-1003 §B1/§B2). Kept out of ticket-rail.tsx (which imports the heavy
// Board/dependency-graph DOM components) so the root tsconfig's __tests__ suites
// can unit-test the collapse-persistence round-trip + the relation slice/show-more
// arithmetic WITHOUT pulling the DOM component graph into the no-DOM-lib typecheck.

// ── collapse persistence ─────────────────────────────────────────────────────
/** A minimal localStorage shape — referenced via globalThis so this module stays
 *  DOM-free (the root tsconfig's __tests__ typecheck has no DOM lib). */
interface MiniStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolve the ambient localStorage (or null when absent / SSR). */
function storage(): MiniStorage | null {
  const ls = (globalThis as { localStorage?: MiniStorage }).localStorage;
  return ls ?? null;
}

/** The localStorage key for a rail section's collapsed flag. */
export function railCollapseKey(section: string): string {
  return "catalyst.ticket-rail." + section + ".collapsed";
}

/** Read a section's collapsed flag (default false = open; try/catch fail-open). */
export function readRailCollapsed(section: string): boolean {
  try {
    return storage()?.getItem(railCollapseKey(section)) === "1";
  } catch {
    return false;
  }
}

/** Persist a section's collapsed flag (try/catch — never throws in private mode). */
export function writeRailCollapsed(section: string, collapsed: boolean): void {
  try {
    const ls = storage();
    if (!ls) return;
    if (collapsed) ls.setItem(railCollapseKey(section), "1");
    else ls.removeItem(railCollapseKey(section));
  } catch {
    /* ignore */
  }
}

// ── relation slice / show-more arithmetic ────────────────────────────────────
/** The relation-group display limit (first N rendered before "Show more"). */
export const RELATION_GROUP_LIMIT = 5;

/** Pure: how many rows are hidden behind a "Show N more" expander for a group of
 *  `total` relations (0 when total ≤ the limit). */
export function relationHiddenCount(total: number): number {
  return Math.max(0, total - RELATION_GROUP_LIMIT);
}
