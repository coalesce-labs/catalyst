import { describe, test, expect } from "bun:test";
import { computeParity, verdictToExit } from "./parity-check.ts";

type WorkerStateRow = { orchestrator: string; ticket: string; status: string; phase?: string };
type CoordinationRow = Record<string, unknown>;

function ws(ticket: string, status: string): WorkerStateRow {
  return { orchestrator: ticket, ticket, status, phase: "teardown" };
}

function row(ticket: string, eventName: string): CoordinationRow {
  return {
    id: `ev-${ticket}-${eventName}`,
    local_seq: 1,
    attributes: {
      "event.name": `${eventName}.${ticket}`,
      "event.stream_class": "coordination",
    },
    body: {},
  };
}

describe("computeParity (CTL-1668 Phase 3)", () => {
  test("healthy: all pairs covered, no divergence → verdict healthy (exit 0)", () => {
    const r = computeParity({ workerStates: [ws("CTL-1", "done")], coordinationRows: [row("CTL-1", "phase.teardown.complete")] });
    expect(r.matchedPairs).toBe(1);
    expect(r.divergences).toHaveLength(0);
    expect(r.verdict).toBe("healthy");
  });

  test("could-not-evaluate: zero matched pairs → verdict inconclusive (exit 2), distinct from healthy", () => {
    expect(computeParity({ workerStates: [], coordinationRows: [] }).verdict).toBe("inconclusive");
    expect(computeParity({ workerStates: [ws("CTL-1", "done")], coordinationRows: [] }).verdict).toBe("inconclusive");
  });

  test("divergence: matched pair but conflicting terminal status → verdict divergent (exit 1)", () => {
    const r = computeParity({ workerStates: [ws("CTL-1", "done")], coordinationRows: [row("CTL-1", "phase.implement.failed")] });
    expect(r.divergences.length).toBeGreaterThan(0);
    expect(r.verdict).toBe("divergent");
  });

  test("coverage gap is reported SEPARATELY from integrity divergence", () => {
    const r = computeParity({
      workerStates: [ws("CTL-1", "done"), ws("CTL-2", "done")],
      coordinationRows: [row("CTL-1", "phase.teardown.complete")],
    });
    expect(r.coverageGaps).toContainEqual({ orchestrator: "CTL-2", ticket: "CTL-2" });
    expect(r.divergences).toHaveLength(0);
  });

  test("wire order preserved: rows consumed in input order, never sorted", () => {
    const rows = [row("CTL-3", "..."), row("CTL-1", "..."), row("CTL-2", "...")];
    const r = computeParity({ workerStates: [], coordinationRows: rows });
    expect(r.orderedTickets).toEqual(["CTL-3", "CTL-1", "CTL-2"]);
  });
});

describe("verdictToExit (CTL-1668 Phase 3)", () => {
  test("healthy → 0, divergent → 1, inconclusive → 2", () => {
    expect(verdictToExit("healthy")).toBe(0);
    expect(verdictToExit("divergent")).toBe(1);
    expect(verdictToExit("inconclusive")).toBe(2);
  });

  test("unknown verdict falls back to 2", () => {
    expect(verdictToExit("unknown" as "healthy")).toBe(2);
  });
});
