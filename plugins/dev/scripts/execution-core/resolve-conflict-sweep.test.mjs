import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyResolveConflictCandidate,
  RESOLVE_CONFLICT_STALL_REASON,
  RESOLVED_MARKER_REASON,
  CAP_EXHAUSTED_REASON,
  RESOLVE_CONFLICT_CYCLE_CAP,
  defaultCollectResolveConflictCandidates,
  classifyLiveConflict,
  defaultLocalMergeTree,
  writeResolveConflictBrief,
  markStalledSignalResolving,
  defaultMarkAndDispatch,
  defaultEscalateCapExhausted,
  defaultCollectResolveConflictCompletions,
  runResolveConflictSweepPass,
  emitResolveConflictEvent,
  RESOLVE_CONFLICT_SWEEP_EVENT_TYPES,
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

  // #1461 Fix 2 (CRITICAL final-review finding): the cap check runs BEFORE the
  // already-resolving check — this is exactly what lets a repeatedly-FAILING
  // resolve-conflict run eventually escalate instead of being permanently
  // invisible. Once cycleCount (now counting BOTH complete AND failed dispatch
  // attempts, via countResolveConflictAttempts) reaches the cap, a candidate
  // that's STILL marked "already-resolving" (the original stalled-phase signal
  // never got de-marked because the dispatched runs kept failing, not
  // completing) routes to cap-exhausted instead of skip-forever.
  test("cap exhausted even while still marked already-resolving → cap-exhausted, not skip (Fix 2: repeated failures escalate)", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: false, alreadyResolving: true, cycleCount: 3, classification: null }))
      .toEqual({ action: "cap-exhausted", reason: "cycle-cap-exhausted" });
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

// #1461 Fix 5 (final-review finding, human-approved design): classifyLiveConflict
// now diffs LOCAL HEAD (in the ticket's worktree) against origin/<base> — NOT
// origin/<base> vs origin/<ticket> (the pushed remote branch). The `mergeTree`
// seam is now a 2-arg (worktreePath, base) call — no `head`/ticket-branch arg —
// since a dispatch-time pre-flight rebase stall typically happens BEFORE the
// ticket's branch has ever been pushed, and local HEAD never needs fetching.
describe("classifyLiveConflict", () => {
  test("delegates to the injected 2-arg (worktreePath, base) mergeTree seam then classifyMergeTree", async () => {
    const mergeTree = async (wt, base) => {
      expect(wt).toBe("/wt/CTL-1");
      expect(base).toBe("main");
      return { exitCode: 1, output: "CONFLICT (content): Merge conflict in a.ts" };
    };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-1", base: "main" }, { mergeTree });
    expect(result).toEqual({ resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] });
  });

  // Proves classification now works against a LOCAL, UNPUSHED worktree state:
  // the fake mergeTree seam never receives (or needs) a ticket/head branch name
  // at all — it only ever sees the worktree path + base, exactly what a
  // pre-push implement-phase stall can supply.
  test("classifies a local unpushed worktree's HEAD without ever referencing a ticket branch name", async () => {
    let sawArgs;
    const mergeTree = async (...args) => {
      sawArgs = args;
      // Simulates `git merge-tree --write-tree origin/main HEAD` finding a
      // clean, additive resolution — no fetch/diff of any origin/<ticket> ref.
      return { exitCode: 0, output: "" };
    };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-unpushed", base: "main" }, { mergeTree });
    expect(sawArgs).toEqual(["/wt/CTL-unpushed", "main"]);
    expect(result).toEqual({ resolvable: true, conflictFiles: [], conflictTypes: [] });
  });

  test("returns null when the mergeTree seam throws (probe failed this tick)", async () => {
    const mergeTree = async () => { throw new Error("fetch failed"); };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-1", base: "main" }, { mergeTree });
    expect(result).toBeNull();
  });

  test("returns null when worktreePath is missing (never spawn git blind)", async () => {
    const result = await classifyLiveConflict({ worktreePath: null, base: "main" }, { mergeTree: async () => ({ exitCode: 0, output: "" }) });
    expect(result).toBeNull();
  });
});

// defaultLocalMergeTree — the real (non-injected) seam classifyLiveConflict
// defaults to. Unit-testable only at the argv-shape level without spawning
// real git (a real-git integration test, mirroring stale-pr-rescue-timer.test.mjs's
// "defaultMergeTree (real git)" suite, is out of scope for this pass — the
// task's own guidance is "inject a fake git-runner seam, don't spawn real git").
describe("defaultLocalMergeTree", () => {
  test("is exported and is an async function distinct from defaultMergeTree's remote-fetch shape", () => {
    expect(typeof defaultLocalMergeTree).toBe("function");
    expect(defaultLocalMergeTree.constructor.name).toBe("AsyncFunction");
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

  // fakeSettleDispatchSync — a minimal stand-in for the real settleDispatchSync
  // (dispatch.mjs) that honors verifySync + onSettled exactly like the real one:
  // the synchronous provisional code reflects verifySync(), and onSettled fires
  // when the underlying promise resolves/rejects.
  function fakeSettleDispatchSync(result, { verifySync, onSettled } = {}) {
    const ok = verifySync ? verifySync() !== false : true;
    const pending = Promise.resolve(result).then(
      (r) => { onSettled?.(r, null); return r; },
      (err) => { onSettled?.(null, err); return { code: 1, error: err }; },
    );
    return { code: ok ? 0 : 1, async: true, pending };
  }

  test("sdk dispatch path: verifySync (sdkSignalRunnable) false → reports failure, not a blind success", () => {
    const deps = baseDeps({
      dispatch: () => Promise.resolve({ code: 0 }),
      isThenable: (x) => x != null && typeof x.then === "function",
      settleDispatchSync: fakeSettleDispatchSync,
      sdkSignalRunnable: () => false, // the prelaunch signal never went runnable
    });
    const result = defaultMarkAndDispatch(
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
  });

  test("sdk dispatch path: a rejected promise triggers backstopOnRejection", async () => {
    const backstopCalls = [];
    const deps = baseDeps({
      dispatch: () => Promise.reject(new Error("boom")),
      isThenable: (x) => x != null && typeof x.then === "function",
      settleDispatchSync: fakeSettleDispatchSync,
      sdkSignalRunnable: () => true,
      backstopOnRejection: (ctx) => (_res, err) => { backstopCalls.push([ctx, err.message]); },
    });
    const result = defaultMarkAndDispatch(
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    );
    expect(result.pendingSdk).toBeTruthy();
    await result.pendingSdk;
    expect(backstopCalls).toHaveLength(1);
    expect(backstopCalls[0][0]).toMatchObject({ ticket: "CTL-1", phase: "resolve-conflict" });
    expect(backstopCalls[0][1]).toBe("boom");
  });

  test("malformed signal JSON returns a structured failure instead of throwing", () => {
    const deps = baseDeps({ readFileSync: () => "{not json" });
    const args = [
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    ];
    expect(() => defaultMarkAndDispatch(...args)).not.toThrow();
    const result = defaultMarkAndDispatch(...args);
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toMatch(/mark\/brief write failed/);
  });

  test("brief write failure returns a structured failure instead of throwing", () => {
    const deps = baseDeps({
      writeFileSync: (p) => {
        if (String(p).includes("resolve-conflict-brief")) throw new Error("disk full");
      },
    });
    const args = [
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    ];
    expect(() => defaultMarkAndDispatch(...args)).not.toThrow();
    const result = defaultMarkAndDispatch(...args);
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toMatch(/mark\/brief write failed/);
  });
});

describe("defaultEscalateCapExhausted", () => {
  test("marks the signal cap-exhausted and posts the escalation comment", () => {
    const reads = { "/w/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_resolvable" }) };
    const writes = [];
    const posted = [];
    const deps = {
      readFileSync: (p) => reads[p],
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: () => {},
      postComment: (ticket, body) => { posted.push([ticket, body]); return true; },
    };
    const ok = defaultEscalateCapExhausted({ ticket: "CTL-1", phase: "implement", workerDir: "/w", cycleCount: 3 }, deps);
    expect(ok).toBe(true);
    const written = JSON.parse(writes[0][1]);
    expect(written.failureReason).toBe("resolve-conflict-cycle-cap-exhausted");
    expect(posted).toHaveLength(1);
    expect(posted[0][0]).toBe("CTL-1");
    expect(posted[0][1]).toMatch(/^🔼 \*\*phase-resolve-conflict\*\* escalated/);
    expect(posted[0][1]).toMatch(/cycle cap \(3\)/);
  });
});

describe("defaultCollectResolveConflictCompletions", () => {
  function fakeFs({ workerDirs, files }) {
    return {
      readdirSync: (p, opts) => (opts?.withFileTypes ? (workerDirs[p] ?? []).map((n) => ({ name: n, isDirectory: () => true })) : (files[p] ?? [])),
      readFileSync: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
    };
  }

  // #1461 Fix 1: a completion is now reported ONLY when the ORIGINAL
  // stalled-phase signal is STILL present and STILL carries RESOLVED_MARKER_REASON.
  test("finds a ticket whose resolve-conflict phase is done, the brief names the stalled phase, and that phase is still marked resolving", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-1"] },
      files: {
        "/orch/workers/CTL-1": ["phase-resolve-conflict.json", "resolve-conflict-brief.json", "phase-implement.json"],
        "/orch/workers/CTL-1/phase-resolve-conflict.json": JSON.stringify({ status: "done" }),
        "/orch/workers/CTL-1/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
        "/orch/workers/CTL-1/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_resolvable" }),
      },
    });
    const out = defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs });
    expect(out).toEqual([{ ticket: "CTL-1", stalledPhase: "implement" }]);
  });

  test("skips a ticket whose resolve-conflict phase is not done", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-2"] },
      files: {
        "/orch/workers/CTL-2": ["phase-resolve-conflict.json", "resolve-conflict-brief.json"],
        "/orch/workers/CTL-2/phase-resolve-conflict.json": JSON.stringify({ status: "running" }),
        "/orch/workers/CTL-2/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "verify" }),
      },
    });
    expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs })).toEqual([]);
  });

  test("skips a ticket with no resolve-conflict signal at all", () => {
    const fs = fakeFs({ workerDirs: { "/orch/workers": ["CTL-3"] }, files: { "/orch/workers/CTL-3": ["phase-implement.json"] } });
    expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs })).toEqual([]);
  });

  // #1461 Fix 1 (CRITICAL final-review finding): idempotence guard tests.
  describe("Fix 1 idempotence guard", () => {
    function filesFor(stalledSignalRaw) {
      const files = {
        "/orch/workers/CTL-1": ["phase-resolve-conflict.json", "resolve-conflict-brief.json", "phase-implement.json"],
        "/orch/workers/CTL-1/phase-resolve-conflict.json": JSON.stringify({ status: "done" }),
        "/orch/workers/CTL-1/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
      };
      if (stalledSignalRaw !== undefined) {
        files["/orch/workers/CTL-1/phase-implement.json"] = JSON.stringify(stalledSignalRaw);
      }
      return files;
    }

    test("(a) a completion is collected once when the stalled phase is still marked RESOLVED_MARKER_REASON", () => {
      const fs = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-1"] },
        files: filesFor({ status: "stalled", failureReason: "source_conflict_resolvable" }),
      });
      expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs }))
        .toEqual([{ ticket: "CTL-1", stalledPhase: "implement" }]);
    });

    test("(b) the SAME ticket is NOT collected again once the stalled-phase signal file is gone (simulates defaultClearStall deleting it)", () => {
      // First call: still present + marked → collected.
      const fsBefore = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-1"] },
        files: filesFor({ status: "stalled", failureReason: "source_conflict_resolvable" }),
      });
      expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fsBefore }))
        .toEqual([{ ticket: "CTL-1", stalledPhase: "implement" }]);

      // Second call: defaultClearStall's own first step (rmSync phase-implement.json)
      // has run — the file is gone. Must NOT be re-collected.
      const filesAfterClear = filesFor(undefined);
      delete filesAfterClear["/orch/workers/CTL-1/phase-implement.json"];
      const fsAfter = fakeFs({ workerDirs: { "/orch/workers": ["CTL-1"] }, files: filesAfterClear });
      expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fsAfter })).toEqual([]);
    });

    test("(c) not re-collected when something else already re-marked the stalled phase with a DIFFERENT reason", () => {
      const fs = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-1"] },
        files: filesFor({ status: "stalled", failureReason: "resolve-conflict-cycle-cap-exhausted" }),
      });
      expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs })).toEqual([]);
    });

    test("not collected when the stalled-phase signal is unreadable/corrupt (treated like absent)", () => {
      const files = filesFor(undefined);
      files["/orch/workers/CTL-1/phase-implement.json"] = "{not valid json";
      const fs = fakeFs({ workerDirs: { "/orch/workers": ["CTL-1"] }, files });
      expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs })).toEqual([]);
    });
  });
});

describe("runResolveConflictSweepPass", () => {
  test("mode 'off' skips everything, no census called", () => {
    const collectCandidates = () => { throw new Error("must not be called"); };
    const report = runResolveConflictSweepPass({ mode: "off", collectCandidates });
    expect(report).toEqual({ marked: [], wouldMark: [], escalated: [], wouldEscalate: [], cleared: [], wouldClear: [], skipped: [], failed: [] });
  });

  test("shadow mode classifies and emits would-mark, takes no action", async () => {
    const emitted = [];
    const report = await runResolveConflictSweepPass({
      mode: "shadow",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_ctl708_unavailable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 0,
      classifyLive: async () => ({ resolvable: true, conflictFiles: [], conflictTypes: [] }),
      markAndDispatch: () => { throw new Error("must not be called in shadow"); },
      emit: (type) => emitted.push(type),
    });
    expect(report.wouldMark).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(emitted).toContain("resolve-conflict.would.mark");
    // #1461 Fix 4: resolve-conflict.would.dispatch was in the closed vocabulary
    // but never actually fired by the driver on the shadow twin — the enforce
    // path fires TWO distinct events for this action (marked.resolvable, then
    // dispatched), so shadow now fires both twins for observability parity.
    expect(emitted).toContain("resolve-conflict.would.dispatch");
  });

  // #1461 Fix 4: shadow-mode "would escalate" observability parity — the cap-
  // exhausted path's shadow twin must actually fire, not just the enforce path.
  test("shadow mode emits would-escalate for a cap-exhausted candidate, takes no action", async () => {
    const emitted = [];
    const report = await runResolveConflictSweepPass({
      mode: "shadow",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_resolvable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 3,
      escalateCapExhausted: () => { throw new Error("must not be called in shadow"); },
      emit: (type) => emitted.push(type),
    });
    expect(report.wouldEscalate).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(emitted).toContain("resolve-conflict.would.escalate");
  });

  test("enforce mode marks + dispatches a resolvable candidate", async () => {
    const dispatched = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_ctl708_unavailable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 0,
      classifyLive: async () => ({ resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] }),
      markAndDispatch: (c) => { dispatched.push(c.ticket); return { success: true, dispatched: true }; },
      emit: async () => true,
    });
    expect(report.marked).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(dispatched).toEqual(["CTL-1"]);
  });

  test("enforce mode escalates a cap-exhausted candidate", async () => {
    const escalated = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_resolvable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 3,
      classifyLive: async () => ({ resolvable: true, conflictFiles: [], conflictTypes: [] }),
      escalateCapExhausted: (c) => { escalated.push(c.ticket); return true; },
      emit: async () => true,
    });
    expect(report.escalated).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(escalated).toEqual(["CTL-1"]);
  });

  // #1461 Fix 2 (CRITICAL final-review finding): a REPEATEDLY-FAILING
  // resolve-conflict run (never a successful completion) must still reach the
  // cap and escalate via the SAME defaultEscalateCapExhausted path — driven end
  // to end by cycleCountOf reflecting countResolveConflictAttempts (complete +
  // failed), not the completion-only countResolveConflictCycles.
  test("a candidate whose cycleCountOf reflects FAILED (not completed) dispatch attempts still escalates at the cap", async () => {
    const escalated = [];
    const cycleCountCalls = [];
    // Simulates the real wiring: cycleCountOf === countResolveConflictAttempts,
    // which has counted 3 `phase.resolve-conflict.failed.<ticket>` events (zero
    // `.complete.` events) for this ticket — the run never once completed.
    const cycleCountOf = (ticket) => {
      cycleCountCalls.push(ticket);
      return 3; // RESOLVE_CONFLICT_CYCLE_CAP reached via failures alone
    };
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      // Still marked "already-resolving" — nothing ever de-marked it, because
      // every dispatched attempt FAILED rather than completing.
      collectCandidates: () => [{ ticket: "CTL-2", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_resolvable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf,
      classifyLive: async () => { throw new Error("must not classify — cap check precedes classification"); },
      escalateCapExhausted: (c) => { escalated.push(c.ticket); return true; },
      emit: async () => true,
    });
    expect(cycleCountCalls).toEqual(["CTL-2"]);
    expect(report.escalated).toEqual([{ ticket: "CTL-2", phase: "implement" }]);
    expect(escalated).toEqual(["CTL-2"]);
  });

  test("enforce mode clears a completion via the injected clearStall seam", async () => {
    const cleared = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [],
      collectCompletions: () => [{ ticket: "CTL-1", stalledPhase: "implement" }],
      clearStall: (c) => { cleared.push(c); return true; },
      emit: async () => true,
    });
    expect(report.cleared).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(cleared).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
  });

  test("a throwing census degrades to an empty pass, never aborts", async () => {
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => { throw new Error("census exploded"); },
      collectCompletions: () => [],
      emit: async () => true,
    });
    expect(report.marked).toEqual([]);
    expect(report.failed).toEqual([]);
  });
});

// #1461 Fix 4 (IMPORTANT final-review finding): emitResolveConflictEvent — the
// dedicated unified-log emitter, mirroring emitUnstuckEvent's own test suite
// (unstuck-sweep.test.mjs "emitUnstuckEvent — dedicated unified-log emitter").
describe("emitResolveConflictEvent — dedicated unified-log emitter (#1461)", () => {
  let SCRATCH, LOG_PATH, prevDir;
  beforeEach(() => {
    SCRATCH = mkdtempSync(join(tmpdir(), "resolve-conflict-emit-"));
    const ym = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    LOG_PATH = join(SCRATCH, "events", `${ym}.jsonl`);
    prevDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = SCRATCH;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevDir;
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  test("appends a valid resolve-conflict.* line to the unified log", async () => {
    const ok = await emitResolveConflictEvent("resolve-conflict.would.mark", {
      ticket: "CTL-Z",
      phase: "implement",
    });
    expect(ok).toBe(true);
    expect(existsSync(LOG_PATH)).toBe(true);
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.event).toBe("resolve-conflict.would.mark");
    expect(last.ticket).toBe("CTL-Z");
    expect(last.phase).toBe("implement");
    expect(last.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("accepts every type in the sweep's own closed vocabulary", async () => {
    for (const t of RESOLVE_CONFLICT_SWEEP_EVENT_TYPES) {
      expect(await emitResolveConflictEvent(t, { ticket: "CTL-Z" })).toBe(true);
    }
  });

  test("rejects an event type outside the sweep's closed vocabulary (does not silently no-op)", async () => {
    await expect(emitResolveConflictEvent("unstuck.would.clear-noise", {})).rejects.toThrow(
      /unknown resolve-conflict-sweep event type/
    );
  });
});
