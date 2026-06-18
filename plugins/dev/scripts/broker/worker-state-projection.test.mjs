// Unit + integration tests for the event-sourced worker-state projection
// (CTL-532, ADR-018 Phase 3). Run:
//   bun test plugins/dev/scripts/broker/worker-state-projection.test.mjs
//
// Tiers:
//   - store helpers (Phase 1): worker_state / worker_revive_events / projection_meta
//   - pure reducer (Phase 2): reduceWorkerStateEvent
//   - projection integration (Phase 3): driver + router hook + startup replay
//   - liveness surface (Phase 4): buildBrokerState.workerStates

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
  hasActiveWorkers,
  ACTIVE_WORKER_FRESHNESS_MS,
  reduceWorkerStateEvent,
  projectWorkerStateEvent,
  replayWorkerStateProjection,
  processEvent,
  buildBrokerState,
} from "./index.mjs";
// DB lifecycle is imported directly from broker-state.mjs (the
// broker-state.test.mjs precedent) — these are not part of the pinned barrel.
import { openBrokerStateDb, closeBrokerStateDb } from "./broker-state.mjs";

let tmpDir;
let savedCatalystDir;

beforeEach(() => {
  // openBrokerStateDb is a no-op if a handle is already open — defensively
  // close any DB leaked by a prior test file so we always get a fresh one.
  closeBrokerStateDb();
  tmpDir = mkdtempSync(join(tmpdir(), "ws-proj-"));
  openBrokerStateDb(join(tmpDir, "t.db"));
  // Snapshot CATALYST_DIR so replay tests that redirect it cannot leak into
  // sibling test files (worker-state.test.mjs also reads this env var).
  savedCatalystDir = process.env.CATALYST_DIR;
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = savedCatalystDir;
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
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "plan",
      status: "phase-complete",
      eventId: "e2",
      eventTs: "2026-05-21T02:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "research",
      status: "phase-failed",
      eventId: "e1",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row.phase).toBe("plan");
    expect(row.status).toBe("phase-complete");
    expect(row.last_event_ts).toBe("2026-05-21T02:00:00.000Z");
  });

  test("upsert with NEWER eventTs overwrites phase/status and advances last_event_ts", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "research",
      status: "phase-complete",
      eventId: "e1",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "plan",
      status: "phase-complete",
      eventId: "e2",
      eventTs: "2026-05-21T02:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row.phase).toBe("plan");
    expect(row.last_event_id).toBe("e2");
    expect(row.last_event_ts).toBe("2026-05-21T02:00:00.000Z");
  });

  test("pr_number is COALESCE-sticky: a later event with null prNumber keeps the old value", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      status: "pr-created",
      prNumber: 999,
      eventId: "e1",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      status: "done",
      eventId: "e2",
      eventTs: "2026-05-21T02:00:00.000Z",
    });
    const row = getWorkerState("orch-1", "CTL-1");
    expect(row.pr_number).toBe(999);
    expect(row.status).toBe("done");
  });

  test("revive_count never regresses: MAX semantics", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      reviveCount: 3,
      eventId: "e1",
      eventTs: "2026-05-21T02:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      reviveCount: 1,
      eventId: "e2",
      eventTs: "2026-05-21T03:00:00.000Z",
    });
    expect(getWorkerState("orch-1", "CTL-1").revive_count).toBe(3);
  });

  test("getWorkerStatesByOrchestrator returns only that orchestrator's rows", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      status: "dispatched",
      eventId: "e1",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-2",
      status: "dispatched",
      eventId: "e2",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-2",
      ticket: "CTL-3",
      status: "dispatched",
      eventId: "e3",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    const rows = getWorkerStatesByOrchestrator("orch-1");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.orchestrator === "orch-1")).toBe(true);
  });

  test("getAllWorkerStates returns every row", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      status: "dispatched",
      eventId: "e1",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-2",
      ticket: "CTL-3",
      status: "dispatched",
      eventId: "e3",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    expect(getAllWorkerStates().length).toBe(2);
  });

  test("recordReviveEvent returns true for a new id, false for a duplicate id", () => {
    expect(
      recordReviveEvent({
        eventId: "rev-1",
        orchestrator: "orch-1",
        ticket: "CTL-1",
        ts: "2026-05-21T01:00:00.000Z",
      })
    ).toBe(true);
    expect(
      recordReviveEvent({
        eventId: "rev-1",
        orchestrator: "orch-1",
        ticket: "CTL-1",
        ts: "2026-05-21T01:00:00.000Z",
      })
    ).toBe(false);
  });

  test("getReviveCount counts distinct ledger rows for (orch,ticket)", () => {
    recordReviveEvent({
      eventId: "rev-1",
      orchestrator: "orch-1",
      ticket: "CTL-1",
      ts: "2026-05-21T01:00:00.000Z",
    });
    recordReviveEvent({
      eventId: "rev-2",
      orchestrator: "orch-1",
      ticket: "CTL-1",
      ts: "2026-05-21T02:00:00.000Z",
    });
    recordReviveEvent({
      eventId: "rev-3",
      orchestrator: "orch-1",
      ticket: "CTL-2",
      ts: "2026-05-21T02:00:00.000Z",
    });
    expect(getReviveCount("orch-1", "CTL-1")).toBe(2);
    expect(getReviveCount("orch-1", "CTL-2")).toBe(1);
    expect(getReviveCount("orch-1", "CTL-x")).toBe(0);
  });

  test("getStaleWorkers: non-terminal + old ts returned; terminal excluded; fresh excluded", () => {
    const now = "2026-05-21T10:00:00.000Z";
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "STALE",
      status: "implement",
      eventId: "e1",
      eventTs: "2026-05-21T09:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "TERMINAL",
      status: "done",
      eventId: "e2",
      eventTs: "2026-05-21T09:00:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "FRESH",
      status: "implement",
      eventId: "e3",
      eventTs: "2026-05-21T09:59:00.000Z",
    });
    const stale = getStaleWorkers(30 * 60 * 1000, now); // 30 min threshold
    const tickets = stale.map((r) => r.ticket);
    expect(tickets).toContain("STALE");
    expect(tickets).not.toContain("TERMINAL");
    expect(tickets).not.toContain("FRESH");
  });

  test("getStaleWorkers threshold boundary: exactly at, just under, just over", () => {
    const now = "2026-05-21T10:00:00.000Z";
    // 30-min threshold ⇒ cutoff is 09:30:00.
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "AT",
      status: "implement",
      eventId: "e1",
      eventTs: "2026-05-21T09:30:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "UNDER",
      status: "implement",
      eventId: "e2",
      eventTs: "2026-05-21T09:31:00.000Z",
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "OVER",
      status: "implement",
      eventId: "e3",
      eventTs: "2026-05-21T09:29:00.000Z",
    });
    const tickets = getStaleWorkers(30 * 60 * 1000, now).map((r) => r.ticket);
    expect(tickets).toContain("OVER");
    expect(tickets).not.toContain("UNDER");
    // "AT" the exact cutoff is not strictly older than the threshold ⇒ excluded.
    expect(tickets).not.toContain("AT");
  });

  test("getProjectionMeta / setProjectionMeta round-trip the id=1 row", () => {
    expect(getProjectionMeta()).toBeNull();
    setProjectionMeta({
      lastEventId: "e9",
      lastEventTs: "2026-05-21T05:00:00.000Z",
      eventsFolded: 42,
    });
    let meta = getProjectionMeta();
    expect(meta.lastEventId).toBe("e9");
    expect(meta.lastEventTs).toBe("2026-05-21T05:00:00.000Z");
    expect(meta.eventsFolded).toBe(42);
    // Upsert again — still a single row.
    setProjectionMeta({
      lastEventId: "e10",
      lastEventTs: "2026-05-21T06:00:00.000Z",
      eventsFolded: 99,
    });
    meta = getProjectionMeta();
    expect(meta.lastEventId).toBe("e10");
    expect(meta.eventsFolded).toBe(99);
  });
});

// ─── hasActiveWorkers: the activity gate (CTL-1122 PR2) ──────────────────────
// True iff ≥1 non-terminal worker_state row has emitted an event within the
// freshness window. Freshness-bounded (NOT raw non-terminal) so a crashed
// never-terminal row can't pin the github/linear ingestion-recency gate open
// during a dead-fleet lull (PR2 fork b / plan risk #4). The freshness bound is
// the complement of getStaleWorkers' predicate among non-terminal rows.

describe("hasActiveWorkers (CTL-1122 PR2)", () => {
  const now = "2026-05-21T10:00:00.000Z";
  const fresh = "2026-05-21T09:59:00.000Z"; // 1 min ago, within 30-min window
  const stale = "2026-05-21T09:00:00.000Z"; // 60 min ago, past 30-min window

  test("no rows → false", () => {
    expect(hasActiveWorkers(now)).toBe(false);
  });

  test("one fresh non-terminal (running) row → true", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      status: "implement",
      eventId: "e1",
      eventTs: fresh,
    });
    expect(hasActiveWorkers(now)).toBe(true);
  });

  test("one fresh null-status row → true (dispatched, no status yet)", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "research",
      eventId: "e1",
      eventTs: fresh,
    });
    expect(getWorkerState("orch-1", "CTL-1").status).toBeNull();
    expect(hasActiveWorkers(now)).toBe(true);
  });

  test("only terminal rows (done/failed/complete), even if fresh → false", () => {
    for (const [t, status] of [
      ["A", "done"],
      ["B", "failed"],
      ["C", "complete"],
    ]) {
      upsertWorkerState({
        orchestrator: "orch-1",
        ticket: t,
        status,
        eventId: `e-${t}`,
        eventTs: fresh,
      });
    }
    expect(hasActiveWorkers(now)).toBe(false);
  });

  test("a STALE non-terminal row (crashed, never terminal) → false (fork b)", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CRASHED",
      status: "implement",
      eventId: "e1",
      eventTs: stale,
    });
    // getStaleWorkers would return it; hasActiveWorkers must NOT count it.
    expect(getStaleWorkers(30 * 60 * 1000, now).map((r) => r.ticket)).toContain("CRASHED");
    expect(hasActiveWorkers(now)).toBe(false);
  });

  test("mixed: one terminal-fresh + one non-terminal-fresh → true", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "DONE",
      status: "done",
      eventId: "e1",
      eventTs: fresh,
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "LIVE",
      status: "verify",
      eventId: "e2",
      eventTs: fresh,
    });
    expect(hasActiveWorkers(now)).toBe(true);
  });

  test("non-terminal row with NULL last_event_ts → false (no confirmed beat)", () => {
    // upsert with no eventTs leaves last_event_ts NULL; getStaleWorkers also
    // excludes these (IS NOT NULL), so the gate stays consistent with it.
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "NOTS",
      status: "implement",
      eventId: "e1",
    });
    expect(getWorkerState("orch-1", "NOTS").last_event_ts).toBeNull();
    expect(hasActiveWorkers(now)).toBe(false);
  });

  test("boundary: a row exactly at the freshness cutoff counts as active", () => {
    // 30-min window ⇒ cutoff is 09:30:00. A beat AT the cutoff is >= cutoff ⇒
    // active (the complement of getStaleWorkers, where AT-cutoff is excluded).
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "AT",
      status: "implement",
      eventId: "e1",
      eventTs: "2026-05-21T09:30:00.000Z",
    });
    expect(hasActiveWorkers(now)).toBe(true);
    expect(getStaleWorkers(30 * 60 * 1000, now).map((r) => r.ticket)).not.toContain("AT");
  });

  test("custom freshnessMs is honored (tighter window excludes an otherwise-fresh row)", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      status: "implement",
      eventId: "e1",
      eventTs: "2026-05-21T09:50:00.000Z", // 10 min ago
    });
    expect(hasActiveWorkers(now, 30 * 60 * 1000)).toBe(true); // within 30 min
    expect(hasActiveWorkers(now, 5 * 60 * 1000)).toBe(false); // outside 5 min
  });

  test("ACTIVE_WORKER_FRESHNESS_MS default is exported and positive", () => {
    expect(typeof ACTIVE_WORKER_FRESHNESS_MS).toBe("number");
    expect(ACTIVE_WORKER_FRESHNESS_MS).toBeGreaterThan(0);
  });
});

// ─── Phase 2: the pure event reducer ─────────────────────────────────────────

function canonicalPhaseEvent({
  name,
  orchestrator = "orch-1",
  ts = "2026-05-21T01:00:00.000Z",
  id = "evt-phase-1",
}) {
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
    const r = reduceWorkerStateEvent(
      canonicalPhaseEvent({ name: "phase.research.complete.CTL-1" })
    );
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
    const r = reduceWorkerStateEvent(
      canonicalPhaseEvent({ name: "phase.implement.turn-cap-exhausted.CTL-1" })
    );
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
            ticket: "T-3",
            status: "pr-created",
            phase_name: "pr",
            pr: { number: 42 },
            phaseReviveCount: 2,
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
      body: {
        payload: {
          ticket: "T-9",
          state: { status: "implement", phase: 3, pr: 77, reviveCount: 1 },
        },
      },
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
    expect(
      reduceWorkerStateEvent({
        attributes: { "event.name": "github.pr.merged", "vcs.pr.number": 5 },
      })
    ).toBeNull();
  });

  test("missing ticket → null; missing orchestrator → null", () => {
    expect(
      reduceWorkerStateEvent({
        ts: "2026-05-21T01:00:00.000Z",
        attributes: {
          "event.name": "orchestrator.worker.dispatched",
          "catalyst.orchestrator.id": "orch-1",
        },
      })
    ).toBeNull();
    expect(
      reduceWorkerStateEvent({
        ts: "2026-05-21T01:00:00.000Z",
        attributes: {
          "event.name": "orchestrator.worker.dispatched",
          "catalyst.worker.ticket": "CTL-1",
        },
      })
    ).toBeNull();
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
    projectWorkerStateEvent(
      canonicalPhaseEvent({
        name: "phase.plan.complete.CTL-2",
        id: "p-new",
        ts: "2026-05-21T05:00:00.000Z",
      })
    );
    projectWorkerStateEvent(
      canonicalPhaseEvent({
        name: "phase.research.failed.CTL-2",
        id: "p-old",
        ts: "2026-05-21T01:00:00.000Z",
      })
    );
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
        JSON.stringify(
          canonicalPhaseEvent({
            name: "phase.research.complete.CTL-1",
            id: "r1",
            ts: "2026-05-21T01:00:00.000Z",
          })
        ),
        JSON.stringify(
          canonicalPhaseEvent({
            name: "phase.plan.complete.CTL-1",
            id: "r2",
            ts: "2026-05-21T02:00:00.000Z",
          })
        ),
        JSON.stringify(
          canonicalPhaseEvent({
            name: "phase.triage.complete.CTL-2",
            id: "r3",
            ts: "2026-05-21T01:30:00.000Z",
          })
        ),
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
      const revived = (id, ticket) =>
        JSON.stringify({
          ts: "2026-05-21T01:00:00.000Z",
          id,
          attributes: {
            "event.name": "orchestrator.worker.revived",
            "catalyst.orchestrator.id": "orch-1",
            "catalyst.worker.ticket": ticket,
          },
          body: { payload: { reviveCount: 1 } },
        });
      const lines = [
        JSON.stringify(
          canonicalPhaseEvent({
            name: "phase.research.complete.CTL-1",
            id: "r1",
            ts: "2026-05-21T01:00:00.000Z",
          })
        ),
        revived("rev-1", "CTL-1"),
        revived("rev-2", "CTL-1"),
        JSON.stringify(
          canonicalPhaseEvent({
            name: "phase.plan.complete.CTL-1",
            id: "r2",
            ts: "2026-05-21T02:00:00.000Z",
          })
        ),
      ];
      const path = monthLogPath(tmpDir);
      mkdtempSyncEnsure(path);
      writeFileSync(path, lines.join("\n") + "\n");

      // updated_at records wall-clock write time, not derived state — it
      // legitimately differs between two replays. Strip it so the comparison
      // proves the *derived projection* is byte-identical (true idempotency).
      const derivedRows = () =>
        JSON.stringify(getAllWorkerStates().map(({ updated_at, ...rest }) => rest));

      replayWorkerStateProjection();
      const first = derivedRows();
      const reviveFirst = getReviveCount("orch-1", "CTL-1");

      replayWorkerStateProjection();
      const second = derivedRows();
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
    projectWorkerStateEvent(
      canonicalPhaseEvent({
        name: "phase.research.complete.CTL-1",
        id: "c1",
        ts: "2026-05-21T01:00:00.000Z",
      })
    );
    closeBrokerStateDb();

    // Reopen the same DB file — rows must still be there.
    openBrokerStateDb(dbPath);
    const survived = getWorkerState("orch-1", "CTL-1");
    expect(survived).not.toBeNull();
    expect(survived.phase).toBe("research");

    // A newer event after restart advances the row.
    projectWorkerStateEvent(
      canonicalPhaseEvent({
        name: "phase.plan.complete.CTL-1",
        id: "c2",
        ts: "2026-05-21T02:00:00.000Z",
      })
    );
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

// ─── Phase 4: liveness surface ───────────────────────────────────────────────

describe("liveness surface (CTL-532)", () => {
  test("buildBrokerState() includes a workerStates array reflecting upserted rows", () => {
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-1",
      phase: "implement",
      status: "implement",
      eventId: "e1",
      eventTs: "2026-05-21T01:00:00.000Z",
    });
    const state = buildBrokerState();
    expect(Array.isArray(state.workerStates)).toBe(true);
    expect(state.workerStates.length).toBe(1);
    expect(state.workerStates[0].ticket).toBe("CTL-1");
  });

  test("buildBrokerState() returns an empty workerStates array when there are no rows", () => {
    const state = buildBrokerState();
    expect(Array.isArray(state.workerStates)).toBe(true);
    expect(state.workerStates.length).toBe(0);
  });
});

// Helper: ensure the directory for a fixture log path exists.
function mkdtempSyncEnsure(filePath) {
  mkdirSync(join(filePath, ".."), { recursive: true });
}

// ─── verify-phase coverage backfill (CTL-532) ────────────────────────────────
// These tests were added by the orchestrator verify phase to pin documented
// design behaviors that the original suite left uncovered: the
// orchestrator.worker.status_terminal reducer branch, the equal-timestamp
// watermark tie-break, the launch_failed/done lifecycle aliases, the
// worker.state_changed missing-state guard, and the store early-return guards.

function workerLifecycleEvent({
  name,
  orchestrator = "orch-1",
  ticket = "CTL-1",
  ts = "2026-05-21T01:00:00.000Z",
  id,
  payload = {},
  attributes = {},
}) {
  return {
    ts,
    ...(id ? { id } : {}),
    attributes: {
      "event.name": name,
      "catalyst.orchestrator.id": orchestrator,
      "catalyst.worker.ticket": ticket,
      ...attributes,
    },
    body: { payload },
  };
}

describe("reduceWorkerStateEvent — status_terminal branch (CTL-532)", () => {
  test("status_terminal with payload.status → patch carries that status", () => {
    const r = reduceWorkerStateEvent(
      workerLifecycleEvent({
        name: "orchestrator.worker.status_terminal",
        ticket: "CTL-77",
        payload: { status: "done" },
      })
    );
    expect(r).not.toBeNull();
    expect(r.kind).toBe("worker_lifecycle");
    expect(r.ticket).toBe("CTL-77");
    expect(r.patch).toEqual({ status: "done" });
  });

  test("status_terminal with only a PR number → patch carries prNumber, no status", () => {
    const r = reduceWorkerStateEvent(
      workerLifecycleEvent({
        name: "orchestrator.worker.status_terminal",
        ticket: "CTL-77",
        payload: { pr: { number: 88 } },
      })
    );
    expect(r).not.toBeNull();
    expect(r.patch).toEqual({ prNumber: 88 });
  });

  test("status_terminal with neither status nor PR → reducer returns null", () => {
    const r = reduceWorkerStateEvent(
      workerLifecycleEvent({
        name: "orchestrator.worker.status_terminal",
        ticket: "CTL-77",
        payload: {},
      })
    );
    expect(r).toBeNull();
  });

  test("a terminal status_terminal event excludes the worker from getStaleWorkers", () => {
    projectWorkerStateEvent(
      workerLifecycleEvent({
        name: "orchestrator.worker.status_terminal",
        ticket: "CTL-DONE",
        ts: "2026-05-21T09:00:00.000Z",
        id: "st-done-1",
        payload: { status: "done" },
      })
    );
    const stale = getStaleWorkers(30 * 60 * 1000, "2026-05-21T11:00:00.000Z");
    expect(stale.map((r) => r.ticket)).not.toContain("CTL-DONE");
  });
});

describe("reduceWorkerStateEvent — lifecycle aliases (CTL-532)", () => {
  test("orchestrator.worker.launch_failed → status=failed", () => {
    const r = reduceWorkerStateEvent(
      workerLifecycleEvent({ name: "orchestrator.worker.launch_failed" })
    );
    expect(r.patch).toEqual({ status: "failed" });
  });

  test("orchestrator.worker.done → status=done", () => {
    const r = reduceWorkerStateEvent(workerLifecycleEvent({ name: "orchestrator.worker.done" }));
    expect(r.patch).toEqual({ status: "done" });
  });

  test("unknown orchestrator.worker.* action → null", () => {
    const r = reduceWorkerStateEvent(
      workerLifecycleEvent({ name: "orchestrator.worker.some_future_action" })
    );
    expect(r).toBeNull();
  });
});

describe("reduceWorkerStateEvent — worker.state_changed guards (CTL-532)", () => {
  test("worker.state_changed with no state object → null", () => {
    const r = reduceWorkerStateEvent({
      ts: "2026-05-21T03:00:00.000Z",
      id: "wsc-nostate",
      attributes: {
        "event.name": "worker.state_changed",
        "catalyst.orchestrator.id": "demo",
        "catalyst.worker.ticket": "T-1",
      },
      body: { payload: { ticket: "T-1" } },
    });
    expect(r).toBeNull();
  });

  test("state.prNumber takes precedence over a nested state.pr.number", () => {
    const r = reduceWorkerStateEvent({
      ts: "2026-05-21T03:00:00.000Z",
      id: "wsc-prec",
      attributes: {
        "event.name": "worker.state_changed",
        "catalyst.orchestrator.id": "demo",
        "catalyst.worker.ticket": "T-2",
      },
      body: { payload: { state: { status: "pr", prNumber: 5, pr: { number: 9 } } } },
    });
    expect(r.patch.prNumber).toBe(5);
  });
});

describe("upsertWorkerState — equal-timestamp watermark tie (CTL-532)", () => {
  test("an event at the SAME eventTs overwrites phase/status (>= gate, last write wins)", () => {
    const ts = "2026-05-21T04:00:00.000Z";
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-TIE",
      phase: "research",
      status: "phase-complete",
      eventId: "tie-a",
      eventTs: ts,
    });
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket: "CTL-TIE",
      phase: "plan",
      status: "phase-failed",
      eventId: "tie-b",
      eventTs: ts,
    });
    const row = getWorkerState("orch-1", "CTL-TIE");
    expect(row.phase).toBe("plan");
    expect(row.status).toBe("phase-failed");
    expect(row.last_event_id).toBe("tie-b");
  });
});

describe("store helper guards (CTL-532)", () => {
  test("upsertWorkerState with a missing orchestrator/ticket is a silent no-op", () => {
    upsertWorkerState({ orchestrator: null, ticket: "CTL-1", phase: "research", eventId: "g1" });
    upsertWorkerState({ orchestrator: "orch-1", ticket: null, phase: "research", eventId: "g2" });
    expect(getAllWorkerStates().length).toBe(0);
  });

  test("recordReviveEvent returns false when a required key is missing", () => {
    expect(
      recordReviveEvent({ eventId: null, orchestrator: "orch-1", ticket: "CTL-1" })
    ).toBe(false);
    expect(
      recordReviveEvent({ eventId: "r1", orchestrator: null, ticket: "CTL-1" })
    ).toBe(false);
    expect(getReviveCount("orch-1", "CTL-1")).toBe(0);
  });
});
