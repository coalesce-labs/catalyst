// unstuck-sweep.test.mjs — CTL-1064 pure router, action driver, census.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStalledTicket,
  STALL_CATEGORY_MAP,
  UNSTUCK_SWEEP_INTENT_KIND,
  UNSTUCK_SWEEP_EVENT_TYPES,
  defaultCollectUnstuckCandidates,
  runUnstuckSweepPass,
} from "./unstuck-sweep.mjs";

// ---------------------------------------------------------------------------
// classifyStalledTicket — pure top-level router (CTL-1064)
// ---------------------------------------------------------------------------
describe("classifyStalledTicket — pure top-level router (CTL-1064)", () => {
  test("rebase_refused_dirty_tree → dirty-tree/clear-noise-and-retry", () => {
    const r = classifyStalledTicket({ reason: "rebase_refused_dirty_tree" });
    expect(r.category).toBe("dirty-tree");
    expect(r.action).toBe("clear-noise-and-retry");
  });

  test("source_conflict_ctl708_unavailable → source-conflict/force-push-if-clean", () => {
    const r = classifyStalledTicket({ reason: "source_conflict_ctl708_unavailable" });
    expect(r.category).toBe("source-conflict");
    expect(r.action).toBe("force-push-if-clean");
  });

  test("orphan-sweep-stale (normalized from failureReason) → orphan-stale", () => {
    const r = classifyStalledTicket({ reason: "orphan-sweep-stale" });
    expect(r.category).toBe("orphan-stale");
    expect(r.action).toBe("emit-phase-complete-if-merged");
  });

  test("remediate-cycle-cap-exhausted → remediate-cap/escalate", () => {
    const r = classifyStalledTicket({ reason: "remediate-cycle-cap-exhausted" });
    expect(r.category).toBe("remediate-cap");
    expect(r.action).toBe("escalate");
  });

  test("unknown/unrecognized reason → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: "some-unknown-reason" });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("empty-branch-like reason (unrecognized) → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: "empty_branch:0_commits_ahead_of_origin/main" });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("null reason → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: null });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("undefined reason → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: undefined });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("liveSessionInWorktree:true → action:skip regardless of reason", () => {
    const r = classifyStalledTicket({ reason: "rebase_refused_dirty_tree", liveSessionInWorktree: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("live-session");
  });

  test("linearTerminal:true → action:skip regardless of reason", () => {
    const r = classifyStalledTicket({ reason: "source_conflict_ctl708_unavailable", linearTerminal: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("linear-terminal");
  });

  test("liveSession takes precedence over linearTerminal", () => {
    const r = classifyStalledTicket({ reason: "rebase_refused_dirty_tree", liveSessionInWorktree: true, linearTerminal: true });
    expect(r.reason).toBe("live-session");
  });
});

// ---------------------------------------------------------------------------
// UNSTUCK_SWEEP_INTENT_KIND constant
// ---------------------------------------------------------------------------
describe("UNSTUCK_SWEEP_INTENT_KIND (CTL-1064)", () => {
  test("equals 'unstuck-sweep'", () => {
    expect(UNSTUCK_SWEEP_INTENT_KIND).toBe("unstuck-sweep");
  });
});

// ---------------------------------------------------------------------------
// UNSTUCK_SWEEP_EVENT_TYPES — 10 unique strings, all starting with 'unstuck.'
// ---------------------------------------------------------------------------
describe("UNSTUCK_SWEEP_EVENT_TYPES (CTL-1064)", () => {
  test("has exactly 10 strings", () => {
    expect(UNSTUCK_SWEEP_EVENT_TYPES.length).toBe(10);
  });
  test("all start with 'unstuck.'", () => {
    for (const t of UNSTUCK_SWEEP_EVENT_TYPES) {
      expect(t.startsWith("unstuck.")).toBe(true);
    }
  });
  test("all are unique", () => {
    const uniq = new Set(UNSTUCK_SWEEP_EVENT_TYPES);
    expect(uniq.size).toBe(10);
  });
  test("is frozen", () => {
    expect(Object.isFrozen(UNSTUCK_SWEEP_EVENT_TYPES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runUnstuckSweepPass — action driver (CTL-1064)
// ---------------------------------------------------------------------------
describe("runUnstuckSweepPass — action driver (CTL-1064)", () => {
  function makeCandidate(overrides = {}) {
    return {
      ticket: "CTL-TEST",
      phase: "implement",
      evidence: {
        reason: "rebase_refused_dirty_tree",
        ticket: "CTL-TEST",
        phase: "implement",
        liveSessionInWorktree: false,
        linearTerminal: false,
      },
      ...overrides,
    };
  }

  test("mode:'off' → pass entirely skipped (census never called, no events, no intents)", () => {
    let censusCount = 0;
    let emitCount = 0;
    let intentCount = 0;
    const report = runUnstuckSweepPass({
      mode: "off",
      collectCandidates: () => { censusCount++; return [makeCandidate()]; },
      emit: () => { emitCount++; },
      recordIntent: () => { intentCount++; },
    });
    expect(censusCount).toBe(0);
    expect(emitCount).toBe(0);
    expect(intentCount).toBe(0);
    expect(report.acted).toEqual([]);
    expect(report.wouldAct).toEqual([]);
  });

  test("mode:'shadow' → emits would.* only; no act seam, no intent, no comment", () => {
    const emitted = [];
    const actCalled = [];
    const intentCalled = [];
    const commentCalled = [];
    const report = runUnstuckSweepPass({
      mode: "shadow",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": () => { actCalled.push(1); } },
      emit: (type, fields) => { emitted.push({ type, fields }); },
      recordIntent: () => { intentCalled.push(1); },
      postComment: () => { commentCalled.push(1); },
    });
    expect(actCalled).toHaveLength(0);
    expect(intentCalled).toHaveLength(0);
    expect(commentCalled).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("unstuck.would.clear-noise");
    expect(report.wouldAct).toHaveLength(1);
    expect(report.acted).toHaveLength(0);
    expect(report.escalated).toHaveLength(0);
  });

  test("mode:'shadow' for escalate category → emits unstuck.would.escalate", () => {
    const emitted = [];
    const report = runUnstuckSweepPass({
      mode: "shadow",
      collectCandidates: () => [makeCandidate({
        evidence: { reason: "remediate-cycle-cap-exhausted", ticket: "CTL-TEST", phase: "implement", liveSessionInWorktree: false, linearTerminal: false },
      })],
      emit: (type) => { emitted.push(type); },
    });
    expect(emitted).toContain("unstuck.would.escalate");
    expect(report.wouldEscalate).toHaveLength(1);
  });

  test("mode:'enforce' + clearable → calls act seam + recordIntent + postComment + emits enforce event", () => {
    const actCalled = [];
    const intentCalled = [];
    const commentCalled = [];
    const emitted = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": (c, d) => { actCalled.push({ c, d }); } },
      emit: (type) => { emitted.push(type); },
      recordIntent: (kind, subject) => { intentCalled.push({ kind, subject }); },
      isIntentEffective: () => false,
      postComment: (t, cat, p) => { commentCalled.push({ t, cat, p }); },
    });
    expect(actCalled).toHaveLength(1);
    expect(intentCalled).toHaveLength(1);
    expect(intentCalled[0].kind).toBe("unstuck-sweep");
    expect(intentCalled[0].subject).toBe("CTL-TEST/implement");
    expect(commentCalled).toHaveLength(1);
    expect(commentCalled[0].cat).toBe("dirty-tree");
    expect(emitted).toContain("unstuck.cleared.noise");
  });

  test("mode:'enforce' + escalate category → calls escalate seam + postComment + emits unstuck.escalated", () => {
    const escalateCalled = [];
    const commentCalled = [];
    const emitted = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate({
        evidence: { reason: "remediate-cycle-cap-exhausted", ticket: "CTL-TEST", phase: "implement", liveSessionInWorktree: false, linearTerminal: false },
      })],
      escalate: (c) => { escalateCalled.push(c.ticket); },
      emit: (type) => { emitted.push(type); },
      postComment: (t) => { commentCalled.push(t); },
    });
    expect(escalateCalled).toContain("CTL-TEST");
    expect(emitted).toContain("unstuck.escalated");
    expect(commentCalled).toContain("CTL-TEST");
  });

  test("mode:'enforce' + skip (live session) → no act, no emit, no intent", () => {
    const actCalled = [];
    const emitted = [];
    const intentCalled = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate({
        evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-TEST", phase: "implement", liveSessionInWorktree: true, linearTerminal: false },
      })],
      actByCategory: { "dirty-tree": () => { actCalled.push(1); } },
      emit: () => { emitted.push(1); },
      recordIntent: () => { intentCalled.push(1); },
    });
    expect(actCalled).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(intentCalled).toHaveLength(0);
  });

  test("mode:'enforce' + isIntentEffective=true → skips action (storm-prevention)", () => {
    const actCalled = [];
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": () => { actCalled.push(1); } },
      isIntentEffective: () => true,
      emit: () => {},
    });
    expect(actCalled).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe("intent-effective");
  });

  test("records intent with kind:'unstuck-sweep' and subject:'<ticket>/<phase>'", () => {
    const intents = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": () => {} },
      emit: () => {},
      recordIntent: (kind, subject) => { intents.push({ kind, subject }); },
      isIntentEffective: () => false,
    });
    expect(intents[0].kind).toBe("unstuck-sweep");
    expect(intents[0].subject).toBe("CTL-TEST/implement");
  });

  test("a throwing census never aborts the pass (degrades to empty list)", () => {
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => { throw new Error("census failed"); },
      emit: () => {},
    });
    expect(report.acted).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });

  test("a throwing per-candidate seam does not abort the rest", () => {
    const actCalled = [];
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [
        makeCandidate({ ticket: "T1" }),
        makeCandidate({ ticket: "T2" }),
      ],
      actByCategory: {
        "dirty-tree": (c) => {
          if (c.ticket === "T1") throw new Error("T1 failed");
          actCalled.push(c.ticket);
        },
      },
      emit: () => {},
      isIntentEffective: () => false,
    });
    expect(actCalled).toContain("T2");
    expect(report.failed.some(f => f.ticket === "T1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultCollectUnstuckCandidates — shared census builder (CTL-1064)
// ---------------------------------------------------------------------------
describe("defaultCollectUnstuckCandidates — shared census builder (CTL-1064)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1064-census-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  function makeWorker(ticket, signalOverrides = {}) {
    const d = join(orchDir, "workers", ticket);
    mkdirSync(d, { recursive: true });
    const signal = {
      ticket,
      phase: "implement",
      status: "stalled",
      stalledReason: "rebase_refused_dirty_tree",
      ...signalOverrides,
    };
    writeFileSync(join(d, "phase-implement.json"), JSON.stringify(signal));
    return d;
  }

  test("reads stalledReason from status:stalled phase signals", () => {
    makeWorker("CTL-STALLED");
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ticket).toBe("CTL-STALLED");
    expect(candidates[0].evidence.reason).toBe("rebase_refused_dirty_tree");
  });

  test("reads failureReason from status:failed + failureReason:orphan-sweep-stale", () => {
    makeWorker("CTL-ORPHAN", {
      status: "failed",
      failureReason: "orphan-sweep-stale",
      stalledReason: undefined,
    });
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.reason).toBe("orphan-sweep-stale");
  });

  test("skips running/done signals and tickets with wrong status", () => {
    makeWorker("CTL-RUNNING", { status: "running" });
    makeWorker("CTL-DONE", { status: "done" });
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates).toHaveLength(0);
  });

  test("liveSessionInWorktree set from agentsSnapshot", () => {
    makeWorker("CTL-LIVE");
    const candidates = defaultCollectUnstuckCandidates({
      orchDir,
      agentsSnapshot: [{ cwd: "/some/worktree/CTL-LIVE" }],
      resolveWorktreePath: () => "/some/worktree/CTL-LIVE",
    });
    expect(candidates[0].evidence.liveSessionInWorktree).toBe(true);
  });

  test("linearTerminal set from injected isLinearTerminal seam", () => {
    makeWorker("CTL-TERMINAL");
    const candidates = defaultCollectUnstuckCandidates({
      orchDir,
      isLinearTerminal: (t) => t === "CTL-TERMINAL",
    });
    expect(candidates[0].evidence.linearTerminal).toBe(true);
  });

  test("worktreePath from resolveWorktreePath seam (null when absent)", () => {
    makeWorker("CTL-NOPATH");
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates[0].evidence.worktreePath).toBeNull();
  });

  test("a throwing probe for one ticket does not abort enumeration of others", () => {
    const d1 = join(orchDir, "workers", "CTL-OK");
    mkdirSync(d1, { recursive: true });
    writeFileSync(
      join(d1, "phase-implement.json"),
      JSON.stringify({ ticket: "CTL-OK", phase: "implement", status: "stalled", stalledReason: "rebase_refused_dirty_tree" }),
    );
    // malformed json for second ticket
    const d2 = join(orchDir, "workers", "CTL-BAD");
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, "phase-implement.json"), "{ not json");

    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    // CTL-OK still found despite CTL-BAD being malformed
    expect(candidates.some(c => c.ticket === "CTL-OK")).toBe(true);
  });
});
