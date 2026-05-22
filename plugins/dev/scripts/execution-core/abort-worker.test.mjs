// Unit tests for the kill-on-drag-out abort module (CTL-565 Phase 4).
// Run: cd plugins/dev/scripts/execution-core && bun test abort-worker.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortWorker } from "./abort-worker.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "abort-worker-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// writeSignal — write workers/<ticket>/phase-<phase>.json with the given body.
function writeSignal(ticket, phase, body) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(body));
}

// readSignal — parse a worker's phase-<phase>.json back.
function readSignal(ticket, phase) {
  return JSON.parse(
    readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"),
  );
}

describe("abortWorker", () => {
  test("rewrites every non-terminal phase signal to status 'aborted'", () => {
    writeSignal("CTL-1", "research", { status: "done" });
    writeSignal("CTL-1", "plan", { status: "running" });
    const r = abortWorker(orchDir, "CTL-1", {
      killJob: () => {},
      teardownWorktree: () => true,
    });
    expect(r.signalsMarked).toEqual(["plan"]); // 'research' (done) left untouched
    expect(readSignal("CTL-1", "plan").status).toBe("aborted");
    expect(readSignal("CTL-1", "research").status).toBe("done");
  });

  test("calls killJob once per distinct bg_job_id", () => {
    writeSignal("CTL-1", "plan", { status: "running", bg_job_id: "abc" });
    const killed = [];
    abortWorker(orchDir, "CTL-1", {
      killJob: (id) => killed.push(id),
      teardownWorktree: () => true,
    });
    expect(killed).toEqual(["abc"]);
  });

  test("calls teardownWorktree once with { repoRoot, ticket }", () => {
    writeSignal("CTL-1", "plan", { status: "running" });
    const calls = [];
    abortWorker(orchDir, "CTL-1", {
      repoRoot: "/repo",
      killJob: () => {},
      teardownWorktree: (a) => {
        calls.push(a);
        return true;
      },
    });
    expect(calls).toEqual([{ repoRoot: "/repo", ticket: "CTL-1" }]);
  });

  test("skips worktree teardown while a bg job is still live (unkilled)", () => {
    // killJob returns false (no `claude` bg-kill verb) → the job is presumed
    // alive → tearing down its worktree would yank the fs from under it.
    writeSignal("CTL-1", "plan", { status: "running", bg_job_id: "live-1" });
    let teardownCalled = false;
    const r = abortWorker(orchDir, "CTL-1", {
      repoRoot: "/repo",
      killJob: () => false,
      teardownWorktree: () => {
        teardownCalled = true;
        return true;
      },
    });
    expect(teardownCalled).toBe(false);
    expect(r.worktreeRemoved).toBe(false);
    expect(r.aborted).toBe(true); // signals are still marked
  });

  test("tears the worktree down once every bg job was confirmed killed", () => {
    writeSignal("CTL-1", "plan", { status: "running", bg_job_id: "k-1" });
    let teardownArgs = null;
    abortWorker(orchDir, "CTL-1", {
      repoRoot: "/repo",
      killJob: () => true, // confirmed killed → safe to remove the worktree
      teardownWorktree: (a) => {
        teardownArgs = a;
        return true;
      },
    });
    expect(teardownArgs).toEqual({ repoRoot: "/repo", ticket: "CTL-1" });
  });

  test("a ticket with no worker dir is a clean no-op", () => {
    const r = abortWorker(orchDir, "CTL-NOPE", {
      killJob: () => {
        throw new Error("x");
      },
      teardownWorktree: () => {
        throw new Error("x");
      },
    });
    expect(r).toMatchObject({ aborted: false, signalsMarked: [] });
  });

  test("a ticket whose every signal is already terminal is a no-op (no kill, no teardown)", () => {
    writeSignal("CTL-DONE", "research", { status: "done" });
    writeSignal("CTL-DONE", "monitor-deploy", { status: "done" });
    let teardownCalled = false;
    const r = abortWorker(orchDir, "CTL-DONE", {
      killJob: () => {},
      teardownWorktree: () => {
        teardownCalled = true;
        return true;
      },
    });
    expect(r.aborted).toBe(false);
    expect(teardownCalled).toBe(false);
  });

  test("a throwing killJob / teardownWorktree never propagates — signals still marked", () => {
    writeSignal("CTL-1", "plan", { status: "running" });
    const r = abortWorker(orchDir, "CTL-1", {
      killJob: () => {
        throw new Error("kill boom");
      },
      teardownWorktree: () => {
        throw new Error("teardown boom");
      },
    });
    expect(r.aborted).toBe(true);
    expect(readSignal("CTL-1", "plan").status).toBe("aborted"); // marking survives the throws
  });

  test("stamps an abortedAt ISO timestamp on a marked signal", () => {
    writeSignal("CTL-1", "implement", { status: "running" });
    abortWorker(orchDir, "CTL-1", { killJob: () => {}, teardownWorktree: () => true });
    const signal = readSignal("CTL-1", "implement");
    expect(typeof signal.abortedAt).toBe("string");
    expect(Number.isNaN(Date.parse(signal.abortedAt))).toBe(false);
  });
});
