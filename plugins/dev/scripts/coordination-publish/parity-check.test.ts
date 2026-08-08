import { describe, test, expect } from "bun:test";
import { computeParity, verdictToExit } from "./parity-check.ts";

type WorkerStateRow = { orchestrator: string; ticket: string; status: string; phase?: string };
type CoordinationRow = Record<string, unknown>;

function ws(ticket: string, status: string, orchestrator: string = ticket): WorkerStateRow {
  return { orchestrator, ticket, status, phase: "teardown" };
}

function row(
  ticket: string,
  eventName: string,
  orchestrator: string = ticket,
  ts: string | null = null,
): CoordinationRow {
  return {
    id: `ev-${ticket}-${eventName}-${orchestrator}-${ts ?? "nots"}`,
    local_seq: 1,
    ts,
    attributes: {
      "event.name": `${eventName}.${ticket}`,
      "event.stream_class": "coordination",
      // Real coordination events carry the emitting orchestrator here; parity keys on it.
      "catalyst.orchestrator.id": orchestrator,
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

  test("complete is a SUCCESS terminal status: complete vs failure coordination → divergent", () => {
    // broker-state.mjs WORKER_TERMINAL_STATUSES includes "complete" as a canonical done status.
    // Skipping the comparison for it (returning null) would hide a real conflict as healthy.
    const r = computeParity({
      workerStates: [ws("CTL-1", "complete")],
      coordinationRows: [row("CTL-1", "phase.implement.failed")],
    });
    expect(r.divergences.length).toBeGreaterThan(0);
    expect(r.verdict).toBe("divergent");
  });

  test("complete matched to a success terminal coordination → healthy", () => {
    const r = computeParity({
      workerStates: [ws("CTL-1", "complete")],
      coordinationRows: [row("CTL-1", "phase.teardown.complete")],
    });
    expect(r.divergences).toHaveLength(0);
    expect(r.verdict).toBe("healthy");
  });

  test("same ticket, two orchestrators: parity keys on (orchestrator, ticket), no cross-contamination", () => {
    // orchA finished clean; orchB's run failed. Keyed by ticket alone, orchA's "done" would be
    // compared against orchB's failure terminal and diverge falsely. Composite keying isolates them.
    const r = computeParity({
      workerStates: [ws("CTL-1", "done", "orchA"), ws("CTL-1", "done", "orchB")],
      coordinationRows: [
        row("CTL-1", "phase.teardown.complete", "orchA"),
        row("CTL-1", "phase.implement.failed", "orchB"),
      ],
    });
    expect(r.matchedPairs).toBe(2);
    expect(r.divergences).toHaveLength(1);
    expect(r.divergences[0]?.orchestrator).toBe("orchB");
  });

  test("non-terminal coordination only → NOT a matched pair (inconclusive, never healthy)", () => {
    // A terminal worker row whose only coordination event is non-terminal (worker.transition)
    // has nothing comparable — the harness must not report healthy on an unevaluable stream.
    const r = computeParity({
      workerStates: [ws("CTL-1", "done")],
      coordinationRows: [row("CTL-1", "worker.transition")],
    });
    expect(r.matchedPairs).toBe(0);
    expect(r.divergences).toHaveLength(0);
    expect(r.verdict).toBe("inconclusive");
  });

  test("non-terminal worker status → NOT a matched pair even with a terminal coordination event", () => {
    const r = computeParity({
      workerStates: [ws("CTL-1", "dispatched")],
      coordinationRows: [row("CTL-1", "phase.teardown.complete")],
    });
    expect(r.matchedPairs).toBe(0);
    expect(r.verdict).toBe("inconclusive");
  });

  test("terminal selection follows the projection watermark, not input order (out-of-order ts)", () => {
    // The newer FAILURE is appended BEFORE the delayed older success. Input-order-last would pick
    // the success (false match against ws done); watermark ordering picks the newer failure.
    const r = computeParity({
      workerStates: [ws("CTL-1", "done")],
      coordinationRows: [
        row("CTL-1", "phase.implement.failed", "CTL-1", "2026-08-08T00:00:02Z"),
        row("CTL-1", "phase.teardown.complete", "CTL-1", "2026-08-08T00:00:01Z"),
      ],
    });
    expect(r.matchedPairs).toBe(1);
    expect(r.divergences).toHaveLength(1);
    expect(r.verdict).toBe("divergent");
  });

  test("exact-ts tie → later-processed terminal event wins (matches projection >=)", () => {
    const sameTs = "2026-08-08T00:00:05Z";
    const r = computeParity({
      workerStates: [ws("CTL-1", "done")],
      coordinationRows: [
        row("CTL-1", "phase.teardown.complete", "CTL-1", sameTs),
        row("CTL-1", "phase.implement.failed", "CTL-1", sameTs), // processed last on tie → wins
      ],
    });
    expect(r.divergences).toHaveLength(1);
    expect(r.verdict).toBe("divergent");
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
