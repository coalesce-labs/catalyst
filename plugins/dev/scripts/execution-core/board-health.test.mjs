// board-health.test.mjs — CTL-1290. Validates the board-health delegate module.
//
// Run: cd plugins/dev/scripts/execution-core && bun test board-health.test.mjs
//
// The module is split pure-core / injected-IO precisely so the invariants and
// the cheap-gate funnel are unit-testable WITHOUT a daemon, a DB, or wall-clock.
// These tests hand-build boardState snapshots (pure) and stub every IO dep
// (impure) — the load-bearing safety property (shadow takes zero mutating
// action) is asserted by passing `act: () => { throw }` and proving no throw.

import { describe, test, expect } from "bun:test";
import {
  assembleBoardState,
  evaluateInvariants,
  decideBoardHealth,
  proposeMoves,
  buildBoardContext,
  buildBoardScanEvent,
  boardHealthPass,
} from "./board-health.mjs";

const NOW = Date.parse("2026-06-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;

// A complete, default-healthy boardState shape (the frozen output assembleBoardState
// produces). Overrides are shallow-merged per top-level key.
function mkBoard(o = {}) {
  return {
    ticketsById: o.ticketsById ?? new Map(),
    signals: o.signals ?? [],
    eligible: o.eligible ?? [],
    roster: o.roster ?? [],
    self: o.self ?? "mini",
    multiHost: o.multiHost ?? false,
    capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4, ...(o.capacity ?? {}) },
    reconcileMarkers: o.reconcileMarkers ?? {},
    ring: {
      recentDispatchTs: null,
      cacheReconcile: null,
      accountRatelimit: null,
      reconcileFailing: new Set(),
      ...(o.ring ?? {}),
    },
    ownerForTicket: o.ownerForTicket ?? null,
    now: o.now ?? NOW,
  };
}

// ─── evaluateInvariants — one green + one failing per invariant ──────────────
describe("evaluateInvariants — per-invariant green/fail", () => {
  test("cacheCoherence: reconcile changed>0 → fail; changed=0 → ok; unseen → not observable", () => {
    const failed = evaluateInvariants(mkBoard({ ring: { cacheReconcile: { changed: 3 } } }));
    expect(failed.cacheCoherence.ok).toBe(false);
    expect(failed.cacheCoherence.failed).toBe(1);
    expect(failed.cacheCoherence.observable).toBe(true);

    const green = evaluateInvariants(mkBoard({ ring: { cacheReconcile: { changed: 0 } } }));
    expect(green.cacheCoherence.ok).toBe(true);
    expect(green.cacheCoherence.failed).toBe(0);

    const unseen = evaluateInvariants(mkBoard({ ring: { cacheReconcile: null } }));
    expect(unseen.cacheCoherence.observable).toBe(false);
  });

  test("dispatchLiveness: free slots + queue + stale dispatch → wedge; live dispatch → ok", () => {
    const wedged = evaluateInvariants(
      mkBoard({
        capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
        eligible: [{ id: "CTL-1" }, { id: "CTL-2" }],
        ring: { recentDispatchTs: NOW - 30 * MIN }, // > 10min default stall
      }),
    );
    expect(wedged.dispatchLiveness.ok).toBe(false);
    expect(wedged.dispatchLiveness.failed).toBe(1);
    expect(wedged.dispatchLiveness.flagged).toContain("CTL-1");

    const live = evaluateInvariants(
      mkBoard({
        eligible: [{ id: "CTL-1" }],
        capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
        ring: { recentDispatchTs: NOW - 1 * MIN }, // recent
      }),
    );
    expect(live.dispatchLiveness.ok).toBe(true);
  });

  test("dispatchLiveness: no free slots OR empty queue → no wedge (ok)", () => {
    const noSlots = evaluateInvariants(
      mkBoard({ capacity: { freeSlots: 0 }, eligible: [{ id: "CTL-1" }], ring: { recentDispatchTs: null } }),
    );
    expect(noSlots.dispatchLiveness.ok).toBe(true);
    const noQueue = evaluateInvariants(
      mkBoard({ capacity: { freeSlots: 4 }, eligible: [], ring: { recentDispatchTs: null } }),
    );
    expect(noQueue.dispatchLiveness.ok).toBe(true);
  });

  test("workerAge: non-terminal worker past phase-normal age flags; within-age + terminal do not", () => {
    const r = evaluateInvariants(
      mkBoard({
        signals: [
          { ticket: "CTL-OLD", phase: "implement", status: "running", ageMs: 5 * HOUR }, // > 4h impl normal
          { ticket: "CTL-YOUNG", phase: "implement", status: "running", ageMs: 1 * HOUR },
          { ticket: "CTL-DONE", phase: "implement", status: "complete", ageMs: 99 * HOUR }, // terminal → skip
        ],
      }),
    );
    expect(r.workerAge.ok).toBe(false);
    expect(r.workerAge.failed).toBe(1);
    expect(r.workerAge.flagged).toEqual(["CTL-OLD"]);
  });

  test("workerAge: research phase has a tighter (1h) normal than the 4h default", () => {
    const r = evaluateInvariants(
      mkBoard({ signals: [{ ticket: "CTL-R", phase: "research", status: "running", ageMs: 2 * HOUR }] }),
    );
    expect(r.workerAge.flagged).toEqual(["CTL-R"]);
  });

  test("blockedTree: blocked by an unscheduled non-done blocker → flag; done/scheduled blocker → ok", () => {
    const ticketsById = new Map([
      ["CTL-A", { identifier: "CTL-A", relations: [{ type: "blocked_by", identifier: "CTL-B" }] }],
      ["CTL-B", { identifier: "CTL-B", state: "In Progress" }],
    ]);
    const flagged = evaluateInvariants(mkBoard({ ticketsById }));
    expect(flagged.blockedTree.ok).toBe(false);
    expect(flagged.blockedTree.flagged).toEqual(["CTL-A"]);

    const doneById = new Map([
      ["CTL-A", { identifier: "CTL-A", relations: [{ type: "blocked_by", identifier: "CTL-B" }] }],
      ["CTL-B", { identifier: "CTL-B", state: "Done" }],
    ]);
    expect(evaluateInvariants(mkBoard({ ticketsById: doneById })).blockedTree.ok).toBe(true);

    // blocker present in the eligible queue → scheduled → not a dead chain
    const scheduled = evaluateInvariants(
      mkBoard({ ticketsById, eligible: [{ id: "CTL-B" }] }),
    );
    expect(scheduled.blockedTree.ok).toBe(true);
  });

  test("projectSilence: project quiet past threshold flags; recent movement ok; no join → not observable", () => {
    const silent = evaluateInvariants(
      mkBoard({ eligible: [{ id: "CTL-A", project: "P1", updatedAt: new Date(NOW - 25 * HOUR).toISOString() }] }),
    );
    expect(silent.projectSilence.ok).toBe(false);
    expect(silent.projectSilence.flagged).toEqual(["P1"]);

    const moving = evaluateInvariants(
      mkBoard({ eligible: [{ id: "CTL-A", project: "P1", updatedAt: new Date(NOW - 1 * HOUR).toISOString() }] }),
    );
    expect(moving.projectSilence.ok).toBe(true);

    const noJoin = evaluateInvariants(mkBoard({ eligible: [{ id: "CTL-A" }] }));
    expect(noJoin.projectSilence.observable).toBe(false);
  });

  test("rateLimitHeadroom: near-cliff flags (observable); absent signal → not observable", () => {
    const near = evaluateInvariants(mkBoard({ ring: { accountRatelimit: { nearCliff: true } } }));
    expect(near.rateLimitHeadroom.ok).toBe(false);
    expect(near.rateLimitHeadroom.failed).toBe(1);
    expect(near.rateLimitHeadroom.observable).toBe(true);

    const absent = evaluateInvariants(mkBoard({ ring: { accountRatelimit: null } }));
    expect(absent.rateLimitHeadroom.observable).toBe(false);
  });

  test("strandedNode: rostered host owns work + reconcile failing → flag (observable)", () => {
    const ticketsById = new Map([["CTL-A", { identifier: "CTL-A" }]]);
    const ownerForTicket = () => "mini-2";
    const r = evaluateInvariants(
      mkBoard({
        ticketsById,
        roster: ["mini", "mini-2"],
        ownerForTicket,
        reconcileMarkers: { "mini-2": { consecutiveFailures: 3 } },
      }),
    );
    expect(r.strandedNode.ok).toBe(false);
    expect(r.strandedNode.observable).toBe(true);
    expect(r.strandedNode.flagged).toEqual(["mini-2"]);
  });

  test("strandedNode: no HRW owner fn OR no reconcile signal → not observable", () => {
    const noHrw = evaluateInvariants(mkBoard({ roster: ["mini", "mini-2"], ownerForTicket: null }));
    expect(noHrw.strandedNode.observable).toBe(false);

    const ticketsById = new Map([["CTL-A", { identifier: "CTL-A" }]]);
    const noSignal = evaluateInvariants(
      mkBoard({ ticketsById, roster: ["mini", "mini-2"], ownerForTicket: () => "mini-2", reconcileMarkers: {} }),
    );
    expect(noSignal.strandedNode.observable).toBe(false);
  });

  test("a throwing invariant fails OPEN ({ok:true,error}) and never aborts the scan", () => {
    // ticketsById that throws when iterated (blockedTree walks it).
    const boom = {
      get size() { return 1; },
      [Symbol.iterator]() { throw new Error("boom"); },
    };
    const r = evaluateInvariants(mkBoard({ ticketsById: boom }));
    expect(r.blockedTree.ok).toBe(true);
    expect(r.blockedTree.error).toBeDefined();
    // the rest of the scan still completed
    expect(r.dispatchLiveness).toBeDefined();
    expect(r.workerAge).toBeDefined();
  });
});

// ─── decideBoardHealth — the cheap-gate funnel (§6) ─────────────────────────
function inv(ok, failed = 0, observable = true, flagged = []) {
  return { ok, failed, observable, flagged, note: "" };
}
function allGreen() {
  return {
    cacheCoherence: inv(true),
    dispatchLiveness: inv(true),
    workerAge: inv(true),
    blockedTree: inv(true),
    projectSilence: inv(true),
    rateLimitHeadroom: inv(true),
    strandedNode: inv(true),
  };
}

describe("decideBoardHealth — ordered gates, first match wins", () => {
  test("Gate 1: all observable green → skip/all-green, proposed all 0", () => {
    const d = decideBoardHealth(allGreen(), mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("all-green");
    expect(d.proposed).toEqual({ tier1: 0, tier2: 0, tier3: 0 });
    expect(d.invariantsFailed).toBe(0);
  });

  test("Gate 2: failures but freeSlots===0 → skip/no-free-slots", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 0 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("no-free-slots");
  });

  test("Gate 3: failures + free slots + rate-limit cliff → skip/rate-limit-cliff", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1), rateLimitHeadroom: inv(false, 1) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("rate-limit-cliff");
  });

  test("Gate 4: real observable failures + headroom → proceed + tiered proposals", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("proceed");
    expect(d.gate.reason).toMatch(/invariant\(s\) flagged/);
    expect(d.invariantsFailed).toBe(1);
    expect(d.proposed.tier1).toBe(1); // dispatch wedge → kick-dispatch
  });

  test("every return carries a non-empty gate.reason", () => {
    for (const board of [mkBoard({ capacity: { freeSlots: 4 } }), mkBoard({ capacity: { freeSlots: 0 } })]) {
      const d = decideBoardHealth({ ...allGreen(), dispatchLiveness: inv(false, 1) }, board);
      expect(typeof d.gate.reason).toBe("string");
      expect(d.gate.reason.length).toBeGreaterThan(0);
    }
  });

  test("observable:false failure is EXCLUDED from invariantsFailed and never triggers proceed", () => {
    const invs = { ...allGreen(), rateLimitHeadroom: inv(false, 1, /*observable*/ false) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.gate.decision).toBe("skip");
    expect(d.gate.reason).toBe("all-green");
    expect(d.invariantsFailed).toBe(0);
  });
});

// ─── proposeMoves — failed invariants → correct tier buckets ────────────────
describe("proposeMoves — tiering", () => {
  test("dispatch wedge → tier1 kick-dispatch; worker-age → tier1 nudge per ticket", () => {
    const invs = {
      ...allGreen(),
      dispatchLiveness: inv(false, 1),
      workerAge: inv(false, 2, true, ["CTL-1", "CTL-2"]),
    };
    const m = proposeMoves(invs, mkBoard());
    expect(m.tier1.some((x) => x.move === "kick-dispatch")).toBe(true);
    expect(m.tier1.filter((x) => x.move === "nudge").map((x) => x.ticket)).toEqual(["CTL-1", "CTL-2"]);
  });

  test("blocked-tree → tier2; stranded-node + project-silence → tier3", () => {
    const invs = {
      ...allGreen(),
      blockedTree: inv(false, 1, true, ["CTL-A"]),
      strandedNode: inv(false, 1, true, ["mini-2"]),
      projectSilence: inv(false, 1, true, ["P1"]),
    };
    const m = proposeMoves(invs, mkBoard());
    expect(m.tier2.map((x) => x.move)).toContain("re-dispatch-blocker");
    expect(m.tier3.map((x) => x.move)).toEqual(
      expect.arrayContaining(["escalate-stranded-node", "escalate-project-silence"]),
    );
  });

  test("all-green → no moves; counts in decideBoardHealth match the arrays", () => {
    const m = proposeMoves(allGreen(), mkBoard());
    expect(m).toEqual({ tier1: [], tier2: [], tier3: [] });

    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1), blockedTree: inv(false, 1, true, ["CTL-A"]) };
    const d = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    expect(d.proposed.tier1).toBe(d.moves.tier1.length);
    expect(d.proposed.tier2).toBe(d.moves.tier2.length);
    expect(d.proposed.tier3).toBe(d.moves.tier3.length);
  });
});

// ─── buildBoardScanEvent — the flat event the emit envelope rides ───────────
describe("buildBoardScanEvent", () => {
  test("type/ticket/scalars at top of details; rosters as arrays; mode echoed", () => {
    const invs = { ...allGreen(), dispatchLiveness: inv(false, 1, true, ["CTL-1"]) };
    const decision = decideBoardHealth(invs, mkBoard({ capacity: { freeSlots: 4 } }));
    const ev = buildBoardScanEvent({ mode: "shadow", invariants: invs, decision });

    expect(ev.type).toBe("recovery.board-scan");
    expect(ev.ticket).toBeNull();
    expect(ev.fix_class).toBeNull();
    expect(ev.details.mode).toBe("shadow");
    expect(ev.details.invariantsFailed).toBe(1);
    expect(ev.details.gateDecision).toBe("proceed");
    expect(typeof ev.details.gateReason).toBe("string");
    expect(ev.details.proposedTier1).toBe(decision.proposed.tier1);
    // per-invariant {ok,failed,observable}
    expect(ev.details.invariants.dispatchLiveness).toEqual({ ok: false, failed: 1, observable: true });
    // rosters/move arrays live in details (→ body.payload), as arrays
    expect(Array.isArray(ev.details.flagged)).toBe(true);
    expect(ev.details.flagged).toContain("CTL-1");
    expect(Array.isArray(ev.details.tier1Moves)).toBe(true);
  });
});

// ─── buildBoardContext — the whole-board brief the delegate gets injected ────
describe("buildBoardContext", () => {
  test("stuckWorkers from flagged signals; invariants block; slots + queue", () => {
    const board = mkBoard({
      self: "mini",
      roster: ["mini"],
      capacity: { maxParallel: 4, liveCount: 2, freeSlots: 2 },
      eligible: [{ id: "CTL-1" }, { id: "CTL-2" }],
      signals: [{ ticket: "CTL-OLD", phase: "implement", status: "running", ageMs: 5 * HOUR }],
    });
    const invs = { ...allGreen(), workerAge: inv(false, 1, true, ["CTL-OLD"]) };
    const ctx = buildBoardContext(board, invs);

    expect(ctx.schema).toBe("recovery-board-context/v1");
    expect(ctx.slots).toEqual({ capacity: 4, inUse: 2, free: 2 });
    expect(ctx.eligibleQueue.depth).toBe(2);
    expect(ctx.eligibleQueue.topTickets).toEqual(["CTL-1", "CTL-2"]);
    expect(ctx.stuckWorkers).toEqual([
      { ticket: "CTL-OLD", phase: "implement", status: "running", ageSeconds: Math.round(5 * HOUR / 1000) },
    ]);
    expect(ctx.invariants.workerAge).toEqual({ ok: false, failed: 1 });
  });

  test("strandedNodes carry their HRW-owned tickets (schema {host, ownedTickets})", () => {
    const board = mkBoard({
      roster: ["mini", "mini-2"],
      ticketsById: new Map([
        ["CTL-A", { identifier: "CTL-A" }],
        ["CTL-B", { identifier: "CTL-B" }],
        ["CTL-C", { identifier: "CTL-C" }],
      ]),
      ownerForTicket: (id) => (id === "CTL-C" ? "mini" : "mini-2"),
    });
    const invs = { ...allGreen(), strandedNode: inv(false, 1, true, ["mini-2"]) };
    const ctx = buildBoardContext(board, invs);
    expect(ctx.strandedNodes).toEqual([{ host: "mini-2", ownedTickets: ["CTL-A", "CTL-B"] }]);
  });
});

// ─── assembleBoardState — the one impure reader (reads only) ─────────────────
describe("assembleBoardState", () => {
  test("normalizes descriptors/signals/eligible; reads signal.updatedAt/phase TOP-LEVEL (no evidence.signal)", () => {
    const board = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => [{ identifier: "CTL-A", state: "In Progress" }],
      // a raw signal with NO `evidence` field — age must still compute from top-level updatedAt
      getWorkerSignals: () => [{ ticket: "CTL-A", phase: "implement", status: "running", updatedAt: new Date(NOW - 5 * HOUR).toISOString() }],
      getEligible: () => [{ identifier: "CTL-B", project: "P1" }],
      roster: ["mini"],
      self: "mini",
      multiHost: false,
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 3 },
      readEventRing: () => [],
      getReconcileMarkers: () => ({}),
      now: () => NOW,
    });
    expect(board.ticketsById.get("CTL-A").state).toBe("In Progress");
    expect(board.signals[0].ageMs).toBe(5 * HOUR);
    expect(board.eligible[0].id).toBe("CTL-B");
    // worker-age still flags off the top-level signal fields — no evidence.signal needed
    const r = evaluateInvariants(board);
    expect(r.workerAge.flagged).toEqual(["CTL-A"]);
  });

  test("deriveRing: dispatch SUCCESS events set recentDispatchTs; failed/escalated/runaway do NOT", () => {
    const ring = (name) =>
      assembleBoardState({
        readEventRing: () => [{ attributes: { "event.name": name }, ts: new Date(NOW - MIN).toISOString() }],
        now: () => NOW,
      }).ring.recentDispatchTs;
    // success / activity signals → counted (dispatcher is alive)
    expect(ring("phase.dispatch.launched.CTL-1")).toBe(NOW - MIN);
    expect(ring("phase.dispatch.requested.CTL-1")).toBe(NOW - MIN);
    expect(ring("new-work")).toBe(NOW - MIN);
    // loud-failure signals → NOT counted (must not green the silent-hold wedge)
    expect(ring("phase.dispatch.failed.CTL-1")).toBeNull();
    expect(ring("phase.dispatch.escalated.CTL-1")).toBeNull();
    expect(ring("phase.dispatch.runaway.CTL-1")).toBeNull();
  });

  test("dispatchLiveness stays WEDGED when the only recent dispatch events are failures", () => {
    const board = assembleBoardState({
      getEligible: () => [{ identifier: "CTL-1" }],
      capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
      // a fail-loop: recent phase.dispatch.failed events, no launched/requested
      readEventRing: () => [{ attributes: { "event.name": "phase.dispatch.failed.CTL-1" }, ts: new Date(NOW - MIN).toISOString() }],
      now: () => NOW,
    });
    expect(evaluateInvariants(board).dispatchLiveness.ok).toBe(false); // wedge NOT masked by failures
  });

  test("each reader fails soft — a throwing dep degrades to []/{}, never throws", () => {
    const board = assembleBoardState({
      orchDir: "/tmp/x",
      getBoard: () => { throw new Error("db down"); },
      getWorkerSignals: () => { throw new Error("signals down"); },
      getEligible: () => { throw new Error("eligible down"); },
      readEventRing: () => { throw new Error("ring down"); },
      getReconcileMarkers: () => { throw new Error("markers down"); },
      now: () => NOW,
    });
    expect(board.ticketsById.size).toBe(0);
    expect(board.signals).toEqual([]);
    expect(board.eligible).toEqual([]);
    // and a full scan over the degraded board still runs
    expect(() => evaluateInvariants(board)).not.toThrow();
  });
});

// ─── boardHealthPass — injected IO, the ONE place mode branches ──────────────
function flaggedDeps(extra = {}) {
  // a board that trips dispatchLiveness (free slots + queue + no recent dispatch)
  return {
    orchDir: "/tmp/x",
    getBoard: () => [],
    getWorkerSignals: () => [],
    getEligible: () => [{ identifier: "CTL-1" }, { identifier: "CTL-2" }],
    roster: [],
    self: "mini",
    multiHost: false,
    capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
    readEventRing: () => [], // no dispatch events → wedge
    getReconcileMarkers: () => ({}),
    lastRunMs: 0,
    intervalMs: 0, // never throttled
    now: () => NOW,
    ...extra,
  };
}

describe("boardHealthPass — mode branching + shadow safety", () => {
  test("mode:off → strict no-op: no emit, act never called, returns {ran:false,reason:off}", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({ mode: "off", emit: (e) => emits.push(e), act: () => { throw new Error("must not act"); } }),
    );
    expect(r).toEqual({ ran: false, reason: "off" });
    expect(emits.length).toBe(0);
  });

  test("mode:shadow → emits ONE recovery.board-scan (mode=shadow); act is NEVER called (no throw)", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({ mode: "shadow", emit: (e) => emits.push(e), act: () => { throw new Error("shadow must not act"); } }),
    );
    expect(r.ran).toBe(true);
    expect(emits.length).toBe(1);
    expect(emits[0].type).toBe("recovery.board-scan");
    expect(emits[0].details.mode).toBe("shadow");
  });

  test("mode:enforce with NO act seam (the scheduler reality) → emits, mutates nothing, no throw", () => {
    const emits = [];
    const r = boardHealthPass(flaggedDeps({ mode: "enforce", emit: (e) => emits.push(e) }));
    expect(r.ran).toBe(true);
    expect(emits.length).toBe(1);
    expect(emits[0].details.mode).toBe("enforce");
  });

  test("mode:enforce WITH act stub → act called once per proposed move (future-wiring proof)", () => {
    const emits = [];
    const acted = [];
    boardHealthPass(
      flaggedDeps({ mode: "enforce", emit: (e) => emits.push(e), act: (move) => acted.push(move) }),
    );
    // the flagged board proposes exactly one tier-1 kick-dispatch
    expect(acted.length).toBe(1);
    expect(acted[0].move).toBe("kick-dispatch");
  });

  test("enforce + multiHost: HRW gate skips a move owned by another host", () => {
    const acted = [];
    boardHealthPass({
      orchDir: "/tmp/x",
      mode: "enforce",
      getBoard: () => [{ identifier: "CTL-OWNED-ELSEWHERE" }],
      getWorkerSignals: () => [{ ticket: "CTL-OWNED-ELSEWHERE", phase: "implement", status: "running", updatedAt: new Date(NOW - 5 * HOUR).toISOString() }],
      getEligible: () => [],
      roster: ["mini", "mini-2"],
      self: "mini",
      multiHost: true,
      capacity: { maxParallel: 4, liveCount: 1, freeSlots: 3 },
      readEventRing: () => [],
      ownerForTicket: () => "mini-2", // every ticket owned by the OTHER host
      getReconcileMarkers: () => ({}),
      lastRunMs: 0,
      intervalMs: 0,
      now: () => NOW,
      emit: () => {},
      act: (move) => acted.push(move),
    });
    // the only proposed move (nudge CTL-OWNED-ELSEWHERE) is owned by mini-2 → skipped
    expect(acted.length).toBe(0);
  });

  test("throttle: a call within intervalMs returns {ran:false,reason:throttled} with NO emit", () => {
    const emits = [];
    const r = boardHealthPass(
      flaggedDeps({
        mode: "shadow",
        emit: (e) => emits.push(e),
        lastRunMs: NOW - 1 * MIN, // 1min ago
        intervalMs: 5 * MIN, // 5min floor → throttled
      }),
    );
    expect(r).toEqual({ ran: false, reason: "throttled" });
    expect(emits.length).toBe(0);
  });

  test("fail-soft: a throwing emit is caught — the pass still returns {ran:true}", () => {
    const r = boardHealthPass(
      flaggedDeps({ mode: "shadow", emit: () => { throw new Error("emit blew up"); } }),
    );
    expect(r.ran).toBe(true);
  });
});
