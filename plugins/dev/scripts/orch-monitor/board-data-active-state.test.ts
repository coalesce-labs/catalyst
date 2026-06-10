// CTL-729: unit tests for deriveActiveState() — the widened BoardActiveState
// that now includes "needs-human" (escalated by the progress watchdog).
// Uses a temp dir per test so marker files are fully isolated.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// board-data.mjs is plain JS — import dynamically so TS doesn't choke on the path.
const { deriveActiveState } = await import("./lib/board-data.mjs");

const STUCK_MS = 1_800_000; // 30 min — matches the constant in board-data.mjs

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ctl-729-active-state-"));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function withDir(cb: (dir: string) => void): string {
  const dir = makeTmpDir();
  cleanupDirs.push(dir);
  cb(dir);
  return dir;
}

describe("deriveActiveState (CTL-729)", () => {
  it("returns 'active' when no markers and ageMs is fresh", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "implement", 60_000, dir);
    expect(result).toBe("active");
  });

  it("returns 'needs-human' when .linear-label-needs-human.applied exists", async () => {
    const dir = withDir((d) => writeFileSync(join(d, ".linear-label-needs-human.applied"), ""));
    const result = await deriveActiveState("CTL-999", "implement", 60_000, dir);
    expect(result).toBe("needs-human");
  });

  it("needs-human beats stuck (marker + old transcript)", async () => {
    const dir = withDir((d) => {
      writeFileSync(join(d, ".linear-label-needs-human.applied"), "");
      writeFileSync(join(d, ".terminal-done.applied"), "");
    });
    const result = await deriveActiveState("CTL-999", "implement", STUCK_MS + 1, dir);
    expect(result).toBe("needs-human");
  });

  it("returns 'stuck' when .terminal-done.applied exists (no needs-human)", async () => {
    const dir = withDir((d) => writeFileSync(join(d, ".terminal-done.applied"), ""));
    const result = await deriveActiveState("CTL-999", "implement", 0, dir);
    expect(result).toBe("stuck");
  });

  it("returns 'stuck' when .worktree-removed exists", async () => {
    const dir = withDir((d) => writeFileSync(join(d, ".worktree-removed"), ""));
    const result = await deriveActiveState("CTL-999", "implement", 0, dir);
    expect(result).toBe("stuck");
  });

  it("returns 'stuck' when transcript is stale beyond STUCK_MS", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "implement", STUCK_MS + 1, dir);
    expect(result).toBe("stuck");
  });

  it("returns 'active' when transcript is exactly at STUCK_MS boundary", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "implement", STUCK_MS, dir);
    expect(result).toBe("active");
  });

  it("returns 'active' for wait-heavy phase (monitor-merge) even with stale transcript", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "monitor-merge", STUCK_MS + 1, dir);
    expect(result).toBe("active");
  });

  it("returns 'active' for wait-heavy phase (monitor-deploy) even with stale transcript", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "monitor-deploy", STUCK_MS + 1, dir);
    expect(result).toBe("active");
  });

  it("returns 'active' for wait-heavy phase (pr) even with stale transcript", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "pr", STUCK_MS + 1, dir);
    expect(result).toBe("active");
  });

  it("needs-human still wins for wait-heavy phase", async () => {
    const dir = withDir((d) => writeFileSync(join(d, ".linear-label-needs-human.applied"), ""));
    const result = await deriveActiveState("CTL-999", "monitor-merge", STUCK_MS + 1, dir);
    expect(result).toBe("needs-human");
  });

  it("returns 'active' when ageMs is null (transcript path not found)", async () => {
    const dir = withDir(() => {});
    const result = await deriveActiveState("CTL-999", "implement", null, dir);
    expect(result).toBe("active");
  });
});
