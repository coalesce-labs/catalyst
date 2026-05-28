// Unit tests for gc-liveness.mjs (CTL-643).
// Liveness probes for the broker boot-time GC pass — decide whether a single
// interest's owning orchestrator/ticket or session is still active.
// Run: bun test plugins/dev/scripts/broker/gc-liveness.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOrchestratorActive, isSessionAlive } from "./gc-liveness.mjs";

let tmpDir;
let execCoreOrchDir;
let runsRoot;
let jobsRoot;
let statJob;

function writeSignal(orchDir, ticket, phase, body) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(body));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gc-liveness-test-"));
  execCoreOrchDir = join(tmpDir, "execution-core");
  runsRoot = join(tmpDir, "runs");
  jobsRoot = join(tmpDir, "jobs");
  mkdirSync(execCoreOrchDir, { recursive: true });
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(jobsRoot, { recursive: true });

  // Execution-core: in-flight ticket (one running implement signal).
  writeSignal(execCoreOrchDir, "CTL-700", "implement", {
    ticket: "CTL-700",
    phase: "implement",
    status: "running",
    bg_job_id: "live-job",
  });
  // Execution-core: all-terminal ticket (monitor-deploy done).
  writeSignal(execCoreOrchDir, "CTL-701", "monitor-deploy", {
    ticket: "CTL-701",
    phase: "monitor-deploy",
    status: "done",
  });
  // Execution-core: failed ticket — not in-flight.
  writeSignal(execCoreOrchDir, "CTL-702", "verify", {
    ticket: "CTL-702",
    phase: "verify",
    status: "failed",
  });
  // Legacy run dir.
  mkdirSync(join(runsRoot, "o-legacy-123", "workers"), { recursive: true });
  writeFileSync(join(runsRoot, "o-legacy-123", "workers", "x.json"), "{}");

  // Session liveness fixtures.
  const live = { "live-session": { mtime: 1, state: {} } };
  statJob = (sid) => live[sid] ?? null;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("isOrchestratorActive", () => {
  test("returns true for an execution-core ticket with a running phase signal", () => {
    expect(isOrchestratorActive("CTL-700", { execCoreOrchDir, runsRoot })).toBe(true);
  });

  test("returns false for an execution-core ticket whose only signal is terminal-done", () => {
    expect(isOrchestratorActive("CTL-701", { execCoreOrchDir, runsRoot })).toBe(false);
  });

  test("returns false for an execution-core ticket whose only signal is failed", () => {
    expect(isOrchestratorActive("CTL-702", { execCoreOrchDir, runsRoot })).toBe(false);
  });

  test("returns true for a legacy orchestrator with a runs/<X>/workers/ dir", () => {
    expect(isOrchestratorActive("o-legacy-123", { execCoreOrchDir, runsRoot })).toBe(true);
  });

  test("returns false for a pure orphan with no signal-file dir under either root", () => {
    expect(isOrchestratorActive("CTL-999", { execCoreOrchDir, runsRoot })).toBe(false);
  });

  test("returns false for empty or null orchestrator id", () => {
    expect(isOrchestratorActive("", { execCoreOrchDir, runsRoot })).toBe(false);
    expect(isOrchestratorActive(null, { execCoreOrchDir, runsRoot })).toBe(false);
    expect(isOrchestratorActive(undefined, { execCoreOrchDir, runsRoot })).toBe(false);
  });

  test("tolerates missing roots", () => {
    expect(isOrchestratorActive("CTL-700", {})).toBe(false);
  });
});

describe("isSessionAlive", () => {
  test("returns true for a session whose statJob resolves to a state object", () => {
    expect(isSessionAlive("live-session", { statJob })).toBe(true);
  });

  test("returns false for a session whose statJob returns null", () => {
    expect(isSessionAlive("dead-session", { statJob })).toBe(false);
  });

  test("returns false for empty or null session id", () => {
    expect(isSessionAlive("", { statJob })).toBe(false);
    expect(isSessionAlive(null, { statJob })).toBe(false);
  });

  test("returns false when statJob is not a function", () => {
    expect(isSessionAlive("live-session", {})).toBe(false);
  });
});
