// board-display.test.ts — units for the BOARD2 (CTL-906) pure column-derivation
// helper extracted from TicketBoard so the "Show empty columns" + "Column
// grouping" Gherkin scenarios are tested without a DOM (same pattern as
// worker-grouping / list-order). Imports only the pure ui/src/board helper.
import { describe, it, expect } from "bun:test";
import {
  ticketColumns,
  LINEAR_COLUMNS,
  PHASE_COLUMNS,
} from "../ui/src/board/board-display";
import type { BoardTicket } from "../ui/src/board/types";

function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id, title: id, type: "feature", repo: "catalyst", team: "CTL",
    phase: "implement", status: "active", model: null, linearState: "Implement",
    workerStatus: null, activeState: null, working: false, lastActiveMs: null,
    priority: 2, estimate: null, scope: null, project: null, costUSD: null,
    tokens: null, turns: null, phaseCosts: null, phaseSummary: [], pr: null,
    updatedAt: "", ...over,
  };
}

describe("board-display — column grouping selects the right column set", () => {
  it("groupBy 'linear' uses the Linear-state columns", () => {
    const cols = ticketColumns([], { groupBy: "linear", showEmptyColumns: true });
    expect(cols.map((c) => c.key)).toEqual(LINEAR_COLUMNS.map((c) => c.key));
  });

  it("groupBy 'phase' uses the pipeline-phase columns", () => {
    const cols = ticketColumns([], { groupBy: "phase", showEmptyColumns: true });
    expect(cols.map((c) => c.key)).toEqual(PHASE_COLUMNS.map((c) => c.key));
  });
});

describe("board-display — Show empty columns toggle (the Gherkin)", () => {
  // Several columns have zero tickets; the rest have items.
  const tickets = [
    mkTicket("a", { linearState: "Implement" }),
    mkTicket("b", { linearState: "Implement" }),
    mkTicket("c", { linearState: "PR" }),
  ];

  it("with showEmptyColumns=true, ALL columns are present (matches today)", () => {
    const cols = ticketColumns(tickets, { groupBy: "linear", showEmptyColumns: true });
    expect(cols.map((c) => c.key)).toEqual(LINEAR_COLUMNS.map((c) => c.key));
    // and the populated columns carry their items.
    expect(cols.find((c) => c.key === "Implement")?.items.map((t) => t.id)).toEqual(["a", "b"]);
    expect(cols.find((c) => c.key === "PR")?.items.map((t) => t.id)).toEqual(["c"]);
  });

  it("with showEmptyColumns=false, zero-count columns are dropped; the rest reflow", () => {
    const cols = ticketColumns(tickets, { groupBy: "linear", showEmptyColumns: false });
    // only the two non-empty columns survive (Implement, PR) — the rest reflow.
    expect(cols.map((c) => c.key)).toEqual(["Implement", "PR"]);
    expect(cols.every((c) => c.items.length > 0)).toBe(true);
  });

  it("never drops a column that has items, regardless of the toggle", () => {
    const onlyImplement = [mkTicket("x", { linearState: "Implement" })];
    const cols = ticketColumns(onlyImplement, { groupBy: "linear", showEmptyColumns: false });
    expect(cols.map((c) => c.key)).toEqual(["Implement"]);
  });
});

describe("board-display — the `order` knob flows into each column", () => {
  it("applies the ordering within a column when order is set", () => {
    const tickets = [
      mkTicket("p3", { linearState: "Implement", priority: 3 }),
      mkTicket("p1", { linearState: "Implement", priority: 1 }),
    ];
    const cols = ticketColumns(tickets, { groupBy: "linear", showEmptyColumns: true, order: "priority" });
    expect(cols.find((c) => c.key === "Implement")?.items.map((t) => t.id)).toEqual(["p1", "p3"]);
  });

  it("with no order preserves payload array order (regression guard)", () => {
    const tickets = [
      mkTicket("p3", { linearState: "Implement", priority: 3 }),
      mkTicket("p1", { linearState: "Implement", priority: 1 }),
    ];
    const cols = ticketColumns(tickets, { groupBy: "linear", showEmptyColumns: true });
    expect(cols.find((c) => c.key === "Implement")?.items.map((t) => t.id)).toEqual(["p3", "p1"]);
  });

  it("counts live (active) items per column", () => {
    const tickets = [
      mkTicket("live", { linearState: "Implement", activeState: "active" }),
      mkTicket("idle", { linearState: "Implement", activeState: null }),
    ];
    const cols = ticketColumns(tickets, { groupBy: "linear", showEmptyColumns: true });
    expect(cols.find((c) => c.key === "Implement")?.live).toBe(1);
  });
});
