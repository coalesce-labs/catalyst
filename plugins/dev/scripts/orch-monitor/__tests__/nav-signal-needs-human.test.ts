// CTL-1180: nav-signal anomaly dot lights when a ticket has attention:"needs-human"
// even when there is no held-blocked hold and no stuck worker. Previously only
// `held:"blocked"` and `stuck > 0` lit the dot.

import { describe, it, expect } from "bun:test";
import { deriveNavSignal } from "../lib/nav-signal.mjs";
import type { BoardPayload, BoardTicket } from "../lib/board-data.mjs";

function ticket(id: string, overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: id,
    type: "task",
    repo: "catalyst",
    team: "CTL",
    phase: "pr",
    status: "failed",
    model: null,
    linearState: "PR",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 2,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-15T00:00:00Z",
    held: null,
    heldSince: null,
    currentPhaseSince: null,
    blockers: [],
    attention: null,
    attentionSince: null,
    host: null,
    generation: null,
    failureReason: null,
    ...overrides,
  };
}

function board(overrides: Partial<BoardPayload> = {}): BoardPayload {
  return {
    generatedAt: "2026-06-15T00:00:00Z",
    config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [],
    queue: [],
    ...overrides,
  };
}

describe("nav-signal anomaly — needs-human tickets (CTL-1180)", () => {
  it("a needs-human ticket with no hold and no stuck worker → anomaly:true", () => {
    const sig = deriveNavSignal(
      board({ tickets: [ticket("CTL-1180", { attention: "needs-human", held: null })] }),
    );
    expect(sig.anomaly).toBe(true);
  });

  it("a needs-human ticket lights the dot regardless of held status", () => {
    // Even a ticket not blocked should light the dot if it needs a human
    const sig = deriveNavSignal(
      board({ tickets: [ticket("CTL-1", { attention: "needs-human", held: null })] }),
    );
    expect(sig.anomaly).toBe(true);
  });

  it("no needs-human + no blocked + stuck:0 → anomaly:false (no false positive)", () => {
    const sig = deriveNavSignal(
      board({
        tickets: [ticket("CTL-1", { attention: null, held: null })],
        config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
      }),
    );
    expect(sig.anomaly).toBe(false);
  });

  it("attention:waiting-on-you does NOT light the anomaly dot (only needs-human does)", () => {
    const sig = deriveNavSignal(
      board({
        tickets: [ticket("CTL-1", { attention: "waiting-on-you", held: null })],
        config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
      }),
    );
    // waiting-on-you is already tracked by the worker badge, not the anomaly dot
    // This test documents the design decision: anomaly is for ESCALATIONS, not worker blocks
    expect(sig.anomaly).toBe(false);
  });
});
