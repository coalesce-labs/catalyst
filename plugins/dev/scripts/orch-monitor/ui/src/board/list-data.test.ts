// list-data.test.ts — units for the BOARD4 (CTL-908) dense List view core. Pure
// logic, no DOM — run from the ui package:
//   cd ui && bun test src/board/list-data.test.ts
//
// Encodes the BOARD4 Gherkin scenarios that are testable without a renderer:
//   • "Flip to List view … rows ordered by the same shared comparator the board
//      columns use" — flattenTicketRows == concat of the live board's OWN per-column
//      ticketColumns output, in column order. The LOAD-BEARING order-parity assertion
//      (asserted against the REAL shipped resolveList/ticketColumns, no mock).
//   • "List view honors grouping" — groupListRows sections by the swimlane key, one
//      lane per project, "Unassigned" for no-project, sort applied WITHIN each lane.
//   • the column sort overlay (ticketSortValue accessors) + denseOnly handling.
import { describe, it, expect } from "bun:test";
import type { BoardPayload, BoardTicket, BoardWorker, BoardHostRef } from "./types";
import { ticketColumns, PHASE_COLUMNS } from "./board-display";
import { resolveListIds, sortWorkers, type Ordering } from "./list-order";
import {
  flattenTicketRows,
  flattenWorkerRows,
  groupListRows,
  orderedRowIds,
  rowId,
  ticketSortValue,
  workerSortValue,
  phaseOrder,
  scopeOrder,
  activeRank,
  RESOLVED_SORT_KEY,
} from "./list-data";

// ── fixtures — the REAL shipped shapes ───────────────────────────────────────
const t = (over: Partial<BoardTicket> & { id: string }): BoardTicket => ({
  title: `title ${over.id}`,
  type: "feature",
  repo: "catalyst",
  team: "CTL",
  phase: "implement",
  status: "active",
  model: null,
  linearState: "Implement",
  workerStatus: null,
  activeState: null,
  working: false,
  lastActiveMs: null,
  priority: 3,
  estimate: null,
  scope: null,
  project: null,
  costUSD: null,
  tokens: null,
  turns: null,
  phaseCosts: null,
  phaseSummary: [],
  pr: null,
  updatedAt: "2026-06-09T00:00:00.000Z",
  host: null,
  ...over,
});

const w = (over: Partial<BoardWorker> & { name: string }): BoardWorker => ({
  ticket: over.ticket ?? over.name,
  tickets: over.tickets ?? [over.ticket ?? over.name],
  phase: "implement",
  status: "active",
  activeState: null,
  working: false,
  lastActiveMs: null,
  repo: "catalyst",
  team: "CTL",
  runtimeMs: null,
  costUSD: null,
  ...over,
});

const payload = (tickets: BoardTicket[], workers: BoardWorker[] = []): BoardPayload => ({
  generatedAt: "",
  config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
  repos: [],
  workers,
  tickets,
  queue: [],
});

const h = (name: string): BoardHostRef => ({ name, id: `id-${name}` });

describe("list-data — order parity (the LOAD-BEARING invariant: List order == kanban order)", () => {
  // tickets spread across linear columns + within a column, so order matters.
  const tickets: BoardTicket[] = [
    t({ id: "CTL-1", linearState: "PR", phase: "pr" }),
    t({ id: "CTL-2", linearState: "Implement", phase: "implement" }),
    t({ id: "CTL-3", linearState: "Research", phase: "research" }),
    t({ id: "CTL-4", linearState: "Implement", phase: "verify" }),
    t({ id: "CTL-5", linearState: "Todo", phase: "triage" }),
  ];

  it("flattenTicketRows (linear) == concat of the board's OWN per-column ticketColumns output, in column order", () => {
    const opts = { lens: "linear" as const };
    const expected = ticketColumns([...tickets], { groupBy: "linear", showEmptyColumns: true })
      .flatMap((c) => c.items.map((e) => e.id));
    const actual = flattenTicketRows(tickets, opts).map((r) => r.entity.id);
    expect(actual).toEqual(expected);
  });

  it("flattenTicketRows (phase) == the board's per-phase-column output in PHASE_COLUMNS order", () => {
    const opts = { lens: "phase" as const };
    const expected = ticketColumns([...tickets], { groupBy: "phase", showEmptyColumns: true })
      .flatMap((c) => c.items.map((e) => e.id));
    const actual = flattenTicketRows(tickets, opts).map((r) => r.entity.id);
    expect(actual).toEqual(expected);
  });

  it("orderedRowIds equals resolveListIds concatenated per column (== the detail pager's ids)", () => {
    const p = payload(tickets);
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    // The detail pager resolves ONE column at a time via resolveListIds; the List is
    // the concatenation of every column's ids in column order.
    const cols = ticketColumns([...tickets], { groupBy: "linear", showEmptyColumns: true });
    const pagerConcat = cols.flatMap((c) =>
      resolveListIds(p, { kind: "ticket", lens: "linear", col: c.key }),
    );
    expect(orderedRowIds(rows)).toEqual(pagerConcat);
  });

  it("tags each row with the column key it was resolved from (so the detail-link carries ?col)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const ctl3 = rows.find((r) => r.entity.id === "CTL-3");
    expect(ctl3?.col).toBe("Research");
    const ctl1 = rows.find((r) => r.entity.id === "CTL-1");
    expect(ctl1?.col).toBe("PR");
  });

  it("the row .order index is a 0..n-1 stable run in stream order (the __resolved__ sort value)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    expect(rows.map((r) => r.order)).toEqual(rows.map((_, i) => i));
  });

  it("honors the BOARD2 ordering knob — flatten == board columns ordered the SAME way", () => {
    for (const order of ["priority", "recent", "live"] as Ordering[]) {
      const expected = ticketColumns([...tickets], { groupBy: "linear", showEmptyColumns: true, order })
        .flatMap((c) => c.items.map((e) => e.id));
      const actual = flattenTicketRows(tickets, { lens: "linear", order }).map((r) => r.entity.id);
      expect(actual).toEqual(expected);
    }
  });

  it("does not mutate the input tickets array", () => {
    const input = [...tickets];
    const snapshot = input.map((x) => x.id);
    flattenTicketRows(input, { lens: "linear", order: "priority" });
    expect(input.map((x) => x.id)).toEqual(snapshot);
  });
});

describe("list-data — worker stream (CTL-930 forward-compat)", () => {
  const workers: BoardWorker[] = [
    w({ name: "CTL-10:1", ticket: "CTL-10", activeState: null, runtimeMs: 100 }),
    w({ name: "CTL-11:1", ticket: "CTL-11", activeState: "active", runtimeMs: 50 }),
    w({ name: "CTL-12:1", ticket: "CTL-12", activeState: "stuck", runtimeMs: 200 }),
  ];

  it("flattenWorkerRows == sortWorkers order, col === '' (single stream, no columns)", () => {
    const rows = flattenWorkerRows(workers);
    expect(rows.map((r) => r.entity.name)).toEqual(sortWorkers(workers).map((x) => x.name));
    expect(rows.every((r) => r.col === "")).toBe(true);
  });

  it("rowId reads BoardWorker.name (the listContextAtom.ids convention for workers)", () => {
    expect(rowId(workers[0]!)).toBe("CTL-10:1");
  });
});

describe("list-data — rowId", () => {
  it("reads BoardTicket.id for tickets", () => {
    expect(rowId(t({ id: "CTL-99" }))).toBe("CTL-99");
  });
});

describe("list-data — swimlane sectioning (groupListRows over the BOARD3 engine)", () => {
  const tickets: BoardTicket[] = [
    t({ id: "CTL-1", project: "Zeta", linearState: "Implement" }),
    t({ id: "CTL-2", project: null, linearState: "Implement" }),
    t({ id: "CTL-3", project: "Alpha", linearState: "Implement" }),
    t({ id: "CTL-4", project: "Alpha", linearState: "Research" }),
  ];

  it("swimlane=none -> exactly one lane, empty label (no header row), identity to flat", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const lanes = groupListRows(rows, "none");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.label).toBe("");
    expect(lanes[0]?.items).toHaveLength(rows.length);
  });

  it("swimlane=project -> one labeled lane per project, no-project in 'Unassigned' (last)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const lanes = groupListRows(rows, "project");
    expect(lanes.map((l) => l.label)).toEqual(["Alpha", "Zeta", "Unassigned"]);
    // CTL-2 (no project) lands in the Unassigned lane.
    expect(lanes.at(-1)?.items.map((r) => r.entity.id)).toEqual(["CTL-2"]);
  });

  it("preserves the flattened stream order WITHIN a lane (never re-interleaved across lanes)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const lanes = groupListRows(rows, "project");
    const alpha = lanes.find((l) => l.label === "Alpha");
    // In LINEAR_COLUMNS order Research (idx 2) precedes Implement (idx 4), so the
    // flattened stream is CTL-4 (Research) then CTL-3 (Implement) — and groupListRows
    // preserves that intra-lane order rather than re-sorting by id.
    expect(alpha?.items.map((r) => r.entity.id)).toEqual(["CTL-4", "CTL-3"]);
  });

  it("host axis: single distinct host -> ONE lane (identity no-op)", () => {
    const single = [
      t({ id: "CTL-1", host: h("mini"), linearState: "Implement" }),
      t({ id: "CTL-2", host: h("mini"), linearState: "Implement" }),
    ];
    const rows = flattenTicketRows(single, { lens: "linear" });
    const lanes = groupListRows(rows, "host");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.label).toBe("mini");
  });

  it("host axis: all hosts un-stamped (single-host today) -> ONE Unassigned lane (identity no-op)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const lanes = groupListRows(rows, "host");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.label).toBe("Unassigned");
  });
});

describe("list-data — ticket sort-value accessors (the column-sort overlay)", () => {
  it("pri: Urgent(1) sorts before Low(4); No-priority(0) sinks to +Infinity (last)", () => {
    expect(ticketSortValue(t({ id: "a", priority: 1 }), "pri")).toBe(1);
    expect(ticketSortValue(t({ id: "b", priority: 4 }), "pri")).toBe(4);
    expect(ticketSortValue(t({ id: "c", priority: 0 }), "pri")).toBe(Number.POSITIVE_INFINITY);
  });

  it("age: parses updatedAt to ms; empty/malformed -> 0 (no throw)", () => {
    expect(ticketSortValue(t({ id: "a", updatedAt: "2026-06-09T00:00:00.000Z" }), "age")).toBe(
      Date.parse("2026-06-09T00:00:00.000Z"),
    );
    expect(ticketSortValue(t({ id: "b", updatedAt: "" }), "age")).toBe(0);
    expect(ticketSortValue(t({ id: "c", updatedAt: "not-a-date" }), "age")).toBe(0);
  });

  it("cost: prefers the PR number over costUSD; 0 when neither (null-safe)", () => {
    expect(ticketSortValue(t({ id: "a", pr: 1234, costUSD: 5 }), "cost")).toBe(1234);
    expect(ticketSortValue(t({ id: "b", pr: null, costUSD: 5 }), "cost")).toBe(5);
    expect(ticketSortValue(t({ id: "c", pr: null, costUSD: null }), "cost")).toBe(0);
  });

  it("est: numeric estimate wins; else falls back to the scope ordinal; null-safe", () => {
    expect(ticketSortValue(t({ id: "a", estimate: 3 }), "est")).toBe(3);
    expect(ticketSortValue(t({ id: "b", estimate: null, scope: "large" }), "est")).toBe(scopeOrder("large"));
    expect(ticketSortValue(t({ id: "c", estimate: null, scope: null }), "est")).toBe(scopeOrder(null));
  });

  it("host: reads host.name; null when absent (sorts last, no throw)", () => {
    expect(ticketSortValue(t({ id: "a", host: h("mini") }), "host")).toBe("mini");
    expect(ticketSortValue(t({ id: "b", host: null }), "host")).toBeNull();
  });

  it("phase: maps to the PHASE_COLUMNS index so a Phase sort matches kanban column order", () => {
    expect(ticketSortValue(t({ id: "a", phase: "triage" }), "phase")).toBe(0);
    expect(ticketSortValue(t({ id: "b", phase: PHASE_COLUMNS.at(-1)!.key }), "phase")).toBe(
      PHASE_COLUMNS.length - 1,
    );
    // an unknown phase sorts LAST
    expect(phaseOrder("not-a-phase")).toBe(PHASE_COLUMNS.length);
  });

  it("live: active(0) floats above idle(1) and stuck(2) — matches resolveList worker rank", () => {
    expect(ticketSortValue(t({ id: "a", activeState: "active" }), "live")).toBe(0);
    expect(ticketSortValue(t({ id: "b", activeState: null }), "live")).toBe(1);
    expect(ticketSortValue(t({ id: "c", activeState: "stuck" }), "live")).toBe(2);
    expect(activeRank("dead")).toBe(1);
  });

  it("an unknown column key -> null (sorts last, no throw)", () => {
    expect(ticketSortValue(t({ id: "a" }), "nope")).toBeNull();
    expect(ticketSortValue(t({ id: "a" }), RESOLVED_SORT_KEY)).toBeNull();
  });
});

describe("list-data — worker sort-value accessors (CTL-930 forward-compat)", () => {
  it("runtime/cost null-safe; live rank; session/host nullable", () => {
    expect(workerSortValue(w({ name: "x", runtimeMs: 42 }), "runtime")).toBe(42);
    expect(workerSortValue(w({ name: "x", runtimeMs: null }), "runtime")).toBe(0);
    expect(workerSortValue(w({ name: "x", activeState: "active" }), "live")).toBe(0);
    expect(workerSortValue(w({ name: "x" }), "session")).toBeNull();
    expect(workerSortValue(w({ name: "x", host: h("mini") }), "host")).toBe("mini");
    expect(workerSortValue(w({ name: "x" }), "nope")).toBeNull();
  });
});
