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
 * The BOARD2 (CTL-906) in-column ordering key. Shared by the board columns AND
 * BOARD4's list view (both order through `resolveList`), so their order can
 * never drift. `undefined`/absent = the historical payload-array order (no
 * re-sort) — the FND2 byte-for-byte regression guard.
 *   - `priority` — P1 (urgent) first; ties broken by `updatedAt` desc.
 *   - `recent`   — `updatedAt` desc.
 *   - `live`     — `activeState === "active"` first, then `priority`.
 */
export type Ordering = "priority" | "recent" | "live";

/**
 * The context that selects + orders a list. Mirrors the typed search params
 * (`route-search.ts`) the detail shell reconstructs from the URL:
 *   - `kind:"ticket"` + `lens` + `col` (+ optional `order`) → one board column.
 *   - `kind:"worker"` → the in-flight worker queue (rank-sorted).
 */
export type ListContext =
  | { kind: "ticket"; lens?: ListLens; col?: string; order?: Ordering }
  | { kind: "worker"; lens?: ListLens; col?: string };

// ── worker ordering (lifted verbatim from Board.tsx:441-442) ────────────────
// `isActive` is the same predicate Board.tsx defines at line 67. Kept local so
// this module stays import-free apart from the shared types.
const isActive = (s: BoardActiveState): boolean => s === "active";

/**
 * CTL-947: the activity group a worker belongs to, for display grouping. The
 * full ordered set of groups (first → last):
 *   0 — active       : `activeState === "active"` (in-loop, generating)
 *   1 — waiting-on-user: live worker parked for a human prompt (`waitingOnUser`)
 *   2 — waiting      : idle / between-phases (`activeState === null`)
 *   3 — stuck        : `activeState === "stuck"` (stale transcript / terminal marker)
 *   4 — blocked      : ticket hold `held === "blocked"` — rendered LAST per spec
 *   5 — dead         : CTL-978 — bg job reached terminal state; NOT in-flight
 *
 * Note: "blocked" is a ticket-level attribute; `workerActivityGroup` takes it as
 * an optional second argument so the pure grouper can partition without needing
 * to carry a ticket lookup internally.
 */
export type WorkerActivityGroup =
  | "active"
  | "waiting-on-user"
  | "waiting"
  | "stuck"
  | "blocked"
  | "dead";

const WORKER_GROUP_RANK: Record<WorkerActivityGroup, number> = {
  active: 0,
  "waiting-on-user": 1,
  waiting: 2,
  stuck: 3,
  blocked: 4,
  dead: 5,
};

/** Map a worker (+ optional ticket held state) to its display activity group. */
export function workerActivityGroup(
  w: BoardWorker,
  ticketHeld?: "blocked" | "waiting" | null,
): WorkerActivityGroup {
  // CTL-978: dead workers form their own group — excluded from in-flight count.
  // Dead takes priority over everything else (the bg job is definitively gone).
  if (w.activeState === "dead") return "dead";
  if (ticketHeld === "blocked") return "blocked";
  if (w.activeState === "stuck") return "stuck";
  if (w.waitingOnUser) return "waiting-on-user";
  if (isActive(w.activeState)) return "active";
  return "waiting";
}

/**
 * The worker rank used by the in-flight queue: active (in-loop) first,
 * waiting-on-user second, idle/between-phases third, stuck fourth, blocked last.
 * CTL-947 extends the original `active?0 : stuck?2 : 1` closure to cover all
 * activity states. `ticketHeld` is the associated ticket's `held` field — pass
 * it when building the grouped queue view so blocked tickets sort to the bottom.
 */
export function rankWorker(
  w: BoardWorker,
  ticketHeld?: "blocked" | "waiting" | null,
): number {
  return WORKER_GROUP_RANK[workerActivityGroup(w, ticketHeld)];
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

// ── ticket in-column ordering (BOARD2 / CTL-906) ────────────────────────────
// `updatedAt` is an ISO string; `Date.parse` yields NaN for "" / malformed —
// treat that as 0 (oldest) so a missing timestamp sinks to the bottom of a
// "recent" sort rather than throwing or sorting unpredictably.
const updatedAtMs = (t: BoardTicket): number => {
  const ms = Date.parse(t.updatedAt);
  return Number.isFinite(ms) ? ms : 0;
};
// Linear priority is `0 = No priority, 1 = Urgent … 4 = Low`. For a
// priority-first sort we want Urgent (1) at the top and "No priority" (0) at the
// bottom, so map 0 → +Infinity (sinks last) and keep 1..4 ascending.
const priorityRank = (p: number): number => (p === 0 ? Number.POSITIVE_INFINITY : p);
const isActiveTicket = (t: BoardTicket): boolean => t.activeState === "active";

/**
 * The in-column comparator for the BOARD2 (CTL-906) `order` knob. PURE — returns
 * a `(a, b) => number` and never mutates. Used by `resolveList` (so the board
 * columns + BOARD4 list view share one order) AND directly in unit tests.
 *   - `priority` — `priorityRank` asc (Urgent first, No-priority last), ties
 *     broken by `updatedAt` desc.
 *   - `recent`   — `updatedAt` desc.
 *   - `live`     — active-first, then `priority` (same priorityRank).
 */
export function compareTickets(order: Ordering): (a: BoardTicket, b: BoardTicket) => number {
  if (order === "recent") {
    return (a, b) => updatedAtMs(b) - updatedAtMs(a);
  }
  if (order === "live") {
    return (a, b) =>
      Number(isActiveTicket(b)) - Number(isActiveTicket(a)) ||
      priorityRank(a.priority) - priorityRank(b.priority);
  }
  // "priority"
  return (a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority) || updatedAtMs(b) - updatedAtMs(a);
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
 *     order preserved, NO re-sort UNLESS `order` is given (BOARD2 / CTL-906),
 *     in which case `compareTickets(order)` is applied AFTER the column filter
 *     so the board columns, the pager `N/total`, and the j/k walk stay
 *     byte-identical to each other (the FND P1 invariant).
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
  ctx: { kind: "ticket"; lens?: ListLens; col?: string; order?: Ordering },
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
  const filtered = filterTickets(payload.tickets, ctx.lens ?? "linear", ctx.col);
  // BOARD2 / CTL-906: re-sort the column when an `order` is requested. No order
  // → payload-array order preserved (the FND2 byte-for-byte regression guard).
  return ctx.order ? filtered.sort(compareTickets(ctx.order)) : filtered;
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
  // Route through resolveList so the optional BOARD2 `order` is applied here too
  // — the pager + j/k walk read the same ordered ids the board column renders.
  return (resolveList(payload, ctx) as BoardTicket[]).map((t) => t.id);
}
