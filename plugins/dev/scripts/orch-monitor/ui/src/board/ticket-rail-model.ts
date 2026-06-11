// ticket-rail-model.ts — the PURE (DOM-free) helpers behind the floating rail
// cards (CTL-1003 §B1/§B2). Kept out of ticket-rail.tsx (which imports the heavy
// Board/dependency-graph DOM components) so the root tsconfig's __tests__ suites
// can unit-test the relation slice/show-more arithmetic WITHOUT pulling the DOM
// component graph into the no-DOM-lib typecheck.
//
// CTL-1049: the rail-section COLLAPSE persistence (the old global
// `catalyst.ticket-rail.<id>.collapsed` localStorage round-trip — readRailCollapsed
// / writeRailCollapsed / railCollapseKey) is GONE. That key was shared across every
// ticket, so a section collapsed on ticket A leaked onto ticket B. Detail-rail
// collapse is now per-history-entry transient state in the back-stack entry-state
// family (detail-entry-state.ts: railSectionExpanded / setRailSection), so a fresh
// PUSH opens every section and a back/forward traverse restores the exact state.

// ── relation slice / show-more arithmetic ────────────────────────────────────
/** The relation-group display limit (first N rendered before "Show more"). */
export const RELATION_GROUP_LIMIT = 5;

/** Pure: how many rows are hidden behind a "Show N more" expander for a group of
 *  `total` relations (0 when total ≤ the limit). */
export function relationHiddenCount(total: number): number {
  return Math.max(0, total - RELATION_GROUP_LIMIT);
}
