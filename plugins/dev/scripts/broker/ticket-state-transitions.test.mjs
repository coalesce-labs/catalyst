// Unit tests for the CTL-1489 sink-5 durable ticket-transition store.
// Covers the append-only ticket_state_transitions table (INSERT OR IGNORE by
// event_id) and the five widened COALESCE-sticky worker_state path columns.
// Run: bun test plugins/dev/scripts/broker/ticket-state-transitions.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  recordTicketStateTransition,
  getTicketStateTransitions,
  getLatestTicketStateTransition,
  upsertWorkerState,
  getWorkerState,
} from "./broker-state.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tst-transitions-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseRow = (over = {}) => ({
  eventId: "e1",
  orchestrator: "CTL-1",
  ticket: "CTL-1",
  fromStage: "research",
  toStage: "plan",
  toDisposition: null,
  worktreePath: "/wt/CTL-1",
  bgJobId: "abc",
  generation: 1,
  handoffPath: null,
  artifact: "thoughts/x.md",
  ts: "2026-07-22T00:00:00Z",
  ...over,
});

describe("ticket_state_transitions store", () => {
  test("is append-only + deduped by event_id", () => {
    const row = baseRow();
    expect(recordTicketStateTransition(row)).toBe(true); // inserted
    expect(recordTicketStateTransition(row)).toBe(false); // duplicate ignored
    const all = getTicketStateTransitions("CTL-1");
    expect(all.length).toBe(1);
    expect(all[0].to_stage).toBe("plan");
    expect(all[0].worktree_path).toBe("/wt/CTL-1");
    expect(all[0].generation).toBe(1);
    expect(all[0].artifact_path).toBe("thoughts/x.md");
  });

  test("returns false when eventId or ticket missing", () => {
    expect(recordTicketStateTransition({ ticket: "CTL-1", ts: "t" })).toBe(false);
    expect(recordTicketStateTransition({ eventId: "e", ts: "t" })).toBe(false);
    expect(recordTicketStateTransition(null)).toBe(false);
  });

  test("getTicketStateTransitions returns rows in ts order", () => {
    recordTicketStateTransition(baseRow({ eventId: "e2", toStage: "implement", ts: "2026-07-22T00:01:00Z" }));
    recordTicketStateTransition(baseRow({ eventId: "e1", toStage: "plan", ts: "2026-07-22T00:00:00Z" }));
    const all = getTicketStateTransitions("CTL-1");
    expect(all.map((r) => r.to_stage)).toEqual(["plan", "implement"]);
  });

  test("getLatestTicketStateTransition returns newest by ts", () => {
    recordTicketStateTransition(baseRow({ eventId: "e1", toStage: "plan", ts: "2026-07-22T00:00:00Z" }));
    recordTicketStateTransition(baseRow({ eventId: "e2", toStage: "implement", ts: "2026-07-22T00:01:00Z" }));
    const latest = getLatestTicketStateTransition("CTL-1");
    expect(latest.event_id).toBe("e2");
    expect(latest.to_stage).toBe("implement");
  });

  test("getLatestTicketStateTransition returns null for unknown ticket", () => {
    expect(getLatestTicketStateTransition("CTL-999")).toBe(null);
  });
});

describe("worker_state widened path columns", () => {
  test("are COALESCE-sticky — a later null-path event never erases a known path", () => {
    upsertWorkerState({
      orchestrator: "CTL-1",
      ticket: "CTL-1",
      status: "running",
      worktreePath: "/wt/CTL-1",
      bgJobId: "abc",
      generation: 2,
      handoffPath: "/h.md",
      artifact: "thoughts/x.md",
      eventTs: "2026-07-22T00:00:00Z",
      eventId: "a",
    });
    upsertWorkerState({
      orchestrator: "CTL-1",
      ticket: "CTL-1",
      status: "running",
      worktreePath: null,
      bgJobId: null,
      generation: null,
      handoffPath: null,
      artifact: null,
      eventTs: "2026-07-22T00:01:00Z",
      eventId: "b",
    });
    const w = getWorkerState("CTL-1", "CTL-1");
    expect(w.worktree_path).toBe("/wt/CTL-1"); // sticky — not erased
    expect(w.bg_job_id).toBe("abc");
    expect(w.generation).toBe(2);
    expect(w.handoff_path).toBe("/h.md");
    expect(w.artifact_path).toBe("thoughts/x.md");
  });

  test("a later non-null path overwrites the earlier value", () => {
    upsertWorkerState({
      orchestrator: "CTL-1",
      ticket: "CTL-1",
      status: "running",
      worktreePath: "/wt/old",
      eventTs: "2026-07-22T00:00:00Z",
      eventId: "a",
    });
    upsertWorkerState({
      orchestrator: "CTL-1",
      ticket: "CTL-1",
      status: "running",
      worktreePath: "/wt/new",
      eventTs: "2026-07-22T00:01:00Z",
      eventId: "b",
    });
    expect(getWorkerState("CTL-1", "CTL-1").worktree_path).toBe("/wt/new");
  });
});
