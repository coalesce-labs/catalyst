// projection-reader.test.mjs — CTL-1489: daemon-side projection-backed readers.
// Run: cd plugins/dev/scripts/execution-core && bun test projection-reader.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertWorkerState,
  recordTicketStateTransition,
} from "../broker/broker-state.mjs";
import {
  readWorkerSignalsFromProjection,
  findHeldRunFromProjection,
} from "./projection-reader.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "proj-reader-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedWorker(over = {}) {
  const pick = (k, dflt) => (k in over ? over[k] : dflt);
  upsertWorkerState({
    orchestrator: pick("orchestrator", "CTL-1"),
    ticket: pick("ticket", "CTL-1"),
    phase: pick("phase", "implement"),
    status: pick("status", "running"),
    worktreePath: pick("worktreePath", "/wt/CTL-1"),
    bgJobId: pick("bgJobId", "bg-1"),
    generation: pick("generation", 2),
    artifact: pick("artifact", "thoughts/x.md"),
    eventTs: pick("eventTs", "2026-07-22T00:00:00Z"),
    eventId: pick("eventId", "e1"),
  });
}

describe("readWorkerSignalsFromProjection", () => {
  test("reproduces the WorkerSignal shape from durable state", () => {
    seedWorker();
    const sigs = readWorkerSignalsFromProjection();
    const s = sigs.find((x) => x.ticket === "CTL-1");
    expect(s).toBeDefined();
    for (const k of [
      "ticket",
      "layout",
      "signalPath",
      "phase",
      "status",
      "liveness",
      "updatedAt",
      "pr",
      "worktreePath",
      "host",
      "raw",
    ]) {
      expect(k in s, `missing ${k}`).toBe(true);
    }
    expect(s.liveness.kind).toBe("bg"); // derived from bg_job_id
    expect(s.liveness.value).toBe("bg-1");
    expect(s.worktreePath).toBe("/wt/CTL-1");
    expect(s.phase).toBe("implement");
    expect(s.status).toBe("running");
    expect(s.raw.generation).toBe(2);
    expect(s.raw.artifact).toBe("thoughts/x.md");
  });

  test("liveness.kind is pid when bg_job_id is absent", () => {
    seedWorker({ ticket: "CTL-2", bgJobId: null });
    const s = readWorkerSignalsFromProjection().find((x) => x.ticket === "CTL-2");
    expect(s.liveness.kind).toBe("pid");
    expect(s.liveness.value).toBe(null);
  });

  test("returns [] (never throws) when the DB has no rows", () => {
    expect(readWorkerSignalsFromProjection()).toEqual([]);
  });

  test("optional orchestrator filter narrows the result set", () => {
    seedWorker({ orchestrator: "CTL-1", ticket: "CTL-1" });
    seedWorker({ orchestrator: "CTL-9", ticket: "CTL-9" });
    const only = readWorkerSignalsFromProjection(undefined, { orchestrator: "CTL-9" });
    expect(only.map((s) => s.ticket)).toEqual(["CTL-9"]);
  });
});

describe("findHeldRunFromProjection", () => {
  test("returns { phase, signal } for a needs-input worker", () => {
    seedWorker({ ticket: "CTL-3", phase: "implement", status: "needs-input" });
    const held = findHeldRunFromProjection("CTL-3");
    expect(held).not.toBe(null);
    expect(held.phase).toBe("implement");
    expect(held.signal.ticket).toBe("CTL-3");
    expect(held.signal.status).toBe("needs-input");
  });

  test("returns { phase, signal } for a stalled worker", () => {
    seedWorker({ ticket: "CTL-4", phase: "verify", status: "stalled" });
    expect(findHeldRunFromProjection("CTL-4").phase).toBe("verify");
  });

  test("returns null for a running (not-held) worker", () => {
    seedWorker({ ticket: "CTL-5", status: "running" });
    expect(findHeldRunFromProjection("CTL-5")).toBe(null);
  });

  test("returns null for an unknown ticket", () => {
    expect(findHeldRunFromProjection("CTL-NOPE")).toBe(null);
  });

  test("surfaces the artifact pointer from the latest transition when worker_state has none", () => {
    upsertWorkerState({
      orchestrator: "CTL-6",
      ticket: "CTL-6",
      phase: "implement",
      status: "needs-input",
      eventTs: "2026-07-22T00:00:00Z",
      eventId: "w6",
    });
    recordTicketStateTransition({
      eventId: "t6",
      orchestrator: "CTL-6",
      ticket: "CTL-6",
      toStage: "implement",
      artifact: "thoughts/plan-6.md",
      ts: "2026-07-22T00:00:01Z",
    });
    const held = findHeldRunFromProjection("CTL-6");
    expect(held.signal.raw.artifact).toBe("thoughts/plan-6.md");
  });
});
