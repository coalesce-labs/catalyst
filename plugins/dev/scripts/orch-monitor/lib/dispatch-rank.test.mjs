// dispatch-rank.test.mjs — units for the canonical dispatch-order comparator
// (CTL-1015) + a PARITY test that locks it to execution-core/scheduler-rank.mjs.
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/dispatch-rank.test.mjs

import { describe, it, expect } from "bun:test";
import {
  compareDispatchOrder,
  rankDispatchOrder,
  PRIORITY_RANK,
} from "./dispatch-rank.mjs";
import { compareTickets } from "../../execution-core/scheduler-rank.mjs";

describe("PRIORITY_RANK", () => {
  it("maps 1..4 to themselves", () => {
    expect(PRIORITY_RANK(1)).toBe(1);
    expect(PRIORITY_RANK(4)).toBe(4);
  });
  it("maps 0 / absent / out-of-range to 5 (below Low)", () => {
    expect(PRIORITY_RANK(0)).toBe(5);
    expect(PRIORITY_RANK(undefined)).toBe(5);
    expect(PRIORITY_RANK(null)).toBe(5);
    expect(PRIORITY_RANK(9)).toBe(5);
  });
});

describe("compareDispatchOrder — axis by axis", () => {
  it("priority ascending: urgent(1) before low(4) before none(0)", () => {
    expect(compareDispatchOrder({ priority: 1 }, { priority: 4 })).toBeLessThan(0);
    expect(compareDispatchOrder({ priority: 4 }, { priority: 0 })).toBeLessThan(0);
    expect(compareDispatchOrder({ priority: 0 }, { priority: 1 })).toBeGreaterThan(0);
  });

  it("stage descending within equal priority (later phase first)", () => {
    const a = { priority: 2, stage: 5 };
    const b = { priority: 2, stage: 1 };
    expect(compareDispatchOrder(a, b)).toBeLessThan(0); // higher stage sorts first
  });

  it("absent stage ties at -1 → falls through to createdAt", () => {
    const a = { priority: 2, createdAt: "2026-01-01T00:00:00Z" };
    const b = { priority: 2, createdAt: "2026-02-01T00:00:00Z" };
    expect(compareDispatchOrder(a, b)).toBeLessThan(0); // earlier createdAt first
  });

  it("createdAt ascending (FIFO) within equal priority+stage", () => {
    const a = { priority: 3, createdAt: "2026-01-01T00:00:00Z" };
    const b = { priority: 3, createdAt: "2026-06-01T00:00:00Z" };
    expect(compareDispatchOrder(a, b)).toBeLessThan(0);
  });

  it("absent createdAt sorts LAST within its band", () => {
    const known = { priority: 2, createdAt: "2026-01-01T00:00:00Z", id: "A" };
    const missing = { priority: 2, createdAt: "", id: "B" };
    expect(compareDispatchOrder(known, missing)).toBeLessThan(0);
    expect(compareDispatchOrder(missing, known)).toBeGreaterThan(0);
  });

  it("identifier ascending as the final tie-break (id or identifier)", () => {
    const a = { priority: 2, createdAt: "2026-01-01T00:00:00Z", id: "CTL-100" };
    const b = { priority: 2, createdAt: "2026-01-01T00:00:00Z", id: "CTL-200" };
    expect(compareDispatchOrder(a, b)).toBeLessThan(0);
    const c = { priority: 2, identifier: "CTL-100" };
    const d = { priority: 2, identifier: "CTL-200" };
    expect(compareDispatchOrder(c, d)).toBeLessThan(0);
  });
});

describe("rankDispatchOrder", () => {
  it("does not mutate the input and returns a sorted copy", () => {
    const input = [
      { id: "C", priority: 4, createdAt: "2026-01-01T00:00:00Z" },
      { id: "A", priority: 1, createdAt: "2026-03-01T00:00:00Z" },
      { id: "B", priority: 2, createdAt: "2026-02-01T00:00:00Z" },
    ];
    const snapshot = JSON.stringify(input);
    const out = rankDispatchOrder(input);
    expect(out.map((x) => x.id)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(input)).toBe(snapshot); // untouched
  });
  it("tolerates null / undefined input", () => {
    expect(rankDispatchOrder(null)).toEqual([]);
    expect(rankDispatchOrder(undefined)).toEqual([]);
  });
});

describe("PARITY with execution-core/scheduler-rank.mjs compareTickets", () => {
  // A shared fixture exercising every axis + absent-field case. Both comparators
  // read `identifier` (scheduler) — dispatch-rank falls back id→identifier, so we
  // give every item BOTH so the tie-break key is identical across the two.
  const fixture = [
    { identifier: "CTL-9", id: "CTL-9", priority: 0, createdAt: "2026-01-01T00:00:00Z" },
    { identifier: "CTL-1", id: "CTL-1", priority: 1, createdAt: "2026-05-01T00:00:00Z", stage: 2 },
    { identifier: "CTL-2", id: "CTL-2", priority: 1, createdAt: "2026-05-01T00:00:00Z", stage: 7 },
    { identifier: "CTL-3", id: "CTL-3", priority: 2, createdAt: "2026-02-01T00:00:00Z" },
    { identifier: "CTL-4", id: "CTL-4", priority: 2, createdAt: "2026-02-01T00:00:00Z" },
    { identifier: "CTL-5", id: "CTL-5", priority: 2, createdAt: "", stage: 3 },
    { identifier: "CTL-6", id: "CTL-6", priority: 4, createdAt: "2026-03-01T00:00:00Z" },
    { identifier: "CTL-7", id: "CTL-7", priority: undefined, createdAt: "2026-04-01T00:00:00Z" },
    { identifier: "CTL-8", id: "CTL-8", priority: 3, createdAt: "2026-01-15T00:00:00Z", stage: 0 },
  ];

  it("produces an identical sort order over the shared fixture", () => {
    const viaDispatch = [...fixture].sort(compareDispatchOrder).map((x) => x.identifier);
    const viaScheduler = [...fixture].sort(compareTickets).map((x) => x.identifier);
    expect(viaDispatch).toEqual(viaScheduler);
  });

  it("agrees pairwise on the sign of every comparison", () => {
    for (const a of fixture) {
      for (const b of fixture) {
        expect(Math.sign(compareDispatchOrder(a, b))).toBe(Math.sign(compareTickets(a, b)));
      }
    }
  });
});
