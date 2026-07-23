// Unit tests for reconstruct-ticket-state.mjs (CTL-1490 Feature F).
// Run: cd plugins/dev/scripts/execution-core && bun test reconstruct-ticket-state.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconstructTicketState } from "./reconstruct-ticket-state.mjs";

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reconstruct-ticket-state-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// writeThoughtsDoc — create a dated thoughts doc for a given phase + ticket.
function writeThoughtsDoc(phase, ticket) {
  const DIRS = {
    triage: "thoughts/shared/phase-triage",
    research: "thoughts/shared/research",
    plan: "thoughts/shared/plans",
    verify: "thoughts/shared/phase-verify",
    review: "thoughts/shared/phase-review",
    pr: "thoughts/shared/phase-pr",
    "monitor-merge": "thoughts/shared/phase-monitor-merge",
    "monitor-deploy": "thoughts/shared/phase-monitor-deploy",
  };
  const relDir = DIRS[phase];
  if (!relDir) throw new Error(`No thoughts dir for phase: ${phase}`);
  const dir = join(tempDir, relDir);
  mkdirSync(dir, { recursive: true });
  const lc = ticket.toLowerCase();
  writeFileSync(join(dir, `2026-07-01-${lc}.md`), `# ${phase} doc for ${ticket}\n`);
}

// noWorktree — injectable buildWorktree that fails open but records if called.
function noWorktree() {
  return { ok: false, cwd: null };
}

// noPrs — injectable checkOpenPrs that returns empty.
function noPrs() {
  return { prs: [] };
}

describe("reconstructTicketState", () => {
  test("T1: archived-as-Done ticket → nextPhase null, worktree NOT rebuilt", async () => {
    let worktreeCalled = false;
    const result = await reconstructTicketState("CTL-9001", {
      repoRoot: tempDir,
      checkArchive: () => ({ terminal: true, completedPhases: ["triage", "research", "plan"] }),
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: () => {
        worktreeCalled = true;
        return { ok: true, cwd: "/tmp/wt" };
      },
    });
    expect(result.nextPhase).toBeNull();
    expect(result.pr).toBeNull();
    expect(result.worktree).toBeNull();
    expect(worktreeCalled).toBe(false);
  });

  test("T2: thoughts docs through review → nextPhase = pr, completedPhases includes review", async () => {
    for (const phase of ["triage", "research", "plan", "verify", "review"]) {
      writeThoughtsDoc(phase, "CTL-9002");
    }
    const result = await reconstructTicketState("CTL-9002", {
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.nextPhase).toBe("pr");
    expect(result.completedPhases).toContain("review");
    expect(result.completedPhases).not.toContain("pr");
  });

  test("T3: nothing done → nextPhase = research (NEW_WORK_ENTRY_PHASE), empty completedPhases", async () => {
    const result = await reconstructTicketState("CTL-9003", {
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.nextPhase).toBe("research");
    expect(result.completedPhases).toEqual([]);
  });

  test("T4: open PR exists → pr field populated from checkOpenPrs seam", async () => {
    const result = await reconstructTicketState("CTL-9004", {
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: () => ({ prs: [{ number: 42, state: "OPEN", isDraft: false }] }),
      buildWorktree: noWorktree,
    });
    expect(result.pr).not.toBeNull();
    expect(result.pr.number).toBe(42);
  });

  test("T5: non-terminal → calls buildWorktree with { ticket, repoRoot, expectedBranch: ticket }", async () => {
    writeThoughtsDoc("triage", "CTL-9005");
    let capturedArgs = null;
    const result = await reconstructTicketState("CTL-9005", {
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => null,
      checkOpenPrs: noPrs,
      buildWorktree: (ticket, opts) => {
        capturedArgs = { ticket, ...opts };
        return { ok: true, cwd: "/tmp/wt-ctl-9005" };
      },
    });
    expect(capturedArgs?.ticket).toBe("CTL-9005");
    expect(capturedArgs?.repoRoot).toBe(tempDir);
    expect(capturedArgs?.expectedBranch).toBe("CTL-9005");
    expect(result.worktree).toBe("/tmp/wt-ctl-9005");
  });

  test("T6: projection seam returns completed phases → used ahead of thoughts walk", async () => {
    // No thoughts docs on disk; projection provides phases through plan.
    const result = await reconstructTicketState("CTL-9006", {
      repoRoot: tempDir,
      checkArchive: () => null,
      getProjection: () => ({ completedPhases: ["triage", "research", "plan"] }),
      checkOpenPrs: noPrs,
      buildWorktree: noWorktree,
    });
    expect(result.completedPhases).toContain("plan");
    expect(result.nextPhase).toBe("implement");
  });
});
