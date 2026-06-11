// list-data.ts — the PURE (React-/jotai-/DOM-free) core of the BOARD4 (CTL-908)
// dense List view. The List flattens the kanban columns into ONE ordered stream
// of the SAME resolved entities the columns render, so "List order == kanban
// order" is guaranteed by reuse, not re-implemented. Unit-tested under `bun test`
// (list-data.test.ts), the same discipline as board-display.ts / board-grouping.ts
// / list-order.ts.
//
// The load-bearing invariant (BOARD4 Gherkin "rows ordered by the same shared
// comparator the board columns use"): `flattenTicketRows` concatenates the live
// board's OWN per-column `ticketColumns(...)` output (which resolves each column
// through the shared `resolveList`), in column order. There is no second
// comparator to drift from — the same `ticketColumns` the TicketBoard renders.

import type { BoardTicket, BoardWorker } from "./types";
import { ticketColumns } from "./board-display";
import { sortWorkers, type ListLens, type Ordering } from "./list-order";
import {
  buildLanes,
  type GroupBy,
  type HostLiveness,
  type Lane,
} from "./board-grouping";

/** Density mirrors the BOARD2 `boardPrefsAtom.density` ("comfortable" | "compact").
 *  "compact" drops the `denseOnly` columns + collapses chip-rich cells. */
export type Density = "comfortable" | "compact";

/** One resolved List row: the entity, the kanban column key it came from (so a
 *  row's detail-link / breadcrumb carries the right `?col`), and its 0-based index
 *  in the flattened kanban-order stream (the sentinel sort value for "no sort"). */
export interface ListRow<E> {
  entity: E;
  /** kanban column key the row was resolved from (""+ for workers — single stream). */
  col: string;
  /** 0-based position in the flattened resolveList stream — the `__resolved__` sort
   *  value, so "no active sort" === "resolveList order" with no special-case branch. */
  order: number;
}

/** The display options the flatten needs — a subset of BoardPrefs. */
export interface ListDataOptions {
  /** the column lens ("linear" | "phase") — selects which kanban column SET to flatten. */
  lens: ListLens;
  /** the in-column ordering knob (priority | recent | live); absent = payload order. */
  order?: Ordering;
}

/**
 * Flatten the kanban's per-column ticket lists into ONE ordered stream, in kanban
 * column order, tagging each row with the column key it came from.
 *
 * Reuses the SHIPPED `ticketColumns` (board-display.ts) — the exact helper
 * TicketBoard renders — with `showEmptyColumns:true` so the flatten is independent
 * of the board's empty-column reflow (an empty column simply contributes zero rows
 * either way). The result reads "column 1 top-to-bottom, then column 2…", which is
 * the operator's scan order the ticket promises, and is byte-identical to the
 * board because it IS the board's own column resolution.
 *
 * PURE — never mutates `tickets`.
 */
export function flattenTicketRows(
  tickets: readonly BoardTicket[],
  opts: ListDataOptions,
): ListRow<BoardTicket>[] {
  const cols = ticketColumns([...tickets], {
    groupBy: opts.lens,
    showEmptyColumns: true,
    order: opts.order,
  });
  const out: ListRow<BoardTicket>[] = [];
  let order = 0;
  for (const c of cols) {
    for (const entity of c.items) {
      out.push({ entity, col: c.key, order: order++ });
    }
  }
  return out;
}

/**
 * Flatten the worker queue into the List stream. The worker lens has no columns —
 * it is the single rank-sorted stream `sortWorkers` produces (== the live QueueView
 * order, == `resolveList({kind:"worker"})`). `col` is "" (no column origin).
 * Defined now for the CTL-930 Workers lens (forward-compat); PURE.
 */
export function flattenWorkerRows(
  workers: readonly BoardWorker[],
): ListRow<BoardWorker>[] {
  return sortWorkers(workers).map((entity, order) => ({ entity, col: "", order }));
}

/** The stable id of a List row's entity — `BoardTicket.id` for tickets,
 *  `BoardWorker.name` for workers (the `listContextAtom.ids` convention the detail
 *  pager + j/k walk read; matches `resolveListIds`). */
export function rowId<E extends { id?: string; name?: string }>(entity: E): string {
  // tickets carry `id`; workers carry `name`. Both are present on exactly one shape.
  return entity.id ?? entity.name ?? "";
}

/** The ordered id list for a flattened (and optionally grouped/sorted) row stream —
 *  exactly what `listContextAtom.ids` binds to. Group order is preserved (never
 *  re-interleaved across lanes). */
export function orderedRowIds<E extends { id?: string; name?: string }>(
  rows: readonly ListRow<E>[],
): string[] {
  return rows.map((r) => rowId(r.entity));
}

/**
 * Section the flattened row stream into swimlane lanes via the SHIPPED BOARD3
 * `buildLanes` engine — keyed on the SAME `Swimlane` axis the kanban lanes use, so
 * the List sections match the board's lanes (and single-host/`none` collapse to ONE
 * lane, the identity no-op: no group header). Sort is applied by the caller WITHIN
 * each returned lane's `items` (grouping wraps sort, never the reverse).
 *
 * `buildLanes` groups on `GroupableEntity` (team/project/repo/host) — `ListRow`
 * carries the entity, so we map the lane membership back onto the rows by grouping
 * the ENTITIES and re-wrapping. Order WITHIN each lane is the flattened stream order
 * (stable), so a lane reads in kanban order until a column sort overlays it.
 */
export function groupListRows<E extends { team?: string | null; project?: string | null; repo?: string | null; host?: import("./types").BoardHostRef | null }>(
  rows: ListRow<E>[],
  swimlane: GroupBy,
  liveness?: HostLiveness,
): Lane<ListRow<E>>[] {
  // buildLanes is generic over GroupableEntity; a ListRow is NOT groupable itself,
  // so we group the underlying entities (which ARE groupable) and re-wrap the lanes
  // to carry the rows. We project each row to its entity for grouping, then rebuild
  // the per-lane row list by membership — preserving the flattened stream order.
  const entityRows = new Map<E, ListRow<E>>();
  for (const r of rows) entityRows.set(r.entity, r);
  const entityLanes = buildLanes(
    rows.map((r) => r.entity),
    swimlane,
    liveness,
  );
  return entityLanes.map((lane) => ({
    ...lane,
    items: lane.items
      .map((e) => entityRows.get(e))
      .filter((r): r is ListRow<E> => r != null),
  }));
}

// ── sort-value accessors (BOARD4 column sort overlay) ────────────────────────
// The List's default order is the `__resolved__` sentinel (the row's `order`
// index), so "no active sort" === kanban order. Clicking a SortHeader overlays one
// of these accessors via `useSort.sortFn` (null sorts last per the hook). Pure +
// null-safe (no throw on a missing host/estimate).

/** Sentinel sort key meaning "the resolveList order itself" — the default. */
export const RESOLVED_SORT_KEY = "__resolved__" as const;

/** index a phase into PHASE_COLUMNS so a Phase sort matches kanban column order.
 *  Lifted to a map for O(1); an unknown phase sorts LAST (high index). */
import { PHASE_COLUMNS } from "./board-display";
const PHASE_ORDER: Record<string, number> = Object.fromEntries(
  PHASE_COLUMNS.map((c, i) => [c.key, i]),
);
export function phaseOrder(phase: string): number {
  return PHASE_ORDER[phase] ?? PHASE_COLUMNS.length;
}

/** scope ordinal (xs < s < m < l < xl) for the Est sort when no numeric estimate. */
const SCOPE_ORDER: Record<string, number> = { xs: 0, small: 1, medium: 2, large: 3, xl: 4 };
export function scopeOrder(scope: string | null): number {
  return scope != null ? (SCOPE_ORDER[scope] ?? 99) : 99;
}

/** active-first rank matching `resolveList` worker semantics (active=0, stuck=2,
 *  else=1) so the live items float when the operator sorts by the live column. */
export function activeRank(state: BoardTicket["activeState"]): number {
  return state === "active" ? 0 : state === "stuck" ? 2 : 1;
}

/** ms since epoch for a ticket's `updatedAt`; NaN/empty → 0 (sinks in a desc sort). */
function updatedAtMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The sort value for a ticket under a given List column key. Returns
 * string|number|null (null sorts last per `useSort.sortFn`). The `__resolved__`
 * sentinel is handled by the caller (it reads the row's `order`), not here.
 * Null-safe: a missing host/estimate never throws.
 */
export function ticketSortValue(t: BoardTicket, key: string): string | number | null {
  switch (key) {
    case "live":
      return activeRank(t.activeState);
    case "pri":
      // 0 = "No priority" → sink last; 1..4 ascending (Urgent first).
      return t.priority === 0 ? Number.POSITIVE_INFINITY : t.priority;
    case "id":
      return t.id;
    case "title":
      return t.title;
    case "phase":
      return phaseOrder(t.phase);
    case "status":
      return t.status;
    case "est":
      return t.estimate ?? scopeOrder(t.scope);
    case "host":
      return t.host?.name ?? null;
    case "age":
      return updatedAtMs(t.updatedAt);
    case "cost":
      // prefer the PR number (a shipped ticket), else the cost in USD.
      return t.pr ?? t.costUSD ?? 0;
    default:
      return null;
  }
}

/** The sort value for a worker under a List column key (CTL-930 forward-compat). */
export function workerSortValue(w: BoardWorker, key: string): string | number | null {
  switch (key) {
    case "live":
      return activeRank(w.activeState);
    case "id":
      return w.ticket;
    case "session":
      return w.sessionId ?? null;
    case "phase":
      return phaseOrder(w.phase);
    case "repo":
      return w.repo;
    case "host":
      return w.host?.name ?? null;
    case "runtime":
      return w.runtimeMs ?? 0;
    case "cost":
      return w.costUSD ?? 0;
    case "status":
      return w.status;
    default:
      return null;
  }
}
