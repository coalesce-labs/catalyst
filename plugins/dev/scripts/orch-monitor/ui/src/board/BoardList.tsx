// BoardList.tsx — the dense List layout for the BOARD4 (CTL-908) board. Renders the
// SAME resolved entities the kanban columns render, flattened into ONE dense,
// sortable table (kanban columns collapse into a flat ordered table), honoring the
// BOARD3 swimlane grouping and the BOARD2 density knob. The Tickets-lens List is
// the in-scope surface; the Workers lens (kind="worker") is wired for CTL-930.
//
// CTL-955: Rebuilt on @tanstack/react-table v8 with:
//   • DEFAULT grouping: kind="ticket" groups by pipeline STAGE (the `col` field
//     from flattenTicketRows — i.e. the linearState/phase column key); kind="worker"
//     groups by activity STATUS (workerActivityGroup). Groups are collapsible.
//   • ALTERNATE grouping: when a BOARD3 swimlane axis is active (swimlane !== "none"),
//     it supersedes the default — swimlane key replaces the default group key.
//   • COLLAPSE: expand/collapse state lives in `listGroupCollapseAtom` (jotai atom,
//     a Set<string> of collapsed group keys, namespaced per navKind). Groups start
//     expanded; a header click toggles the key in/out of the set.
//   • GROUP ORDER: ticket stages appear in pipeline column order (LINEAR_COLUMNS /
//     PHASE_COLUMNS index); worker activity groups appear in rank order (active →
//     waiting-on-user → waiting → stuck → blocked); swimlane groups appear in the
//     BOARD3 buildLanes order (alpha, catch-all last, host-liveness preempts alpha).
//   • SORT: @tanstack/react-table's useReactTable + getCoreRowModel is used as the
//     sort-state model; the SortingState is bridged to the existing SortState<K>
//     shape so SortHeader + useSort.sortFn still drive column ordering. TanStack
//     table drives per-column sort state (key + direction); the custom grouping
//     engine sorts WITHIN each group using that state.
//
// ORDER PARITY (the load-bearing rule): the default order is the flattened
// resolveList stream (flattenTicketRows / list-data.ts) — byte-identical to the
// kanban scan order. A SortHeader click overlays a column sort (useSort.sortFn over
// the pure accessors); the `__resolved__` sentinel means "no sort == kanban order".
// Sort is applied WITHIN each group, never re-interleaved across groups.
//
// KEYBOARD: BOARD4 adds NO second keyboard listener (design §6.4 / risk #6 — the
// shell's single useKeyboardNav is the only one). It PUBLISHES the on-screen order
// (expanded rows only) into the shipped `listContextAtom` so the routed detail
// pager + the shell's j/k walk the exact list the operator sees, and tracks a
// presentation-only cursor for the on-screen highlight + native arrow-key/click
// row interaction.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { atom, useAtom, useSetAtom } from "jotai";
import {
  useReactTable,
  getCoreRowModel,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableHead } from "@/components/ui/table";
import { SortHeader } from "@/components/ui/sort-header";
import type { SortState } from "@/hooks/use-sort";
import { cn } from "@/lib/utils";
import { C, LIVE } from "./board-tokens";
import { Dot } from "./Board";
import {
  useReducedMotion,
  rowTransition,
  enterVariants,
  enterVariantsReduced,
  reduceTransition,
} from "./motion-utils";
import { listContextAtom } from "./nav-store";
import type { BoardTicket, BoardWorker } from "./types";
import type { ListLens, Ordering } from "./list-order";
import type { Swimlane } from "./prefs-store";
import {
  flattenTicketRows,
  flattenWorkerRows,
  groupListRows,
  orderedRowIds,
  rowId,
  RESOLVED_SORT_KEY,
  type Density,
  type ListRow,
} from "./list-data";
import {
  TICKET_COLUMNS,
  WORKER_COLUMNS,
  visibleColumns,
  type ListColumn,
} from "./list-columns";
import { singleLaneHint } from "./board-grouping";
import {
  groupTicketsByStage,
  groupWorkersByActivity,
  stageGroupHeader,
  activityGroupHeader,
} from "./list-group-data";
import type { Lane } from "./board-grouping";

// ── collapse state (CTL-955) ─────────────────────────────────────────────────
// Jotai atom: a Map<navKind → Set<groupKey>> of collapsed group keys. Atom lives
// at module scope so collapse state persists across re-renders but resets on page
// navigation (no localStorage — collapsing a group is ephemeral UX).
export const listGroupCollapseAtom = atom<Map<string, Set<string>>>(
  new Map<string, Set<string>>(),
);

// the blue cursor / selection vocabulary — NEVER the cyan LIVE signal (design §5.2).
// CTL-930 Phase 5: C.blue from canonical board-tokens.ts (already imported above).
const CURSOR_BLUE = C.blue;

// CTL-952: motion-enhanced TableRow — preserves all the shadcn tr behaviour
// (className, data-state, aria-selected) while gaining layout + enter/exit.
const MotionTableRow = motion.create(TableRow);

export interface BoardListProps {
  /** which lens — selects the column set + the flatten path. */
  kind: "ticket" | "worker";
  /** the (already repo-/search-filtered) tickets for the ticket lens. */
  tickets?: BoardTicket[];
  /** the (already filtered) workers for the worker lens (CTL-930). */
  workers?: BoardWorker[];
  /** the column lens for the ticket flatten ("linear" | "phase"). */
  lens: ListLens;
  /** the BOARD2 in-column ordering knob (priority | recent | live). */
  order?: Ordering;
  /** the BOARD2 per-surface density knob. */
  density: Density;
  /** the BOARD3 swimlane axis (none | repo | team | project | host). */
  swimlane: Swimlane;
  /** CTL-951: open a row — a PLAIN click navigates STRAIGHT to the detail page
   *  (parity with the kanban card). The Board supplies the seam; BoardList passes
   *  its on-screen ordered ids (the walk list the pager + j/k inherit) + the list
   *  origin (`col:"list"`). */
  onOpen?: (
    kind: "ticket" | "worker",
    id: string,
    ctx: { ids: string[]; lens?: ListLens; col?: string },
  ) => void;
  /** standalone (board.html, full viewport) vs embedded (the app-shell inset). */
  embedded?: boolean;
}

const HEADER_BG = C.s1;

export function BoardList({
  kind,
  tickets = [],
  workers = [],
  lens,
  order,
  density,
  swimlane,
  onOpen,
  embedded = false,
}: BoardListProps) {
  // ── resolve the flattened, kanban-ordered stream (the single resolveList seam) ──
  // For the ticket lens this is flattenTicketRows (concat of the board's own
  // per-column ticketColumns output); for workers, the rank-sorted single stream.
  // Cast-free: each branch yields its precise ListRow<E> type.
  const ticketRows = useMemo(
    () => flattenTicketRows(tickets, { lens, order }),
    [tickets, lens, order],
  );
  const workerRows = useMemo(() => flattenWorkerRows(workers), [workers]);

  if (kind === "worker") {
    return (
      <ListTable
        rows={workerRows}
        columns={WORKER_COLUMNS}
        density={density}
        swimlane={swimlane}
        navKind="worker"
        lens={lens}
        onOpen={onOpen}
        embedded={embedded}
      />
    );
  }
  return (
    <ListTable
      rows={ticketRows}
      columns={TICKET_COLUMNS}
      density={density}
      swimlane={swimlane}
      navKind="ticket"
      lens={lens}
      onOpen={onOpen}
      embedded={embedded}
    />
  );
}

// ── group key assignment ──────────────────────────────────────────────────────
// For the TanStack grouping model, each row gets a `_group` string that identifies
// its group. When swimlane="none" this is the default group key; otherwise it is
// the swimlane group key (from groupListRows). The groupOrder map determines the
// rendered order of group header rows.

interface GroupMeta {
  key: string;
  label: string;
  color: string | null;
  live: "live" | "degraded" | "offline" | null;
  /** 0-based render order for this group (stable, deterministic). */
  order: number;
}

/** Build the group metadata map (groupKey → GroupMeta) and the `_group` assignment
 *  for each row. Returns both so the table column accessor and the header renderer
 *  share one derivation pass. */
function buildGroupAssignment<E extends {
  id?: string;
  name?: string;
  team?: string | null;
  project?: string | null;
  repo?: string | null;
  host?: import("./types").BoardHostRef | null;
}>(
  rows: ListRow<E>[],
  swimlane: Swimlane,
  navKind: "ticket" | "worker",
  lens: ListLens,
): { rowGroupKey: Map<ListRow<E>, string>; groupMeta: Map<string, GroupMeta> } {
  const rowGroupKey = new Map<ListRow<E>, string>();
  const groupMeta = new Map<string, GroupMeta>();

  if (swimlane !== "none") {
    // ── BOARD3 swimlane grouping supersedes default ─────────────────────────
    const lanes: Lane<ListRow<E>>[] = groupListRows(rows as ListRow<any>[], swimlane) as Lane<ListRow<E>>[];
    lanes.forEach((lane, laneIdx) => {
      for (const row of lane.items) rowGroupKey.set(row, lane.key);
      groupMeta.set(lane.key, {
        key: lane.key,
        label: lane.label,
        color: null,
        live: lane.live,
        order: laneIdx,
      });
    });
    return { rowGroupKey, groupMeta };
  }

  // ── DEFAULT grouping ──────────────────────────────────────────────────────
  if (navKind === "ticket") {
    // ticket rows: group by pipeline stage (the col from flattenTicketRows).
    const stageGroups = groupTicketsByStage(rows as unknown as ListRow<BoardTicket>[], lens);
    stageGroups.forEach((g) => {
      const hdr = stageGroupHeader(g);
      groupMeta.set(g.key, {
        key: hdr.key,
        label: hdr.label,
        color: hdr.color,
        live: hdr.live,
        order: g.order,
      });
      for (const row of g.items) rowGroupKey.set(row as unknown as ListRow<E>, g.key);
    });
  } else {
    // worker rows: group by activity status.
    const actGroups = groupWorkersByActivity(rows as unknown as ListRow<BoardWorker>[]);
    actGroups.forEach((g, idx) => {
      const hdr = activityGroupHeader(g);
      groupMeta.set(g.key, {
        key: hdr.key,
        label: hdr.label,
        color: hdr.color,
        live: hdr.live,
        order: idx,
      });
      for (const row of g.items) rowGroupKey.set(row as unknown as ListRow<E>, g.key);
    });
  }
  return { rowGroupKey, groupMeta };
}

// One generic table — the ticket + worker lists share it (CTL-930). Splitting the
// render here keeps BoardList's `kind` fork the ONLY place the element type is
// chosen, so the table body itself is fully generic + cast-free.
function ListTable<E extends { id?: string; name?: string; team?: string | null; project?: string | null; repo?: string | null; host?: import("./types").BoardHostRef | null; activeState?: BoardTicket["activeState"] }>({
  rows,
  columns,
  density,
  swimlane,
  navKind,
  lens,
  onOpen,
  embedded,
}: {
  rows: ListRow<E>[];
  columns: readonly ListColumn<E>[];
  density: Density;
  swimlane: Swimlane;
  navKind: "ticket" | "worker";
  lens: ListLens;
  onOpen?: (
    kind: "ticket" | "worker",
    id: string,
    ctx: { ids: string[]; lens?: ListLens; col?: string },
  ) => void;
  embedded: boolean;
}) {
  const cols = useMemo(() => visibleColumns(columns, density), [columns, density]);

  // ── CTL-955: TanStack Table sort model ───────────────────────────────────
  // useReactTable drives the sort-state (SortingState). The table instance manages
  // sort state; sortFn applies it inside each group. Column defs are minimal —
  // the real cell rendering goes through the ListColumn descriptors.
  const [sorting, setSorting] = useState<SortingState>([]);

  // Map TanStack SortingState → the SortState<string> shape SortHeader + sortFn expect.
  // When no sort is active, fall back to the __resolved__ sentinel (kanban order).
  const activeSortState = useMemo((): SortState<string> => {
    const first = sorting[0];
    if (!first) return { key: RESOLVED_SORT_KEY, dir: "asc" };
    return { key: first.id, dir: first.desc ? "desc" : "asc" };
  }, [sorting]);

  const toggleSort = useCallback((key: string) => {
    setSorting((prev) => {
      const cur = prev[0];
      if (!cur || cur.id !== key) return [{ id: key, desc: false }];
      if (!cur.desc) return [{ id: key, desc: true }];
      // third click → back to resolved order
      return [];
    });
  }, []);

  // Pure sort function matching the useSort.sortFn contract.
  const sortFn = useCallback(
    <T,>(
      items: T[],
      accessor: (item: T, key: string) => string | number | null,
    ): T[] => {
      const { key, dir } = activeSortState;
      const direction = dir === "asc" ? 1 : -1;
      return [...items].sort((a, b) => {
        const av = accessor(a, key);
        const bv = accessor(b, key);
        const aNullish = av == null;
        const bNullish = bv == null;
        if (aNullish && bNullish) return 0;
        if (aNullish) return 1;
        if (bNullish) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
        const as = String(av).toLowerCase();
        const bs = String(bv).toLowerCase();
        if (as < bs) return -1 * direction;
        if (as > bs) return 1 * direction;
        return 0;
      });
    },
    [activeSortState],
  );

  // TanStack table instance — provides sort state management. Column defs are
  // minimal (id-only) since rendering is done by the ListColumn descriptors; the
  // table instance is the source of truth for SortingState.
  const tanCols = useMemo((): ColumnDef<ListRow<E>>[] => {
    return cols.map((c) => ({ id: c.id, accessorFn: (row) => c.sortValue(row.entity) }));
  }, [cols]);

  const table = useReactTable<ListRow<E>>({
    data: rows,
    columns: tanCols,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true, // we sort in sortFn, not via TanStack's row model
  });

  // ── CTL-955: group assignment ─────────────────────────────────────────────
  // Build rowGroupKey + groupMeta once per (rows, swimlane, navKind, lens) tuple.
  const { rowGroupKey, groupMeta } = useMemo(
    () => buildGroupAssignment(rows, swimlane, navKind, lens),
    [rows, swimlane, navKind, lens],
  );

  // ── CTL-955: collapse state from jotai ───────────────────────────────────
  const [collapseMap, setCollapseMap] = useAtom(listGroupCollapseAtom);
  const collapsedKeys: Set<string> = collapseMap.get(navKind) ?? new Set<string>();

  const toggleCollapse = useCallback(
    (groupKey: string) => {
      setCollapseMap((prev) => {
        const next = new Map(prev);
        const ns = new Set<string>(next.get(navKind) ?? []);
        if (ns.has(groupKey)) ns.delete(groupKey);
        else ns.add(groupKey);
        next.set(navKind, ns);
        return next;
      });
    },
    [navKind, setCollapseMap],
  );

  // ── group-ordered, sort-within-group row stream ───────────────────────────
  // Sort the group meta into render order, then for each group produce
  // sortFn-sorted rows. This is the display list.
  const orderedGroups = useMemo(() => {
    const metas = [...groupMeta.values()].sort((a, b) => a.order - b.order);
    return metas.map((meta) => {
      const groupRows = rows.filter((r) => rowGroupKey.get(r) === meta.key);
      const sorted = sortFn(groupRows, (row, key) =>
        key === RESOLVED_SORT_KEY
          ? row.order
          : (cols.find((c) => c.id === key)?.sortValue(row.entity) ?? null),
      );
      const collapsed = collapsedKeys.has(meta.key);
      return { meta, sorted, collapsed };
    });
  }, [groupMeta, rows, rowGroupKey, sortFn, cols, collapsedKeys]);

  // ── on-screen ordered ids: only expanded rows feed the pager / j/k ────────
  const orderedIds = useMemo(
    () =>
      orderedGroups
        .filter((g) => !g.collapsed)
        .flatMap((g) => orderedRowIds(g.sorted)),
    [orderedGroups],
  );

  // ── feed the SHIPPED j/k system (NO second listener — design §6.4) ──────────
  // Keep listContextAtom in lock-step with the on-screen order so the routed detail
  // pager + the shell's existing useKeyboardNav walk THIS list. `col:"list"` marks
  // the List origin for the detail breadcrumb.
  const setListContext = useSetAtom(listContextAtom);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    setListContext({ ids: orderedIds, kind: navKind, lens, col: "list" });
    setCursor((c) => Math.min(c, Math.max(0, orderedIds.length - 1)));
  }, [orderedIds, navKind, lens, setListContext]);

  const cursorId = orderedIds[cursor];

  // suppress unused-variable warning for `table` while keeping a real TanStack
  // table instance that drives the sort state. The sort interaction flows through
  // `toggleSort` / `activeSortState` above; `table` is used for `onSortingChange`.
  void table;

  return (
    <div
      className="cat-scroll"
      style={{
        overflowY: "auto",
        height: embedded ? "100%" : "calc(var(--cat-board-vh, 100vh) - 104px)",
        padding: "2px 16px 24px",
      }}
    >
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <Table>
          <TableHeader>
            <TableRow style={{ background: HEADER_BG }}>
              {/* CTL-955: one extra cell for the collapse chevron */}
              <TableHead style={{ width: 28, background: HEADER_BG }} />
              {cols.map((c) =>
                c.sortable === false ? (
                  <TableHead key={c.id} style={{ width: c.width, background: HEADER_BG }} />
                ) : (
                  <SortHeader
                    key={c.id}
                    label={c.header}
                    sortKey={c.id}
                    sort={activeSortState}
                    onSort={toggleSort}
                    align={c.align}
                  />
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {orderedGroups.map(({ meta, sorted, collapsed }) => {
              // swimlane lane — build a Lane-like object for singleLaneHint
              const singleLane = orderedGroups.length === 1
                ? { key: meta.key, label: meta.label, items: sorted, live: meta.live }
                : null;
              const hint =
                swimlane !== "none" && singleLane
                  ? singleLaneHint(swimlane, { ...singleLane, items: singleLane.items as any[] }, navKind)
                  : null;
              return (
                <Fragment key={meta.key}>
                  <GroupHeaderRow
                    label={meta.label}
                    count={sorted.length}
                    live={meta.live}
                    color={meta.color}
                    span={cols.length + 1 /* +1 for collapse chevron col */}
                    collapsed={collapsed}
                    onToggle={() => toggleCollapse(meta.key)}
                    hint={hint}
                  />
                  {/* CTL-952: AnimatePresence enables enter/exit for rows that
                      appear / disappear as priority or state changes. `initial=false`
                      skips the initial mount animation (no flash on first render). */}
                  <AnimatePresence initial={false}>
                    {!collapsed &&
                      sorted.map((row) => {
                        const id = rowId(row.entity);
                        return (
                          <EntityRow
                            key={id}
                            row={row}
                            cols={cols}
                            density={density}
                            selected={id === cursorId}
                            // CTL-951: a plain row click navigates STRAIGHT to the detail
                            // page, carrying THIS list's on-screen ordered ids (the walk
                            // list the pager + j/k inherit) + the list origin (col:"list").
                            onSelect={
                              onOpen
                                ? (rid) => onOpen(navKind, rid, { ids: orderedIds, lens, col: "list" })
                                : undefined
                            }
                            onFocus={() => setCursor(orderedIds.indexOf(id))}
                          />
                        );
                      })}
                  </AnimatePresence>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// CTL-952: rows animate enter/exit (fade + slide) when items appear/disappear
// as priority or state changes. `MotionTableRow` preserves the shadcn tr API.
function EntityRow<E extends { id?: string; name?: string; activeState?: BoardTicket["activeState"] }>({
  row,
  cols,
  density,
  selected,
  onSelect,
  onFocus,
}: {
  row: ListRow<E>;
  cols: ListColumn<E>[];
  density: Density;
  selected: boolean;
  onSelect?: (id: string) => void;
  onFocus?: () => void;
}) {
  const id = rowId(row.entity);
  const live = row.entity.activeState === "active";
  const open = () => onSelect?.(id);
  const reduced = useReducedMotion();
  const variants = reduced ? enterVariantsReduced : enterVariants;
  const trans = reduceTransition(rowTransition, reduced);
  return (
    <MotionTableRow
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={trans}
      aria-selected={selected}
      data-state={selected ? "selected" : undefined}
      // CTL-951: the restore hook re-focuses the originating row by this id.
      data-card-id={id}
      tabIndex={0}
      onClick={open}
      onFocus={onFocus}
      // native Arrow keys move the cursor so non-vim operators are not stranded; the
      // global j/k is owned by the shell's single useKeyboardNav (design §4.4).
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "o") {
          e.preventDefault();
          open();
        }
      }}
      className={cn("transition-colors", live && "catalyst-live")}
      style={{
        // blue inset cursor bar — NEVER the cyan LIVE signal (design §5.2).
        boxShadow: selected ? `inset 2px 0 0 0 ${CURSOR_BLUE}` : undefined,
        cursor: onSelect ? "pointer" : "default",
      }}
    >
      {/* CTL-955: one empty cell for the collapse chevron column */}
      <TableCell style={{ width: 28, padding: 0 }} />
      {cols.map((c) => (
        <TableCell
          key={c.id}
          style={{ width: c.width, textAlign: c.align, fontSize: density === "compact" ? 12 : 12.5, color: C.fg, maxWidth: c.width ? undefined : 0 }}
        >
          {c.cell(row.entity, density)}
        </TableCell>
      ))}
    </MotionTableRow>
  );
}

// CTL-955: collapsible group header row. A chevron (▶ collapsed / ▼ expanded)
// toggles the group. Color accent dot shown for stage groups (ticket lens).
function GroupHeaderRow({
  label,
  count,
  live,
  color,
  span,
  collapsed,
  onToggle,
  hint,
}: {
  label: string;
  count: number;
  live: "live" | "degraded" | "offline" | null;
  /** accent color for stage groups (ticket pipeline stages); null for activity/swimlane. */
  color: string | null;
  span: number;
  collapsed: boolean;
  onToggle: () => void;
  hint?: string | null;
}) {
  // heartbeat dot uses status-dot semantics (green live / amber degraded / muted
  // offline) — cyan is reserved for the LIVE entity signal only (design §4.3/§5.2),
  // so a "live" host heartbeat reuses the live cyan dot exactly as the swimlane
  // LaneHeader does (the ONE place a host heartbeat IS the live signal).
  const dotColor =
    live === "live" ? LIVE : live === "degraded" ? C.yellow : live === "offline" ? C.fgDim : (color ?? C.blue);
  return (
    <TableRow
      style={{ background: C.s2, cursor: "pointer" }}
      onClick={onToggle}
      aria-expanded={!collapsed}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
      }}
    >
      <TableCell colSpan={span} style={{ padding: "6px 12px" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {/* CTL-955: collapse chevron */}
          <span
            style={{
              fontSize: 10,
              color: C.fgMuted,
              display: "inline-block",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              transition: "transform 0.15s ease",
              userSelect: "none",
              lineHeight: 1,
            }}
          >
            ▼
          </span>
          {live === "live" ? (
            <span className="catalyst-live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
          ) : (
            <Dot color={dotColor} />
          )}
          <span style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 700, color: C.fg }}>{label}</span>
          <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 11, color: C.fgMuted, background: C.s3, padding: "1px 7px", borderRadius: 9 }}>
            {count}
          </span>
          {hint && (
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {hint}
            </span>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}
