// nav-signal.test.ts — CTL-896 / SHELL6 acceptance guards for the nav-signal
// projection. Encodes the five SHELL6 Gherkin scenarios against the PURE
// projection (deriveNavSignal / deriveDaemonHealth), which is fully injectable so
// every scenario is unit-testable without an fs/DB/subprocess/event-log.
import { describe, it, expect } from "bun:test";
import {
  deriveNavSignal,
  deriveDaemonHealth,
} from "../lib/nav-signal.mjs";
import type {
  BoardPayload,
  BoardWorker,
  BoardTicket,
  BoardQueueItem,
} from "../lib/board-data.mjs";

function worker(name: string, overrides: Partial<BoardWorker> = {}): BoardWorker {
  return {
    name,
    ticket: name,
    tickets: [name],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 1000,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: null,
    costUSD: null,
    sessionId: "sess",
    startedAt: null,
    pid: null,
    catalystSessionId: null,
    host: null,
    generation: null,
    ...overrides,
  };
}

function ticket(id: string, overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: id,
    type: "task",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "running",
    model: null,
    linearState: "Implement",
    workerStatus: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 1000,
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
    updatedAt: "2026-06-08T11:00:00.000Z",
    held: null,
    heldSince: null,
    currentPhaseSince: null,
    attention: null,
    attentionSince: null,
    blockers: [],
    host: null,
    generation: null,
    ...overrides,
  };
}

function queued(id: string, overrides: Partial<BoardQueueItem> = {}): BoardQueueItem {
  return {
    id,
    title: id,
    priority: 2,
    createdAt: "2026-06-08T10:00:00.000Z",
    state: "Todo",
    repo: "catalyst",
    team: "CTL",
    rank: 0,
    estimate: null,
    scope: null,
    project: null,
    host: null,
    ...overrides,
  };
}

function board(overrides: Partial<BoardPayload> = {}): BoardPayload {
  return {
    generatedAt: "2026-06-08T12:00:00.000Z",
    config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [],
    queue: [],
    ...overrides,
  };
}

describe("nav-signal projection (CTL-896 / SHELL6)", () => {
  // Scenario: Worker count badge reflects live sessions
  describe("worker count badge", () => {
    it("counts the active execution-core workers", () => {
      const sig = deriveNavSignal(
        board({ workers: [worker("CTL-1"), worker("CTL-2"), worker("CTL-3")] }),
      );
      expect(sig.workerCount).toBe(3);
    });

    it("is zero when no worker is running", () => {
      expect(deriveNavSignal(board()).workerCount).toBe(0);
    });

    // "updates as workers start and finish" — the projection is a pure function of
    // the latest snapshot, so a finished worker (dropped from board.workers) lowers
    // the count on the very next frame; no page reload, no stale bookkeeping.
    it("tracks the count down when a worker finishes", () => {
      const before = deriveNavSignal(board({ workers: [worker("a"), worker("b")] }));
      const after = deriveNavSignal(board({ workers: [worker("a")] }));
      expect(before.workerCount).toBe(2);
      expect(after.workerCount).toBe(1);
    });
  });

  // Scenario: Queue depth badge reflects waiting work
  describe("queue depth badge", () => {
    it("reflects the number of tickets waiting in the queue", () => {
      const sig = deriveNavSignal(
        board({ queue: [queued("q1"), queued("q2"), queued("q3"), queued("q4")] }),
      );
      expect(sig.queueDepth).toBe(4);
    });

    it("is zero when the queue is empty", () => {
      expect(deriveNavSignal(board()).queueDepth).toBe(0);
    });
  });

  // Scenario: Board anomaly dot
  describe("board anomaly dot", () => {
    it("flags an anomaly when a ticket is held blocked (needs-human / dependency)", () => {
      const sig = deriveNavSignal(
        board({ tickets: [ticket("CTL-1"), ticket("CTL-2", { held: "blocked" })] }),
      );
      expect(sig.anomaly).toBe(true);
    });

    it("flags an anomaly when a worker is stuck", () => {
      const sig = deriveNavSignal(
        board({ config: { maxParallel: 6, inFlight: 1, freeSlots: 5, active: 0, working: 0, stuck: 1 } }),
      );
      expect(sig.anomaly).toBe(true);
    });

    it("clears the anomaly when nothing is blocked or stuck", () => {
      const sig = deriveNavSignal(
        board({ tickets: [ticket("CTL-1"), ticket("CTL-2", { held: "waiting" })] }),
      );
      // a `waiting` hold is NOT an anomaly — deps satisfied, just awaiting capacity.
      expect(sig.anomaly).toBe(false);
    });

    it("clears the anomaly on the frame after the block resolves", () => {
      const blocked = deriveNavSignal(board({ tickets: [ticket("x", { held: "blocked" })] }));
      const resolved = deriveNavSignal(board({ tickets: [ticket("x", { held: null })] }));
      expect(blocked.anomaly).toBe(true);
      expect(resolved.anomaly).toBe(false);
    });
  });

  // Scenario: Daemon-health dot
  describe("daemon-health dot", () => {
    it("maps a live local heartbeat to healthy (green)", () => {
      expect(deriveNavSignal(board(), { liveness: "live" }).daemon).toBe("healthy");
    });

    it("maps a degraded local heartbeat to degraded (amber)", () => {
      expect(deriveNavSignal(board(), { liveness: "degraded" }).daemon).toBe("degraded");
    });

    it("maps an offline local heartbeat to offline (red)", () => {
      expect(deriveNavSignal(board(), { liveness: "offline" }).daemon).toBe("offline");
    });

    it("defaults to offline when no liveness is known (never fabricates health)", () => {
      expect(deriveNavSignal(board()).daemon).toBe("offline");
    });

    it("an explicit daemon health overrides the liveness mapping", () => {
      expect(deriveNavSignal(board(), { daemon: "degraded" }).daemon).toBe("degraded");
    });
  });

  // Single-host identity no-op: the LOCAL daemon's own heartbeat IS the health.
  describe("deriveDaemonHealth (single-host local liveness)", () => {
    const now = Date.parse("2026-06-08T12:00:00.000Z");

    it("a fresh local heartbeat → healthy", () => {
      const last = { "mac-mini": "2026-06-08T11:59:50.000Z" }; // 10s ago
      expect(deriveDaemonHealth(last, "mac-mini", { now })).toBe("healthy");
    });

    it("a stale-but-grace local heartbeat → degraded", () => {
      const last = { "mac-mini": "2026-06-08T11:58:00.000Z" }; // 2min ago (> 30s, < 5min)
      expect(deriveDaemonHealth(last, "mac-mini", { now })).toBe("degraded");
    });

    it("a very old local heartbeat → offline", () => {
      const last = { "mac-mini": "2026-06-08T11:00:00.000Z" }; // 1h ago
      expect(deriveDaemonHealth(last, "mac-mini", { now })).toBe("offline");
    });

    it("never-heard local host → offline (no fabrication)", () => {
      expect(deriveDaemonHealth({}, "mac-mini", { now })).toBe("offline");
      expect(deriveDaemonHealth({ "other-host": "2026-06-08T11:59:55.000Z" }, "mac-mini", { now })).toBe(
        "offline",
      );
    });
  });

  // Scenario: Live without thrash — the projection passes the snapshot's
  // generatedAt through so a consumer can dedupe identical frames; it does no I/O.
  describe("passthrough + purity", () => {
    it("carries the source snapshot's generatedAt", () => {
      expect(deriveNavSignal(board({ generatedAt: "2026-06-08T13:00:00.000Z" })).generatedAt).toBe(
        "2026-06-08T13:00:00.000Z",
      );
    });

    it("is total over a null/garbage snapshot (degrades, never throws)", () => {
      const sig = deriveNavSignal(null);
      expect(sig).toEqual({
        workerCount: 0,
        queueDepth: 0,
        anomaly: false,
        daemon: "offline",
        generatedAt: "",
      });
    });
  });
});
