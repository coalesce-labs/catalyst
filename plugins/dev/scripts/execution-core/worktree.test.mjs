// worktree.test.mjs — unit tests for the execution-core worktree lifecycle (CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test worktree.test.mjs
//
// Every test injects a `spawn` fake so no test ever shells out to the real
// create-worktree.sh or git.

import { describe, test, expect } from "bun:test";
import { createWorktree, parseWorktreeForBranch, teardownWorktree } from "./worktree.mjs";

describe("createWorktree", () => {
  test("invokes create-worktree.sh with [ticket, main, --reuse-existing] and cwd=repoRoot", () => {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: "WORKTREE_PATH=/wt/CTL-1\n", stderr: "" };
    };
    createWorktree({ ticket: "CTL-1", repoRoot: "/repo" }, { spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toMatch(/create-worktree\.sh$/);
    expect(calls[0].args).toEqual(["CTL-1", "main", "--reuse-existing"]);
    expect(calls[0].opts.cwd).toBe("/repo");
  });

  test("parses the trailing WORKTREE_PATH= line from stdout", () => {
    const spawn = () => ({
      status: 0,
      stdout: "setup noise\nWORKTREE_PATH=/wt/CTL-2\n",
      stderr: "",
    });
    const r = createWorktree({ ticket: "CTL-2", repoRoot: "/repo" }, { spawn });
    expect(r).toEqual({ code: 0, worktreePath: "/wt/CTL-2", stderr: "" });
  });

  test("a non-zero status yields that code + worktreePath null, without throwing", () => {
    const spawn = () => ({ status: 3, stdout: "", stderr: "boom" });
    const r = createWorktree({ ticket: "CTL-3", repoRoot: "/repo" }, { spawn });
    expect(r.code).toBe(3);
    expect(r.worktreePath).toBeNull();
    expect(r.stderr).toBe("boom");
  });

  test("stdout with no WORKTREE_PATH line yields worktreePath null even on code 0", () => {
    const spawn = () => ({ status: 0, stdout: "did some setup\n", stderr: "" });
    const r = createWorktree({ ticket: "CTL-4", repoRoot: "/repo" }, { spawn });
    expect(r.code).toBe(0);
    expect(r.worktreePath).toBeNull();
  });

  test("a spawn error (ENOENT) yields code 127 without throwing", () => {
    const spawn = () => ({ error: new Error("spawn ENOENT") });
    const r = createWorktree({ ticket: "CTL-5", repoRoot: "/repo" }, { spawn });
    expect(r.code).toBe(127);
    expect(r.worktreePath).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  // CTL-615 — expectedBranch plumbing
  test("expectedBranch is appended as --expected-branch <name> to argv", () => {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: "WORKTREE_PATH=/wt/CTL-6\n", stderr: "" };
    };
    createWorktree({ ticket: "CTL-6", repoRoot: "/repo", expectedBranch: "CTL-6" }, { spawn });
    expect(calls[0].args).toEqual(["CTL-6", "main", "--reuse-existing", "--expected-branch", "CTL-6"]);
  });

  test("expectedBranch omitted → argv unchanged (backwards compatible)", () => {
    const calls = [];
    const spawn = (_cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: "WORKTREE_PATH=/wt/CTL-6\n", stderr: "" };
    };
    createWorktree({ ticket: "CTL-6", repoRoot: "/repo" }, { spawn });
    expect(calls[0]).toEqual(["CTL-6", "main", "--reuse-existing"]);
  });
});

describe("parseWorktreeForBranch", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /wt/CTL-7",
    "HEAD def",
    "branch refs/heads/CTL-7",
    "",
  ].join("\n");

  test("finds the worktree path bound to refs/heads/<ticket>", () => {
    expect(parseWorktreeForBranch(porcelain, "CTL-7")).toBe("/wt/CTL-7");
  });

  test("returns null when no worktree is on that branch", () => {
    expect(parseWorktreeForBranch(porcelain, "CTL-999")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseWorktreeForBranch("", "CTL-7")).toBeNull();
  });

  test("matches the branch exactly — a prefix is not a match", () => {
    // refs/heads/CTL-7 must not be returned when asked for CTL-70.
    expect(parseWorktreeForBranch(porcelain, "CTL-70")).toBeNull();
  });
});

describe("teardownWorktree", () => {
  // A spawn fake: the `list` argv answers with porcelain, anything else (the
  // `remove`) answers with removeResult.
  function spawnSeq(listStdout, removeResult) {
    const calls = [];
    const fn = (_cmd, args) => {
      calls.push(args);
      if (args.includes("list")) return { status: 0, stdout: listStdout, stderr: "" };
      return removeResult;
    };
    fn.calls = calls;
    return fn;
  }
  const listWith = (path, ticket) =>
    `worktree /repo\nbranch refs/heads/main\n\nworktree ${path}\nbranch refs/heads/${ticket}\n\n`;

  test("resolves the worktree by branch and git-worktree-removes it → true", () => {
    const spawn = spawnSeq(listWith("/wt/CTL-7", "CTL-7"), { status: 0, stdout: "", stderr: "" });
    expect(teardownWorktree({ repoRoot: "/repo", ticket: "CTL-7" }, { spawn })).toBe(true);
    expect(spawn.calls[1]).toEqual(["-C", "/repo", "worktree", "remove", "--force", "/wt/CTL-7"]);
  });

  test("no worktree for the ticket → true (already torn down), no remove call", () => {
    const spawn = spawnSeq("worktree /repo\nbranch refs/heads/main\n\n", null);
    expect(teardownWorktree({ repoRoot: "/repo", ticket: "CTL-7" }, { spawn })).toBe(true);
    expect(spawn.calls).toHaveLength(1); // only the list call
  });

  test("a `git worktree remove` failure → false, never throws", () => {
    const spawn = spawnSeq(listWith("/wt/CTL-7", "CTL-7"), {
      status: 1,
      stdout: "",
      stderr: "locked",
    });
    expect(teardownWorktree({ repoRoot: "/repo", ticket: "CTL-7" }, { spawn })).toBe(false);
  });

  test("a `git worktree list` failure → false", () => {
    const spawn = () => ({ status: 128, stdout: "", stderr: "not a repo" });
    expect(teardownWorktree({ repoRoot: "/repo", ticket: "CTL-7" }, { spawn })).toBe(false);
  });

  test("missing repoRoot or ticket → false (no spawn)", () => {
    expect(teardownWorktree({ ticket: "CTL-7" })).toBe(false);
    expect(teardownWorktree({ repoRoot: "/repo" })).toBe(false);
  });
});
