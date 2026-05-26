// tidy.test.mjs — Phase 8 of CTL-649. The `tidy` umbrella composes
// sessions → worktrees → branches → `git worktree prune` in the ONLY safe
// order: stopping sessions first means worktree removal never creates fresh
// orphans (the Component-5 leak, inverted). All four steps are injected.

import { describe, it, expect } from "bun:test";
import { runTidy } from "./tidy.mjs";

describe("runTidy", () => {
  it("invokes sessions → worktrees → branches → git-wt-prune in that exact order", async () => {
    const calls = [];
    await runTidy({
      cmdSessions: () => calls.push("sessions"),
      cmdWorktrees: () => calls.push("worktrees"),
      cmdBranches: () => calls.push("branches"),
      cmdGitWorktreePrune: () => calls.push("git-wt-prune"),
      yes: true,
    });
    expect(calls).toEqual(["sessions", "worktrees", "branches", "git-wt-prune"]);
  });

  it("aborts the chain if sessions prune fails (avoids orphan-creating worktree-prune)", async () => {
    const calls = [];
    const result = await runTidy({
      cmdSessions: () => {
        calls.push("sessions");
        throw new Error("boom");
      },
      cmdWorktrees: () => calls.push("worktrees"),
      cmdBranches: () => calls.push("branches"),
      cmdGitWorktreePrune: () => calls.push("git-wt-prune"),
      yes: true,
    });
    expect(calls).toEqual(["sessions"]);
    expect(result.failedAt).toBe("sessions");
  });

  it("aborts mid-chain if worktrees prune fails (branches + git-prune skipped)", async () => {
    const calls = [];
    const result = await runTidy({
      cmdSessions: () => calls.push("sessions"),
      cmdWorktrees: () => {
        calls.push("worktrees");
        throw new Error("boom");
      },
      cmdBranches: () => calls.push("branches"),
      cmdGitWorktreePrune: () => calls.push("git-wt-prune"),
      yes: true,
    });
    expect(calls).toEqual(["sessions", "worktrees"]);
    expect(result.failedAt).toBe("worktrees");
  });

  it("--dry-run propagates to all three prune sub-commands", async () => {
    const seen = [];
    await runTidy({
      cmdSessions: ({ dryRun }) => seen.push(["s", dryRun]),
      cmdWorktrees: ({ dryRun }) => seen.push(["w", dryRun]),
      cmdBranches: ({ dryRun }) => seen.push(["b", dryRun]),
      cmdGitWorktreePrune: () => {},
      dryRun: true,
    });
    expect(seen).toEqual([
      ["s", true],
      ["w", true],
      ["b", true],
    ]);
  });

  it("skips git worktree prune in dry-run", async () => {
    const calls = [];
    await runTidy({
      cmdSessions: () => {},
      cmdWorktrees: () => {},
      cmdBranches: () => {},
      cmdGitWorktreePrune: () => calls.push("git-wt-prune"),
      dryRun: true,
    });
    expect(calls).toEqual([]);
  });

  it("propagates --yes to the prune sub-commands", async () => {
    const seen = [];
    await runTidy({
      cmdSessions: ({ yes }) => seen.push(["s", yes]),
      cmdWorktrees: ({ yes }) => seen.push(["w", yes]),
      cmdBranches: ({ yes }) => seen.push(["b", yes]),
      cmdGitWorktreePrune: () => {},
      yes: true,
    });
    expect(seen).toEqual([
      ["s", true],
      ["w", true],
      ["b", true],
    ]);
  });

  it("propagates --include-idle / --include-stale / --force / --max to sub-commands", async () => {
    // These flow through `...rest`; a regression to an explicit allowlist would
    // silently no-op the very behaviors this ticket relies on (e.g. include-idle).
    const seen = {};
    await runTidy({
      cmdSessions: (opts) => {
        seen.sessions = opts;
      },
      cmdWorktrees: (opts) => {
        seen.worktrees = opts;
      },
      cmdBranches: (opts) => {
        seen.branches = opts;
      },
      cmdGitWorktreePrune: () => {},
      yes: true,
      includeIdle: true,
      includeStale: true,
      force: true,
      max: 7,
    });
    expect(seen.sessions.includeIdle).toBe(true);
    expect(seen.worktrees.includeStale).toBe(true);
    expect(seen.branches.force).toBe(true);
    expect(seen.sessions.max).toBe(7);
  });

  it("reports all four steps completed on success", async () => {
    const result = await runTidy({
      cmdSessions: () => {},
      cmdWorktrees: () => {},
      cmdBranches: () => {},
      cmdGitWorktreePrune: () => {},
      yes: true,
    });
    expect(result.completed).toEqual(["sessions", "worktrees", "branches", "git-wt-prune"]);
    expect(result.failedAt).toBeNull();
  });
});
