// Unit tests for the execution-core Step C merge-state decision (CTL-533).
// Run: cd plugins/dev/scripts/execution-core && bun test merge-state.test.mjs

import { describe, test, expect } from "bun:test";
import { nextMergeState } from "./merge-state.mjs";

// makeInputs — a deterministic fixture factory mirroring deploy-state-machine.test.ts.
function makeInputs(over = {}) {
  return {
    ticket: "CTL-1",
    prState: "OPEN",
    mergeStateStatus: "CLEAN",
    prNumber: 42,
    mergedAt: null, // PR.mergedAt from GitHub
    mergeCommitSha: "abc123",
    signalMergedAt: null, // .pr.mergedAt already recorded on the signal
    skipDeployVerification: true,
    currentStatus: "implementing",
    ...over,
  };
}

describe("nextMergeState", () => {
  test("MERGED + skipDeployVerification → status:'done', phase:6", () => {
    const out = nextMergeState(
      makeInputs({
        prState: "MERGED",
        mergedAt: "2026-05-21T03:00:00Z",
        skipDeployVerification: true,
      }),
    );
    expect(out.patch.status).toBe("done");
    expect(out.patch.phase).toBe(6);
  });

  test("MERGED + !skipDeployVerification → status:'merged', phase:5 (CTL-211)", () => {
    const out = nextMergeState(
      makeInputs({
        prState: "MERGED",
        mergedAt: "2026-05-21T03:00:00Z",
        skipDeployVerification: false,
      }),
    );
    expect(out.patch.status).toBe("merged");
    expect(out.patch.phase).toBe(5);
  });

  test("MERGED emits a worker-pr-merged event", () => {
    const out = nextMergeState(
      makeInputs({ prState: "MERGED", mergedAt: "2026-05-21T03:00:00Z" }),
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0].event).toBe("worker-pr-merged");
    expect(out.events[0].detail.pr).toBe(42);
    expect(out.events[0].detail.mergedAt).toBe("2026-05-21T03:00:00Z");
  });

  test("MERGED records pr.mergedAt + mergeCommitSha on the patch", () => {
    const out = nextMergeState(
      makeInputs({
        prState: "MERGED",
        mergedAt: "2026-05-21T03:00:00Z",
        mergeCommitSha: "def456",
      }),
    );
    expect(out.patch.pr.mergedAt).toBe("2026-05-21T03:00:00Z");
    expect(out.patch.pr.mergeCommitSha).toBe("def456");
  });

  test("MERGED is a no-op when mergedAt already recorded on the signal", () => {
    const out = nextMergeState(
      makeInputs({
        prState: "MERGED",
        mergedAt: "2026-05-21T03:00:00Z",
        signalMergedAt: "2026-05-21T03:00:00Z",
      }),
    );
    expect(out.patch).toEqual({});
    expect(out.attention).toBeNull();
    expect(out.events).toEqual([]);
  });

  test("CLOSED → raises a pr-closed attention", () => {
    const out = nextMergeState(makeInputs({ prState: "CLOSED" }));
    expect(out.attention).not.toBeNull();
    expect(out.attention.kind).toBe("pr-closed");
    expect(out.attention.ticket).toBe("CTL-1");
    expect(out.patch).toEqual({});
  });

  test("OPEN → no patch, no attention", () => {
    const out = nextMergeState(makeInputs({ prState: "OPEN" }));
    expect(out.patch).toEqual({});
    expect(out.attention).toBeNull();
    expect(out.events).toEqual([]);
  });

  test("OPEN + DIRTY/BEHIND/BLOCKED → no patch (handlers act out-of-band)", () => {
    for (const ms of ["DIRTY", "BEHIND", "BLOCKED"]) {
      const out = nextMergeState(
        makeInputs({ prState: "OPEN", mergeStateStatus: ms }),
      );
      expect(out.patch).toEqual({});
      expect(out.attention).toBeNull();
    }
  });

  test("status failed/stalled/turn-cap-exhausted → absorbed as no-op", () => {
    // turn-cap-exhausted is terminal since CTL-748 removed turn caps (CTL-830).
    for (const st of ["failed", "stalled", "turn-cap-exhausted"]) {
      const out = nextMergeState(
        makeInputs({ currentStatus: st, prState: "MERGED", mergedAt: "x" }),
      );
      expect(out.patch).toEqual({});
      expect(out.attention).toBeNull();
      expect(out.events).toEqual([]);
    }
  });
});
