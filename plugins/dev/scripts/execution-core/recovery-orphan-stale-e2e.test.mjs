import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultInvokeSeam, reasoningRecoveryPass } from "./recovery-reasoning.mjs";
import { RECOVERY_FIX_BACKOFF_THRESHOLD } from "./recovery-fix-backoff.mjs";

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "cat-47-e2e-")));

// Defect B is a CALL-SITE bug: attemptFix dropped item.phase/item.evidence.signal,
// collapsing candidate to { ticket }. The AC1 case below hand-builds deps.candidate,
// so it cannot observe that regression — these assert the forwarding itself.
describe("attemptFix candidate forwarding (CAT-47 Defect B)", () => {
  const captureCandidate = (item) => {
    const seen = [];
    reasoningRecoveryPass([item], {
      mode: "enforce",
      orchDir: fresh(),
      shouldSkipItem: () => false,
      classifyTicket: () => ({
        decision: "fix",
        fix_class: "orphan_stale",
        details: { seam_id: "orphan-reconcile", reason: "stale" },
      }),
      invokeSeam: (...args) => {
        seen.push(args);
        return { success: true, details: {} };
      },
      recordIntent: () => {},
      postComment: () => {},
      emitEvent: () => {},
      log: () => {},
      nowMs: () => 1000,
    });
    return seen;
  };

  test("forwards the real phase and signal as the 4th-arg candidate", () => {
    const signal = { bg_job_id: "abc123", updatedAt: "2026-08-09T00:00:00Z" };
    const seen = captureCandidate({
      ticket: "CAT-47",
      phase: "monitor-merge",
      evidence: { signal },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0][3]).toEqual({
      candidate: { ticket: "CAT-47", phase: "monitor-merge", signal },
    });
  });

  test("a phase-less item forwards null (never undefined) rather than dropping the key", () => {
    const seen = captureCandidate({ ticket: "CAT-47", evidence: {} });
    expect(seen[0][3].candidate).toEqual({ ticket: "CAT-47", phase: null, signal: null });
  });
});

// Defect A is also a call-site bug: Pass 0r handed defaultInvokeSeam a dep bag with
// no resolvePrState, so the fallback registry was built on the inert () => null.
describe("defaultInvokeSeam registry selection (CAT-47 Defect A)", () => {
  const merged = {
    resolvePrState: () => "MERGED",
    jobLifecycle: () => false,
    nowMs: () => Date.parse("2026-08-09T03:00:00Z"),
    candidate: { phase: "monitor-merge", signal: { bg_job_id: "dead" } },
  };

  test("an EMPTY injected registry falls back to one built from the injected deps", () => {
    let emits = 0;
    const result = defaultInvokeSeam("CAT-47", "orphan-reconcile", {}, {
      ...merged,
      orchDir: fresh(),
      actByCategory: {},
      emitPhaseComplete: () => { emits += 1; return true; },
    });
    expect(result.success).toBe(true);
    expect(emits).toBe(1);
  });

  test("a registry MISSING this category falls back rather than reporting unavailable", () => {
    const result = defaultInvokeSeam("CAT-47", "orphan-reconcile", {}, {
      ...merged,
      orchDir: fresh(),
      actByCategory: { "dirty-tree": () => {} },
      emitPhaseComplete: () => true,
    });
    expect(result.success).toBe(true);
    expect(result.reason ?? "").not.toContain("unavailable");
  });

  test("a registry that DOES provide the category is used verbatim (not rebuilt)", () => {
    let called = 0;
    const result = defaultInvokeSeam("CAT-47", "orphan-reconcile", {}, {
      orchDir: fresh(),
      candidate: { phase: "monitor-merge", signal: null },
      actByCategory: { "orphan-stale": (candidate) => { called += 1; expect(candidate.phase).toBe("monitor-merge"); } },
    });
    expect(result.success).toBe(true);
    expect(called).toBe(1);
  });
});

describe("orphan-stale recovery end to end (CAT-47)", () => {
  test("AC1/AC2: merged PR emits once and uses the literal real-phase marker", () => {
    const root = fresh();
    let emits = 0;
    const deps = {
      orchDir: root,
      resolvePrState: () => "MERGED",
      jobLifecycle: () => false,
      emitPhaseComplete: () => { emits += 1; return true; },
      nowMs: () => Date.parse("2026-08-09T03:00:00Z"),
      candidate: {
        phase: "monitor-merge",
        signal: { bg_job_id: "dead", updatedAt: "2026-08-09T00:00:00Z" },
      },
    };
    expect(defaultInvokeSeam("CAT-47", "orphan-reconcile", {}, deps).success).toBe(true);
    expect(defaultInvokeSeam("CAT-47", "orphan-reconcile", {}, deps).success).toBe(true);
    expect(emits).toBe(1);
    expect(existsSync(join(root, "workers", "CAT-47", ".unstuck-orphan-merge-monitor-merge.applied"))).toBe(true);
  });

  test("AC3: identical seam failures stop at the threshold and comment once", () => {
    const root = fresh();
    let attempts = 0;
    let comments = 0;
    const item = { ticket: "CAT-47", phase: "monitor-merge", evidence: { signal: {} } };
    const options = {
      mode: "enforce",
      orchDir: root,
      shouldSkipItem: () => false,
      classifyTicket: () => ({ decision: "fix", fix_class: "orphan_stale", details: { seam_id: "orphan-reconcile", reason: "stale" } }),
      invokeSeam: () => { attempts += 1; throw new Error("same failure"); },
      recordIntent: () => {},
      postComment: () => { comments += 1; },
      emitEvent: () => {},
      log: () => {},
      nowMs: () => 1000,
    };
    for (let i = 0; i < RECOVERY_FIX_BACKOFF_THRESHOLD + 3; i += 1) {
      reasoningRecoveryPass([item], options);
    }
    expect(attempts).toBe(RECOVERY_FIX_BACKOFF_THRESHOLD);
    expect(comments).toBe(1);
  });

  test("a failed comment delivery is retried before the backoff threshold", () => {
    const root = fresh();
    let comments = 0;
    const options = {
      mode: "enforce", orchDir: root, shouldSkipItem: () => false,
      classifyTicket: () => ({ decision: "fix", fix_class: "orphan_stale", details: { seam_id: "orphan-reconcile", reason: "stale" } }),
      invokeSeam: () => { throw new Error("same failure"); }, recordIntent: () => {}, emitEvent: () => {}, log: () => {}, nowMs: () => 1000,
      postComment: () => { comments += 1; throw new Error("Linear unavailable"); },
    };
    const item = { ticket: "CAT-47", phase: "monitor-merge", evidence: { signal: {} } };
    reasoningRecoveryPass([item], options);
    reasoningRecoveryPass([item], options);
    expect(comments).toBe(2);
  });

  // defaultPostComment fails CLOSED without throwing ({ok:false} on a non-zero
  // linear-comment-post.sh exit), so the throw-based test above does not cover
  // the production failure shape. Committing the hash there would suppress the
  // audit comment permanently on a Linear outage.
  test("a non-throwing {ok:false} post does not commit the dedup hash", () => {
    const root = fresh();
    let comments = 0;
    const options = {
      mode: "enforce", orchDir: root, shouldSkipItem: () => false,
      classifyTicket: () => ({ decision: "fix", fix_class: "orphan_stale", details: { seam_id: "orphan-reconcile", reason: "stale" } }),
      invokeSeam: () => { throw new Error("same failure"); }, recordIntent: () => {}, emitEvent: () => {}, log: () => {}, nowMs: () => 1000,
      postComment: () => { comments += 1; return { ok: false, via: "app-actor", status: 1 }; },
    };
    const item = { ticket: "CAT-47", phase: "monitor-merge", evidence: { signal: {} } };
    reasoningRecoveryPass([item], options);
    reasoningRecoveryPass([item], options);
    expect(comments).toBe(2);
  });

  test("a delivered {ok:true} post commits the hash and suppresses the duplicate", () => {
    const root = fresh();
    let comments = 0;
    const options = {
      mode: "enforce", orchDir: root, shouldSkipItem: () => false,
      classifyTicket: () => ({ decision: "fix", fix_class: "orphan_stale", details: { seam_id: "orphan-reconcile", reason: "stale" } }),
      invokeSeam: () => { throw new Error("same failure"); }, recordIntent: () => {}, emitEvent: () => {}, log: () => {}, nowMs: () => 1000,
      postComment: () => { comments += 1; return { ok: true, via: "app-actor" }; },
    };
    const item = { ticket: "CAT-47", phase: "monitor-merge", evidence: { signal: {} } };
    reasoningRecoveryPass([item], options);
    reasoningRecoveryPass([item], options);
    expect(comments).toBe(1);
  });
});
