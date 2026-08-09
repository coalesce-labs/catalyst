import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultInvokeSeam, reasoningRecoveryPass } from "./recovery-reasoning.mjs";
import { RECOVERY_FIX_BACKOFF_THRESHOLD } from "./recovery-fix-backoff.mjs";

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "cat-47-e2e-")));

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
});
