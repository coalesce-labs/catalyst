// fence-stale-redispatch-seam.test.mjs — CTL-1679 Phase 1.
//
// Hermetic tests for defaultInvokeSeam(ticket, "fence-stale-redispatch", ...).
// The seam re-arms a cluster_fence_stale-failed phase for a fresh-generation
// re-dispatch: delete the stale claim tombstone, reset the phase signal to
// pending (dropping failureReason, preserving every other field), clear the
// dispatch cooldown, and spawn a synthetic emit-complete wake. The emit binary
// is injected (deps.spawnSyncFn) so no real dispatch fires.
//
// Run: cd plugins/dev/scripts/execution-core && bun test __tests__/fence-stale-redispatch-seam.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { defaultInvokeSeam } from "../recovery-reasoning.mjs";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("CTL-1679 fence-stale-redispatch seam", () => {
  let orchDir;
  let calls;
  // A hermetic spawnSync stub that records its invocation and returns success.
  const spawnStub = (...args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };

  function signalPath(ticket, phase) {
    return join(orchDir, "workers", ticket, `phase-${phase}.json`);
  }
  function claimPath(ticket, phase, gen) {
    return join(orchDir, "workers", ticket, `phase-${phase}.claim.${gen}`);
  }
  function cooldownPath(ticket, phase) {
    return join(orchDir, ".dispatch-cooldowns", `${ticket}-${phase}.json`);
  }
  function writeSignal(ticket, phase, obj) {
    const p = signalPath(ticket, phase);
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  }

  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "fence-stale-seam-"));
    calls = [];
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("happy path: resets signal to pending, deletes tombstone, clears cooldown, wakes", () => {
    const ticket = "CTL-1";
    const phase = "pr";
    writeSignal(ticket, phase, {
      status: "failed",
      failureReason: "cluster_fence_stale",
      generation: 3,
      worktreePath: "/tmp/wt/CTL-1",
      attempt: 2,
      ticket,
      phase,
    });
    // Stale claim tombstone at the signal's generation.
    writeFileSync(claimPath(ticket, phase, 3), "");
    // Dispatch cooldown marker that must be cleared.
    mkdirSync(join(orchDir, ".dispatch-cooldowns"), { recursive: true });
    writeFileSync(cooldownPath(ticket, phase), JSON.stringify({ failedAt: Date.now() }));

    const res = defaultInvokeSeam(
      ticket,
      "fence-stale-redispatch",
      { reason: "stale fence" },
      { orchDir, phase, spawnSyncFn: spawnStub },
    );

    expect(res.success).toBe(true);
    // Tombstone deleted.
    expect(existsSync(claimPath(ticket, phase, 3))).toBe(false);
    // Cooldown marker cleared.
    expect(existsSync(cooldownPath(ticket, phase))).toBe(false);
    // Signal reset to pending, failureReason removed, other fields preserved.
    const sig = JSON.parse(readFileSync(signalPath(ticket, phase), "utf8"));
    expect(sig.status).toBe("pending");
    expect(sig.failureReason).toBeUndefined();
    expect(sig.generation).toBe(3);
    expect(sig.worktreePath).toBe("/tmp/wt/CTL-1");
    expect(sig.attempt).toBe(2);
    // Synthetic wake spawned exactly once with --no-signal-update.
    expect(calls.length).toBe(1);
    const argv = calls[0][1];
    expect(argv).toContain("--no-signal-update");
    expect(argv).toContain("--ticket");
    expect(argv).toContain(ticket);
    expect(argv).toContain("--status");
    expect(argv).toContain("complete");
  });

  test("idempotency: running twice does not throw and leaves the signal pending", () => {
    const ticket = "CTL-2";
    const phase = "implement";
    writeSignal(ticket, phase, {
      status: "failed",
      failureReason: "cluster_fence_stale",
      generation: 1,
      ticket,
      phase,
    });
    const first = defaultInvokeSeam(
      ticket,
      "fence-stale-redispatch",
      {},
      { orchDir, phase, spawnSyncFn: spawnStub },
    );
    expect(first.success).toBe(true);
    const second = defaultInvokeSeam(
      ticket,
      "fence-stale-redispatch",
      {},
      { orchDir, phase, spawnSyncFn: spawnStub },
    );
    expect(second.success).toBe(true);
    const sig = JSON.parse(readFileSync(signalPath(ticket, phase), "utf8"));
    expect(sig.status).toBe("pending");
    expect(sig.failureReason).toBeUndefined();
  });

  test("missing signal: returns a structured failure, does not throw", () => {
    const ticket = "CTL-3";
    const phase = "pr";
    // No signal file written.
    const res = defaultInvokeSeam(
      ticket,
      "fence-stale-redispatch",
      {},
      { orchDir, phase, spawnSyncFn: spawnStub },
    );
    expect(res.success).toBe(false);
    expect(typeof res.reason).toBe("string");
    // No wake spawned when there is nothing to re-arm.
    expect(calls.length).toBe(0);
  });

  test("no orchDir: returns a structured failure", () => {
    const res = defaultInvokeSeam(
      "CTL-4",
      "fence-stale-redispatch",
      {},
      { orchDir: null, phase: "pr", spawnSyncFn: spawnStub },
    );
    expect(res.success).toBe(false);
    expect(typeof res.reason).toBe("string");
  });
});
