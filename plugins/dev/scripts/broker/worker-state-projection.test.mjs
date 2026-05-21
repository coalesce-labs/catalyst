// Unit + integration tests for the event-sourced worker-state projection
// (CTL-532, ADR-018 Phase 3). Run:
//   bun test plugins/dev/scripts/broker/worker-state-projection.test.mjs
//
// Tiers:
//   - store helpers (Phase 1): worker_state / worker_revive_events / projection_meta

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
