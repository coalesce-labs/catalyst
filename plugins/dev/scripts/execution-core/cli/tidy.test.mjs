// tidy.test.mjs — Phase 8 of CTL-649. The `tidy` umbrella composes
// sessions → worktrees → branches → `git worktree prune` in the ONLY safe
// order: stopping sessions first means worktree removal never creates fresh
// orphans (the Component-5 leak, inverted). All four steps are injected.

import { describe, it, expect } from "bun:test";
import { runTidy, parseTidyArgs } from "./tidy.mjs";
import { ArgError } from "./args.mjs";

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

  it("propagates --include-interactive / --min-idle-seconds to the sessions step", async () => {
    // CTL-649 interactive-session protection: these guard the operator's own
    // terminal windows. A regression to an explicit allowlist in tidy's own
    // parseArgs would silently drop them; `...rest` must carry them through.
    const seen = {};
    await runTidy({
      cmdSessions: (opts) => {
        seen.sessions = opts;
      },
      cmdWorktrees: () => {},
      cmdBranches: () => {},
      cmdGitWorktreePrune: () => {},
      yes: true,
      includeInteractive: true,
      minIdleMs: 900000,
    });
    expect(seen.sessions.includeInteractive).toBe(true);
    expect(seen.sessions.minIdleMs).toBe(900000);
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

  it("propagates --json to every sub-prune (so they return rows, not print)", async () => {
    const seen = {};
    await runTidy({
      cmdSessions: (opts) => {
        seen.s = opts.json;
      },
      cmdWorktrees: (opts) => {
        seen.w = opts.json;
      },
      cmdBranches: (opts) => {
        seen.b = opts.json;
      },
      cmdGitWorktreePrune: () => {},
      json: true,
      dryRun: true,
    });
    expect(seen).toEqual({ s: true, w: true, b: true });
  });
});

describe("parseTidyArgs (strict)", () => {
  it("maps kebab flags onto the sub-prune option names", () => {
    const opts = parseTidyArgs([
      "--json",
      "--dry-run",
      "--include-idle",
      "--include-interactive",
      "--include-stale",
      "--force",
      "--max",
      "7",
      "--min-idle-seconds",
      "60",
      "--stale-days",
      "3",
    ]);
    expect(opts).toEqual({
      json: true,
      dryRun: true,
      includeIdle: true,
      includeInteractive: true,
      includeStale: true,
      force: true,
      max: 7,
      minIdleMs: 60000,
      staleDays: 3,
    });
  });

  it("REJECTS an unknown flag (finding #1)", () => {
    expect(() => parseTidyArgs(["--include-idl"])).toThrow(ArgError);
    expect(() => parseTidyArgs(["--bogus"])).toThrow(/unknown flag: --bogus/);
  });

  it("REJECTS a non-numeric number flag (finding #2)", () => {
    expect(() => parseTidyArgs(["--max", "abc"])).toThrow(/--max expects a number/);
    expect(() => parseTidyArgs(["--min-idle-seconds", "NaN"])).toThrow(ArgError);
  });

  it("accepts --repo-root <path> (CTL-675)", () => {
    expect(parseTidyArgs(["--repo-root", "/r"]).repoRoot).toBe("/r");
  });
});

describe("runTidy --json shape", () => {
  it("returns { dryRun-able, steps, aborted:false, abortedAt:null } on success", async () => {
    const result = await runTidy({
      cmdSessions: () => ({ planned: 1, emitted: 0, plannedRows: [{ shortId: "abc" }], skippedRows: [] }),
      cmdWorktrees: () => ({ planned: 0, emitted: 0, plannedRows: [], skippedRows: [] }),
      cmdBranches: () => ({ planned: 0, deleted: 0, plannedRows: [], skippedRows: [] }),
      cmdGitWorktreePrune: () => {},
      json: true,
      yes: true,
    });
    expect(result.aborted).toBe(false);
    expect(result.abortedAt).toBeNull();
    expect(result.steps.map((s) => s.step)).toEqual([
      "sessions",
      "worktrees",
      "branches",
      "git-worktree-prune",
    ]);
    // Each prune step carries its structured plannedRows/skippedRows through.
    expect(result.steps[0].plannedRows).toEqual([{ shortId: "abc" }]);
    expect(result.steps[0].skippedRows).toEqual([]);
  });

  it("reflects an injected step failure via aborted / abortedAt (+ remaining steps skipped)", async () => {
    const result = await runTidy({
      cmdSessions: () => ({ planned: 0, emitted: 0, plannedRows: [], skippedRows: [] }),
      cmdWorktrees: () => {
        throw new Error("worktree boom");
      },
      cmdBranches: () => {
        throw new Error("should not run");
      },
      cmdGitWorktreePrune: () => {
        throw new Error("should not run");
      },
      json: true,
      yes: true,
      log: () => {},
    });
    expect(result.aborted).toBe(true);
    expect(result.abortedAt).toBe("worktrees");
    expect(result.steps.map((s) => s.step)).toEqual(["sessions", "worktrees"]);
    expect(result.steps[1].error).toBe("worktree boom");
  });
});
