// branches.test.mjs — Phase 7 of CTL-649. `catalyst-execution-core branches
// {list,prune}`. Bare git refs — no claude-session aspect — so prune deletes
// directly (git branch -D / git push origin --delete), NOT through the reaper.

import { describe, it, expect } from "bun:test";
import { classify, buildRows, runBranchesPrune, parseBranchArgs, gitLines } from "./branches.mjs";
import { ArgError } from "./args.mjs";

describe("branches classify", () => {
  it("WORKTREE_BACKED when checked out in some worktree", () => {
    expect(classify({ worktreePath: "/wt/CTL-1" })).toBe("WORKTREE_BACKED");
  });
  it("MERGED_LOCAL when local-only, in git branch --merged, no worktree", () => {
    expect(classify({ scope: "local", mergedIntoMain: true, worktreePath: null })).toBe(
      "MERGED_LOCAL"
    );
  });
  it("MERGED_REMOTE when remote-only, PR merged", () => {
    expect(classify({ scope: "remote", prState: "merged" })).toBe("MERGED_REMOTE");
  });
  it("CLOSED_NO_MERGE when PR closed without merge", () => {
    expect(classify({ scope: "both", prState: "closed" })).toBe("CLOSED_NO_MERGE");
  });
  it("ORPHAN_LOCAL when local-only, no worktree, no PR, no remote", () => {
    expect(classify({ scope: "local", prState: "none", remoteExists: false })).toBe("ORPHAN_LOCAL");
  });
  it("STALE_REMOTE when remote-only, no PR, ageDays > threshold", () => {
    expect(classify({ scope: "remote", prState: "none", ageDays: 60, staleDays: 30 })).toBe(
      "STALE_REMOTE"
    );
  });
  it("ACTIVE as the safe default (open PR, no worktree)", () => {
    expect(classify({ scope: "both", prState: "open" })).toBe("ACTIVE");
  });
  it("WORKTREE_BACKED wins even when PR merged", () => {
    expect(classify({ worktreePath: "/wt/CTL-1", prState: "merged", scope: "both" })).toBe(
      "WORKTREE_BACKED"
    );
  });
});

describe("buildRows (union local + remote, joined to PRs/worktrees/merge-status)", () => {
  it("computes scope and classification per branch", async () => {
    const rows = await buildRows({
      localBranches: ["main", "CTL-1", "CTL-2"],
      remoteBranches: ["main", "CTL-2", "CTL-3"],
      worktreeBranches: new Set(["main"]),
      mergedLocal: new Set(["CTL-1"]),
      prs: [
        { headRefName: "CTL-2", state: "merged" },
        { headRefName: "CTL-3", state: "merged" },
      ],
      ageDaysFor: () => 1,
      staleDays: 30,
    });
    const main = rows.find((r) => r.name === "main");
    const c1 = rows.find((r) => r.name === "CTL-1");
    const c2 = rows.find((r) => r.name === "CTL-2");
    const c3 = rows.find((r) => r.name === "CTL-3");
    expect(main.classification).toBe("WORKTREE_BACKED");
    expect(c1.scope).toBe("local");
    expect(c1.classification).toBe("MERGED_LOCAL");
    expect(c2.scope).toBe("both");
    expect(c2.classification).toBe("MERGED_REMOTE"); // PR merged dominates
    expect(c3.scope).toBe("remote");
    expect(c3.classification).toBe("MERGED_REMOTE");
  });
});

describe("runBranchesPrune", () => {
  it("deletes MERGED_LOCAL locally by default", async () => {
    const localCalls = [];
    const remoteCalls = [];
    await runBranchesPrune({
      rows: [
        { name: "CTL-1", scope: "local", classification: "MERGED_LOCAL", mergedIntoMain: true },
      ],
      deleteLocalBranch: (b) => localCalls.push(b),
      deleteRemoteBranch: (b) => remoteCalls.push(b),
      yes: true,
    });
    expect(localCalls).toEqual(["CTL-1"]);
    expect(remoteCalls).toEqual([]);
  });

  it("deletes MERGED_REMOTE on the remote by default", async () => {
    const localCalls = [];
    const remoteCalls = [];
    await runBranchesPrune({
      rows: [{ name: "CTL-2", scope: "remote", classification: "MERGED_REMOTE" }],
      deleteLocalBranch: (b) => localCalls.push(b),
      deleteRemoteBranch: (b) => remoteCalls.push(b),
      yes: true,
    });
    expect(remoteCalls).toEqual(["CTL-2"]);
    expect(localCalls).toEqual([]);
  });

  it("refuses to delete unmerged local (ORPHAN_LOCAL) without --force", async () => {
    const localCalls = [];
    await runBranchesPrune({
      rows: [
        { name: "CTL-9", scope: "local", classification: "ORPHAN_LOCAL", mergedIntoMain: false },
      ],
      deleteLocalBranch: (b) => localCalls.push(b),
      deleteRemoteBranch: () => {},
      yes: true,
    });
    expect(localCalls).toEqual([]);
  });

  it("deletes unmerged local with --force", async () => {
    const localCalls = [];
    await runBranchesPrune({
      rows: [
        { name: "CTL-9", scope: "local", classification: "ORPHAN_LOCAL", mergedIntoMain: false },
      ],
      deleteLocalBranch: (b) => localCalls.push(b),
      deleteRemoteBranch: () => {},
      yes: true,
      force: true,
    });
    expect(localCalls).toEqual(["CTL-9"]);
  });

  it("--scope=remote does not delete locals", async () => {
    const localCalls = [];
    const remoteCalls = [];
    await runBranchesPrune({
      rows: [
        { name: "CTL-1", scope: "local", classification: "MERGED_LOCAL", mergedIntoMain: true },
        { name: "CTL-2", scope: "remote", classification: "MERGED_REMOTE" },
      ],
      deleteLocalBranch: (b) => localCalls.push(b),
      deleteRemoteBranch: (b) => remoteCalls.push(b),
      yes: true,
      scope: "remote",
    });
    expect(remoteCalls).toEqual(["CTL-2"]);
    expect(localCalls).toEqual([]);
  });

  it("never deletes WORKTREE_BACKED or ACTIVE", async () => {
    const calls = [];
    await runBranchesPrune({
      rows: [
        { name: "main", scope: "both", classification: "WORKTREE_BACKED" },
        { name: "CTL-5", scope: "both", classification: "ACTIVE" },
      ],
      deleteLocalBranch: (b) => calls.push(b),
      deleteRemoteBranch: (b) => calls.push(b),
      yes: true,
      force: true,
    });
    expect(calls).toEqual([]);
  });

  it("dry-run is the default — no deletions without --yes", async () => {
    const calls = [];
    await runBranchesPrune({
      rows: [
        { name: "CTL-1", scope: "local", classification: "MERGED_LOCAL", mergedIntoMain: true },
      ],
      deleteLocalBranch: (b) => calls.push(b),
      deleteRemoteBranch: (b) => calls.push(b),
    });
    expect(calls).toEqual([]);
  });

  it("CLOSED_NO_MERGE needs --force and deletes the side derived from scope", async () => {
    // CLOSED_NO_MERGE is the only class with no fixed side — it falls back to a
    // scope-derived side. A local-scoped closed branch deletes locally; a
    // remote-scoped one deletes on the remote.
    const localOnly = [];
    await runBranchesPrune({
      rows: [{ name: "CTL-7", scope: "local", classification: "CLOSED_NO_MERGE" }],
      deleteLocalBranch: (b) => localOnly.push(["local", b]),
      deleteRemoteBranch: (b) => localOnly.push(["remote", b]),
      yes: true,
    });
    expect(localOnly).toEqual([]); // refused without --force

    const forced = [];
    await runBranchesPrune({
      rows: [
        { name: "CTL-7", scope: "local", classification: "CLOSED_NO_MERGE" },
        { name: "CTL-8", scope: "remote", classification: "CLOSED_NO_MERGE" },
      ],
      deleteLocalBranch: (b) => forced.push(["local", b]),
      deleteRemoteBranch: (b) => forced.push(["remote", b]),
      yes: true,
      force: true,
    });
    expect(forced).toContainEqual(["local", "CTL-7"]);
    expect(forced).toContainEqual(["remote", "CTL-8"]);
  });
});

describe("runBranchesPrune — structured rows for --json (inspectable plan)", () => {
  const mixedRows = () => [
    { name: "CTL-1", scope: "local", classification: "MERGED_LOCAL", mergedIntoMain: true },
    { name: "CTL-2", scope: "remote", classification: "MERGED_REMOTE" },
    { name: "CTL-9", scope: "local", classification: "ORPHAN_LOCAL", mergedIntoMain: false },
    { name: "main", scope: "both", classification: "WORKTREE_BACKED" },
  ];

  it("returns planned rows with name/scope/classification", async () => {
    const { plannedRows } = await runBranchesPrune({
      rows: mixedRows(),
      deleteLocalBranch: () => {},
      deleteRemoteBranch: () => {},
    });
    expect(plannedRows).toContainEqual({
      name: "CTL-1",
      scope: "local",
      classification: "MERGED_LOCAL",
    });
    expect(plannedRows).toContainEqual({
      name: "CTL-2",
      scope: "remote",
      classification: "MERGED_REMOTE",
    });
    // ORPHAN_LOCAL needs --force → not planned.
    expect(plannedRows.find((r) => r.name === "CTL-9")).toBeUndefined();
  });

  it("records skipped rows with machine reasons", async () => {
    const { skippedRows } = await runBranchesPrune({
      rows: mixedRows(),
      deleteLocalBranch: () => {},
      deleteRemoteBranch: () => {},
    });
    expect(skippedRows).toContainEqual({ name: "CTL-9", reason: "force-required" });
    expect(skippedRows).toContainEqual({ name: "main", reason: "not-prunable" });
  });

  it("records out-of-scope skips", async () => {
    const { skippedRows } = await runBranchesPrune({
      rows: [
        { name: "CTL-1", scope: "local", classification: "MERGED_LOCAL", mergedIntoMain: true },
      ],
      deleteLocalBranch: () => {},
      deleteRemoteBranch: () => {},
      scope: "remote",
    });
    expect(skippedRows).toContainEqual({ name: "CTL-1", reason: "out-of-scope" });
  });

  it("deleted is 0 in dry-run even though rows are planned", async () => {
    const { planned, deleted, plannedRows } = await runBranchesPrune({
      rows: mixedRows(),
      deleteLocalBranch: () => {},
      deleteRemoteBranch: () => {},
    });
    expect(planned).toBe(2);
    expect(deleted).toBe(0);
    expect(plannedRows.length).toBe(2);
  });
});

describe("parseBranchArgs (strict shared parser + option mapping)", () => {
  it("maps kebab flags onto option names", () => {
    expect(
      parseBranchArgs([
        "--json",
        "--yes",
        "--dry-run",
        "--force",
        "--scope",
        "remote",
        "--max",
        "5",
        "--stale-days",
        "7",
      ])
    ).toEqual({
      json: true,
      yes: true,
      dryRun: true,
      force: true,
      scope: "remote",
      max: 5,
      staleDays: 7,
    });
  });

  it("THROWS ArgError on an unknown flag (devex finding #1 — no silent exit 0)", () => {
    expect(() => parseBranchArgs(["--forc"])).toThrow(ArgError);
    expect(() => parseBranchArgs(["--bogus"])).toThrow(/unknown flag: --bogus/);
  });

  it("THROWS ArgError on --stale-days abc (devex finding #2 — no silent NaN)", () => {
    expect(() => parseBranchArgs(["--stale-days", "abc"])).toThrow(ArgError);
    expect(() => parseBranchArgs(["--stale-days", "abc"])).toThrow(/expects a number/);
    expect(() => parseBranchArgs(["--max", "abc"])).toThrow(ArgError);
  });

  it("THROWS ArgError on --scope sideways (out-of-range scope)", () => {
    expect(() => parseBranchArgs(["--scope", "sideways"])).toThrow(ArgError);
    expect(() => parseBranchArgs(["--scope", "sideways"])).toThrow(/local\|remote\|both/);
  });

  it("accepts each valid scope", () => {
    expect(parseBranchArgs(["--scope", "local"]).scope).toBe("local");
    expect(parseBranchArgs(["--scope", "remote"]).scope).toBe("remote");
    expect(parseBranchArgs(["--scope", "both"]).scope).toBe("both");
  });

  it("accepts --repo-root <path> (CTL-675)", () => {
    expect(parseBranchArgs(["prune", "--repo-root", "/r"]).repoRoot).toBe("/r");
  });
});

// CTL-675: the shared listing runner now propagates a git failure (anchored to
// a resolved repoRoot) instead of swallowing it to [] — the silent no-op fix.
describe("gitLines (CTL-675 throw-propagation + cwd anchor)", () => {
  it("propagates a git failure instead of returning empty", () => {
    const run = () => {
      const e = new Error("x");
      e.stderr = "fatal: not a git repository\n";
      throw e;
    };
    expect(() => gitLines(["branch", "--format=%(refname:short)"], "/r", run)).toThrow(
      /fatal: not a git repository/
    );
  });

  it("splits stdout lines on success, anchored to repoRoot", () => {
    let seenCwd;
    const run = (_a, opts) => {
      seenCwd = opts.cwd;
      return "main\nfeat\n";
    };
    expect(gitLines(["branch"], "/r", run)).toEqual(["main", "feat"]);
    expect(seenCwd).toBe("/r");
  });
});
