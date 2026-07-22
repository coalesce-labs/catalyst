// projection-shadow-diff.test.mjs — CTL-1489 shadow-diff drift harness.
// Run: cd plugins/dev/scripts/execution-core && bun test projection-shadow-diff.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertWorkerState,
} from "../broker/broker-state.mjs";
import {
  diffProjectionVsLocal,
  runProjectionShadowDiff,
  normalizeForDiff,
} from "./projection-shadow-diff.mjs";

const localSig = (over = {}) => ({
  ticket: over.ticket ?? "CTL-1",
  layout: "nested",
  signalPath: "/some/path/phase-implement.json", // volatile — normalized out
  phase: over.phase ?? "implement",
  status: over.status ?? "running",
  liveness: { kind: "bg", value: over.bgJobId ?? "bg-1" },
  updatedAt: over.updatedAt ?? "2026-07-22T00:00:00Z", // volatile — normalized out
  pr: over.pr ?? null,
  worktreePath: over.worktreePath ?? "/wt/CTL-1",
  host: { name: "mini-2" }, // volatile — normalized out
  raw: { generation: over.generation ?? 2, artifact: over.artifact ?? "thoughts/x.md", bg_job_id: over.bgJobId ?? "bg-1" },
});

const projSig = (over = {}) => ({
  ticket: over.ticket ?? "CTL-1",
  layout: "projection",
  signalPath: "<projection>",
  phase: over.phase ?? "implement",
  status: over.status ?? "running",
  liveness: { kind: "bg", value: over.bgJobId ?? "bg-1" },
  updatedAt: "2026-07-22T00:05:00Z",
  pr: over.pr ?? null,
  worktreePath: over.worktreePath ?? "/wt/CTL-1",
  host: null,
  raw: { generation: over.generation ?? 2, artifact: over.artifact ?? "thoughts/x.md", bg_job_id: over.bgJobId ?? "bg-1" },
});

describe("normalizeForDiff", () => {
  test("drops volatile fields (signalPath, updatedAt, host, layout)", () => {
    const n = normalizeForDiff(localSig());
    expect("signalPath" in n).toBe(false);
    expect("updatedAt" in n).toBe(false);
    expect("host" in n).toBe(false);
    expect("layout" in n).toBe(false);
    expect(n.status).toBe("running");
    expect(n.worktreePath).toBe("/wt/CTL-1");
  });

  test("a local (structurally different) and projection signal normalize equal when decision-fields match", () => {
    expect(JSON.stringify(normalizeForDiff(localSig()))).toBe(JSON.stringify(normalizeForDiff(projSig())));
  });
});

describe("diffProjectionVsLocal", () => {
  test("all match → exit 0, zero drift", () => {
    const r = diffProjectionVsLocal({ localSignals: [localSig()], projectionSignals: [projSig()] });
    expect(r.exitCode).toBe(0);
    expect(r.drift).toBe(0);
    expect(r.match).toBe(1);
  });

  test("a decision-field mismatch → exit 1 + the drifted ticket listed", () => {
    const r = diffProjectionVsLocal({
      localSignals: [localSig({ status: "needs-input" })],
      projectionSignals: [projSig({ status: "running" })],
    });
    expect(r.exitCode).toBe(1);
    expect(r.drift).toBe(1);
    expect(r.driftTickets).toEqual(["CTL-1"]);
  });

  test("signal-only ticket → missing (non-strict exit 0, strict exit 1)", () => {
    const nonStrict = diffProjectionVsLocal({ localSignals: [localSig()], projectionSignals: [] });
    expect(nonStrict.missing).toBe(1);
    expect(nonStrict.exitCode).toBe(0);
    const strict = diffProjectionVsLocal({ localSignals: [localSig()], projectionSignals: [], strict: true });
    expect(strict.exitCode).toBe(1);
    expect(strict.missingTickets).toEqual(["CTL-1"]);
  });
});

describe("runProjectionShadowDiff (real readers)", () => {
  let tmpDir, orchDir, dbPath;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proj-shadow-"));
    orchDir = join(tmpDir, "orch");
    dbPath = join(tmpDir, "filter-state.db");
  });
  afterEach(() => {
    closeBrokerStateDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLocal(ticket, data) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-implement.json"), JSON.stringify({ ticket, phase: "implement", ...data }));
  }

  test("exit 2 when there is no workers dir", () => {
    const r = runProjectionShadowDiff(join(tmpDir, "nope"), { dbPath: null });
    expect(r.exitCode).toBe(2);
  });

  test("matching local + projection → exit 0", () => {
    writeLocal("CTL-1", {
      status: "running",
      worktreePath: "/wt/CTL-1",
      bg_job_id: "bg-1",
      generation: 2,
      artifact: "thoughts/x.md",
    });
    openBrokerStateDb(dbPath);
    upsertWorkerState({
      orchestrator: "CTL-1",
      ticket: "CTL-1",
      phase: "implement",
      status: "running",
      worktreePath: "/wt/CTL-1",
      bgJobId: "bg-1",
      generation: 2,
      artifact: "thoughts/x.md",
      eventTs: "2026-07-22T00:00:00Z",
      eventId: "e1",
    });
    closeBrokerStateDb();
    const r = runProjectionShadowDiff(orchDir, { dbPath });
    expect(r.exitCode).toBe(0);
    expect(r.drift).toBe(0);
  });

  test("drift when the projection disagrees on status → exit 1", () => {
    writeLocal("CTL-1", { status: "needs-input", worktreePath: "/wt/CTL-1", bg_job_id: "bg-1", generation: 2, artifact: "thoughts/x.md" });
    openBrokerStateDb(dbPath);
    upsertWorkerState({
      orchestrator: "CTL-1",
      ticket: "CTL-1",
      phase: "implement",
      status: "running", // diverges from local needs-input
      worktreePath: "/wt/CTL-1",
      bgJobId: "bg-1",
      generation: 2,
      artifact: "thoughts/x.md",
      eventTs: "2026-07-22T00:00:00Z",
      eventId: "e1",
    });
    closeBrokerStateDb();
    const r = runProjectionShadowDiff(orchDir, { dbPath });
    expect(r.exitCode).toBe(1);
    expect(r.driftTickets).toEqual(["CTL-1"]);
  });
});
