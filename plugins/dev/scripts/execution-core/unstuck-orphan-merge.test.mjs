// unstuck-orphan-merge.test.mjs — CTL-1064 Category C classifier tests.

import { describe, test, expect } from "bun:test";
import {
  classifyOrphanMergedReconcile,
  defaultCollectOrphanMergedCandidates,
  STALE_WORKER_CUTOFF_MS,
} from "./unstuck-orphan-merge.mjs";

const NOW = 1_700_000_000_000; // fixed epoch-ms for tests
const STALE_UPDATED_AT = NOW - STALE_WORKER_CUTOFF_MS - 1000; // definitely stale

const BASE = {
  ticket: "CTL-MERGED",
  phase: "monitor-merge",
  prState: "MERGED",
  bgJobAlive: false,
  signalUpdatedAt: STALE_UPDATED_AT,
  nowMs: NOW,
  alreadyEmitted: false,
  terminalDoneApplied: false,
  linearTerminal: false,
};

// ---------------------------------------------------------------------------
// classifyOrphanMergedReconcile — pure classifier
// ---------------------------------------------------------------------------
describe("classifyOrphanMergedReconcile — pure classifier (CTL-1064 catC)", () => {
  test("PR MERGED + bg dead + not already emitted + no .terminal-done → emit-complete", () => {
    expect(classifyOrphanMergedReconcile(BASE).action).toBe("emit-complete");
  });

  test("PR OPEN → skip/pr-not-merged", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, prState: "OPEN" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("pr-not-merged");
  });

  test("PR CLOSED → skip/pr-not-merged", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, prState: "CLOSED" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("pr-not-merged");
  });

  test("PR MERGED but bg alive → skip/bg-job-alive", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, bgJobAlive: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("bg-job-alive");
  });

  test("PR MERGED + bg dead but signal fresh (within cutoff) → skip/signal-fresh", () => {
    const freshUpdatedAt = NOW - 1000; // just 1 second ago
    const r = classifyOrphanMergedReconcile({ ...BASE, signalUpdatedAt: freshUpdatedAt });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("signal-fresh");
  });

  test("PR MERGED + bg_job_id:null + stale → emit-complete (null counts as dead)", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, bgJobAlive: false });
    expect(r.action).toBe("emit-complete");
  });

  test("alreadyEmitted → skip/already-emitted", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, alreadyEmitted: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("already-emitted");
  });

  test("prState null → skip (fail-closed — missing evidence never treated as merged)", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, prState: null });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("pr-state-unknown");
  });

  test("prState undefined → skip (fail-closed)", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, prState: undefined });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("pr-state-unknown");
  });

  test("linearTerminal → skip/linear-terminal", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, linearTerminal: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("linear-terminal");
  });

  test(".terminal-done.applied present → skip (teardown owns it)", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, terminalDoneApplied: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("terminal-done-owns-it");
  });

  test("terminalDoneApplied takes precedence over linearTerminal", () => {
    const r = classifyOrphanMergedReconcile({ ...BASE, terminalDoneApplied: true, linearTerminal: true });
    expect(r.reason).toBe("terminal-done-owns-it");
  });
});

// ---------------------------------------------------------------------------
// defaultCollectOrphanMergedCandidates — census
// ---------------------------------------------------------------------------
describe("defaultCollectOrphanMergedCandidates — census (CTL-1064 catC)", () => {
  function makeCandidate(overrides = {}) {
    return {
      ticket: "CTL-MERGED",
      phase: "monitor-merge",
      signal: { ticket: "CTL-MERGED", phase: "monitor-merge", status: "failed", failureReason: "orphan-sweep-stale", bg_job_id: "abc123", updatedAt: new Date(STALE_UPDATED_AT).toISOString() },
      workerDir: "/fake/orch/workers/CTL-MERGED",
      evidence: {
        reason: "orphan-sweep-stale",
        ticket: "CTL-MERGED",
        phase: "monitor-merge",
        liveSessionInWorktree: false,
        linearTerminal: false,
      },
      ...overrides,
    };
  }

  test("normalizes orphan-sweep-stale candidate with PR MERGED + dead bg", () => {
    const candidates = defaultCollectOrphanMergedCandidates({
      candidates: [makeCandidate()],
      resolvePrState: () => "MERGED",
      jobLifecycle: () => false,
      nowMs: NOW,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.prState).toBe("MERGED");
    expect(candidates[0].evidence.bgJobAlive).toBe(false);
  });

  test("skips candidates with wrong reason", () => {
    const c = makeCandidate();
    c.evidence.reason = "rebase_refused_dirty_tree";
    const candidates = defaultCollectOrphanMergedCandidates({ candidates: [c], nowMs: NOW });
    expect(candidates).toHaveLength(0);
  });

  test("skips candidates not in phaseAllowlist", () => {
    const c = makeCandidate({ phase: "implement" });
    c.evidence.phase = "implement";
    const candidates = defaultCollectOrphanMergedCandidates({ candidates: [c], nowMs: NOW });
    expect(candidates).toHaveLength(0);
  });

  test("resolvePrState throw → candidate.prState=null (fail-closed)", () => {
    const candidates = defaultCollectOrphanMergedCandidates({
      candidates: [makeCandidate()],
      resolvePrState: () => { throw new Error("API unavailable"); },
      nowMs: NOW,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.prState).toBeNull();
  });

  test("per-candidate catch: a seam throw on one ticket does not abort others", () => {
    const bad = makeCandidate({ ticket: "CTL-BAD" });
    bad.evidence = null; // will cause a throw when accessing .reason
    const good = makeCandidate({ ticket: "CTL-GOOD" });
    const candidates = defaultCollectOrphanMergedCandidates({
      candidates: [bad, good],
      resolvePrState: () => "MERGED",
      nowMs: NOW,
    });
    // bad skipped, good passes
    expect(candidates.some(c => c.ticket === "CTL-GOOD")).toBe(true);
  });
});
