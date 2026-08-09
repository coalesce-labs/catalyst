import { describe, expect, test } from "bun:test";
import { probeBranchSalvage, probeWorktreeUnpushed, resolveWorktreePath } from "./branch-salvage.mjs";

// CAT-11 (Codex P1/P2 round 1) — the local-salvage half of the evidence, the
// configured base branch, and the no-longer-ignored fetch status.
describe("branch salvage — local evidence and base branch (Codex round 1)", () => {
  const lsRemoteHit = { status: 0, stdout: "abc\trefs/heads/PROJ-5\n" };

  // THE headline bug: production never supplied worktreeUnpushed, so
  // classifyRevivalRoute always fell through to non-dispatchable unknown-salvage
  // and RUBRIC FOUR's rescue route was unreachable. git says "no worktree" → false.
  test("supplies worktreeUnpushed:false when git holds no worktree for the branch", () => {
    const run = (_bin, args) => {
      if (args[0] === "ls-remote") return lsRemoteHit;
      if (args[0] === "worktree") return { status: 0, stdout: "worktree /other\nbranch refs/heads/nope\n" };
      if (args[0] === "fetch") return { status: 0, stdout: "" };
      return { status: 0, stdout: "3\n" };
    };
    const r = probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run });
    expect(r.worktreeUnpushed).toBe(false);
    expect(r).toMatchObject({ remoteBranchExists: true, commitsAhead: 3 });
  });

  // A FAILED worktree probe must stay UNKNOWN — never a false "no unpushed work",
  // which would let resume-from-remote discard real local commits.
  test("a failed worktree-list probe leaves worktreeUnpushed undefined", () => {
    const run = (_bin, args) => {
      if (args[0] === "ls-remote") return lsRemoteHit;
      if (args[0] === "worktree") return { status: 128, stdout: "" };
      if (args[0] === "fetch") return { status: 0, stdout: "" };
      return { status: 0, stdout: "1\n" };
    };
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run })
      .worktreeUnpushed).toBeUndefined();
  });

  test("counts commits against the CONFIGURED base branch, not a hardcoded main", () => {
    const seen = [];
    const run = (_bin, args) => {
      seen.push(args.join(" "));
      if (args[0] === "ls-remote") return lsRemoteHit;
      if (args[0] === "worktree") return { status: 0, stdout: "" };
      if (args[0] === "fetch") return { status: 0, stdout: "" };
      return { status: 0, stdout: "4\n" };
    };
    probeBranchSalvage("PROJ-5", {
      branchName: "PROJ-5", repoRoot: "/repo", baseBranch: "develop", run,
    });
    expect(seen.some((s) => s.includes("origin/develop..origin/PROJ-5"))).toBe(true);
    expect(seen.some((s) => s.includes("origin/main.."))).toBe(false);
  });

  // A stale tracking ref makes rev-list SUCCEED after a failed fetch, publishing a
  // verifiable-looking count computed from stale data. That must be unverifiable.
  test("a failed fetch is unverifiable, never a stale commit count", () => {
    const run = (_bin, args) => {
      if (args[0] === "ls-remote") return lsRemoteHit;
      if (args[0] === "worktree") return { status: 0, stdout: "" };
      if (args[0] === "fetch") return { status: 1, stdout: "", stderr: "auth failed" };
      return { status: 0, stdout: "99\n" }; // stale ref would happily answer
    };
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toMatchObject({ unverifiable: true, reason: "fetch-failed", commitsAhead: null });
  });

  test("resolveWorktreePath returns the path when the branch IS checked out", () => {
    const run = () => ({ status: 0,
      stdout: "worktree /a\nbranch refs/heads/other\n\nworktree /wt/PROJ-5\nbranch refs/heads/PROJ-5\n" });
    expect(resolveWorktreePath(["PROJ-5"], { repoRoot: "/repo", run })).toBe("/wt/PROJ-5");
  });

  test("probeWorktreeUnpushed reports false for a path that does not exist", () => {
    expect(probeWorktreeUnpushed("/definitely/not/here/PROJ-5")).toBe(false);
  });

  test("probeWorktreeUnpushed stays unknown with no path at all", () => {
    expect(probeWorktreeUnpushed("")).toBeUndefined();
  });
});

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
        candidates: ["PROJ-5"], worktreeUnpushed: false });
    expect(calls.every(({ opts }) => Number.isFinite(opts.timeout) && opts.timeout > 0)).toBe(true);
    expect(calls.every(({ opts }) => opts.cwd === "/repo")).toBe(true);
  });

  test("reports an absent branch as zero commits", () => {
    const run = () => ({ status: 0, stdout: "" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: false, commitsAhead: 0, branchName: "PROJ-5",
        candidates: ["PROJ-5"], worktreeUnpushed: false });
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
      : args[0] === "worktree" ? { status: 0, stdout: "" }
      : args[0] === "fetch" ? { status: 0, stdout: "" } : { status: 1, stdout: "" });
    expect(probeBranchSalvage("PROJ-5", { branchName: "PROJ-5", repoRoot: "/repo", run }))
      .toEqual({ remoteBranchExists: true, commitsAhead: null, branchName: "PROJ-5",
        candidates: ["PROJ-5"], worktreeUnpushed: false, reason: "rev-list-failed" });
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
