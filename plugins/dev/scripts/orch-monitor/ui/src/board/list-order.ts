// list-order.ts — THE single ordering source for the board, the detail-page
// pager (`N / total`), and the j/k walk (CTL-882 / FND2). This is the P1
// keystone correctness item from detail design §3.1 / §6:
//
//   > the board's sort is an inline `.sort()` with a local `rank()` closure
//   > (Board.tsx:442, not exported). The pager `N/total` and `j/k` MUST consume
//   > the *same* comparator + column filter or the on-screen order silently
//   > drifts from the walk order. Extract `board/list-order.ts` →
//   > `resolveList(payload, ctx)`, imported by both `Board.tsx` and the shell.
//
// PURE module — deliberately React-/jotai-/router-free (it imports only the
// hoisted board *types*) so the orch-monitor `bun test` suite can unit-test it
// directly from outside the `ui/` module graph, the same way board-logic.ts is
// unit-tested by board-client.test.ts. The board view (Board.tsx) and the
// detail shell both call `resolveList`; because they share this one function,
// `indexOf($id)+1` on the shell's resolved list can never disagree with the
// card order the operator counted on the board.

import type {
  BoardActiveState,
  BoardPayload,
  BoardTicket,
  BoardWorker,
} from "./types";

/** Which list the operator is walking — a ticket column or the worker queue. */
export type ListKind = "ticket" | "worker";

/** Which board lens a ticket list was rendered under (mirrors route-search). */
export type ListLens = "linear" | "phase";

/**
 * The context that selects + orders a list. Mirrors the typed search params
 * (`route-search.ts`) the detail shell reconstructs from the URL:
 *   - `kind:"ticket"` + `lens` + `col` → one board column (filter, no re-sort).
 *   - `kind:"worker"` → the in-flight worker queue (rank-sorted).
 */
export type ListContext =
  | { kind: "ticket"; lens?: ListLens; col?: string }
  | { kind: "worker"; lens?: ListLens; col?: string };

// ── worker ordering (lifted verbatim from Board.tsx:441-442) ────────────────
// `isActive` is the same predicate Board.tsx defines at line 67. Kept local so
// this module stays import-free apart from the shared types.
const isActive = (s: BoardActiveState): boolean => s === "active";

/**
 * The worker rank used by the in-flight queue: active (in-loop) first, then
 * everything else, then stuck last. Byte-for-byte the closure from
 * `Board.tsx:441` — `active?0 : stuck?2 : 1`.
 */
export function rankWorker(w: BoardWorker): number {
  return isActive(w.activeState) ? 0 : w.activeState === "stuck" ? 2 : 1;
}

/**
 * Order workers exactly as the in-flight queue does today: by `rankWorker`
 * ascending, ties broken by `runtimeMs` descending (longest-running first).
 * This is the literal comparator from `Board.tsx:442`:
 *   `[...workers].sort((a,b)=> rank(a)-rank(b) || (b.runtimeMs ?? 0)-(a.runtimeMs ?? 0))`
 * Returns a new array — never mutates the resident payload.
 */
export function sortWorkers(workers: readonly BoardWorker[]): BoardWorker[] {
  return [...workers].sort(
    (a, b) => rankWorker(a) - rankWorker(b) || (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0),
  );
}

// ── ticket ordering (lifted verbatim from Board.tsx:362) ────────────────────
/**
 * Select the tickets in one board column. The board has NO explicit `.sort()`
 * on tickets — order is the payload array order within the column filter
 * (`Board.tsx:362`). Reproduce that exactly (filter, no re-sort) or card order
 * drifts from the pager. A `col` of `undefined`/`""` selects nothing (a
 * cold-link with no column context resolves to an empty list, never a throw).
 */
export function filterTickets(
  tickets: readonly BoardTicket[],
  lens: ListLens,
  col: string | undefined,
): BoardTicket[] {
  if (!col) return [];
  return lens === "linear"
    ? tickets.filter((t) => t.linearState === col)
    : tickets.filter((t) => t.phase === col);
}

/**
 * Resolve the ordered list for a board column (tickets) or the in-flight queue
 * (workers) from the resident `BoardPayload` and the navigation context.
 *
 * The board renders through this and the detail shell walks through this, so
 * `resolveList(payload, ctx).map(e => e.id…)` is the single source of truth for
 * pager `N / total` and the j/k order on BOTH pages.
 *
 *   - `kind:"ticket"`: `filterTickets` — column filter on `linearState`
 *     (lens "linear", the default) or `phase` (lens "phase"), payload array
 *     order preserved, NO re-sort.
 *   - `kind:"worker"`: `sortWorkers` — rank(active=0, stuck=2, else=1) then
 *     `runtimeMs` descending.
 *
 * Never mutates `payload`; never throws on missing/unknown context.
 *
 * Overloaded on the `kind` discriminant so callers that pass a literal
 * `kind:"ticket"` / `kind:"worker"` get the precise element type back with no
 * cast; the general `ListContext` signature keeps the union for a dynamic ctx.
 */
export function resolveList(
  payload: BoardPayload,
  ctx: { kind: "ticket"; lens?: ListLens; col?: string },
): BoardTicket[];
export function resolveList(
  payload: BoardPayload,
  ctx: { kind: "worker"; lens?: ListLens; col?: string },
): BoardWorker[];
export function resolveList(
  payload: BoardPayload,
  ctx: ListContext,
): BoardTicket[] | BoardWorker[];
export function resolveList(
  payload: BoardPayload,
  ctx: ListContext,
): BoardTicket[] | BoardWorker[] {
  if (ctx.kind === "worker") {
    return sortWorkers(payload.workers);
  }
  return filterTickets(payload.tickets, ctx.lens ?? "linear", ctx.col);
}

/**
 * The ordered id list for a context — the exact thing the pager and j/k walk
 * bind to (`listContextAtom.ids`). For tickets this is `BoardTicket.id`; for
 * workers it is `BoardWorker.name` (the worker board keys cards by `w.name`,
 * `Board.tsx:387`, and the worker route is `/worker/$id`).
 */
export function resolveListIds(payload: BoardPayload, ctx: ListContext): string[] {
  if (ctx.kind === "worker") {
    return sortWorkers(payload.workers).map((w) => w.name);
  }
  return filterTickets(payload.tickets, ctx.lens ?? "linear", ctx.col).map((t) => t.id);
}
