// catB-force-with-lease.test.mjs — CTL-1064 Category B pure safety gate tests.

import { describe, test, expect } from "bun:test";
import { classifyCleanRebaseForcePush, collectForcePushCandidates } from "./catB-force-with-lease.mjs";

const BASE = {
  stalledReason: "source_conflict_ctl708_unavailable",
  ticket: "CTL-1025",
  porcelain: "",           // clean tree
  commitSubjects: ["CTL-1025: fix widget rendering"],  // ticket-only commits
  headIsDescendant: true,  // HEAD is strict descendant
  liveSessionInWorktree: false,
  linearTerminal: false,
  alreadyPushed: false,
};

// ---------------------------------------------------------------------------
// classifyCleanRebaseForcePush — pure safety gate
// ---------------------------------------------------------------------------
describe("classifyCleanRebaseForcePush — pure safety gate (CTL-1064 catB)", () => {
  test("empty porcelain AND ticket-only commits AND HEAD descendant → force-push", () => {
    expect(classifyCleanRebaseForcePush(BASE).action).toBe("force-push");
  });

  test("noise-only porcelain is treated as clean", () => {
    const evidence = { ...BASE, porcelain: " M .catalyst/config.json\n M .claude/settings.json" };
    expect(classifyCleanRebaseForcePush(evidence).action).toBe("force-push");
  });

  test("noise-filtered porcelain non-empty → skip/dirty-worktree", () => {
    const evidence = { ...BASE, porcelain: " M src/foo.mjs" };
    const r = classifyCleanRebaseForcePush(evidence);
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("dirty-worktree");
  });

  test("porcelain null (unreadable) → skip/dirty-worktree (fail-safe)", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, porcelain: null });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("dirty-worktree");
  });

  test("git log has a non-ticket commit → skip/foreign-commits", () => {
    const evidence = { ...BASE, commitSubjects: ["CTL-1025: fix widget", "CTL-999: unrelated change"] };
    const r = classifyCleanRebaseForcePush(evidence);
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("foreign-commits");
  });

  test("git log origin/main..HEAD empty (zero commits ahead) → skip/empty-commits", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, commitSubjects: [] });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("empty-commits");
  });

  test("HEAD not a descendant of origin/main → skip/not-descendant", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, headIsDescendant: false });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not-descendant");
  });

  test("stalledReason mismatch → skip/wrong-stall-reason", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, stalledReason: "rebase_refused_dirty_tree" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("wrong-stall-reason");
  });

  test("linearTerminal → skip/linear-terminal", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, linearTerminal: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("linear-terminal");
  });

  test("liveSession → skip/live-session-in-worktree", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, liveSessionInWorktree: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("live-session-in-worktree");
  });

  test(".unstuck-force-pushed-<phase>.applied present → skip/already-pushed", () => {
    const r = classifyCleanRebaseForcePush({ ...BASE, alreadyPushed: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("already-pushed");
  });

  test("mixed-case ticket prefix normalized (CTL-1025 == ctl-1025)", () => {
    const evidence = {
      ...BASE,
      ticket: "CTL-1025",
      commitSubjects: ["ctl-1025: fix widget rendering"],
    };
    expect(classifyCleanRebaseForcePush(evidence).action).toBe("force-push");
  });

  // CTL-1064 remediation: Gate 2 is the SOLE ownership guard, so the prior
  // substring match (subjectNorm.includes(ticketNorm)) was a force-push safety
  // hole — short keys prefix-matched longer ones and the key matched anywhere in
  // the body. Now a whole-token (\b…\b) match.
  test("short ticket key must NOT prefix-match a longer one (CTL-1 vs CTL-10)", () => {
    const evidence = {
      ...BASE,
      ticket: "CTL-1",
      commitSubjects: ["CTL-10: someone else's commit"],
    };
    const r = classifyCleanRebaseForcePush(evidence);
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("foreign-commits");
  });

  test("longer key must NOT match a shorter one (CTL-10 vs CTL-1)", () => {
    const evidence = {
      ...BASE,
      ticket: "CTL-10",
      commitSubjects: ["CTL-1: someone else's commit"],
    };
    expect(classifyCleanRebaseForcePush(evidence).reason).toBe("foreign-commits");
  });

  test("foreign commit that merely mentions another ticket id → skip/foreign-commits", () => {
    // A CTL-999 commit body referencing CTL-1025 must not be accepted when our
    // ticket is CTL-1064 (the key appears nowhere as a token).
    const evidence = {
      ...BASE,
      ticket: "CTL-1064",
      commitSubjects: ["CTL-999: revert CTL-1025 fix"],
    };
    expect(classifyCleanRebaseForcePush(evidence).reason).toBe("foreign-commits");
  });

  test("default git-revert subject of a FOREIGN ticket → skip/foreign-commits", () => {
    const evidence = {
      ...BASE,
      ticket: "CTL-1064",
      commitSubjects: ['Revert "CTL-1025: fix widget rendering"'],
    };
    expect(classifyCleanRebaseForcePush(evidence).reason).toBe("foreign-commits");
  });

  test("conventional-commit prefix carrying our key as a token → force-push", () => {
    const evidence = {
      ...BASE,
      ticket: "CTL-1064",
      commitSubjects: ["feat(dev): CTL-1064 — wire the sweep", "fix(CTL-1064): follow-up"],
    };
    expect(classifyCleanRebaseForcePush(evidence).action).toBe("force-push");
  });

  test("leading-zero tolerance in the subject (CTL-1064 matches CTL-01064)", () => {
    const evidence = {
      ...BASE,
      ticket: "CTL-1064",
      commitSubjects: ["CTL-01064: zero-padded subject"],
    };
    expect(classifyCleanRebaseForcePush(evidence).action).toBe("force-push");
  });
});

// ---------------------------------------------------------------------------
// collectForcePushCandidates — census (injected git seams)
// ---------------------------------------------------------------------------
describe("collectForcePushCandidates — census (injected git seams) (CTL-1064 catB)", () => {
  function makeCandidate(overrides = {}) {
    return {
      ticket: "CTL-1025",
      phase: "implement",
      worktreePath: "/fake/worktree/CTL-1025",
      workerDir: "/fake/orch/workers/CTL-1025",
      evidence: {
        reason: "source_conflict_ctl708_unavailable",
        ticket: "CTL-1025",
        phase: "implement",
        liveSessionInWorktree: false,
        linearTerminal: false,
        alreadyPushed: false,
      },
      ...overrides,
    };
  }

  function makeGit({ porcelain = "", log = "CTL-1025: fix\n", isAncestor = true } = {}) {
    return (args) => {
      if (args.includes("status")) return { status: 0, stdout: porcelain, stderr: "" };
      if (args.includes("log")) return { status: 0, stdout: log, stderr: "" };
      if (args.includes("merge-base")) return { status: isAncestor ? 0 : 1, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
  }

  test("emits candidate with probed evidence when stall has correct reason", () => {
    const candidates = collectForcePushCandidates({
      candidates: [makeCandidate()],
      runGit: makeGit(),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.porcelain).toBe("");
    expect(candidates[0].evidence.commitSubjects).toEqual(["CTL-1025: fix"]);
    expect(candidates[0].evidence.headIsDescendant).toBe(true);
  });

  test("skips candidates with wrong stalledReason", () => {
    const c = makeCandidate();
    c.evidence.reason = "rebase_refused_dirty_tree";
    const candidates = collectForcePushCandidates({ candidates: [c], runGit: makeGit() });
    expect(candidates).toHaveLength(0);
  });

  test("skips candidates with no worktreePath", () => {
    const c = makeCandidate({ worktreePath: null });
    const candidates = collectForcePushCandidates({ candidates: [c], runGit: makeGit() });
    expect(candidates).toHaveLength(0);
  });

  test("git log non-zero exit → candidate skipped (no throw)", () => {
    const git = (args) => {
      if (args.includes("log")) return { status: 128, stdout: "", stderr: "error", error: new Error("fail") };
      return { status: 0, stdout: "", stderr: "" };
    };
    const candidates = collectForcePushCandidates({
      candidates: [makeCandidate()],
      runGit: git,
    });
    // Candidate is emitted with empty commitSubjects (graceful degradation)
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.commitSubjects).toEqual([]);
  });

  test("per-candidate catch: git throws → candidate skipped, no abort", () => {
    let callCount = 0;
    const git = (args) => {
      callCount++;
      throw new Error("git not available");
    };
    // Should not throw
    const candidates = collectForcePushCandidates({
      candidates: [makeCandidate()],
      runGit: git,
    });
    expect(candidates).toHaveLength(0);
  });

  // CTL-1064 remediation: exercise the DEFAULT git seam (no runGit injected). The
  // prior in-body `require("node:child_process")` is undefined under node (this
  // package is type:module) and threw; it is now a top-level ESM import. Against
  // a nonexistent worktree the spawned git exits non-zero (porcelain→null), but
  // the default seam itself must resolve and not throw.
  test("default git seam (no injected runGit) resolves via ESM import without throwing", () => {
    let candidates;
    expect(() => {
      candidates = collectForcePushCandidates({
        candidates: [makeCandidate({ worktreePath: "/nonexistent/worktree/CTL-1025" })],
      });
    }).not.toThrow();
    // The probe ran (real git, non-zero on a bogus path) → porcelain stays null.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.porcelain).toBeNull();
  });
});
