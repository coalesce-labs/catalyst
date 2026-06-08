// Unit tests for the execution-core Step G stalled-detector decision (CTL-533).
// Run: cd plugins/dev/scripts/execution-core && bun test stalled-detector.test.mjs

import { describe, test, expect } from "bun:test";
import { detectStalled } from "./stalled-detector.mjs";
import { STALE_WORKER_CUTOFF_MS } from "./config.mjs";

const NOW = Date.parse("2026-05-21T12:00:00Z");

// makeInputs — fixture factory: a fresh, non-stale, non-terminal worker.
function makeInputs(over = {}) {
  return {
    ticket: "CTL-1",
    nowMs: NOW,
    updatedAtMs: NOW - 60_000, // 1 minute ago — fresh
    currentStatus: "implementing",
    prState: "NONE",
    commitCount: 0,
    remoteBranchExists: false,
    branch: "feat/ctl-1",
    ...over,
  };
}

describe("detectStalled", () => {
  test("updatedAt within cutoff → no-op", () => {
    const out = detectStalled(makeInputs());
    expect(out.patch).toEqual({});
    expect(out.attention).toBeNull();
  });

  test("updatedAt older than STALE_WORKER_CUTOFF_MS + PR MERGED → resolve-attention", () => {
    const out = detectStalled(
      makeInputs({
        updatedAtMs: NOW - STALE_WORKER_CUTOFF_MS - 60_000,
        prState: "MERGED",
      }),
    );
    expect(out.attention).not.toBeNull();
    expect(out.attention.kind).toBe("resolve-attention");
    expect(out.attention.ticket).toBe("CTL-1");
    expect(out.patch).toEqual({});
  });

  test("stale + PR OPEN → resolve-attention (not a stall)", () => {
    const out = detectStalled(
      makeInputs({
        updatedAtMs: NOW - STALE_WORKER_CUTOFF_MS - 60_000,
        prState: "OPEN",
      }),
    );
    expect(out.attention.kind).toBe("resolve-attention");
  });

  test("stale + no PR + no commits → raises a stalled attention", () => {
    const out = detectStalled(
      makeInputs({
        updatedAtMs: NOW - STALE_WORKER_CUTOFF_MS - 60_000,
        prState: "NONE",
        commitCount: 0,
      }),
    );
    expect(out.attention).not.toBeNull();
    expect(out.attention.kind).toBe("stalled");
    expect(out.attention.ticket).toBe("CTL-1");
  });

  test("terminal status (done/failed/stalled/turn-cap-exhausted) → absorbed as no-op", () => {
    // turn-cap-exhausted is terminal since CTL-748 removed turn caps (CTL-830).
    for (const st of ["done", "failed", "stalled", "turn-cap-exhausted"]) {
      const out = detectStalled(
        makeInputs({
          currentStatus: st,
          updatedAtMs: NOW - STALE_WORKER_CUTOFF_MS - 60_000,
          prState: "NONE",
        }),
      );
      expect(out.patch).toEqual({});
      expect(out.attention).toBeNull();
    }
  });

  test("a stale signal alone is never stall evidence (CTL-32)", () => {
    // Stale signal, but the PR is OPEN — the PR is authoritative progress.
    const out = detectStalled(
      makeInputs({
        updatedAtMs: NOW - STALE_WORKER_CUTOFF_MS - 10 * 60_000,
        prState: "OPEN",
      }),
    );
    expect(out.attention.kind).not.toBe("stalled");
  });

  test("missing updatedAtMs → treated as not-stale, no-op", () => {
    const out = detectStalled(makeInputs({ updatedAtMs: null }));
    expect(out.patch).toEqual({});
    expect(out.attention).toBeNull();
  });
});
