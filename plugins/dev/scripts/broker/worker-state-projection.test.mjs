// Unit + integration tests for the event-sourced worker-state projection
// (CTL-532, ADR-018 Phase 3). Run:
//   bun test plugins/dev/scripts/broker/worker-state-projection.test.mjs
//
// Tiers:
//   - store helpers (Phase 1): worker_state / worker_revive_events / projection_meta
//   - pure reducer (Phase 2): reduceWorkerStateEvent
//   - projection integration (Phase 3): driver + router hook + startup replay

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertWorkerState,
  getWorkerState,
  getWorkerStatesByOrchestrator,
  getAllWorkerStates,
  recordReviveEvent,
  getReviveCount,
  getProjectionMeta,
  setProjectionMeta,
  getStaleWorkers,
  reduceWorkerStateEvent,
  projectWorkerStateEvent,
  replayWorkerStateProjection,
  processEvent,
} from "./index.mjs";
// DB lifecycle is imported directly from broker-state.mjs (the
// broker-state.test.mjs precedent) — these are not part of the pinned barrel.
import { openBrokerStateDb, closeBrokerStateDb } from "./broker-state.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws-proj-"));
  openBrokerStateDb(join(tmpDir, "t.db"));
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Phase 1: worker_state store helpers ─────────────────────────────────────

describe("worker_state store helpers (CTL-532)", () => {
  test("insert then get returns the row", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "research",
      status: "phase-complete",
      eventId: "e1",
      eventTs: "2026-05-21T00:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row).not.toBeNull();
    expect(row.orchestrator).toBe("orch-1");
    expect(row.ticket).toBe("CTL-1");
    expect(row.phase).toBe("research");
    expect(row.status).toBe("phase-complete");
    expect(row.revive_count).toBe(0);
    expect(row.last_event_id).toBe("e1");
    expect(row.last_event_ts).toBe("2026-05-21T00:00:00.000Z");
  });

  test("getWorkerState returns null for an unknown key", () => {
    expect(getWorkerState("orch-x", "CTL-x")).toBeNull();
  });

  test("upsert with OLDER eventTs does NOT overwrite phase/status (watermark gate)", () => {
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      phase: "plan", status: "phase-complete",
      eventId: "e2", eventTs: "2026-05-21T02:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      phase: "research", status: "phase-failed",
      eventId: "e1", eventTs: "2026-05-21T01:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row.phase).toBe("plan");
    expect(row.status).toBe("phase-complete");
    expect(row.last_event_ts).toBe("2026-05-21T02:00:00.000Z");
  });

  test("upsert with NEWER eventTs overwrites phase/status and advances last_event_ts", () => {
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      phase: "research", status: "phase-complete",
      eventId: "e1", eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      phase: "plan", status: "phase-complete",
      eventId: "e2", eventTs: "2026-05-21T02:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row.phase).toBe("plan");
    expect(row.last_event_id).toBe("e2");
    expect(row.last_event_ts).toBe("2026-05-21T02:00:00.000Z");
  });

  test("pr_number is COALESCE-sticky: a later event with null prNumber keeps the old value", () => {
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      status: "pr-created", prNumber: 999,
      eventId: "e1", eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      status: "done",
      eventId: "e2", eventTs: "2026-05-21T02:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row.pr_number).toBe(999);
    expect(row.status).toBe("done");
  });

  test("revive_count never regresses: MAX semantics", () => {
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      reviveCount: 3, eventId: "e1", eventTs: "2026-05-21T02:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1", ticket: "CTL-1",
      reviveCount: 1, eventId: "e2", eventTs: "2026-05-21T03:00:00.000Z",
    });
    expect(getWorkerState("orch-1", "CTL-1").revive_count).toBe(3);
  });

  test("getWorkerStatesByOrchestrator returns only that orchestrator's rows", () => {
    upsertWorkerState({ orchestrator: "orch-1", ticket: "CTL-1", status: "dispatched", eventId: "e1", eventTs: "2026-05-21T01:00:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-1", ticket: "CTL-2", status: "dispatched", eventId: "e2", eventTs: "2026-05-21T01:00:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-2", ticket: "CTL-3", status: "dispatched", eventId: "e3", eventTs: "2026-05-21T01:00:00.000Z" });
    const rows = getWorkerStatesByOrchestrator("orch-1");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.orchestrator === "orch-1")).toBe(true);
  });

  test("getAllWorkerStates returns every row", () => {
    upsertWorkerState({ orchestrator: "orch-1", ticket: "CTL-1", status: "dispatched", eventId: "e1", eventTs: "2026-05-21T01:00:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-2", ticket: "CTL-3", status: "dispatched", eventId: "e3", eventTs: "2026-05-21T01:00:00.000Z" });
    expect(getAllWorkerStates().length).toBe(2);
  });

  test("recordReviveEvent returns true for a new id, false for a duplicate id", () => {
    expect(recordReviveEvent({ eventId: "rev-1", orchestrator: "orch-1", ticket: "CTL-1", ts: "2026-05-21T01:00:00.000Z" })).toBe(true);
    expect(recordReviveEvent({ eventId: "rev-1", orchestrator: "orch-1", ticket: "CTL-1", ts: "2026-05-21T01:00:00.000Z" })).toBe(false);
  });

  test("getReviveCount counts distinct ledger rows for (orch,ticket)", () => {
    recordReviveEvent({ eventId: "rev-1", orchestrator: "orch-1", ticket: "CTL-1", ts: "2026-05-21T01:00:00.000Z" });
    recordReviveEvent({ eventId: "rev-2", orchestrator: "orch-1", ticket: "CTL-1", ts: "2026-05-21T02:00:00.000Z" });
    recordReviveEvent({ eventId: "rev-3", orchestrator: "orch-1", ticket: "CTL-2", ts: "2026-05-21T02:00:00.000Z" });
    expect(getReviveCount("orch-1", "CTL-1")).toBe(2);
    expect(getReviveCount("orch-1", "CTL-2")).toBe(1);
    expect(getReviveCount("orch-1", "CTL-x")).toBe(0);
  });

  test("getStaleWorkers: non-terminal + old ts returned; terminal excluded; fresh excluded", () => {
    const now = "2026-05-21T10:00:00.000Z";
    upsertWorkerState({ orchestrator: "orch-1", ticket: "STALE", status: "implement", eventId: "e1", eventTs: "2026-05-21T09:00:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-1", ticket: "TERMINAL", status: "done", eventId: "e2", eventTs: "2026-05-21T09:00:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-1", ticket: "FRESH", status: "implement", eventId: "e3", eventTs: "2026-05-21T09:59:00.000Z" });
    const stale = getStaleWorkers(30 * 60 * 1000, now); // 30 min threshold
    const tickets = stale.map((r) => r.ticket);
    expect(tickets).toContain("STALE");
    expect(tickets).not.toContain("TERMINAL");
    expect(tickets).not.toContain("FRESH");
  });

  test("getStaleWorkers threshold boundary: exactly at, just under, just over", () => {
    const now = "2026-05-21T10:00:00.000Z";
    // 30-min threshold ⇒ cutoff is 09:30:00.
    upsertWorkerState({ orchestrator: "orch-1", ticket: "AT", status: "implement", eventId: "e1", eventTs: "2026-05-21T09:30:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-1", ticket: "UNDER", status: "implement", eventId: "e2", eventTs: "2026-05-21T09:31:00.000Z" });
    upsertWorkerState({ orchestrator: "orch-1", ticket: "OVER", status: "implement", eventId: "e3", eventTs: "2026-05-21T09:29:00.000Z" });
    const tickets = getStaleWorkers(30 * 60 * 1000, now).map((r) => r.ticket);
    expect(tickets).toContain("OVER");
    expect(tickets).not.toContain("UNDER");
    // "AT" the exact cutoff is not strictly older than the threshold ⇒ excluded.
    expect(tickets).not.toContain("AT");
  });

  test("getProjectionMeta / setProjectionMeta round-trip the id=1 row", () => {
    expect(getProjectionMeta()).toBeNull();
    setProjectionMeta({ lastEventId: "e9", lastEventTs: "2026-05-21T05:00:00.000Z", eventsFolded: 42 });
    let meta = getProjectionMeta();
    expect(meta.lastEventId).toBe("e9");
    expect(meta.lastEventTs).toBe("2026-05-21T05:00:00.000Z");
    expect(meta.eventsFolded).toBe(42);
    // Upsert again — still a single row.
    setProjectionMeta({ lastEventId: "e10", lastEventTs: "2026-05-21T06:00:00.000Z", eventsFolded: 99 });
    meta = getProjectionMeta();
    expect(meta.lastEventId).toBe("e10");
    expect(meta.eventsFolded).toBe(99);
  });
});

// ─── Phase 2: the pure event reducer ─────────────────────────────────────────

function canonicalPhaseEvent({ name, orchestrator = "orch-1", ts = "2026-05-21T01:00:00.000Z", id = "evt-phase-1" }) {
  // The ticket is the last dotted segment of a phase.<name>.<status>.<TICKET> name.
  const ticket = name.split(".").pop();
  return {
    ts,
    id,
    observedTs: ts,
    attributes: {
      "event.name": name,
      "catalyst.orchestrator.id": orchestrator,
      "linear.issue.identifier": ticket,
    },
    body: { payload: { ticket, phase_name: name.split(".")[1] } },
  };
}

describe("reduceWorkerStateEvent (CTL-532)", () => {
  test("phase.research.complete.CTL-1 → phase=research, status=phase-complete", () => {
    const r = reduceWorkerStateEvent(canonicalPhaseEvent({ name: "phase.research.complete.CTL-1" }));
    expect(r).not.toBeNull();
    expect(r.kind).toBe("phase");
    expect(r.orchestrator).toBe("orch-1");
    expect(r.ticket).toBe("CTL-1");
    expect(r.patch).toEqual({ phase: "research", status: "phase-complete" });
  });

  test("phase.plan.failed.CTL-1 → status=phase-failed", () => {
    const r = reduceWorkerStateEvent(canonicalPhaseEvent({ name: "phase.plan.failed.CTL-1" }));
    expect(r.patch).toEqual({ phase: "plan", status: "phase-failed" });
  });

  test("phase.implement.turn-cap-exhausted.CTL-1 → status=turn-cap-exhausted", () => {
    const r = reduceWorkerStateEvent(canonicalPhaseEvent({ name: "phase.implement.turn-cap-exhausted.CTL-1" }));
    expect(r.patch).toEqual({ phase: "implement", status: "turn-cap-exhausted" });
  });

  test("canonical worker.state_changed → patch carries status/phase/prNumber/reviveCount", () => {
    const event = {
      ts: "2026-05-21T03:00:00.000Z",
      id: "wsc-1",
      attributes: {
        "event.name": "worker.state_changed",
        "catalyst.orchestrator.id": "demo",
        "catalyst.worker.ticket": "T-3",
      },
      body: {
        payload: {
          ticket: "T-3",
          orchestrator: "demo",
          state: {
            ticket: "T-3", status: "pr-created", phase_name: "pr",
            pr: { number: 42 }, phaseReviveCount: 2,
          },
        },
      },
    };
    const r = reduceWorkerStateEvent(event);
    expect(r.kind).toBe("worker_state");
    expect(r.orchestrator).toBe("demo");
    expect(r.ticket).toBe("T-3");
    expect(r.patch.status).toBe("pr-created");
    expect(r.patch.phase).toBe("pr");
    expect(r.patch.prNumber).toBe(42);
    expect(r.patch.reviveCount).toBe(2);
  });

  test("worker.state_changed reads numeric state.phase and scalar state.pr too", () => {
    const event = {
      ts: "2026-05-21T03:00:00.000Z",
      id: "wsc-2",
      attributes: {
        "event.name": "worker.state_changed",
        "catalyst.orchestrator.id": "demo",
        "catalyst.worker.ticket": "T-9",
      },
      body: { payload: { ticket: "T-9", state: { status: "implement", phase: 3, pr: 77, reviveCount: 1 } } },
    };
    const r = reduceWorkerStateEvent(event);
    expect(r.patch.phase).toBe(3);
    expect(r.patch.prNumber).toBe(77);
    expect(r.patch.reviveCount).toBe(1);
  });

  test("legacy flat worker.state_changed (event/detail/orchestrator) → same patch shape", () => {
    const event = {
      event: "worker.state_changed",
      ts: "2026-05-21T03:00:00.000Z",
      orchestrator: "orch-legacy",
      detail: {
        ticket: "CTL-50",
        state: { status: "verify", phase_name: "verify", pr: { number: 12 } },
      },
    };
    const r = reduceWorkerStateEvent(event);
    expect(r.kind).toBe("worker_state");
    expect(r.orchestrator).toBe("orch-legacy");
    expect(r.ticket).toBe("CTL-50");
    expect(r.patch.status).toBe("verify");
    expect(r.patch.phase).toBe("verify");
    expect(r.patch.prNumber).toBe(12);
  });

  test("orchestrator.worker.dispatched → status=dispatched", () => {
    const event = {
      ts: "2026-05-21T01:00:00.000Z",
      attributes: {
        "event.name": "orchestrator.worker.dispatched",
        "catalyst.orchestrator.id": "orch-1",
        "catalyst.worker.ticket": "CTL-1",
      },
      body: { payload: null },
    };
    const r = reduceWorkerStateEvent(event);
    expect(r.kind).toBe("worker_lifecycle");
    expect(r.patch).toEqual({ status: "dispatched" });
  });

  test("orchestrator.worker.pr_created → status=pr-created, prNumber from vcs.pr.number", () => {
    const event = {
      ts: "2026-05-21T01:00:00.000Z",
      attributes: {
        "event.name": "orchestrator.worker.pr_created",
        "catalyst.orchestrator.id": "orch-1",
        "catalyst.worker.ticket": "CTL-255",
        "vcs.pr.number": 510,
      },
      body: { payload: { pr: 510, url: "https://github.com/o/r/pull/510" } },
    };
    const r = reduceWorkerStateEvent(event);
    expect(r.patch.status).toBe("pr-created");
    expect(r.patch.prNumber).toBe(510);
  });

  test("orchestrator.worker.revived → kind=revive, eventId present", () => {
    const event = {
      ts: "2026-05-21T01:00:00.000Z",
      id: "rev-evt-1",
      attributes: {
        "event.name": "orchestrator.worker.revived",
        "catalyst.orchestrator.id": "orch-1",
        "catalyst.worker.ticket": "CTL-330",
      },
      body: { payload: { pid: 13601, reviveCount: 1, reason: "pid-dead" } },
    };
    const r = reduceWorkerStateEvent(event);
    expect(r.kind).toBe("revive");
    expect(r.eventId).toBe("rev-evt-1");
    expect(r.orchestrator).toBe("orch-1");
    expect(r.ticket).toBe("CTL-330");
  });

  test("revived event with no id synthesizes a deterministic eventId", () => {
    const make = () => ({
      ts: "2026-05-21T01:00:00.000Z",
      attributes: {
        "event.name": "orchestrator.worker.revived",
        "catalyst.orchestrator.id": "orch-1",
        "catalyst.worker.ticket": "CTL-330",
      },
      body: { payload: { reviveCount: 1 } },
    });
    const a = reduceWorkerStateEvent(make());
    const b = reduceWorkerStateEvent(make());
    expect(a.eventId).toBeTruthy();
    expect(a.eventId).toBe(b.eventId);
  });

  test("orchestrator.worker.failed → status=failed", () => {
    const event = {
      ts: "2026-05-21T01:00:00.000Z",
      attributes: {
        "event.name": "orchestrator.worker.failed",
        "catalyst.orchestrator.id": "orch-1",
        "catalyst.worker.ticket": "CTL-1",
      },
    };
    expect(reduceWorkerStateEvent(event).patch).toEqual({ status: "failed" });
  });

  test("irrelevant events reduce to null (filter.wake, github.pr.merged)", () => {
    expect(reduceWorkerStateEvent({ attributes: { "event.name": "filter.wake" } })).toBeNull();
    expect(reduceWorkerStateEvent({ event: "session.heartbeat" })).toBeNull();
    expect(reduceWorkerStateEvent({ attributes: { "event.name": "github.pr.merged", "vcs.pr.number": 5 } })).toBeNull();
  });

  test("missing ticket → null; missing orchestrator → null", () => {
    expect(reduceWorkerStateEvent({
      ts: "2026-05-21T01:00:00.000Z",
      attributes: { "event.name": "orchestrator.worker.dispatched", "catalyst.orchestrator.id": "orch-1" },
    })).toBeNull();
    expect(reduceWorkerStateEvent({
      ts: "2026-05-21T01:00:00.000Z",
      attributes: { "event.name": "orchestrator.worker.dispatched", "catalyst.worker.ticket": "CTL-1" },
    })).toBeNull();
  });

  test("IDEMPOTENCY: reduce(event) twice returns deep-equal results (pure)", () => {
    const event = canonicalPhaseEvent({ name: "phase.research.complete.CTL-1" });
    expect(reduceWorkerStateEvent(event)).toEqual(reduceWorkerStateEvent(event));
  });
});

// ─── Phase 3: projection driver, router hook, startup replay ─────────────────

function monthLogPath(dir) {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(dir, "events", `${ym}.jsonl`);
}

describe("projection integration (CTL-532)", () => {
  test("processEvent(phaseCompleteEvent) → getWorkerState row has phase + status", () => {
    processEvent(canonicalPhaseEvent({ name: "phase.research.complete.CTL-1", id: "p1" }));
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row).not.toBeNull();
    expect(row.phase).toBe("research");
    expect(row.status).toBe("phase-complete");
  });

  test("projectWorkerStateEvent on an OLDER out-of-order event does not regress phase/status", () => {
    projectWorkerStateEvent(canonicalPhaseEvent({ name: "phase.plan.complete.CTL-2", id: "p-new", ts: "2026-05-21T05:00:00.000Z" }));
    projectWorkerStateEvent(canonicalPhaseEvent({ name: "phase.research.failed.CTL-2", id: "p-old", ts: "2026-05-21T01:00:00.000Z" }));
    const row = getWorkerState("orch-1", "CTL-2");
    expect(row.phase).toBe("plan");
    expect(row.status).toBe("phase-complete");
  });

  test("projectWorkerStateEvent of a revived event increments revive_count via the ledger", () => {
    const revived = (id) => ({
      ts: "2026-05-21T01:00:00.000Z",
      id,
      attributes: {
        "event.name": "orchestrator.worker.revived",
        "catalyst.orchestrator.id": "orch-1",
        "catalyst.worker.ticket": "CTL-9",
      },
      body: { payload: { reviveCount: 1 } },
    });
    projectWorkerStateEvent(revived("rev-a"));
    projectWorkerStateEvent(revived("rev-b"));
    expect(getWorkerState("orch-1", "CTL-9").revive_count).toBe(2);
    // Re-folding the same ids does not double-count.
    projectWorkerStateEvent(revived("rev-a"));
    projectWorkerStateEvent(revived("rev-b"));
    expect(getWorkerState("orch-1", "CTL-9").revive_count).toBe(2);
  });

  test("replayWorkerStateProjection over a fixture log builds the expected rows", () => {
    const prevDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = tmpDir;
    try {
      const lines = [
        JSON.stringify(canonicalPhaseEvent({ name: "phase.research.complete.CTL-1", id: "r1", ts: "2026-05-21T01:00:00.000Z" })),
        JSON.stringify(canonicalPhaseEvent({ name: "phase.plan.complete.CTL-1", id: "r2", ts: "2026-05-21T02:00:00.000Z" })),
        JSON.stringify(canonicalPhaseEvent({ name: "phase.triage.complete.CTL-2", id: "r3", ts: "2026-05-21T01:30:00.000Z" })),
        "not-json-skip-me",
        "",
      ];
      const path = monthLogPath(tmpDir);
      mkdtempSyncEnsure(path);
      writeFileSync(path, lines.join("\n") + "\n");
      replayWorkerStateProjection();
      expect(getWorkerState("orch-1", "CTL-1").phase).toBe("plan");
      expect(getWorkerState("orch-1", "CTL-2").phase).toBe("triage");
      const meta = getProjectionMeta();
      expect(meta).not.toBeNull();
      expect(meta.eventsFolded).toBeGreaterThan(0);
    } finally {
      if (prevDir === undefined) delete process.env.CATALYST_DIR;
      else process.env.CATALYST_DIR = prevDir;
    }
  });

  test("IDEMPOTENT REPLAY: running replay twice yields byte-identical rows", () => {
    const prevDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = tmpDir;
    try {
      const revived = (id, ticket) => JSON.stringify({
        ts: "2026-05-21T01:00:00.000Z", id,
        attributes: {
          "event.name": "orchestrator.worker.revived",
          "catalyst.orchestrator.id": "orch-1",
          "catalyst.worker.ticket": ticket,
        },
        body: { payload: { reviveCount: 1 } },
      });
      const lines = [
        JSON.stringify(canonicalPhaseEvent({ name: "phase.research.complete.CTL-1", id: "r1", ts: "2026-05-21T01:00:00.000Z" })),
        revived("rev-1", "CTL-1"),
        revived("rev-2", "CTL-1"),
        JSON.stringify(canonicalPhaseEvent({ name: "phase.plan.complete.CTL-1", id: "r2", ts: "2026-05-21T02:00:00.000Z" })),
      ];
      const path = monthLogPath(tmpDir);
      mkdtempSyncEnsure(path);
      writeFileSync(path, lines.join("\n") + "\n");

      replayWorkerStateProjection();
      const first = JSON.stringify(getAllWorkerStates());
      const reviveFirst = getReviveCount("orch-1", "CTL-1");

      replayWorkerStateProjection();
      const second = JSON.stringify(getAllWorkerStates());
      const reviveSecond = getReviveCount("orch-1", "CTL-1");

      expect(second).toBe(first);
      expect(reviveSecond).toBe(reviveFirst);
      expect(reviveSecond).toBe(2);
    } finally {
      if (prevDir === undefined) delete process.env.CATALYST_DIR;
      else process.env.CATALYST_DIR = prevDir;
    }
  });

  test("CRASH-ONLY RESTART: rows survive close/reopen and replay catches up", () => {
    const dbPath = join(tmpDir, "crash.db");
    closeBrokerStateDb();
    openBrokerStateDb(dbPath);
    projectWorkerStateEvent(canonicalPhaseEvent({ name: "phase.research.complete.CTL-1", id: "c1", ts: "2026-05-21T01:00:00.000Z" }));
    closeBrokerStateDb();

    // Reopen the same DB file — rows must still be there.
    openBrokerStateDb(dbPath);
    const survived = getWorkerState("orch-1", "CTL-1");
    expect(survived).not.toBeNull();
    expect(survived.phase).toBe("research");

    // A newer event after restart advances the row.
    projectWorkerStateEvent(canonicalPhaseEvent({ name: "phase.plan.complete.CTL-1", id: "c2", ts: "2026-05-21T02:00:00.000Z" }));
    expect(getWorkerState("orch-1", "CTL-1").phase).toBe("plan");
  });

  test("replayWorkerStateProjection does not throw when the log file is missing", () => {
    const prevDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = join(tmpDir, "no-such-dir");
    try {
      expect(() => replayWorkerStateProjection()).not.toThrow();
    } finally {
      if (prevDir === undefined) delete process.env.CATALYST_DIR;
      else process.env.CATALYST_DIR = prevDir;
    }
  });
});

// Helper: ensure the directory for a fixture log path exists.
function mkdtempSyncEnsure(filePath) {
  mkdirSync(join(filePath, ".."), { recursive: true });
}

