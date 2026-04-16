import { describe, it, expect } from "bun:test";
import {
  readBranchGitState,
  type GitRunner,
  type GitRunnerResult,
} from "../lib/git-state";

function makeRunner(
  responses: Map<string, GitRunnerResult> | ((args: string[]) => GitRunnerResult),
): GitRunner {
  return (args, _cwd) => {
    if (typeof responses === "function") return Promise.resolve(responses(args));
    const key = args.join(" ");
    return Promise.resolve(responses.get(key) ?? { stdout: "", ok: false });
  };
}

describe("readBranchGitState", () => {
  it("returns null when branch --show-current is empty (detached HEAD)", async () => {
    const responses = new Map<string, GitRunnerResult>();
    responses.set("branch --show-current", { stdout: "", ok: true });
    const got = await readBranchGitState("/tmp/wt", "main", {
      runner: makeRunner(responses),
    });
    expect(got).toBeNull();
  });

  it("returns null when branch command fails", async () => {
    const responses = new Map<string, GitRunnerResult>();
    responses.set("branch --show-current", { stdout: "", ok: false });
    const got = await readBranchGitState("/tmp/wt", "main", {
      runner: makeRunner(responses),
    });
    expect(got).toBeNull();
  });

  it("parses commitsAhead, hasUpstream, lastCommitSha when all commands succeed", async () => {
    const responses = new Map<string, GitRunnerResult>();
    responses.set("branch --show-current", { stdout: "feat/x\n", ok: true });
    responses.set("rev-list --count main..HEAD", { stdout: "3\n", ok: true });
    responses.set("ls-remote --heads origin feat/x", {
      stdout: "abc123\trefs/heads/feat/x\n",
      ok: true,
    });
    responses.set("rev-parse HEAD", { stdout: "deadbeefcafe\n", ok: true });

    const got = await readBranchGitState("/tmp/wt", "main", {
      runner: makeRunner(responses),
    });

    expect(got).not.toBeNull();
    expect(got!.branch).toBe("feat/x");
    expect(got!.commitsAhead).toBe(3);
    expect(got!.hasUpstream).toBe(true);
    expect(got!.lastCommitSha).toBe("deadbeefcafe");
  });

  it("sets hasUpstream=false when ls-remote returns empty output", async () => {
    const responses = new Map<string, GitRunnerResult>();
    responses.set("branch --show-current", { stdout: "feat/x\n", ok: true });
    responses.set("rev-list --count main..HEAD", { stdout: "0\n", ok: true });
    responses.set("ls-remote --heads origin feat/x", { stdout: "", ok: true });
    responses.set("rev-parse HEAD", { stdout: "aaa\n", ok: true });

    const got = await readBranchGitState("/tmp/wt", "main", {
      runner: makeRunner(responses),
    });
    expect(got!.hasUpstream).toBe(false);
    expect(got!.commitsAhead).toBe(0);
  });

  it("treats malformed commit count as 0", async () => {
    const responses = new Map<string, GitRunnerResult>();
    responses.set("branch --show-current", { stdout: "feat/x\n", ok: true });
    responses.set("rev-list --count main..HEAD", {
      stdout: "not-a-number\n",
      ok: true,
    });
    responses.set("ls-remote --heads origin feat/x", { stdout: "", ok: true });
    responses.set("rev-parse HEAD", { stdout: "", ok: true });

    const got = await readBranchGitState("/tmp/wt", "main", {
      runner: makeRunner(responses),
    });
    expect(got!.commitsAhead).toBe(0);
    expect(got!.lastCommitSha).toBeNull();
  });

  it("treats rev-list failure as commitsAhead=0", async () => {
    const responses = new Map<string, GitRunnerResult>();
    responses.set("branch --show-current", { stdout: "feat/x\n", ok: true });
    responses.set("rev-list --count main..HEAD", { stdout: "", ok: false });
    responses.set("ls-remote --heads origin feat/x", { stdout: "", ok: true });
    responses.set("rev-parse HEAD", { stdout: "abc\n", ok: true });

    const got = await readBranchGitState("/tmp/wt", "main", {
      runner: makeRunner(responses),
    });
    expect(got!.commitsAhead).toBe(0);
    expect(got!.lastCommitSha).toBe("abc");
  });

  it("respects a non-default base branch name in the rev-list call", async () => {
    const calls: string[] = [];
    const runner: GitRunner = (args, _cwd) => {
      if (args[0] === "branch") {
        return Promise.resolve({ stdout: "feat/x\n", ok: true });
      }
      if (args[0] === "rev-list") {
        calls.push(args.join(" "));
        return Promise.resolve({ stdout: "1\n", ok: true });
      }
      if (args[0] === "ls-remote") {
        return Promise.resolve({ stdout: "", ok: true });
      }
      if (args[0] === "rev-parse") {
        return Promise.resolve({ stdout: "sha\n", ok: true });
      }
      return Promise.resolve({ stdout: "", ok: false });
    };

    await readBranchGitState("/tmp/wt", "develop", { runner });
    expect(calls).toContain("rev-list --count develop..HEAD");
  });

  it("passes the worktreePath as cwd to the runner", async () => {
    const cwds: string[] = [];
    const runner: GitRunner = (args, cwd) => {
      cwds.push(cwd);
      if (args[0] === "branch") {
        return Promise.resolve({ stdout: "feat/x\n", ok: true });
      }
      return Promise.resolve({ stdout: "0\n", ok: true });
    };

    await readBranchGitState("/my/worktree", "main", { runner });
    expect(cwds.every((c) => c === "/my/worktree")).toBe(true);
  });
});
