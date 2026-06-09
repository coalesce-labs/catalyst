// list-order.test.ts — units for the P1 keystone correctness item (CTL-882 /
// FND2): the SINGLE ordering source shared by the board, the detail-page pager
// (`N / total`), and the j/k walk. These encode the FND2 Gherkin acceptance
// scenarios against the PURE module ui/src/board/list-order.ts — no React /
// jotai / router needed (same pattern as route-search.test.ts / board-client
// .test.ts, which unit the pure ui/src/board helpers directly).
//
// The whole point of the extraction is that the board renders through
// `resolveList` and the shell walks through `resolveList`, so the on-screen card
// order can never silently drift from the pager/j-k order. The "byte-for-byte
// identical to today's order" scenarios below lock that in by reproducing the
// two prior inline orderings (Board.tsx:362 ticket filter, Board.tsx:441-442
// worker rank-sort) and asserting `resolveList` matches them exactly.
import { describe, it, expect } from "bun:test";
import {
  resolveList,
  resolveListIds,
  filterTickets,
  sortWorkers,
  rankWorker,
} from "../ui/src/board/list-order";
import type {
  BoardPayload,
  BoardTicket,
  BoardWorker,
  BoardActiveState,
} from "../ui/src/board/types";

// ── minimal fixtures (only the fields the orderings read) ───────────────────
function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: id,
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
    updatedAt: "",
    ...over,
  };
}

function mkWorker(
  name: string,
  activeState: BoardActiveState,
  runtimeMs: number | null,
  over: Partial<BoardWorker> = {},
): BoardWorker {
  return {
    name,
    ticket: name,
    tickets: [name],
    phase: "implement",
    status: "working",
    activeState,
    working: activeState === "active",
    lastActiveMs: null,
    repo: "catalyst",
    team: "CTL",
    runtimeMs,
    costUSD: null,
    ...over,
  };
}

function mkPayload(over: Partial<BoardPayload> = {}): BoardPayload {
  return {
    generatedAt: "",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: [],
    workers: [],
    tickets: [],
    queue: [],
    ...over,
  };
}

// The literal prior inline orderings, kept verbatim so the tests assert against
// the OLD behaviour rather than re-implementing the new one.
function legacyTicketFilter(
  tickets: BoardTicket[],
  lens: "linear" | "phase",
  col: string,
): BoardTicket[] {
  return lens === "linear"
    ? tickets.filter((t) => t.linearState === col)
    : tickets.filter((t) => t.phase === col);
}
function legacyWorkerSort(workers: BoardWorker[]): BoardWorker[] {
  const isActive = (s: BoardActiveState) => s === "active";
  const rank = (w: BoardWorker) => (isActive(w.activeState) ? 0 : w.activeState === "stuck" ? 2 : 1);
  return [...workers].sort((a, b) => rank(a) - rank(b) || (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0));
}

describe("resolveList — ticket columns (the board renders through resolveList)", () => {
  // Gherkin: "The board renders through resolveList" — TicketBoard builds a
  // Linear column for col="Implement" by calling
  // resolveList(payload, {kind:"ticket", lens:"linear", col:"Implement"}); the
  // rendered card order is byte-for-byte identical to today's (filter on
  // linearState, payload array order preserved).
  const tickets = [
    mkTicket("CTL-845", { linearState: "Implement", phase: "implement" }),
    mkTicket("CTL-831", { linearState: "PR", phase: "pr" }),
    mkTicket("CTL-877", { linearState: "Implement", phase: "verify" }),
    mkTicket("CTL-878", { linearState: "Research", phase: "research" }),
    mkTicket("CTL-880", { linearState: "Implement", phase: "implement" }),
  ];
  const payload = mkPayload({ tickets });

  it("filters a Linear column on linearState, payload array order preserved", () => {
    const got = resolveList(payload, { kind: "ticket", lens: "linear", col: "Implement" });
    expect(got.map((t) => (t as BoardTicket).id)).toEqual(["CTL-845", "CTL-877", "CTL-880"]);
  });

  it("is byte-for-byte identical to the prior inline linear filter (Board.tsx:362)", () => {
    const got = resolveList(payload, { kind: "ticket", lens: "linear", col: "Implement" });
    expect(got).toEqual(legacyTicketFilter(tickets, "linear", "Implement"));
  });

  it("filters a phase column on phase when lens === 'phase'", () => {
    const got = resolveList(payload, { kind: "ticket", lens: "phase", col: "implement" });
    expect(got.map((t) => (t as BoardTicket).id)).toEqual(["CTL-845", "CTL-880"]);
    expect(got).toEqual(legacyTicketFilter(tickets, "phase", "implement"));
  });

  it("defaults to the linear lens when lens is omitted", () => {
    const got = resolveList(payload, { kind: "ticket", col: "Implement" });
    expect(got).toEqual(legacyTicketFilter(tickets, "linear", "Implement"));
  });

  it("resolves an empty list (never throws) for a cold-link with no column", () => {
    expect(resolveList(payload, { kind: "ticket", lens: "linear", col: undefined })).toEqual([]);
    expect(filterTickets(tickets, "linear", undefined)).toEqual([]);
  });

  it("does not mutate the payload's ticket array", () => {
    const snapshot = tickets.map((t) => t.id);
    resolveList(payload, { kind: "ticket", lens: "linear", col: "Implement" });
    expect(tickets.map((t) => t.id)).toEqual(snapshot);
  });
});

describe("resolveList — worker queue (rank-sort preserved through the same fn)", () => {
  // Gherkin: "Worker rank-sort is preserved through the same function" — when
  // resolveList is called with {kind:"worker"} it returns workers ordered by
  // rank(active=0, stuck=2, else=1) then runtimeMs descending, matching the
  // existing inline sort at Board.tsx:441-442.
  const workers = [
    mkWorker("w-stuck", "stuck", 5000),
    mkWorker("w-active-short", "active", 1000),
    mkWorker("w-idle", null, 9000),
    mkWorker("w-active-long", "active", 8000),
    mkWorker("w-stuck-long", "stuck", 9999),
  ];
  const payload = mkPayload({ workers });

  it("orders by rank then runtimeMs desc", () => {
    const got = resolveList(payload, { kind: "worker" }) as BoardWorker[];
    expect(got.map((w) => w.name)).toEqual([
      "w-active-long", // active, 8000
      "w-active-short", // active, 1000
      "w-idle", // else, 9000
      "w-stuck-long", // stuck, 9999
      "w-stuck", // stuck, 5000
    ]);
  });

  it("is byte-for-byte identical to the prior inline sort (Board.tsx:441-442)", () => {
    const got = resolveList(payload, { kind: "worker" });
    expect(got).toEqual(legacyWorkerSort(workers));
  });

  it("rankWorker matches active=0 / stuck=2 / else=1", () => {
    expect(rankWorker(mkWorker("a", "active", 0))).toBe(0);
    expect(rankWorker(mkWorker("b", null, 0))).toBe(1);
    expect(rankWorker(mkWorker("c", "stuck", 0))).toBe(2);
  });

  it("treats a null runtimeMs as 0 in the tie-break", () => {
    const ws = [mkWorker("nullrt", "active", null), mkWorker("hasrt", "active", 10)];
    expect(sortWorkers(ws).map((w) => w.name)).toEqual(["hasrt", "nullrt"]);
  });

  it("does not mutate the payload's worker array", () => {
    const snapshot = workers.map((w) => w.name);
    sortWorkers(workers);
    expect(workers.map((w) => w.name)).toEqual(snapshot);
  });
});

describe("resolveListIds — the id list the pager + j/k bind to", () => {
  // Gherkin: "The pager and the board agree (the correctness contract)" — the
  // shell resolves the list via resolveList with the SAME ctx, so indexOf($id)+1
  // and the list length equal what the operator counted on the board.
  it("ticket ids equal the resolved column's ids, in order", () => {
    const tickets = [
      mkTicket("CTL-845", { linearState: "Implement" }),
      mkTicket("CTL-877", { linearState: "Implement" }),
      mkTicket("CTL-880", { linearState: "Implement" }),
    ];
    const payload = mkPayload({ tickets });
    const ctx = { kind: "ticket" as const, lens: "linear" as const, col: "Implement" };
    const ids = resolveListIds(payload, ctx);
    expect(ids).toEqual(["CTL-845", "CTL-877", "CTL-880"]);
    // The correctness contract: indexOf+1 / length the operator counted.
    expect(ids.indexOf("CTL-877") + 1).toBe(2);
    expect(ids.length).toBe(3);
    // And the ids are exactly resolveList(...).map(id) — one source.
    const list = resolveList(payload, ctx) as BoardTicket[];
    expect(list.map((t) => t.id)).toEqual(ids);
  });

  it("worker ids are BoardWorker.name in the rank-sorted order", () => {
    const workers = [
      mkWorker("w-stuck", "stuck", 1),
      mkWorker("w-active", "active", 1),
    ];
    const payload = mkPayload({ workers });
    const ids = resolveListIds(payload, { kind: "worker" });
    expect(ids).toEqual(["w-active", "w-stuck"]);
  });
});
