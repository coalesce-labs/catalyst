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
      .toEqual({ remoteBranchExists: true, commitsAhead: 2, branchName: "PROJ-5",
        candidates: ["PROJ-5"] });
    expect(calls.every(({ opts }) => Number.isFinite(opts.timeout) && opts.timeout > 0)).toBe(true);
    expect(calls.every(({ opts }) => opts.cwd === "/repo")).toBe(true);
  });

  test("reports an absent branch as zero commits", () => {
    const run = () => ({ status: 0, stdout: "" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: false, commitsAhead: 0, branchName: "PROJ-5",
        candidates: ["PROJ-5"] });
  });

  test("keeps failed branch existence unknown", () => {
    const run = () => { throw new Error("offline"); };
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toMatchObject({ remoteBranchExists: undefined, commitsAhead: null, unverifiable: true });
  });

  // A non-zero ls-remote is a FAILED probe, not proof of absence — reporting
  // remoteBranchExists:false there would read as "nothing to rescue" on a transient
  // network/auth failure and send RUBRIC FOUR down its ESCALATE arm.
  test("a non-zero ls-remote is unverifiable, never absence", () => {
    const run = () => ({ status: 128, stdout: "", stderr: "could not read Username" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toMatchObject({ remoteBranchExists: undefined, unverifiable: true,
        reason: "ls-remote-failed" });
  });

  test("keeps commits unknown when rev-list fails", () => {
    const run = (_bin, args) => (args[0] === "ls-remote"
      ? { status: 0, stdout: "abc\trefs/heads/PROJ-5\n" }
      : args[0] === "fetch" ? { status: 0, stdout: "" } : { status: 1, stdout: "" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: true, commitsAhead: null, branchName: "PROJ-5",
        candidates: ["PROJ-5"], reason: "rev-list-failed" });
  });

  test("does not spawn when branch or repo is underivable", () => {
    let calls = 0;
    const run = () => { calls += 1; };
    expect(probeBranchSalvage(null, { repoRoot: "/repo", run }))
      .toEqual({ unverifiable: true, reason: "branch-underivable" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", run }))
      .toEqual({ unverifiable: true, reason: "repo-underivable" });
    expect(calls).toBe(0);
  });

  // CAT-11 (review) REGRESSION: execution-core pushes orphaned work to
  // refs/heads/<TICKET>, not to Linear's branchName slug. Probing only the slug
  // returned {remoteBranchExists:false, commitsAhead:0} for exactly the orphan
  // population this feature exists to rescue.
  test("probes the ticket-key ref FIRST, ahead of Linear's branchName slug", () => {
    const probed = [];
    const run = (_bin, args) => {
      if (args[0] === "ls-remote") {
        probed.push(args[args.length - 1]);
        return args[args.length - 1] === "PROJ-5"
          ? { status: 0, stdout: "abc\trefs/heads/PROJ-5\n" }
          : { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "3\n" };
    };
    const r = probeBranchSalvage("PROJ-5", {
      branchName: "ryan/proj-5-some-linear-slug", repoRoot: "/repo", run,
    });
    expect(probed[0]).toBe("PROJ-5");
    expect(r).toMatchObject({ remoteBranchExists: true, commitsAhead: 3, branchName: "PROJ-5" });
    expect(r.candidates).toEqual(["PROJ-5", "ryan/proj-5-some-linear-slug"]);
  });

  test("falls back to the Linear slug when no ticket-key ref exists", () => {
    const run = (_bin, args) => {
      if (args[0] === "ls-remote") {
        return args[args.length - 1] === "ryan/proj-5-slug"
          ? { status: 0, stdout: "abc\trefs/heads/ryan/proj-5-slug\n" }
          : { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "1\n" };
    };
    expect(probeBranchSalvage("PROJ-5", { branchName: "ryan/proj-5-slug", repoRoot: "/repo", run }))
      .toMatchObject({ remoteBranchExists: true, commitsAhead: 1, branchName: "ryan/proj-5-slug" });
  });

  // The daemon's clone has usually never fetched a branch pushed from a worktree
  // (or from another host), so rev-list against a local remote-tracking ref would
  // exit 128 and silently report commitsAhead:null on the likeliest orphan case.
  test("fetches the single ref before counting commits", () => {
    const calls = [];
    const run = (_bin, args) => {
      calls.push({ args });
      if (args[0] === "ls-remote") return { status: 0, stdout: "abc\trefs/heads/PROJ-5\n" };
      return { status: 0, stdout: "4\n" };
    };
    probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run });
    const fetch = calls.find((c) => c.args[0] === "fetch");
    expect(fetch).toBeDefined();
    expect(fetch.args).toContain("+refs/heads/PROJ-5:refs/remotes/origin/PROJ-5");
    expect(calls.findIndex((c) => c.args[0] === "fetch"))
      .toBeLessThan(calls.findIndex((c) => c.args[0] === "rev-list"));
  });

  // CATALYST_OPEN_PR_GATE_TIMEOUT_MS=0 means "no timeout" to the open-PR gate. This
  // probe spawns synchronously inside the scheduler tick, so inheriting that would let
  // a hung remote wedge the tick. The module snapshots the env var at import time, so
  // exercise the guard through a fresh module instance rather than the shared one.
  test("an explicit 0 gate timeout never removes this probe's cap", async () => {
    const prev = process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS;
    process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS = "0";
    try {
      const fresh = await import(`./branch-salvage.mjs?timeout-zero-${Date.now()}`);
      const calls = [];
      const run = (_bin, args, opts) => {
        calls.push(opts);
        return args[0] === "ls-remote" ? { status: 0, stdout: "" } : { status: 0, stdout: "0\n" };
      };
      fresh.probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((o) => Number.isFinite(o.timeout) && o.timeout > 0)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS;
      else process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS = prev;
    }
  });
});
