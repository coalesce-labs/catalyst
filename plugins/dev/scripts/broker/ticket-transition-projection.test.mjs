// Unit + integration tests for the CTL-1489 sink-5 ticket-transition projection.
// Covers the pure reducer (reduceTicketTransitionEvent), the driver
// (projectTicketTransitionEvent → both tables, idempotent), and non-transition
// event rejection. Run:
//   cd plugins/dev/scripts/broker && bun test ticket-transition-projection.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reduceTicketTransitionEvent,
  projectTicketTransitionEvent,
  getTicketStateTransitions,
  getLatestTicketStateTransition,
  getWorkerState,
} from "./index.mjs";
import { openBrokerStateDb, closeBrokerStateDb } from "./broker-state.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tst-proj-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const transitionEvent = (over = {}) => ({
  ts: "2026-07-22T00:00:00Z",
  id: "e1",
  attributes: {
    "event.name": "worker.transition.CTL-1",
    "catalyst.orchestration": "CTL-1",
    "catalyst.worker.ticket": "CTL-1",
    ...over.attributes,
  },
  body: {
    payload: {
      ticket: "CTL-1",
      to_stage: "plan",
      to_disposition: "needs-human",
      worktree_path: "/wt/CTL-1",
      bg_job_id: "abc",
      generation: 1,
      artifact: "thoughts/x.md",
      ...over.payload,
    },
  },
  ...over.top,
});

describe("reduceTicketTransitionEvent", () => {
  test("extracts widened fields from body.payload", () => {
    const r = reduceTicketTransitionEvent(transitionEvent());
    expect(r.ticket).toBe("CTL-1");
    expect(r.orchestrator).toBe("CTL-1");
    expect(r.toStage).toBe("plan");
    expect(r.toDisposition).toBe("needs-human");
    expect(r.worktreePath).toBe("/wt/CTL-1");
    expect(r.bgJobId).toBe("abc");
    expect(r.generation).toBe(1);
    expect(r.artifact).toBe("thoughts/x.md");
    expect(r.eventId).toBe("e1");
  });

  test("synthesizes an eventId when the envelope carries none", () => {
    const ev = transitionEvent({ top: { id: undefined } });
    delete ev.id;
    const r = reduceTicketTransitionEvent(ev);
    expect(typeof r.eventId).toBe("string");
    expect(r.eventId.length).toBeGreaterThan(0);
  });

  test("returns null for a non-transition event", () => {
    expect(
      reduceTicketTransitionEvent({ attributes: { "event.name": "phase.plan.complete.CTL-1" } })
    ).toBe(null);
    expect(reduceTicketTransitionEvent(null)).toBe(null);
    expect(reduceTicketTransitionEvent({})).toBe(null);
  });
});

describe("projectTicketTransitionEvent", () => {
  test("writes both tables idempotently (replay-safe)", () => {
    const ev = transitionEvent();
    projectTicketTransitionEvent(ev);
    projectTicketTransitionEvent(ev); // replay
    expect(getTicketStateTransitions("CTL-1").length).toBe(1);
    const w = getWorkerState("CTL-1", "CTL-1");
    expect(w.worktree_path).toBe("/wt/CTL-1");
    expect(w.bg_job_id).toBe("abc");
    expect(w.generation).toBe(1);
    expect(w.artifact_path).toBe("thoughts/x.md");
    expect(w.phase).toBe("plan");
  });

  test("does NOT set worker_state.status (status stays owned by phase/state branches)", () => {
    projectTicketTransitionEvent(transitionEvent());
    expect(getWorkerState("CTL-1", "CTL-1").status).toBe(null);
  });

  test("append-only history preserves each distinct transition; latest is newest by ts", () => {
    projectTicketTransitionEvent(
      transitionEvent({ top: { id: "e1", ts: "2026-07-22T00:00:00Z" }, payload: { to_stage: "plan" } })
    );
    projectTicketTransitionEvent(
      transitionEvent({
        top: { id: "e2", ts: "2026-07-22T00:01:00Z" },
        payload: { to_stage: "implement" },
        attributes: {},
      })
    );
    const all = getTicketStateTransitions("CTL-1");
    expect(all.length).toBe(2);
    expect(getLatestTicketStateTransition("CTL-1").to_stage).toBe("implement");
  });

  test("a null-path later transition never erases a captured worktree_path (sticky)", () => {
    projectTicketTransitionEvent(transitionEvent({ top: { id: "e1" } }));
    projectTicketTransitionEvent(
      transitionEvent({
        top: { id: "e2", ts: "2026-07-22T00:01:00Z" },
        payload: { worktree_path: null, bg_job_id: null, generation: null, artifact: null },
        attributes: {},
      })
    );
    const w = getWorkerState("CTL-1", "CTL-1");
    expect(w.worktree_path).toBe("/wt/CTL-1");
    expect(w.bg_job_id).toBe("abc");
  });
});
