// unstuck-act-seams.test.mjs — CTL-1219 unit tests for the four deterministic
// act seams + the buildUnstuckActSeams() registry factory.
//
// Every seam is driven by injected stub deps — zero shelling out, zero real git,
// zero real Linear, no tmp dirs for the pure seams. Mirrors the stub-dep idiom of
// dirty-tree-classifier.test.mjs / catB-force-with-lease.test.mjs.

import { describe, test, expect } from "bun:test";
import {
  buildUnstuckActSeams,
  buildDirtyTreeActSeam,
  buildSourceConflictActSeam,
  buildOrphanStaleActSeam,
  buildStaleLabelActSeam,
} from "./unstuck-act-seams.mjs";
import { STALL_CATEGORY_MAP } from "./unstuck-sweep.mjs";
import { STALE_WORKER_CUTOFF_MS } from "./unstuck-orphan-merge.mjs";

// makeStubDeps — single shared stub-dep factory (plan §"Test fixtures").
// Each test overrides only the deps it exercises. Defaults describe the
// "would succeed" happy path; tests flip specific deps to drive failures.
function makeStubDeps(overrides = {}) {
  return {
    // git seam: (args) → {status, stdout, stderr}. Override per-test.
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
    // porcelain reader: (worktreePath) → string ("" = clean).
    readPorcelain: () => "",
    unlink: () => {},
    writeMarker: () => {},
    markerExists: () => false,
    clearStall: () => true,
    // label writeStatus: removeLabel(ticket, label) → {removed:bool, reason?}.
    writeStatus: { removeLabel: () => ({ removed: true }) },
    resolvePrState: () => "MERGED",
    jobLifecycle: () => false,
    emitPhaseComplete: () => true,
    inRemovalBackoff: () => false,
    nowMs: () => Date.now(),
    orchDir: "/tmp/orch",
    log: { warn() {}, error() {}, info() {} },
    ...overrides,
  };
}

// A canonical dirty-tree candidate (driver shape from defaultCollectUnstuckCandidates).
function dirtyTreeCandidate(overrides = {}) {
  return {
    ticket: "CTL-1",
    phase: "implement",
    signal: { phase: "implement", status: "stalled", stalledReason: "rebase_refused_dirty_tree" },
    workerDir: "/tmp/orch/workers/CTL-1",
    worktreePath: "/wt/CTL-1",
    liveSessionInWorktree: false,
    linearTerminal: false,
    evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-1", phase: "implement" },
    ...overrides,
  };
}

function sourceConflictCandidate(overrides = {}) {
  return {
    ticket: "CTL-2",
    phase: "implement",
    signal: {
      phase: "implement",
      status: "stalled",
      stalledReason: "source_conflict_ctl708_unavailable",
    },
    workerDir: "/tmp/orch/workers/CTL-2",
    worktreePath: "/wt/CTL-2",
    liveSessionInWorktree: false,
    linearTerminal: false,
    evidence: { reason: "source_conflict_ctl708_unavailable", ticket: "CTL-2", phase: "implement" },
    ...overrides,
  };
}

function orphanStaleCandidate(overrides = {}) {
  return {
    ticket: "CTL-3",
    phase: "monitor-merge",
    signal: {
      phase: "monitor-merge",
      status: "failed",
      failureReason: "orphan-sweep-stale",
      bg_job_id: "job-abc",
      updatedAt: "2020-01-01T00:00:00Z",
    },
    workerDir: "/tmp/orch/workers/CTL-3",
    worktreePath: "/wt/CTL-3",
    liveSessionInWorktree: false,
    linearTerminal: false,
    evidence: { reason: "orphan-sweep-stale", ticket: "CTL-3", phase: "monitor-merge" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — dirty-tree act seam
// ---------------------------------------------------------------------------
describe("buildDirtyTreeActSeam (CTL-1219)", () => {
  test("clears each machine-local noise path from the worktree then re-arms the worker", () => {
    const gitCalls = [];
    const cleared = [];
    // porcelain holds ONLY noise: a tracked .catalyst/config.json + a trunk dir.
    let porcelainReads = 0;
    const seam = buildDirtyTreeActSeam(
      makeStubDeps({
        readPorcelain: () => {
          porcelainReads++;
          // first read returns noise; second read (post-clear) is clean.
          if (porcelainReads === 1) return " M .catalyst/config.json\n?? .trunk/out/x";
          return "";
        },
        runGit: (args) => {
          gitCalls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
        unlink: (p) => {
          cleared.push({ unlink: p });
        },
        clearStall: (arg) => {
          cleared.push({ clearStall: arg });
          return true;
        },
      })
    );
    expect(() =>
      seam(dirtyTreeCandidate(), { category: "dirty-tree", action: "clear-noise-and-retry" })
    ).not.toThrow();
    // at least one git invocation against the worktree to clear the tracked noise
    expect(gitCalls.some((a) => a.includes("-C") && a.includes("/wt/CTL-1"))).toBe(true);
    // clearStall called exactly once with {ticket, phase}
    const clearStallCalls = cleared.filter((c) => c.clearStall);
    expect(clearStallCalls).toHaveLength(1);
    expect(clearStallCalls[0].clearStall).toEqual({ ticket: "CTL-1", phase: "implement" });
  });

  test("throws when the worktree is still dirty with REAL work (fail-closed)", () => {
    const cleared = [];
    const seam = buildDirtyTreeActSeam(
      makeStubDeps({
        // real dirt present → must never clear/re-arm.
        readPorcelain: () => " M src/app.ts",
        clearStall: () => {
          cleared.push(1);
          return true;
        },
      })
    );
    expect(() =>
      seam(dirtyTreeCandidate(), { category: "dirty-tree", action: "clear-noise-and-retry" })
    ).toThrow(/real-dirt/);
    expect(cleared).toHaveLength(0);
  });

  test("throws when worktreePath is null", () => {
    const seam = buildDirtyTreeActSeam(makeStubDeps());
    expect(() =>
      seam(dirtyTreeCandidate({ worktreePath: null }), {
        category: "dirty-tree",
        action: "clear-noise-and-retry",
      })
    ).toThrow(/no-worktree/);
  });

  test("idempotent — marker present → no-op (no git, no clearStall)", () => {
    const gitCalls = [];
    const cleared = [];
    const seam = buildDirtyTreeActSeam(
      makeStubDeps({
        markerExists: () => true,
        runGit: (a) => {
          gitCalls.push(a);
          return { status: 0 };
        },
        clearStall: () => {
          cleared.push(1);
          return true;
        },
      })
    );
    expect(() =>
      seam(dirtyTreeCandidate(), { category: "dirty-tree", action: "clear-noise-and-retry" })
    ).not.toThrow();
    expect(gitCalls).toHaveLength(0);
    expect(cleared).toHaveLength(0);
  });

  test("writes the idempotency marker after a successful clear", () => {
    const markers = [];
    let porcelainReads = 0;
    const seam = buildDirtyTreeActSeam(
      makeStubDeps({
        readPorcelain: () => (++porcelainReads === 1 ? " M .catalyst/config.json" : ""),
        writeMarker: (p) => {
          markers.push(p);
        },
      })
    );
    seam(dirtyTreeCandidate(), { category: "dirty-tree", action: "clear-noise-and-retry" });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toContain(".unstuck-cleared-implement.applied");
  });

  test("re-uses filterMachineLocalDirt: only noise + deleted node_modules are cleared; a real line throws", () => {
    const seam = buildDirtyTreeActSeam(
      makeStubDeps({
        // mixes noise (.trunk), node_modules deletion, and a REAL change → throws.
        readPorcelain: () => "?? .trunk/out/x\n D node_modules/foo\n M src/real.ts",
      })
    );
    expect(() =>
      seam(dirtyTreeCandidate(), { category: "dirty-tree", action: "clear-noise-and-retry" })
    ).toThrow(/real-dirt/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — source-conflict act seam (force-push-with-lease, clean only)
// ---------------------------------------------------------------------------
describe("buildSourceConflictActSeam (CTL-1219)", () => {
  // git probe responder that simulates a CLEAN, rebased, ours-only branch.
  function cleanBranchGit(pushResult = { status: 0, stdout: "", stderr: "" }) {
    return (args) => {
      const a = args.join(" ");
      if (a.includes("status --porcelain")) return { status: 0, stdout: "", stderr: "" };
      if (a.includes("log") && a.includes("origin/main..HEAD"))
        return { status: 0, stdout: "CTL-2: fix the thing\n", stderr: "" };
      if (a.includes("merge-base") && a.includes("--is-ancestor"))
        return { status: 0, stdout: "", stderr: "" };
      if (a.includes("push")) return pushResult;
      return { status: 0, stdout: "", stderr: "" };
    };
  }

  test("force-pushes with --force-with-lease when worktree is clean + ours + descends origin/main", () => {
    const gitCalls = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: (args) => {
          gitCalls.push(args);
          return cleanBranchGit()(args);
        },
      })
    );
    expect(() =>
      seam(sourceConflictCandidate(), {
        category: "source-conflict",
        action: "force-push-if-clean",
      })
    ).not.toThrow();
    const pushCall = gitCalls.find((a) => a.includes("push"));
    expect(pushCall).toBeDefined();
    expect(pushCall).toContain("--force-with-lease");
  });

  test("throws (no push) when the worktree is dirty with real work", () => {
    const gitCalls = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: (args) => {
          gitCalls.push(args);
          if (args.join(" ").includes("status --porcelain"))
            return { status: 0, stdout: " M src/real.ts", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      })
    );
    expect(() =>
      seam(sourceConflictCandidate(), {
        category: "source-conflict",
        action: "force-push-if-clean",
      })
    ).toThrow(/dirty-worktree/);
    expect(gitCalls.some((a) => a.includes("push"))).toBe(false);
  });

  test("throws when a foreign commit is present (no push)", () => {
    const gitCalls = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: (args) => {
          gitCalls.push(args);
          const a = args.join(" ");
          if (a.includes("status --porcelain")) return { status: 0, stdout: "", stderr: "" };
          if (a.includes("log") && a.includes("origin/main..HEAD"))
            return { status: 0, stdout: "CTL-2: ours\nCTL-999: foreign\n", stderr: "" };
          if (a.includes("merge-base")) return { status: 0 };
          return { status: 0 };
        },
      })
    );
    expect(() =>
      seam(sourceConflictCandidate(), {
        category: "source-conflict",
        action: "force-push-if-clean",
      })
    ).toThrow(/foreign-commits/);
    expect(gitCalls.some((a) => a.includes("push"))).toBe(false);
  });

  test("throws when HEAD is not a strict descendant of origin/main (no push)", () => {
    const gitCalls = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: (args) => {
          gitCalls.push(args);
          const a = args.join(" ");
          if (a.includes("status --porcelain")) return { status: 0, stdout: "", stderr: "" };
          if (a.includes("log") && a.includes("origin/main..HEAD"))
            return { status: 0, stdout: "CTL-2: ours\n", stderr: "" };
          if (a.includes("merge-base") && a.includes("--is-ancestor")) return { status: 1 }; // not ancestor
          return { status: 0 };
        },
      })
    );
    expect(() =>
      seam(sourceConflictCandidate(), {
        category: "source-conflict",
        action: "force-push-if-clean",
      })
    ).toThrow(/not-descendant/);
    expect(gitCalls.some((a) => a.includes("push"))).toBe(false);
  });

  test("throws when the push command itself fails (non-zero git exit)", () => {
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: cleanBranchGit({ status: 1, stdout: "", stderr: "! [rejected]" }),
      })
    );
    expect(() =>
      seam(sourceConflictCandidate(), {
        category: "source-conflict",
        action: "force-push-if-clean",
      })
    ).toThrow(/push-failed/);
  });

  test("idempotent via the force-pushed marker — early no-op, push never called", () => {
    const gitCalls = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        markerExists: () => true,
        runGit: (a) => {
          gitCalls.push(a);
          return { status: 0 };
        },
      })
    );
    expect(() =>
      seam(sourceConflictCandidate(), {
        category: "source-conflict",
        action: "force-push-if-clean",
      })
    ).not.toThrow();
    expect(gitCalls.some((a) => a.includes("push"))).toBe(false);
  });

  // CTL-1243: hardcoded linearTerminal:false bypasses the guard in classifyCleanRebaseForcePush
  test("buildSourceConflictActSeam honors candidate.evidence.linearTerminal", () => {
    const gitCalls = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: (args) => {
          gitCalls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );
    expect(() =>
      seam(
        sourceConflictCandidate({ linearTerminal: true, evidence: { linearTerminal: true, reason: "source_conflict_ctl708_unavailable", ticket: "CTL-2", phase: "implement" } }),
        { category: "source-conflict", action: "force-push-if-clean" },
      ),
    ).toThrow(/linear-terminal/);
    expect(gitCalls.some((a) => a.includes("push"))).toBe(false);
  });

  test("writes the marker after a successful push", () => {
    const markers = [];
    const seam = buildSourceConflictActSeam(
      makeStubDeps({
        runGit: cleanBranchGit(),
        writeMarker: (p) => {
          markers.push(p);
        },
      })
    );
    seam(sourceConflictCandidate(), { category: "source-conflict", action: "force-push-if-clean" });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toContain(".unstuck-force-pushed-implement.applied");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — orphan-stale act seam (emit synthetic phase-complete if merged)
// ---------------------------------------------------------------------------
describe("buildOrphanStaleActSeam (CTL-1219)", () => {
  test("emits a synthetic phase.<phase>.complete.<ticket> when the orphan-merge precondition holds", () => {
    const emits = [];
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        resolvePrState: () => "MERGED",
        jobLifecycle: () => false,
        nowMs: () => Date.parse("2020-01-01T01:00:00Z"), // 1h after a stale signal
        emitPhaseComplete: (arg) => {
          emits.push(arg);
          return true;
        },
      })
    );
    expect(() =>
      seam(orphanStaleCandidate(), {
        category: "orphan-stale",
        action: "emit-phase-complete-if-merged",
      })
    ).not.toThrow();
    expect(emits).toHaveLength(1);
    expect(emits[0]).toEqual({ ticket: "CTL-3", phase: "monitor-merge" });
  });

  test("throws when the PR is not MERGED (no emit)", () => {
    const emits = [];
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        resolvePrState: () => "OPEN",
        emitPhaseComplete: (a) => {
          emits.push(a);
          return true;
        },
      })
    );
    expect(() =>
      seam(orphanStaleCandidate(), {
        category: "orphan-stale",
        action: "emit-phase-complete-if-merged",
      })
    ).toThrow(/pr-not-merged/);
    expect(emits).toHaveLength(0);
  });

  test("throws when the bg job is still alive (no emit)", () => {
    const emits = [];
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        jobLifecycle: () => true,
        emitPhaseComplete: (a) => {
          emits.push(a);
          return true;
        },
      })
    );
    expect(() =>
      seam(orphanStaleCandidate(), {
        category: "orphan-stale",
        action: "emit-phase-complete-if-merged",
      })
    ).toThrow(/bg-job-alive/);
    expect(emits).toHaveLength(0);
  });

  test("throws when the signal is fresh (within STALE_WORKER_CUTOFF_MS) (no emit)", () => {
    const emits = [];
    const updatedAt = "2020-01-01T00:00:00Z";
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        nowMs: () => Date.parse(updatedAt) + STALE_WORKER_CUTOFF_MS - 1000, // still fresh
        emitPhaseComplete: (a) => {
          emits.push(a);
          return true;
        },
      })
    );
    expect(() =>
      seam(
        orphanStaleCandidate({
          signal: { phase: "monitor-merge", bg_job_id: "job-abc", updatedAt },
        }),
        { category: "orphan-stale", action: "emit-phase-complete-if-merged" }
      )
    ).toThrow(/signal-fresh/);
    expect(emits).toHaveLength(0);
  });

  test("throws when .terminal-done.applied is present (teardown owns it; no emit)", () => {
    const emits = [];
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        // markerExists returns true ONLY for the terminal-done marker.
        markerExists: (p) => /\.terminal-done\.applied$/.test(p),
        emitPhaseComplete: (a) => {
          emits.push(a);
          return true;
        },
      })
    );
    expect(() =>
      seam(orphanStaleCandidate(), {
        category: "orphan-stale",
        action: "emit-phase-complete-if-merged",
      })
    ).toThrow(/terminal-done/);
    expect(emits).toHaveLength(0);
  });

  test("idempotent via the orphan-merge marker — no-op, no emit", () => {
    const emits = [];
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        // markerExists true ONLY for the unstuck-orphan-merge marker.
        markerExists: (p) => /\.unstuck-orphan-merge-/.test(p),
        emitPhaseComplete: (a) => {
          emits.push(a);
          return true;
        },
      })
    );
    expect(() =>
      seam(orphanStaleCandidate(), {
        category: "orphan-stale",
        action: "emit-phase-complete-if-merged",
      })
    ).not.toThrow();
    expect(emits).toHaveLength(0);
  });

  test("throws when emitPhaseComplete itself fails (no marker written)", () => {
    const markers = [];
    const seam = buildOrphanStaleActSeam(
      makeStubDeps({
        nowMs: () => Date.parse("2020-01-01T01:00:00Z"),
        emitPhaseComplete: () => false, // emit failed
        writeMarker: (p) => {
          markers.push(p);
        },
      })
    );
    expect(() =>
      seam(orphanStaleCandidate(), {
        category: "orphan-stale",
        action: "emit-phase-complete-if-merged",
      })
    ).toThrow(/emit-failed/);
    expect(markers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — stale-label act seam (clear the stale attention label)
// ---------------------------------------------------------------------------
describe("buildStaleLabelActSeam (CTL-1219)", () => {
  function staleLabelCandidate(overrides = {}) {
    return {
      ticket: "CTL-4",
      phase: "none",
      evidence: {
        ticket: "CTL-4",
        phase: "none",
        linearState: "Done",
        attentionLabels: ["needs-human"],
      },
      ...overrides,
    };
  }

  test("removes the stale attention label from a terminal ticket", () => {
    const removed = [];
    const seam = buildStaleLabelActSeam(
      makeStubDeps({
        writeStatus: {
          removeLabel: (t, l) => {
            removed.push({ t, l });
            return { removed: true };
          },
        },
      })
    );
    expect(() =>
      seam(staleLabelCandidate(), {
        category: "stale-label",
        action: "clear-label",
        label: "needs-human",
      })
    ).not.toThrow();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual({ t: "CTL-4", l: "needs-human" });
  });

  test("throws when removeLabel reports failure (driver → report.failed)", () => {
    const seam = buildStaleLabelActSeam(
      makeStubDeps({
        writeStatus: { removeLabel: () => ({ removed: false, reason: "auth-failed" }) },
      })
    );
    expect(() =>
      seam(staleLabelCandidate(), {
        category: "stale-label",
        action: "clear-label",
        label: "needs-human",
      })
    ).toThrow(/not-removed/);
  });

  test("respects the CTL-1078 removal back-off — throws in-backoff rather than reporting false success", () => {
    const removed = [];
    const seam = buildStaleLabelActSeam(
      makeStubDeps({
        inRemovalBackoff: () => true,
        writeStatus: {
          removeLabel: (t, l) => {
            removed.push({ t, l });
            return { removed: true };
          },
        },
      })
    );
    expect(() =>
      seam(staleLabelCandidate(), {
        category: "stale-label",
        action: "clear-label",
        label: "needs-human",
      })
    ).toThrow(/in-backoff/);
    // back-off short-circuits before any real removal attempt
    expect(removed).toHaveLength(0);
  });

  test("throws when the decision carries no label (defensive)", () => {
    const seam = buildStaleLabelActSeam(makeStubDeps());
    expect(() =>
      seam(staleLabelCandidate(), { category: "stale-label", action: "clear-label" })
    ).toThrow(/no-label/);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — buildUnstuckActSeams registry factory
// ---------------------------------------------------------------------------
describe("buildUnstuckActSeams — registry factory (CTL-1219)", () => {
  test("returns an object keyed by exactly the four enforceable category strings", () => {
    const seams = buildUnstuckActSeams(makeStubDeps());
    expect(Object.keys(seams).sort()).toEqual([
      "dirty-tree",
      "orphan-stale",
      "source-conflict",
      "stale-label",
    ]);
  });

  test("every value is a function of arity 2 (candidate, decision)", () => {
    const seams = buildUnstuckActSeams(makeStubDeps());
    for (const key of Object.keys(seams)) {
      expect(typeof seams[key]).toBe("function");
      expect(seams[key].length).toBe(2);
    }
  });

  test("keys cover every non-escalate category in STALL_CATEGORY_MAP", () => {
    const seams = buildUnstuckActSeams(makeStubDeps());
    for (const { category, action } of Object.values(STALL_CATEGORY_MAP)) {
      if (action === "escalate") continue; // remediate-cap/unknown route to escalate, NOT the registry
      // CTL-1442/CTL-1443: skip-typed entries (escalation-ask-cap, boot-resume-
      // gate-expired) route to the sweep's own skip path (unstuck-sweep.mjs
      // action === "skip" — the same branch classifyStalledTicket's live-session/
      // linear-terminal returns use), NOT the seam registry.
      if (action === "skip") continue;
      expect(Object.keys(seams)).toContain(category);
    }
  });

  test("the registry object is frozen (no accidental mutation of wired seams)", () => {
    const seams = buildUnstuckActSeams(makeStubDeps());
    expect(Object.isFrozen(seams)).toBe(true);
  });
});
