import { describe, expect, test } from "bun:test";
import { probeBranchSalvage } from "./branch-salvage.mjs";

describe("probeBranchSalvage (CAT-11)", () => {
  test("reports a remote branch and its commits ahead", () => {
    const calls = [];
    const run = (_bin, args, opts) => {
      calls.push({ args, opts });
      return args[0] === "ls-remote"
        ? { status: 0, stdout: "abc\trefs/heads/PROJ-5\n" }
        : { status: 0, stdout: "2\n" };
    };
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: true, commitsAhead: 2, branchName: "PROJ-5" });
    expect(calls.every(({ opts }) => Number.isFinite(opts.timeout) && opts.timeout > 0)).toBe(true);
    expect(calls.every(({ opts }) => opts.cwd === "/repo")).toBe(true);
  });

  test("reports an absent branch as zero commits", () => {
    const run = () => ({ status: 0, stdout: "" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: false, commitsAhead: 0, branchName: "PROJ-5" });
  });

  test("keeps failed branch existence unknown", () => {
    const run = () => { throw new Error("offline"); };
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toMatchObject({ remoteBranchExists: undefined, commitsAhead: null, unverifiable: true });
  });

  test("keeps commits unknown when rev-list fails", () => {
    let call = 0;
    const run = () => (++call === 1
      ? { status: 0, stdout: "abc\trefs/heads/PROJ-5\n" }
      : { status: 1, stdout: "" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: true, commitsAhead: null, branchName: "PROJ-5" });
  });

  test("does not spawn when branch or repo is underivable", () => {
    let calls = 0;
    const run = () => { calls += 1; };
    expect(probeBranchSalvage("PROJ-5", { repoRoot: "/repo", run }))
      .toEqual({ unverifiable: true, reason: "branch-underivable" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", run }))
      .toEqual({ unverifiable: true, reason: "repo-underivable" });
    expect(calls).toBe(0);
  });
});
