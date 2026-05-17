// worker-signals-reader.test.ts — tests for the multi-orchestrator worker scan.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readWorkerSignals,
  scanOrchestratorWorkers,
  WORKER_RECENT_WINDOW_MS,
} from "./worker-signals-reader.ts";

const NOW = Date.parse("2026-05-14T16:00:00Z");

function makeSignal(over: Record<string, unknown>): Record<string, unknown> {
  return {
    ticket: "T-1",
    orchestrator: "orch-x",
    wave: 1,
    workerName: "orch-x-T-1",
    label: "oneshot T-1",
    status: "implementing",
    phase: 3,
    phaseTimestamps: {},
    lastHeartbeat: new Date(NOW - 5_000).toISOString(),
    startedAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 5_000).toISOString(),
    completedAt: null,
    worktreePath: "/tmp/wt",
    pr: null,
    linearState: null,
    definitionOfDone: {},
    pid: 12345,
    ...over,
  };
}

function setupOrch(root: string, orchName: string, signals: Record<string, unknown>[]) {
  const dir = join(root, orchName, "workers");
  mkdirSync(dir, { recursive: true });
  for (const s of signals) {
    const ticket = (s["ticket"] as string) ?? "T-?";
    writeFileSync(join(dir, `${ticket}.json`), JSON.stringify(s));
  }
}

interface PerPhaseFixture {
  phase: string;
  status?: string;
  updatedAt?: string;
  model?: string;
}

function setupPerPhaseOrch(
  root: string,
  orchName: string,
  ticket: string,
  phases: PerPhaseFixture[],
) {
  const dir = join(root, orchName, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  for (const p of phases) {
    writeFileSync(
      join(dir, `phase-${p.phase}.json`),
      JSON.stringify({
        ticket,
        phase: p.phase,
        orchestrator: orchName,
        model: p.model ?? "sonnet",
        turnCap: 50,
        status: p.status ?? "running",
        bg_job_id: "bg-fake",
        startedAt: p.updatedAt ?? new Date(NOW - 60_000).toISOString(),
        updatedAt: p.updatedAt ?? new Date(NOW - 5_000).toISOString(),
      }),
    );
  }
}

describe("readWorkerSignals", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-ws-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("missing runs dir → empty", () => {
    expect(readWorkerSignals(join(tmp, "missing"), NOW)).toEqual([]);
  });

  test("single orchestrator with two workers", () => {
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-1", workerName: "orch-a-T-1" }),
      makeSignal({ ticket: "T-2", workerName: "orch-a-T-2", status: "researching" }),
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(2);
    const names = out.map((w) => w.workerName).sort();
    expect(names).toEqual(["orch-a-T-1", "orch-a-T-2"]);
  });

  test("two orchestrators merge", () => {
    setupOrch(tmp, "orch-a", [makeSignal({ ticket: "T-1", workerName: "orch-a-T-1" })]);
    setupOrch(tmp, "orch-b", [
      makeSignal({ ticket: "T-9", workerName: "orch-b-T-9", orchestrator: "orch-b" }),
      makeSignal({ ticket: "T-8", workerName: "orch-b-T-8", orchestrator: "orch-b" }),
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(3);
  });

  test("done workers older than the recent window are filtered out", () => {
    const oldTs = new Date(NOW - WORKER_RECENT_WINDOW_MS - 60_000).toISOString();
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-old", workerName: "orch-a-T-old", status: "done", updatedAt: oldTs, completedAt: oldTs }),
      makeSignal({ ticket: "T-active", workerName: "orch-a-T-active" }),
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].workerName).toBe("orch-a-T-active");
  });

  test("recently-done workers (within window) stay visible", () => {
    const recentTs = new Date(NOW - 5 * 60_000).toISOString();
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-fresh", workerName: "orch-a-T-fresh", status: "done", updatedAt: recentTs, completedAt: recentTs }),
    ]);
    expect(readWorkerSignals(tmp, NOW)).toHaveLength(1);
  });

  test("failed workers follow the same recent-window rule", () => {
    const oldTs = new Date(NOW - WORKER_RECENT_WINDOW_MS - 1_000).toISOString();
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-failed-old", workerName: "orch-a-T-failed-old", status: "failed", updatedAt: oldTs }),
      makeSignal({ ticket: "T-failed-new", workerName: "orch-a-T-failed-new", status: "failed", updatedAt: new Date(NOW - 60_000).toISOString() }),
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].workerName).toBe("orch-a-T-failed-new");
  });

  test("in-progress workers are kept regardless of updatedAt age", () => {
    const ancient = new Date(NOW - 365 * 86_400_000).toISOString();
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-stuck", workerName: "orch-a-T-stuck", status: "implementing", updatedAt: ancient }),
    ]);
    expect(readWorkerSignals(tmp, NOW)).toHaveLength(1);
  });

  test("malformed JSON files are skipped, others kept", () => {
    setupOrch(tmp, "orch-a", [makeSignal({ ticket: "T-good", workerName: "orch-a-T-good" })]);
    writeFileSync(join(tmp, "orch-a", "workers", "T-bad.json"), "{ not valid");
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].workerName).toBe("orch-a-T-good");
  });

  test("rollup files (e.g. -rollup.md ignored implicitly, -rollup.json skipped)", () => {
    setupOrch(tmp, "orch-a", [makeSignal({ ticket: "T-1", workerName: "orch-a-T-1" })]);
    writeFileSync(join(tmp, "orch-a", "workers", "T-1-rollup.md"), "# notes");
    writeFileSync(join(tmp, "orch-a", "workers", "T-1-rollup.json"), JSON.stringify({ junk: true }));
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
  });

  test("dedupe by workerName when two files conflict", () => {
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-1", workerName: "shared", status: "implementing" }),
    ]);
    setupOrch(tmp, "orch-b", [
      makeSignal({ ticket: "T-1", workerName: "shared", orchestrator: "orch-b", status: "done", updatedAt: new Date(NOW).toISOString() }),
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
  });

  test("signal missing required fields is skipped", () => {
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-good", workerName: "orch-a-T-good" }),
    ]);
    writeFileSync(join(tmp, "orch-a", "workers", "T-bad.json"), JSON.stringify({ status: "implementing" }));
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
  });
});

describe("readWorkerSignals (per-phase layout)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-ws-pa-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("per-phase only: surfaces a single ticket as one row with phaseName", () => {
    setupPerPhaseOrch(tmp, "orch-pa", "T-100", [{ phase: "implement" }]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.ticket).toBe("T-100");
    expect(row.phaseName).toBe("implement");
    expect(row.status).toBe("running");
    expect(row.workerName).toBe("orch-pa-T-100");
  });

  test("per-phase: latest non-terminal phase wins when multiple files present", () => {
    setupPerPhaseOrch(tmp, "orch-pa", "T-100", [
      { phase: "triage", updatedAt: new Date(NOW - 10 * 60_000).toISOString() },
      { phase: "implement", updatedAt: new Date(NOW - 60_000).toISOString() },
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].phaseName).toBe("implement");
    expect(out[0].updatedAt).toBe(new Date(NOW - 60_000).toISOString());
  });

  test("per-phase + flat coexist: overlay merges phaseName onto flat signal", () => {
    setupOrch(tmp, "orch-pa", [
      makeSignal({
        ticket: "T-100",
        workerName: "orch-pa-T-100",
        orchestrator: "orch-pa",
        status: "implementing",
        pr: { number: 42, url: "" },
        worktreePath: "/tmp/wt-100",
      }),
    ]);
    setupPerPhaseOrch(tmp, "orch-pa", "T-100", [
      { phase: "verify", updatedAt: new Date(NOW - 30_000).toISOString() },
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.ticket).toBe("T-100");
    expect(row.phaseName).toBe("verify");
    expect(row.pr?.number).toBe(42);
    expect(row.worktreePath).toBe("/tmp/wt-100");
    expect(row.status).toBe("running"); // per-phase status wins
  });

  test("per-phase directory with no phase-*.json is skipped silently", () => {
    setupOrch(tmp, "orch-pa", [makeSignal({ ticket: "T-flat", workerName: "orch-pa-T-flat" })]);
    mkdirSync(join(tmp, "orch-pa", "workers", "T-empty"), { recursive: true });
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].ticket).toBe("T-flat");
  });

  test("mixed orch: flat-only ticket + per-phase-only ticket → both surface", () => {
    setupOrch(tmp, "orch-pa", [makeSignal({ ticket: "T-A", workerName: "orch-pa-T-A", orchestrator: "orch-pa" })]);
    setupPerPhaseOrch(tmp, "orch-pa", "T-B", [{ phase: "research" }]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(2);
    const tickets = out.map((w) => w.ticket).sort();
    expect(tickets).toEqual(["T-A", "T-B"]);
    const phaseNames = out.map((w) => w.phaseName).sort();
    expect(phaseNames).toEqual([null, "research"]);
  });

  test("per-phase: all-terminal phases fall back to most-recent overall", () => {
    setupPerPhaseOrch(tmp, "orch-pa", "T-100", [
      { phase: "triage", status: "done", updatedAt: new Date(NOW - 30 * 60_000).toISOString() },
      { phase: "research", status: "done", updatedAt: new Date(NOW - 10 * 60_000).toISOString() },
      { phase: "plan", status: "failed", updatedAt: new Date(NOW - 2 * 60_000).toISOString() },
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].phaseName).toBe("plan");
    expect(out[0].status).toBe("failed");
  });

  test("per-phase: malformed JSON and missing required fields are skipped, valid file surfaces", () => {
    const dir = join(tmp, "orch-pa", "workers", "T-100");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-broken.json"), "{ not valid json");
    writeFileSync(
      join(dir, "phase-missing-ticket.json"),
      JSON.stringify({ phase: "verify", orchestrator: "orch-pa", status: "running" }),
    );
    writeFileSync(
      join(dir, "phase-valid.json"),
      JSON.stringify({
        ticket: "T-100",
        phase: "implement",
        orchestrator: "orch-pa",
        model: "sonnet",
        turnCap: 50,
        status: "running",
        bg_job_id: "bg-good",
        startedAt: new Date(NOW - 60_000).toISOString(),
        updatedAt: new Date(NOW - 5_000).toISOString(),
      }),
    );
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].phaseName).toBe("implement");
  });

  test("legacy flat-only orch still works (no regression when no subdirs present)", () => {
    setupOrch(tmp, "orch-legacy", [
      makeSignal({ ticket: "T-1", workerName: "orch-legacy-T-1", orchestrator: "orch-legacy" }),
      makeSignal({ ticket: "T-2", workerName: "orch-legacy-T-2", orchestrator: "orch-legacy", status: "researching" }),
    ]);
    const out = readWorkerSignals(tmp, NOW);
    expect(out).toHaveLength(2);
    expect(out.every((w) => w.phaseName === null)).toBe(true);
  });
});

describe("scanOrchestratorWorkers", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-ws2-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("returns workers for a single orch dir without applying the recent-window filter", () => {
    const ancient = new Date(NOW - 365 * 86_400_000).toISOString();
    setupOrch(tmp, "orch-a", [
      makeSignal({ ticket: "T-ancient", workerName: "orch-a-T-ancient", status: "done", updatedAt: ancient, completedAt: ancient }),
    ]);
    const out = scanOrchestratorWorkers(join(tmp, "orch-a"));
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("done");
  });

  test("missing workers/ dir → empty", () => {
    mkdirSync(join(tmp, "orch-empty"), { recursive: true });
    expect(scanOrchestratorWorkers(join(tmp, "orch-empty"))).toEqual([]);
  });
});
