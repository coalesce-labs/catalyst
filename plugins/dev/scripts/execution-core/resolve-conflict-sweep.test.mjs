import { describe, test, expect } from "bun:test";
import {
  classifyResolveConflictCandidate,
  RESOLVE_CONFLICT_STALL_REASON,
  RESOLVED_MARKER_REASON,
  CAP_EXHAUSTED_REASON,
  RESOLVE_CONFLICT_CYCLE_CAP,
  defaultCollectResolveConflictCandidates,
} from "./resolve-conflict-sweep.mjs";

describe("constants", () => {
  test("stall reason strings match the real producer + do not collide with the enum", () => {
    expect(RESOLVE_CONFLICT_STALL_REASON).toBe("source_conflict_ctl708_unavailable");
    expect(RESOLVED_MARKER_REASON).toBe("source_conflict_resolvable");
    expect(CAP_EXHAUSTED_REASON).toBe("resolve-conflict-cycle-cap-exhausted");
    expect(RESOLVE_CONFLICT_CYCLE_CAP).toBeGreaterThan(0);
  });
});

describe("classifyResolveConflictCandidate", () => {
  test("not our stall reason and not already resolving → skip", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: false, alreadyResolving: false, cycleCount: 0, classification: null }))
      .toEqual({ action: "skip", reason: "not-our-stall" });
  });

  test("cap already exhausted → cap-exhausted regardless of classification", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 3, classification: { resolvable: true, conflictFiles: [], conflictTypes: [] } }))
      .toEqual({ action: "cap-exhausted", reason: "cycle-cap-exhausted" });
  });

  test("already marked/dispatched this cycle → skip (dispatch is in flight)", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: false, alreadyResolving: true, cycleCount: 0, classification: null }))
      .toEqual({ action: "skip", reason: "already-resolving" });
  });

  test("classification unavailable (merge-tree probe failed this tick) → skip, retry next tick", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 0, classification: null }))
      .toEqual({ action: "skip", reason: "classification-unavailable" });
  });

  test("classified not-resolvable → skip, leave for existing needs-human surfacing", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 0, classification: { resolvable: false, conflictFiles: ["a.ts"], conflictTypes: ["modify/delete"] } }))
      .toEqual({ action: "skip", reason: "not-resolvable" });
  });

  test("resolvable and under cap → mark-and-dispatch", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 1, classification: { resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] } }))
      .toEqual({ action: "mark-and-dispatch", reason: "resolvable" });
  });
});

describe("defaultCollectResolveConflictCandidates", () => {
  function fakeFs({ workerDirs, files }) {
    return {
      readdirSync: (p, opts) => {
        if (opts?.withFileTypes) {
          return (workerDirs[p] ?? []).map((name) => ({ name, isDirectory: () => true }));
        }
        return files[p] ?? [];
      },
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
    };
  }

  test("finds a ticket stalled via failureReason (the real producer field)", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-1"] },
      files: {
        "/orch/workers/CTL-1": ["phase-implement.json"],
        "/orch/workers/CTL-1/phase-implement.json": JSON.stringify({
          status: "stalled",
          failureReason: "source_conflict_ctl708_unavailable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ticket: "CTL-1", phase: "implement" });
  });

  test("also finds a ticket via the legacy stalledReason field (defensive dual-check)", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-2"] },
      files: {
        "/orch/workers/CTL-2": ["phase-verify.json"],
        "/orch/workers/CTL-2/phase-verify.json": JSON.stringify({
          status: "stalled",
          stalledReason: "source_conflict_ctl708_unavailable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0].ticket).toBe("CTL-2");
  });

  test("finds an already-marked (in-flight) ticket via RESOLVED_MARKER_REASON", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-3"] },
      files: {
        "/orch/workers/CTL-3": ["phase-review.json"],
        "/orch/workers/CTL-3/phase-review.json": JSON.stringify({
          status: "stalled",
          failureReason: "source_conflict_resolvable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0].raw.failureReason).toBe("source_conflict_resolvable");
  });

  test("ignores an unrelated stall reason", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-4"] },
      files: {
        "/orch/workers/CTL-4": ["phase-implement.json"],
        "/orch/workers/CTL-4/phase-implement.json": JSON.stringify({
          status: "stalled",
          failureReason: "rebase_refused_dirty_tree",
        }),
      },
    });
    expect(defaultCollectResolveConflictCandidates({ orchDir, ...fs })).toHaveLength(0);
  });

  test("a missing workers dir returns []", () => {
    expect(defaultCollectResolveConflictCandidates({ orchDir: "/nope", readdirSync: () => { throw new Error("ENOENT"); } })).toEqual([]);
  });
});
