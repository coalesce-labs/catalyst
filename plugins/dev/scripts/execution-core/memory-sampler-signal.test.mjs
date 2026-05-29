// memory-sampler-signal.test.mjs — CTL-685. Signal-writer for the OOM-kill path.
// Tests run against a temp directory; no real daemon state is touched.
//
// Run: cd plugins/dev/scripts/execution-core && bun test memory-sampler-signal.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMarkWorkerOom, resolveSignalPath } from "./memory-sampler-signal.mjs";

let tmpDir;
let workersDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ctl685-sig-"));
  workersDir = join(tmpDir, "workers");
  mkdirSync(workersDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSignal(ticket, phase, payload) {
  const dir = join(workersDir, ticket);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `phase-${phase}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

describe("defaultMarkWorkerOom", () => {
  test("flips signal to status:failed, failureReason:worker-oom atomically", () => {
    const sig = {
      ticket: "CTL-685",
      phase: "implement",
      status: "running",
      worktreePath: "/wt/CTL-685",
    };
    const signalPath = writeSignal("CTL-685", "implement", sig);

    const agent = { cwd: "/wt/CTL-685", sessionId: "aaaaaaaa-1111-2222-3333-444444444444" };
    const meta = { ticket: "CTL-685", phase: "implement" };
    const ok = defaultMarkWorkerOom(agent, meta, { coreDir: tmpDir });

    expect(ok).toBe(true);
    const updated = JSON.parse(readFileSync(signalPath, "utf8"));
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe("worker-oom");
    expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // original fields preserved
    expect(updated.ticket).toBe("CTL-685");
  });

  test("returns false without throwing when no matching signal exists", () => {
    const agent = { cwd: "/no/such/worktree", sessionId: "aaaaaaaa-1111-2222-3333-444444444444" };
    const meta = { ticket: "CTL-999", phase: "implement" };
    expect(() => defaultMarkWorkerOom(agent, meta, { coreDir: tmpDir })).not.toThrow();
    const ok = defaultMarkWorkerOom(agent, meta, { coreDir: tmpDir });
    expect(ok).toBe(false);
  });

  test("scan fallback matches by worktreePath when meta.ticket/phase absent", () => {
    const sig = {
      ticket: "CTL-685",
      phase: "implement",
      status: "running",
      worktreePath: "/wt/CTL-685-scan",
    };
    const signalPath = writeSignal("CTL-685", "implement", sig);

    const agent = { cwd: "/wt/CTL-685-scan", sessionId: "aaaaaaaa-1111-2222-3333-444444444444" };
    const ok = defaultMarkWorkerOom(agent, {}, { coreDir: tmpDir });
    expect(ok).toBe(true);
    const updated = JSON.parse(readFileSync(signalPath, "utf8"));
    expect(updated.status).toBe("failed");
  });
});

describe("resolveSignalPath", () => {
  test("returns direct path when meta.ticket + phase match and worktreePath matches", () => {
    const sig = { worktreePath: "/wt/CTL-685" };
    const signalPath = writeSignal("CTL-685", "implement", sig);
    const agent = { cwd: "/wt/CTL-685" };
    const meta = { ticket: "CTL-685", phase: "implement" };
    expect(resolveSignalPath(agent, meta, tmpDir)).toBe(signalPath);
  });

  test("returns direct path when agent.cwd is absent (no cwd check)", () => {
    const sig = { worktreePath: "/some/path" };
    const signalPath = writeSignal("CTL-685", "implement", sig);
    const agent = { cwd: null };
    const meta = { ticket: "CTL-685", phase: "implement" };
    expect(resolveSignalPath(agent, meta, tmpDir)).toBe(signalPath);
  });

  test("returns null when no workers dir exists", () => {
    rmSync(workersDir, { recursive: true, force: true });
    const agent = { cwd: "/wt/CTL-685" };
    const meta = {};
    expect(resolveSignalPath(agent, meta, tmpDir)).toBe(null);
  });

  test("scan fallback finds signal by worktreePath when meta absent", () => {
    const sig = { worktreePath: "/wt/CTL-685-scan" };
    const signalPath = writeSignal("CTL-685", "implement", sig);
    const agent = { cwd: "/wt/CTL-685-scan" };
    expect(resolveSignalPath(agent, {}, tmpDir)).toBe(signalPath);
  });

  test("returns null when no signal worktreePath matches agent.cwd", () => {
    writeSignal("CTL-685", "implement", { worktreePath: "/other/path" });
    const agent = { cwd: "/wt/CTL-685" };
    expect(resolveSignalPath(agent, {}, tmpDir)).toBe(null);
  });

  test("ignores yield tombstone files (phase-*-yield-*.json)", () => {
    const dir = join(workersDir, "CTL-685");
    mkdirSync(dir, { recursive: true });
    const tombstone = join(dir, "phase-implement-yield-abc12345.json");
    writeFileSync(tombstone, JSON.stringify({ worktreePath: "/wt/CTL-685" }));
    const agent = { cwd: "/wt/CTL-685" };
    expect(resolveSignalPath(agent, {}, tmpDir)).toBe(null);
  });
});
