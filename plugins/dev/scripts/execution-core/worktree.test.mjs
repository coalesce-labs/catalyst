// worktree.test.mjs — unit tests for the execution-core worktree lifecycle (CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test worktree.test.mjs
//
// Every test injects a `spawn` fake so no test ever shells out to the real
// create-worktree.sh or git.

import { describe, test, expect } from "bun:test";
import { createWorktree } from "./worktree.mjs";

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
});
