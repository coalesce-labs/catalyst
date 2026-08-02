import { describe, test, expect } from "bun:test";
import {
  classifyResolveConflictCandidate,
  RESOLVE_CONFLICT_STALL_REASON,
  RESOLVED_MARKER_REASON,
  CAP_EXHAUSTED_REASON,
  RESOLVE_CONFLICT_CYCLE_CAP,
  defaultCollectResolveConflictCandidates,
  classifyLiveConflict,
  writeResolveConflictBrief,
  markStalledSignalResolving,
  defaultMarkAndDispatch,
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

describe("classifyLiveConflict", () => {
  test("delegates to the injected mergeTree seam then classifyMergeTree", async () => {
    const mergeTree = async (wt, base, head) => {
      expect(wt).toBe("/wt/CTL-1");
      expect(base).toBe("main");
      expect(head).toBe("CTL-1");
      return { exitCode: 1, output: "CONFLICT (content): Merge conflict in a.ts" };
    };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-1", base: "main", head: "CTL-1" }, { mergeTree });
    expect(result).toEqual({ resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] });
  });

  test("returns null when the mergeTree seam throws (probe failed this tick)", async () => {
    const mergeTree = async () => { throw new Error("fetch failed"); };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-1", base: "main", head: "CTL-1" }, { mergeTree });
    expect(result).toBeNull();
  });

  test("returns null when worktreePath is missing (never spawn git blind)", async () => {
    const result = await classifyLiveConflict({ worktreePath: null, base: "main", head: "CTL-1" }, { mergeTree: async () => ({ exitCode: 0, output: "" }) });
    expect(result).toBeNull();
  });
});

describe("writeResolveConflictBrief", () => {
  test("writes the v1 brief atomically and returns the path", () => {
    const writes = [];
    const renames = [];
    const deps = {
      mkdirSync: () => {},
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: (from, to) => renames.push([from, to]),
    };
    const brief = { ticket: "CTL-1", stalledPhase: "implement", conflictFiles: ["a.ts"], conflictTypes: ["content"], attempt: 1, maxAttempts: 3 };
    const p = writeResolveConflictBrief("/orch", "CTL-1", brief, deps);
    expect(p).toBe("/orch/workers/CTL-1/resolve-conflict-brief.json");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatch(/\.tmp\./);
    const written = JSON.parse(writes[0][1]);
    expect(written.schema).toBe("resolve-conflict-brief/v1");
    expect(written.ticket).toBe("CTL-1");
    expect(written.stalledPhase).toBe("implement");
    expect(renames).toEqual([[writes[0][0], p]]);
  });
});

describe("markStalledSignalResolving", () => {
  test("rewrites failureReason to RESOLVED_MARKER_REASON, preserves other fields", () => {
    const reads = { "/w/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_ctl708_unavailable", bg_job_id: "abc123" }) };
    const writes = [];
    const renames = [];
    markStalledSignalResolving("/w/phase-implement.json", {
      readFileSync: (p) => reads[p],
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: (from, to) => renames.push([from, to]),
    });
    const written = JSON.parse(writes[0][1]);
    expect(written.status).toBe("stalled");
    expect(written.failureReason).toBe("source_conflict_resolvable");
    expect(written.bg_job_id).toBe("abc123"); // untouched
    expect(renames).toHaveLength(1);
  });
});

describe("defaultMarkAndDispatch", () => {
  function baseDeps(overrides = {}) {
    return {
      readFileSync: () => JSON.stringify({ status: "stalled", failureReason: "source_conflict_ctl708_unavailable" }),
      writeFileSync: () => {},
      renameSync: () => {},
      mkdirSync: () => {},
      dispatch: () => ({ code: 0, signal: { bg_job_id: "job-1" } }),
      isThenable: () => false,
      ...overrides,
    };
  }

  test("marks the signal, writes the brief, dispatches — returns success:true", () => {
    const dispatched = [];
    const deps = baseDeps({ dispatch: (orchDir, ticket, phase) => { dispatched.push([orchDir, ticket, phase]); return { code: 0 }; } });
    const result = defaultMarkAndDispatch(
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(dispatched).toEqual([["/orch", "CTL-1", "resolve-conflict"]]);
  });

  test("returns success:false when dispatch reports a non-zero code", () => {
    const deps = baseDeps({ dispatch: () => ({ code: 1, stderr: "boom" }) });
    const result = defaultMarkAndDispatch(
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
  });
});
