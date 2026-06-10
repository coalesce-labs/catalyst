// board-display.test.ts — units for the CTL-950 shared-header column helpers
// (visibleColumnDefs + laneColumns). PURE logic, no DOM:
//   cd ui && bun test src/board/board-display.test.ts
//
// CTL-950 reworks the swimlane board from "one full TicketBoard per lane" (per-
// group headers + per-group horizontal scroll) into ONE sticky header row + ONE
// horizontal scroll, with each swimlane laying its cards into the SAME shared
// column grid. The two new helpers are the pure backbone of that:
//   • visibleColumnDefs — the SINGLE column set the shared header shows, decided
//     over EVERY lane combined (so a column an operator sees is real somewhere).
//   • laneColumns — distribute ONE lane's tickets across that FIXED column set,
//     KEEPING empty cells (aligned blanks, never a per-lane reflow).
import { describe, it, expect } from "bun:test";
import type { BoardTicket } from "./types";
import {
  visibleColumnDefs,
  laneColumns,
  LINEAR_COLUMNS,
  PHASE_COLUMNS,
} from "./board-display";

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

describe("visibleColumnDefs — the shared header column set (CTL-950)", () => {
  it("showEmptyColumns=true returns the FULL lens column set (linear)", () => {
    const defs = visibleColumnDefs([t({ id: "CTL-1", linearState: "Research" })], {
      groupBy: "linear",
      showEmptyColumns: true,
    });
    expect(defs.map((d) => d.key)).toEqual(LINEAR_COLUMNS.map((d) => d.key));
  });

  it("showEmptyColumns=true returns the FULL lens column set (phase)", () => {
    const defs = visibleColumnDefs([t({ id: "CTL-1", phase: "plan" })], {
      groupBy: "phase",
      showEmptyColumns: true,
    });
    expect(defs.map((d) => d.key)).toEqual(PHASE_COLUMNS.map((d) => d.key));
  });

  it("showEmptyColumns=false keeps only columns that ANY ticket occupies (linear)", () => {
    const defs = visibleColumnDefs(
      [
        t({ id: "CTL-1", linearState: "Research" }),
        t({ id: "CTL-2", linearState: "Done" }),
      ],
      { groupBy: "linear", showEmptyColumns: false },
    );
    expect(defs.map((d) => d.key)).toEqual(["Research", "Done"]);
  });

  it("showEmptyColumns=false over the COMBINED set — a column kept iff SOME lane fills it", () => {
    // the cross-lane union: lane A (Research) + lane B (Plan) → both columns kept,
    // even though neither lane alone fills both. This is the load-bearing reason
    // the column set is computed over every lane combined (the shared header).
    const all = [
      t({ id: "CTL-1", linearState: "Research" }),
      t({ id: "CTL-2", linearState: "Plan" }),
    ];
    const defs = visibleColumnDefs(all, { groupBy: "linear", showEmptyColumns: false });
    expect(defs.map((d) => d.key)).toEqual(["Research", "Plan"]);
  });

  it("empty ticket array with showEmptyColumns=false → no columns", () => {
    expect(visibleColumnDefs([], { groupBy: "linear", showEmptyColumns: false })).toEqual([]);
  });
});

describe("laneColumns — one lane's tickets over the FIXED shared column set (CTL-950)", () => {
  const defs = visibleColumnDefs(
    [
      t({ id: "CTL-1", linearState: "Research" }),
      t({ id: "CTL-2", linearState: "Plan" }),
    ],
    { groupBy: "linear", showEmptyColumns: false },
  );

  it("returns ONE derived column per def, in def order (aligned grid tracks)", () => {
    const cols = laneColumns([t({ id: "CTL-1", linearState: "Research" })], defs, {
      groupBy: "linear",
    });
    expect(cols.map((c) => c.key)).toEqual(defs.map((d) => d.key));
  });

  it("KEEPS empty lane cells — a lane with only Research tickets still has a (blank) Plan cell", () => {
    const cols = laneColumns([t({ id: "CTL-1", linearState: "Research" })], defs, {
      groupBy: "linear",
    });
    const research = cols.find((c) => c.key === "Research");
    const plan = cols.find((c) => c.key === "Plan");
    expect(research?.items.map((x) => x.id)).toEqual(["CTL-1"]);
    expect(plan?.items).toEqual([]); // aligned blank, not dropped
  });

  it("counts live (activeState=active) tickets per lane cell", () => {
    const cols = laneColumns(
      [
        t({ id: "CTL-1", linearState: "Research", activeState: "active" }),
        t({ id: "CTL-2", linearState: "Research", activeState: null }),
      ],
      defs,
      { groupBy: "linear" },
    );
    const research = cols.find((c) => c.key === "Research");
    expect(research?.items).toHaveLength(2);
    expect(research?.live).toBe(1);
  });

  it("two lanes share the SAME column key set in the SAME order", () => {
    const laneA = laneColumns([t({ id: "CTL-1", linearState: "Research" })], defs, {
      groupBy: "linear",
    });
    const laneB = laneColumns([t({ id: "CTL-2", linearState: "Plan" })], defs, {
      groupBy: "linear",
    });
    expect(laneA.map((c) => c.key)).toEqual(laneB.map((c) => c.key));
  });
});
