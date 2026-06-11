// detail-entry-state.ts — the PURE (React-/jotai-free) model behind the
// back-stack entry state convention (CTL-1049). Every detail page (ticket +
// worker) keys its transient view state — the active tab, which right-rail
// sections are expanded, the scroll offset — by the TanStack Router per-history-
// entry key (`location.state.__TSR_key`), NOT by route path or global prefs.
//
// The convention (CTL-1049 Gherkin):
//   1. Forward navigation (PUSH) lands on a BRAND-NEW entry key → no stored
//      state → the page renders the DEFAULTS (Spec tab, all rail sections open,
//      top of scroll). The last tab choice can never leak across tickets, because
//      a different ticket is a different entry.
//   2. Backward navigation (browser back / Escape) traverses to an EXISTING entry
//      key → its stored {activeTab, railExpanded, scrollY} is restored verbatim.
//
// This module owns the DEFAULTS, the per-entry shape, and the bounded-memory
// arithmetic (an LRU over the live entry keys so the atomFamily can't grow without
// bound across a long session). The jotai `atomFamily` + the React hooks that read
// the router key live in `detail-entry-store.ts` / the detail pages; this file is
// deliberately runtime-free so the family-eviction + default rules are unit-tested
// under the root `bun test` (same discipline as route-search.ts / ticket-rail-model.ts).

/** The transient per-entry view state a detail page restores on back/forward. */
export interface DetailEntryState {
  /** The active reading tab. `"spec"` is the fresh-push default (CTL-996 idiom:
   *  spec is the hero). Ticket pages use the full set; the worker page only ever
   *  reads/writes `"spec"` for it (its in-body Now/History tab is separate). */
  activeTab: string;
  /** Which right-rail sections are EXPANDED, keyed by section id
   *  (`properties` · `labels` · `project` · `relations` · `dependencies`). A
   *  section absent from the map inherits the default = EXPANDED (all-open is the
   *  fresh default, so a never-touched section is open). A section present with
   *  `false` was explicitly collapsed on THIS entry. */
  railExpanded: Record<string, boolean>;
  /** The saved vertical scroll offset of the single detail scroller
   *  (`data-shell-scroll`). 0 on a fresh push (top); a real offset on a traversed
   *  entry (back/forward restoration). */
  scrollY: number;
}

/** The fresh-push defaults: Spec tab, ALL rail sections expanded, scrolled to top.
 *  A new history entry (PUSH) has no stored state, so the family hands back a
 *  fresh copy of this — the "forward navigation = defaults" Gherkin. */
export const DETAIL_ENTRY_DEFAULTS: DetailEntryState = {
  activeTab: "spec",
  railExpanded: {},
  scrollY: 0,
};

/** A fresh, independent copy of the defaults (never share the object reference —
 *  each entry's atom owns its own mutable snapshot). */
export function freshEntryState(): DetailEntryState {
  return { activeTab: "spec", railExpanded: {}, scrollY: 0 };
}

/** Resolve whether a rail section is expanded for an entry: an explicit stored
 *  `false` collapses it; anything else (absent / `true`) is EXPANDED — the
 *  all-open default. Detail rails ignore the legacy global localStorage collapse
 *  (CTL-1003) entirely; this per-entry map is the sole source of truth. */
export function railSectionExpanded(state: DetailEntryState, sectionId: string): boolean {
  return state.railExpanded[sectionId] !== false;
}

/** Return a new state with `sectionId` set to `expanded` (immutable update — the
 *  jotai setter replaces the atom value). */
export function setRailSection(
  state: DetailEntryState,
  sectionId: string,
  expanded: boolean,
): DetailEntryState {
  return { ...state, railExpanded: { ...state.railExpanded, [sectionId]: expanded } };
}

// ── bounded memory (LRU over live entry keys) ────────────────────────────────
/** The max number of distinct history-entry keys whose state we retain. A long
 *  session walking hundreds of tickets would otherwise grow the atomFamily without
 *  bound; we keep the most-recently-touched MAX and evict the rest. Generous
 *  enough that a realistic back stack is never pruned out from under the operator. */
export const DETAIL_ENTRY_LRU_MAX = 50;

/**
 * Given the current recency order (most-recent LAST) and a key that was just
 * touched, return `{ order, evicted }`: the new recency order (touched key moved
 * to the end, de-duped) capped at `max`, plus the keys evicted off the front when
 * the cap is exceeded. The caller calls `family.remove(key)` for each evicted key.
 *
 * Pure + total: an empty order + a new key yields `{ order: [key], evicted: [] }`.
 */
export function touchEntryLRU(
  order: readonly string[],
  key: string,
  max: number = DETAIL_ENTRY_LRU_MAX,
): { order: string[]; evicted: string[] } {
  const next = order.filter((k) => k !== key);
  next.push(key);
  if (next.length <= max) return { order: next, evicted: [] };
  const overflow = next.length - max;
  const evicted = next.slice(0, overflow);
  return { order: next.slice(overflow), evicted };
}
