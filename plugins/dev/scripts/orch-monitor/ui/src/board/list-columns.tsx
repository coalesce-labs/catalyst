// list-columns.tsx — the column-descriptor model + cell renderers for the BOARD4
// (CTL-908) dense List view. Generic over BoardTicket | BoardWorker (CTL-930 lens
// forward-compat): one descriptor type, two column sets, one render engine.
//
// Every cell REUSES the live board's own atoms (exported from Board.tsx) — never a
// re-implementation — so the live/priority/phase/status render can never drift
// between the kanban cards and the List rows (design §5.1 risk #2). The sort-value
// accessors live in the PURE, DOM-free list-data.ts (unit-tested there); this file
// only binds them to the descriptors + supplies the React cells.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { C } from "./board-tokens";
import type { BoardTicket, BoardWorker } from "./types";
import {
  ActivityDot,
  PriorityIcon,
  PhasePill,
  ScopeChip,
  StatusBadge,
  HeldBadge,
  Cost,
  accentFor,
  fmtAgo,
  fmtRuntime,
} from "./Board";
import { ticketSortValue, workerSortValue, type Density } from "./list-data";

export type { Density };

/** A List column descriptor. Generic over the entity so ticket + worker lists share
 *  one render engine (CTL-930). `id` doubles as the sort key + the React key. */
export interface ListColumn<E> {
  /** sort key + React key. */
  id: string;
  /** the SortHeader label ("" for the dot column). */
  header: string;
  /** px width; omit = flex. */
  width?: number;
  align?: "left" | "right";
  /** false -> no sort affordance (the live dot column). */
  sortable?: boolean;
  /** dense-only columns are dropped when density === "compact". */
  denseOnly?: boolean;
  /** the value useSort.sortFn reads (string|number|null; null sorts last). Delegates
   *  to the pure accessor in list-data.ts so the sort logic is unit-tested DOM-free. */
  sortValue: (e: E) => string | number | null;
  /** the cell renderer — receives density so a cell can compact itself. */
  cell: (e: E, density: Density) => ReactNode;
}

const idStyle: React.CSSProperties = { fontFamily: C.mono, fontSize: 11.5, fontWeight: 600, color: C.blue };
const titleStyle: React.CSSProperties = { color: C.fg, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const dimMono: React.CSSProperties = { fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 11, color: C.fgDim };

// ── ticket columns (the Tickets-lens List) ───────────────────────────────────
// 1:1 from the BOARD4 Gherkin row spec ("id, priority, title, phase, status,
// scope/estimate, live signal, cost/turns or PR") + age + host (CTL-930/BFF2).
export const TICKET_COLUMNS: readonly ListColumn<BoardTicket>[] = [
  {
    id: "live",
    header: "",
    width: 28,
    sortable: false,
    sortValue: (t) => ticketSortValue(t, "live"),
    // the LIVE cyan lives ONLY here, via the shared ActivityDot — never on chrome.
    cell: (t) => <ActivityDot state={t.activeState} fallback={accentFor(t, "phase")} />,
  },
  {
    id: "pri",
    header: "Pri",
    width: 44,
    sortValue: (t) => ticketSortValue(t, "pri"),
    cell: (t) => <PriorityIcon p={t.priority} />,
  },
  {
    id: "id",
    header: "Ticket",
    width: 100,
    sortValue: (t) => ticketSortValue(t, "id"),
    cell: (t) => <span style={idStyle}>{t.id}</span>,
  },
  {
    id: "title",
    header: "Title",
    sortValue: (t) => ticketSortValue(t, "title"),
    cell: (t) => <div style={titleStyle} title={t.title}>{t.title}</div>,
  },
  {
    id: "phase",
    header: "Phase",
    width: 120,
    sortValue: (t) => ticketSortValue(t, "phase"),
    cell: (t) => <PhasePill phase={t.phase} />,
  },
  {
    id: "status",
    header: "Status",
    width: 130,
    sortValue: (t) => ticketSortValue(t, "status"),
    // dense: the chip anatomy (HeldBadge + the exceptional-StatusBadge for
    // failed/stalled/etc) PLUS the plain status word (StatusBadge renders null for
    // ordinary statuses like "active"/"done", so the word keeps the column legible).
    // compact: just the plain status word.
    cell: (t, density) =>
      density === "compact" ? (
        <span style={dimMono}>{t.status}</span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <HeldBadge held={t.held} blockers={t.blockers} />
          <StatusBadge status={t.status} />
          <span style={dimMono}>{t.status}</span>
        </span>
      ),
  },
  {
    id: "est",
    header: "Est",
    width: 64,
    sortValue: (t) => ticketSortValue(t, "est"),
    cell: (t) => <ScopeChip scope={t.scope} estimate={t.estimate} />,
  },
  {
    id: "host",
    header: "Host",
    width: 110,
    denseOnly: true,
    sortValue: (t) => ticketSortValue(t, "host"),
    cell: (t) => (t.host?.name ? <span style={dimMono}>{t.host.name}</span> : <span style={dimMono}>—</span>),
  },
  {
    id: "age",
    header: "Age",
    width: 80,
    sortValue: (t) => ticketSortValue(t, "age"),
    cell: (t) => <span style={dimMono}>{fmtAgo(t.updatedAt)}</span>,
  },
  {
    id: "cost",
    header: "Cost/PR",
    width: 84,
    denseOnly: true,
    align: "right",
    sortValue: (t) => ticketSortValue(t, "cost"),
    cell: (t) =>
      t.pr ? (
        <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.green }}>#{t.pr}</span>
      ) : (
        <Cost v={t.costUSD} />
      ),
  },
];

// ── worker columns (the Workers-lens List — CTL-930 forward-compat) ───────────
// Defined now so the Workers lens drops in with zero new render code. Reuses the
// WorkerCard atoms; base order comes from sortWorkers via flattenWorkerRows.
export const WORKER_COLUMNS: readonly ListColumn<BoardWorker>[] = [
  {
    id: "live",
    header: "",
    width: 28,
    sortable: false,
    sortValue: (w) => workerSortValue(w, "live"),
    cell: (w) => <ActivityDot state={w.activeState} fallback={C.blue} />,
  },
  {
    id: "id",
    header: "Ticket",
    width: 100,
    sortValue: (w) => workerSortValue(w, "id"),
    cell: (w) => <span style={idStyle}>{w.ticket}</span>,
  },
  {
    id: "session",
    header: "Session",
    width: 90,
    denseOnly: true,
    sortValue: (w) => workerSortValue(w, "session"),
    cell: (w) => (w.sessionId ? <span style={dimMono}>{w.sessionId.slice(0, 7)}</span> : <span style={dimMono}>—</span>),
  },
  {
    id: "phase",
    header: "Phase",
    width: 120,
    sortValue: (w) => workerSortValue(w, "phase"),
    cell: (w) => <PhasePill phase={w.phase} />,
  },
  {
    id: "repo",
    header: "Repo",
    width: 90,
    sortValue: (w) => workerSortValue(w, "repo"),
    cell: (w) => <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>{w.repo}</Badge>,
  },
  {
    id: "host",
    header: "Host",
    width: 110,
    denseOnly: true,
    sortValue: (w) => workerSortValue(w, "host"),
    cell: (w) => (w.host?.name ? <span style={dimMono}>{w.host.name}</span> : <span style={dimMono}>—</span>),
  },
  {
    id: "runtime",
    header: "Runtime",
    width: 80,
    sortValue: (w) => workerSortValue(w, "runtime"),
    cell: (w) => <span style={dimMono}>{fmtRuntime(w.runtimeMs)}</span>,
  },
  {
    id: "cost",
    header: "Cost",
    width: 76,
    denseOnly: true,
    align: "right",
    sortValue: (w) => workerSortValue(w, "cost"),
    cell: (w) => <Cost v={w.costUSD} />,
  },
  {
    id: "status",
    header: "Status",
    width: 96,
    sortValue: (w) => workerSortValue(w, "status"),
    cell: (w) => <span style={dimMono}>{w.status}</span>,
  },
];

/** Drop the `denseOnly` columns when the surface density is "compact" (BOARD2's
 *  per-surface density knob). PURE — returns a filtered view. */
export function visibleColumns<E>(columns: readonly ListColumn<E>[], density: Density): ListColumn<E>[] {
  return columns.filter((c) => density === "comfortable" || !c.denseOnly);
}
