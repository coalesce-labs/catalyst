// queue-model.test.ts — units for the CTL-1015 control-tower pure helpers
// (ordinal / assignSlots / groupHoldingBuckets / deadWorkers). Pure logic, no DOM
// — run from the ui package:  cd ui && bun test src/components/queue/queue-model.test.ts
import { describe, it, expect } from "bun:test";
import type { BoardWorker, BoardTicket } from "../../board/types";
import {
  ordinal,
  assignSlots,
  groupHoldingBuckets,
  holdingTicketIds,
  deadWorkers,
} from "./queue-model";

function w(p: Partial<BoardWorker> & { name: string; ticket: string }): BoardWorker {
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
    phase: "triage",
    status: "queued",
    model: null,
    linearState: "Todo",
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
    updatedAt: "2026-06-11T00:00:00Z",
    held: null,
    blockers: [],
    heldSince: null,
    currentPhaseSince: null,
    host: null,
    generation: null,
    ...p,
  };
}

describe("ordinal", () => {
  it("basic suffixes", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(10)).toBe("10th");
  });
  it("11–13 are always 'th' (teen exception)", () => {
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
  });
  it("21/22/23 follow the last-digit rule", () => {
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(101)).toBe("101st");
  });
});

describe("assignSlots", () => {
  it("orders by startedAt asc (oldest first), then name", () => {
    const a = assignSlots(
      [
        w({ name: "z", ticket: "A", startedAt: 300 }),
        w({ name: "a", ticket: "B", startedAt: 100 }),
        w({ name: "m", ticket: "C", startedAt: 200 }),
      ],
      4,
    );
    expect(a.occupied.map((x) => x.name)).toEqual(["a", "m", "z"]);
    expect(a.emptyCount).toBe(1);
    expect(a.overCapacity).toEqual([]);
  });
  it("is STABLE: equal startedAt tie-broken by name", () => {
    const a = assignSlots(
      [
        w({ name: "beta", ticket: "A", startedAt: 100 }),
        w({ name: "alpha", ticket: "B", startedAt: 100 }),
      ],
      4,
    );
    expect(a.occupied.map((x) => x.name)).toEqual(["alpha", "beta"]);
  });
  it("excludes dead workers (they hold no slot)", () => {
    const a = assignSlots(
      [
        w({ name: "live", ticket: "A", startedAt: 100 }),
        w({ name: "corpse", ticket: "B", startedAt: 50, activeState: "dead" }),
      ],
      3,
    );
    expect(a.occupied.map((x) => x.name)).toEqual(["live"]);
    expect(a.emptyCount).toBe(2);
  });
  it("over-capacity workers land in overCapacity, no empty slots", () => {
    const a = assignSlots(
      [
        w({ name: "w1", ticket: "A", startedAt: 1 }),
        w({ name: "w2", ticket: "B", startedAt: 2 }),
        w({ name: "w3", ticket: "C", startedAt: 3 }),
      ],
      2,
    );
    expect(a.occupied.map((x) => x.name)).toEqual(["w1", "w2"]);
    expect(a.overCapacity.map((x) => x.name)).toEqual(["w3"]);
    expect(a.emptyCount).toBe(0);
  });
  it("empty fleet → all slots empty", () => {
    const a = assignSlots([], 5);
    expect(a.occupied).toEqual([]);
    expect(a.emptyCount).toBe(5);
  });
});

describe("groupHoldingBuckets", () => {
  it("needs-you = waitingOnUser live workers, carrying their deck slot number", () => {
    const workers = [
      w({ name: "w1", ticket: "A", startedAt: 1 }),
      w({ name: "w2", ticket: "B", startedAt: 2, waitingOnUser: true }),
    ];
    const b = groupHoldingBuckets([], workers, 4);
    expect(b.needsYou.items).toHaveLength(1);
    const it0 = b.needsYou.items[0];
    expect(it0.kind).toBe("worker");
    if (it0.kind === "worker") expect(it0.slot).toBe(2); // w2 is the 2nd slot
  });
  it("blocked / waiting buckets = held tickets NOT in flight", () => {
    const tickets = [
      t({ id: "CTL-1", held: "blocked", blockers: ["CTL-9"] }),
      t({ id: "CTL-2", held: "waiting" }),
      t({ id: "CTL-3", held: null }),
    ];
    const b = groupHoldingBuckets(tickets, [], 4);
    expect(b.blocked.items.map((i) => (i.kind === "ticket" ? i.ticket.id : ""))).toEqual(["CTL-1"]);
    expect(b.waiting.items.map((i) => (i.kind === "ticket" ? i.ticket.id : ""))).toEqual(["CTL-2"]);
    expect(b.allEmpty).toBe(false);
  });
  it("a held ticket held by a LIVE worker is excluded (not double-listed)", () => {
    const tickets = [t({ id: "CTL-1", held: "blocked" })];
    const workers = [w({ name: "w1", ticket: "CTL-1", startedAt: 1 })];
    const b = groupHoldingBuckets(tickets, workers, 4);
    expect(b.blocked.items).toHaveLength(0);
  });
  it("allEmpty true when nothing is blocked/waiting/needs-you", () => {
    const b = groupHoldingBuckets([t({ id: "CTL-1" })], [w({ name: "w", ticket: "X", startedAt: 1 })], 4);
    expect(b.allEmpty).toBe(true);
  });
  it("INVARIANT: bucket ticket ids never overlap the dispatch queue", () => {
    // The eligible projection already excludes blocked/waiting tickets from the
    // queue; this asserts the buckets we surface are disjoint from a queue.
    const tickets = [
      t({ id: "CTL-1", held: "blocked" }),
      t({ id: "CTL-2", held: "waiting" }),
    ];
    const queueIds = new Set(["CTL-10", "CTL-11"]); // eligible, none held
    const b = groupHoldingBuckets(tickets, [], 4);
    for (const id of holdingTicketIds(b)) expect(queueIds.has(id)).toBe(false);
  });
});

describe("deadWorkers", () => {
  it("filters to dead, oldest first", () => {
    const d = deadWorkers([
      w({ name: "live", ticket: "A", activeState: "active", startedAt: 5 }),
      w({ name: "dead2", ticket: "B", activeState: "dead", startedAt: 30 }),
      w({ name: "dead1", ticket: "C", activeState: "dead", startedAt: 10 }),
    ]);
    expect(d.map((x) => x.name)).toEqual(["dead1", "dead2"]);
  });
});
