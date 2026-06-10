// board-display.ts — the PURE (React-/jotai-/DOM-free) column-derivation helper
// behind the BOARD2 (CTL-906) display options. TicketBoard renders exactly the
// columns this returns, so the "Show empty columns" + "Column grouping (Status /
// Phase)" + in-column "Ordering" Gherkin scenarios are unit-tested without a DOM
// (same discipline as worker-grouping.ts / list-order.ts).
//
// The column SETS are lifted from Board.tsx's `LINEAR_COLS` / `PHASE_COLS` (the
// hard-wired two lenses) so the colors + keys stay byte-identical; the board now
// imports them from here so there is ONE definition. Ordering is delegated to
// the shared `resolveList` so the board columns and BOARD4's list view can never
// drift (the FND2 P1 invariant).

import type { BoardPayload, BoardTicket } from "./types";
import { resolveList, type ListLens, type Ordering } from "./list-order";

/** One board column definition: the filter key, its display label, accent color. */
export interface BoardColumnDef {
  key: string;
  label: string;
  c: string;
}

// Lifted verbatim from Board.tsx (LINEAR_COLS / PHASE_COLS) — same keys, same
// colors. LINEAR_COLS had no explicit labels (key === label); normalized here.
export const LINEAR_COLUMNS: readonly BoardColumnDef[] = [
  { key: "Todo", label: "Todo", c: "#94a3b8" },
  { key: "Triage", label: "Triage", c: "#64748b" },
  { key: "Research", label: "Research", c: "#3b82f6" },
  { key: "Plan", label: "Plan", c: "#a855f7" },
  { key: "Implement", label: "Implement", c: "#10b981" },
  { key: "Validate", label: "Validate", c: "#f59e0b" },
  { key: "PR", label: "PR", c: "#14b8a6" },
  { key: "Done", label: "Done", c: "#6b7280" },
];

export const PHASE_COLUMNS: readonly BoardColumnDef[] = [
  { key: "triage", label: "Triage", c: "#64748b" },
  { key: "research", label: "Research", c: "#3b82f6" },
  { key: "plan", label: "Plan", c: "#a855f7" },
  { key: "implement", label: "Implement", c: "#10b981" },
  { key: "verify", label: "Verify", c: "#f59e0b" },
  { key: "review", label: "Review", c: "#eab308" },
  { key: "pr", label: "PR", c: "#14b8a6" },
  { key: "monitor-merge", label: "Merge", c: "#4ea1ff" },
  { key: "monitor-deploy", label: "Deploy", c: "#39d07a" },
  { key: "teardown", label: "Teardown", c: "#6b7280" },
];

/** The display options that drive the ticket-column derivation (a subset of
 *  BoardPrefs — only the bits TicketBoard needs). */
export interface TicketColumnOptions {
  groupBy: ListLens; // "linear" | "phase"
  showEmptyColumns: boolean;
  order?: Ordering;
}

/** A derived, ready-to-render column: its definition + the resolved (filtered +
 *  optionally ordered) items + the live (active) count for the header chip. */
export interface DerivedColumn extends BoardColumnDef {
  items: BoardTicket[];
  live: number;
}

// Stub payload to route a ticket array through resolveList (its ticket branch
// reads `.tickets` only) — mirrors Board.tsx's EMPTY_BOARD_PAYLOAD.
const STUB_REST: Omit<BoardPayload, "tickets"> = {
  generatedAt: "",
  config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
  repos: [],
  workers: [],
  queue: [],
};

/**
 * Derive the ticket columns to render for the given (already repo-/search-
 * filtered) ticket array and the BOARD2 display options:
 *   - pick the column SET by `groupBy` (linear | phase);
 *   - resolve each column's items through the shared `resolveList` (column
 *     filter + optional `order`) so the on-screen order == the pager/j-k order;
 *   - when `showEmptyColumns` is false, drop zero-count columns so the rest
 *     reflow to fill the width (the "Show empty columns" Gherkin).
 * PURE — never mutates its inputs.
 */
export function ticketColumns(
  tickets: BoardTicket[],
  opts: TicketColumnOptions,
): DerivedColumn[] {
  const defs = opts.groupBy === "linear" ? LINEAR_COLUMNS : PHASE_COLUMNS;
  // resolveList's ticket branch only READS payload.tickets (filter → new array),
  // never mutates it, so handing the live array straight through is safe.
  const payload: BoardPayload = { ...STUB_REST, tickets };
  return defs
    .map((def): DerivedColumn => {
      const items = resolveList(payload, {
        kind: "ticket",
        lens: opts.groupBy,
        col: def.key,
        order: opts.order,
      });
      const live = items.filter((t) => t.activeState === "active").length;
      return { ...def, items, live };
    })
    .filter((col) => opts.showEmptyColumns || col.items.length > 0);
}

// ── CTL-950: shared column header across swimlanes ───────────────────────────
// The single sticky header row at the top of the swimlane board must show the
// SAME column set for every lane (Linear-style), so the column SET is derived
// ONCE over the full (cross-lane) ticket array rather than per-lane. With
// showEmptyColumns=false a column is kept iff ANY lane has a ticket in it — so a
// column an operator sees in the header is guaranteed to be a real lane cell
// somewhere, never empty-in-header-yet-present-in-one-lane.
/**
 * The visible column DEFINITIONS for the shared header — the lens column set,
 * narrowed by `showEmptyColumns` over the WHOLE ticket array (every swimlane
 * combined). PURE; no items, no order — just which columns the header shows.
 */
export function visibleColumnDefs(
  tickets: BoardTicket[],
  opts: { groupBy: ListLens; showEmptyColumns: boolean },
): BoardColumnDef[] {
  const defs = opts.groupBy === "linear" ? LINEAR_COLUMNS : PHASE_COLUMNS;
  if (opts.showEmptyColumns) return [...defs];
  const payload: BoardPayload = { ...STUB_REST, tickets };
  return defs.filter(
    (def) =>
      resolveList(payload, { kind: "ticket", lens: opts.groupBy, col: def.key }).length > 0,
  );
}

/**
 * Distribute ONE lane's tickets across a FIXED column set (the shared header's
 * `defs`), returning a derived column per def in def order (so every lane lays
 * its cards into the same grid tracks). Empty lane-cells are KEPT — the column
 * exists in the shared header, the lane simply has nothing in it (an aligned
 * blank cell, not a reflow). PURE.
 */
export function laneColumns(
  tickets: BoardTicket[],
  defs: readonly BoardColumnDef[],
  opts: { groupBy: ListLens; order?: Ordering },
): DerivedColumn[] {
  const payload: BoardPayload = { ...STUB_REST, tickets };
  return defs.map((def): DerivedColumn => {
    const items = resolveList(payload, {
      kind: "ticket",
      lens: opts.groupBy,
      col: def.key,
      order: opts.order,
    });
    const live = items.filter((t) => t.activeState === "active").length;
    return { ...def, items, live };
  });
}
