// CTL-1180: groupHoldingBuckets routes a not-in-flight needs-human ticket into
// the needs-you bucket. Previously only live waitingOnUser workers landed there.
// A reaped failed ticket (no live worker) now also surfaces under needs-you.

import { describe, it, expect } from "bun:test";
import type { BoardWorker, BoardTicket } from "../../board/types";
import { groupHoldingBuckets } from "./queue-model";

function w(
  p: Partial<BoardWorker> & { name: string; ticket: string },
): BoardWorker {
  return {
    tickets: [p.ticket],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 100,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 1000,
    costUSD: null,
    ...p,
  };
}

function t(p: Partial<BoardTicket> & { id: string }): BoardTicket {
  return {
    title: p.id,
    type: "feature",
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
    priority: 0,
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
    blockers: [],
    heldSince: null,
    currentPhaseSince: null,
    host: null,
    generation: null,
    failureReason: null,
    attention: null,
    attentionSince: null,
    ...p,
  };
}

describe("groupHoldingBuckets — needs-human not-in-flight tickets (CTL-1180)", () => {
  it("a not-in-flight needs-human ticket lands in needsYou", () => {
    const tickets = [t({ id: "CTL-1180", attention: "needs-human" })];
    const b = groupHoldingBuckets(tickets, [], 4);
    const ids = b.needsYou.items.map((i) =>
      i.kind === "ticket" ? i.ticket.id : "",
    );
    expect(ids).toContain("CTL-1180");
    expect(b.allEmpty).toBe(false);
  });

  it("a stalled ticket still lands in the stalled bucket (not needsYou)", () => {
    const tickets = [t({ id: "CTL-1", status: "stalled", attention: null })];
    const b = groupHoldingBuckets(tickets, [], 4);
    expect(b.stalled.items).toHaveLength(1);
    expect(b.needsYou.items.filter((i) => i.kind === "ticket")).toHaveLength(0);
  });

  it("an in-flight needs-human ticket is NOT double-listed in needsYou", () => {
    const tickets = [t({ id: "CTL-1", attention: "needs-human" })];
    const workers = [w({ name: "w1", ticket: "CTL-1", startedAt: 1 })];
    const b = groupHoldingBuckets(tickets, workers, 4);
    // CTL-1 is in-flight → excluded from ticket buckets
    const ticketItems = b.needsYou.items.filter((i) => i.kind === "ticket");
    expect(ticketItems).toHaveLength(0);
  });

  it("∉ queue invariant: needs-human in needsYou, stalled in stalled, blocked in blocked", () => {
    const tickets = [
      t({ id: "CTL-A", attention: "needs-human" }),
      t({ id: "CTL-B", status: "stalled" }),
      t({ id: "CTL-C", held: "blocked" }),
    ];
    const b = groupHoldingBuckets(tickets, [], 4);
    const needsYouIds = b.needsYou.items
      .filter((i) => i.kind === "ticket")
      .map((i) => (i.kind === "ticket" ? i.ticket.id : ""));
    const stalledIds = b.stalled.items.map((i) =>
      i.kind === "ticket" ? i.ticket.id : "",
    );
    const blockedIds = b.blocked.items.map((i) =>
      i.kind === "ticket" ? i.ticket.id : "",
    );
    expect(needsYouIds).toEqual(["CTL-A"]);
    expect(stalledIds).toEqual(["CTL-B"]);
    expect(blockedIds).toEqual(["CTL-C"]);
  });
});
