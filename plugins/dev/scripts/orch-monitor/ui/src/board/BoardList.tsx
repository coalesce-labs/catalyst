// BoardList.tsx — the dense List layout for the BOARD4 (CTL-908) board. Renders the
// SAME resolved entities the kanban columns render, flattened into ONE dense,
// sortable table (kanban columns collapse into a flat ordered table), honoring the
// BOARD3 swimlane grouping and the BOARD2 density knob. The Tickets-lens List is
// the in-scope surface; the Workers lens (kind="worker") is wired for CTL-930.
//
// ORDER PARITY (the load-bearing rule): the default order is the flattened
// resolveList stream (flattenTicketRows / list-data.ts) — byte-identical to the
// kanban scan order. A SortHeader click overlays a column sort (useSort.sortFn over
// the pure accessors); the `__resolved__` sentinel means "no sort == kanban order".
// Sort is applied WITHIN each swimlane lane, never re-interleaved across lanes.
//
// KEYBOARD: BOARD4 adds NO second keyboard listener (design §6.4 / risk #6 — the
// shell's single useKeyboardNav is the only one). It PUBLISHES the on-screen order
// into the shipped `listContextAtom` so the routed detail pager + the shell's j/k
// walk the exact list the operator sees, and tracks a presentation-only cursor for
// the on-screen highlight + native arrow-key/click row interaction.
import { Fragment, useEffect, useMemo, useState } from "react";
import { useSetAtom } from "jotai";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableHead } from "@/components/ui/table";
import { SortHeader } from "@/components/ui/sort-header";
import { useSort } from "@/hooks/use-sort";
import { cn } from "@/lib/utils";
import { C, LIVE } from "./board-tokens";
import { Dot } from "./Board";
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

// the blue cursor / selection vocabulary — NEVER the cyan LIVE signal (design §5.2).
const CURSOR_BLUE = "#4ea1ff";

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
  /** open a row — parity with the kanban card click (opens the detail drawer). */
  onSelect?: (id: string) => void;
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
  onSelect,
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
        onSelect={onSelect}
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
      onSelect={onSelect}
      embedded={embedded}
    />
  );
}

// One generic table — the ticket + worker lists share it (CTL-930). Splitting the
// render here keeps BoardList's `kind` fork the ONLY place the element type is
// chosen, so the table body itself is fully generic + cast-free.
function ListTable<E extends { id?: string; name?: string; team?: string | null; project?: string | null; repo?: string | null; host?: import("./types").BoardHostRef | null }>({
  rows,
  columns,
  density,
  swimlane,
  navKind,
  lens,
  onSelect,
  embedded,
}: {
  rows: ListRow<E>[];
  columns: readonly ListColumn<E>[];
  density: Density;
  swimlane: Swimlane;
  navKind: "ticket" | "worker";
  lens: ListLens;
  onSelect?: (id: string) => void;
  embedded: boolean;
}) {
  const cols = useMemo(() => visibleColumns(columns, density), [columns, density]);

  // default sort = the resolveList order itself (the `__resolved__` sentinel), so
  // "no active sort" === kanban order with no special-case branch.
  const { sort, toggleSort, sortFn } = useSort<string>(RESOLVED_SORT_KEY, "asc");

  // grouping wraps sort: build lanes first (BOARD3 engine; single lane for
  // none/single-host = identity no-op), then sort WITHIN each lane.
  const lanes = useMemo(() => groupListRows(rows, swimlane), [rows, swimlane]);
  const sortedLanes = useMemo(
    () =>
      lanes.map((lane) => ({
        ...lane,
        items: sortFn(lane.items, (row, key) =>
          key === RESOLVED_SORT_KEY
            ? row.order
            : (cols.find((c) => c.id === key)?.sortValue(row.entity) ?? null),
        ),
      })),
    [lanes, sortFn, cols],
  );

  // the on-screen ordered ids (group order preserved) — what listContextAtom + the
  // cursor walk. Single source so List order == pager order == the highlight.
  const orderedIds = useMemo(
    () => sortedLanes.flatMap((lane) => orderedRowIds(lane.items)),
    [sortedLanes],
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

  const showHeaders = swimlane !== "none" && sortedLanes.length > 1;
  const cursorId = orderedIds[cursor];

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
              {cols.map((c) =>
                c.sortable === false ? (
                  <TableHead key={c.id} style={{ width: c.width, background: HEADER_BG }} />
                ) : (
                  <SortHeader
                    key={c.id}
                    label={c.header}
                    sortKey={c.id}
                    sort={sort}
                    onSort={toggleSort}
                    align={c.align}
                  />
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedLanes.map((lane) => (
              <Fragment key={lane.key}>
                {showHeaders && (
                  <GroupHeaderRow
                    label={lane.label}
                    count={lane.items.length}
                    live={lane.live}
                    span={cols.length}
                  />
                )}
                {lane.items.map((row) => {
                  const id = rowId(row.entity);
                  return (
                    <EntityRow
                      key={id}
                      row={row}
                      cols={cols}
                      density={density}
                      selected={id === cursorId}
                      onSelect={onSelect}
                      onFocus={() => setCursor(orderedIds.indexOf(id))}
                    />
                  );
                })}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

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
  return (
    <TableRow
      aria-selected={selected}
      data-state={selected ? "selected" : undefined}
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
      {cols.map((c) => (
        <TableCell
          key={c.id}
          style={{ width: c.width, textAlign: c.align, fontSize: density === "compact" ? 12 : 12.5, color: C.fg, maxWidth: c.width ? undefined : 0 }}
        >
          {c.cell(row.entity, density)}
        </TableCell>
      ))}
    </TableRow>
  );
}

function GroupHeaderRow({
  label,
  count,
  live,
  span,
}: {
  label: string;
  count: number;
  live: "live" | "degraded" | "offline" | null;
  span: number;
}) {
  // heartbeat dot uses status-dot semantics (green live / amber degraded / muted
  // offline) — cyan is reserved for the LIVE entity signal only (design §4.3/§5.2),
  // so a "live" host heartbeat reuses the live cyan dot exactly as the swimlane
  // LaneHeader does (the ONE place a host heartbeat IS the live signal).
  const dotColor =
    live === "live" ? LIVE : live === "degraded" ? C.yellow : live === "offline" ? C.fgDim : C.blue;
  return (
    <TableRow style={{ background: C.s2 }}>
      <TableCell colSpan={span} style={{ padding: "6px 12px" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {live === "live" ? (
            <span className="catalyst-live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
          ) : (
            <Dot color={dotColor} />
          )}
          <span style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 700, color: C.fg }}>{label}</span>
          <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 11, color: C.fgMuted, background: C.s3, padding: "1px 7px", borderRadius: 9 }}>
            {count}
          </span>
        </span>
      </TableCell>
    </TableRow>
  );
}
