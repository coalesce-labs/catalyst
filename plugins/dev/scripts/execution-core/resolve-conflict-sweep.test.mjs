import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
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
  maybeResetForResolveConflictCycle,
  defaultEscalateCapExhausted,
  defaultCollectResolveConflictCompletions,
  defaultCollectResolveConflictFailures,
  defaultRevertStallAndResetCycle,
  runResolveConflictSweepPass,
  emitResolveConflictEvent,
  RESOLVE_CONFLICT_SWEEP_EVENT_TYPES,
} from "./resolve-conflict-sweep.mjs";
import { countResolveConflictAttempts } from "./event-scan.mjs";

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

// #1461 follow-up (final whole-branch re-review): the cycle-reset gap. Without
// maybeResetForResolveConflictCycle, a SECOND genuine stall on the same ticket
// calls dispatch() again while workers/<T>/phase-resolve-conflict.json still
// shows a status from the FIRST cycle — phase-agent-dispatch's own idempotency
// guard (dispatched|running|done → no-op) then silently swallows the redispatch,
// no real resolution work ever happens on cycle 2+, and RESOLVE_CONFLICT_CYCLE_CAP
// can never trip.
//
// inMemoryFs — a minimal in-memory filesystem double shared by the tests below.
// Deliberately simple (flat map keyed by full path) so the reset logic's own
// readdirSync(workerDir) call (a plain listing, no withFileTypes) can be
// exercised faithfully alongside readFileSync/writeFileSync/renameSync/rmSync.
function inMemoryFs(initial = {}) {
  const files = { ...initial };
  const deps = {
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    writeFileSync: (p, body) => {
      files[p] = body;
    },
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
    mkdirSync: () => {},
    rmSync: (p) => {
      delete files[p];
    },
    readdirSync: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
        .map((f) => f.slice(prefix.length));
    },
  };
  return { files, deps };
}

describe("maybeResetForResolveConflictCycle (#1461 follow-up)", () => {
  const orchDir = "/orch";
  const ticket = "CTL-1";
  const workerDir = `${orchDir}/workers/${ticket}`;
  const signalPath = `${workerDir}/phase-resolve-conflict.json`;
  const briefPath = `${workerDir}/resolve-conflict-brief.json`;

  test("(a) no existing signal at all → false, no-op (the common first-cycle case)", () => {
    const { deps } = inMemoryFs({});
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(false);
  });

  test("(b) terminal 'done' → deletes the signal + brief + claim tombstones + progress marker, returns true", () => {
    const { files, deps } = inMemoryFs({
      [signalPath]: JSON.stringify({ status: "done", generation: 1 }),
      [briefPath]: JSON.stringify({ stalledPhase: "implement", attempt: 1 }),
      [`${workerDir}/resolve-conflict.claim.1`]: "{}",
      [`${workerDir}/.progress-resolve-conflict`]: "3",
      // an unrelated phase's claim + progress marker must survive
      [`${workerDir}/implement.claim.1`]: "{}",
      [`${workerDir}/.progress-implement`]: "9",
    });
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(true);
    expect(signalPath in files).toBe(false);
    expect(briefPath in files).toBe(false);
    expect(`${workerDir}/resolve-conflict.claim.1` in files).toBe(false);
    expect(`${workerDir}/.progress-resolve-conflict` in files).toBe(false);
    expect(`${workerDir}/implement.claim.1` in files).toBe(true);
    expect(`${workerDir}/.progress-implement` in files).toBe(true);
  });

  test("(b) terminal 'failed' → resets", () => {
    const { files, deps } = inMemoryFs({ [signalPath]: JSON.stringify({ status: "failed" }) });
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(true);
    expect(signalPath in files).toBe(false);
  });

  test("(b) terminal 'stalled' (phase-agent-dispatch's mark_launch_failed path) → resets", () => {
    const { files, deps } = inMemoryFs({ [signalPath]: JSON.stringify({ status: "stalled" }) });
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(true);
    expect(signalPath in files).toBe(false);
  });

  test("(c) 'dispatched' (actually in-flight) → NEVER touched, returns false", () => {
    const { files, deps } = inMemoryFs({
      [signalPath]: JSON.stringify({ status: "dispatched", generation: 1 }),
      [briefPath]: JSON.stringify({ stalledPhase: "implement" }),
      [`${workerDir}/resolve-conflict.claim.1`]: "{}",
    });
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(false);
    expect(signalPath in files).toBe(true);
    expect(briefPath in files).toBe(true);
    expect(`${workerDir}/resolve-conflict.claim.1` in files).toBe(true);
  });

  test("(c) 'running' (actually in-flight) → NEVER touched, returns false", () => {
    const { files, deps } = inMemoryFs({ [signalPath]: JSON.stringify({ status: "running" }) });
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(false);
    expect(signalPath in files).toBe(true);
  });

  test("malformed signal JSON → treated like absent, returns false (never throws)", () => {
    const { deps } = inMemoryFs({ [signalPath]: "{not json" });
    expect(() => maybeResetForResolveConflictCycle(orchDir, ticket, deps)).not.toThrow();
    expect(maybeResetForResolveConflictCycle(orchDir, ticket, deps)).toBe(false);
  });
});

describe("defaultMarkAndDispatch — #1461 cycle-reset integration", () => {
  const orchDir = "/orch";
  const ticket = "CTL-1";
  const workerDir = `${orchDir}/workers/${ticket}`;

  // A fake `dispatch` that mirrors phase-agent-dispatch's OWN idempotency guard
  // (EXISTING_STATUS in dispatched|running|done → no-op `idempotent:true`,
  // otherwise write status:"dispatched" at a fresh generation) — reading the
  // SAME in-memory files defaultMarkAndDispatch itself just wrote/deleted. This
  // is what proves the reset actually changes what phase-agent-dispatch would see,
  // not just that some internal seam was called.
  function fakeDispatchLikeRealPhaseAgentDispatch(files) {
    let calls = 0;
    const fn = (_orchDir, tk, phase) => {
      calls++;
      const sigPath = `${workerDir}/phase-${phase}.json`;
      let existingStatus = null;
      if (sigPath in files) {
        try {
          existingStatus = JSON.parse(files[sigPath]).status;
        } catch {
          existingStatus = null;
        }
      }
      if (["dispatched", "running", "done"].includes(existingStatus)) {
        return { code: 0, signal: { idempotent: true } };
      }
      files[sigPath] = JSON.stringify({ status: "dispatched", generation: calls + 1 });
      return { code: 0, signal: { bg_job_id: `job-${calls}` } };
    };
    fn.callCount = () => calls;
    return fn;
  }

  test("(a) first cycle (no prior phase-resolve-conflict.json) — dispatches cleanly, no regression", () => {
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", failureReason: RESOLVE_CONFLICT_STALL_REASON }),
    });
    deps.isThenable = () => false;
    deps.dispatch = fakeDispatchLikeRealPhaseAgentDispatch(files);
    const result = defaultMarkAndDispatch(
      { ticket, phase: "implement", workerDir, worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.bgJobId).toBe("job-1");
  });

  // (b) — the actual gap this task fixes: a SECOND genuine stall, with a STALE
  // "done" phase-resolve-conflict.json left over from a completed first cycle,
  // must still result in a REAL dispatch (not an idempotent no-op).
  test("(b) second genuine stall after a completed first cycle resets the stale terminal signal before redispatching", () => {
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-resolve-conflict.json`]: JSON.stringify({ status: "done", generation: 1 }),
      [`${workerDir}/resolve-conflict-brief.json`]: JSON.stringify({ stalledPhase: "implement", attempt: 1 }),
      [`${workerDir}/resolve-conflict.claim.1`]: "{}",
      // a FRESH stall on the original phase — a genuinely new, different conflict
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", failureReason: RESOLVE_CONFLICT_STALL_REASON }),
    });
    deps.isThenable = () => false;
    const dispatch = fakeDispatchLikeRealPhaseAgentDispatch(files);
    deps.dispatch = dispatch;

    const result = defaultMarkAndDispatch(
      { ticket, phase: "implement", workerDir, worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 1, orchDir },
      deps,
    );

    // Proves the redispatch was NOT swallowed as idempotent: a real bg_job_id
    // came back, not `{idempotent:true}`.
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.bgJobId).toBe("job-1");
    expect(dispatch.callCount()).toBe(1);
    // the stale gen-1 claim tombstone from cycle 1 is gone — the fresh
    // gen-1 claim phase-agent-dispatch would attempt is exclusive, not colliding.
    expect(`${workerDir}/resolve-conflict.claim.1` in files).toBe(false);
    // phase-resolve-conflict.json now reflects the NEW dispatch, not the stale "done".
    expect(JSON.parse(files[`${workerDir}/phase-resolve-conflict.json`]).status).toBe("dispatched");
  });

  // Defensive safety net: in production, an in-flight phase-resolve-conflict.json
  // means the original stalled-phase signal is still RESOLVED_MARKER_REASON, which
  // classifyResolveConflictCandidate routes to "skip: already-resolving" — this
  // function is never reached. This test exercises defaultMarkAndDispatch's own
  // reset call directly anyway, to prove the safety property holds even if it
  // were ever reached: the in-flight signal is left byte-for-byte untouched.
  test("(c) an actually in-flight ('running') phase-resolve-conflict.json is never touched by the reset", () => {
    const runningSignal = JSON.stringify({ status: "running", generation: 1 });
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-resolve-conflict.json`]: runningSignal,
      [`${workerDir}/resolve-conflict-brief.json`]: JSON.stringify({ stalledPhase: "implement", attempt: 1 }),
      [`${workerDir}/resolve-conflict.claim.1`]: "{}",
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", failureReason: RESOLVED_MARKER_REASON }),
    });
    deps.isThenable = () => false;
    deps.dispatch = fakeDispatchLikeRealPhaseAgentDispatch(files);

    defaultMarkAndDispatch(
      { ticket, phase: "implement", workerDir, worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 1, orchDir },
      deps,
    );

    // Safety-critical: the reset must never have fired — the running signal,
    // its brief, and its claim tombstone all survive completely untouched.
    // (dispatch() is still invoked by defaultMarkAndDispatch itself — that call
    // is unconditional in this function — but per phase-agent-dispatch's OWN
    // idempotency guard it would correctly no-op against the untouched "running"
    // signal rather than double-launching a worker.)
    expect(files[`${workerDir}/phase-resolve-conflict.json`]).toBe(runningSignal);
    expect(`${workerDir}/resolve-conflict-brief.json` in files).toBe(true);
    expect(`${workerDir}/resolve-conflict.claim.1` in files).toBe(true);
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

// #1461 escalation-gap fix (final-review follow-up, not an automated reviewer
// this time): defaultCollectResolveConflictCompletions ONLY ever recognized
// status:"done" — a status:"failed" phase-resolve-conflict.json was invisible
// to every collector, so the ticket's RESOLVED_MARKER_REASON marker never
// reverted after a genuine failure and the ticket silently fell out of
// candidacy forever, no matter how high the (correctly-incrementing) cap
// counter climbed. This describe block covers the new failure census.
describe("defaultCollectResolveConflictFailures (#1461 escalation-gap fix)", () => {
  function fakeFs({ workerDirs, files }) {
    return {
      readdirSync: (p, opts) => (opts?.withFileTypes ? (workerDirs[p] ?? []).map((n) => ({ name: n, isDirectory: () => true })) : (files[p] ?? [])),
      readFileSync: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
    };
  }

  test("finds a ticket whose resolve-conflict phase FAILED, the brief names the stalled phase, and that phase is still marked resolving", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-1"] },
      files: {
        "/orch/workers/CTL-1": ["phase-resolve-conflict.json", "resolve-conflict-brief.json", "phase-implement.json"],
        "/orch/workers/CTL-1/phase-resolve-conflict.json": JSON.stringify({ status: "failed" }),
        "/orch/workers/CTL-1/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
        "/orch/workers/CTL-1/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_resolvable" }),
      },
    });
    const out = defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs });
    expect(out).toEqual([{ ticket: "CTL-1", stalledPhase: "implement", workerDir: "/orch/workers/CTL-1" }]);
  });

  test("skips a ticket whose resolve-conflict phase is 'done' (that's the completions collector's job, not this one)", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-1"] },
      files: {
        "/orch/workers/CTL-1": ["phase-resolve-conflict.json", "resolve-conflict-brief.json", "phase-implement.json"],
        "/orch/workers/CTL-1/phase-resolve-conflict.json": JSON.stringify({ status: "done" }),
        "/orch/workers/CTL-1/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
        "/orch/workers/CTL-1/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_resolvable" }),
      },
    });
    expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
  });

  // Safety-critical (c): an actually in-flight run must NEVER be touched by the
  // new failure-handling path — proven here at the collector level, since the
  // collector is what feeds the driver's failures sub-pass.
  for (const inFlightStatus of ["dispatched", "running"]) {
    test(`skips a ticket whose resolve-conflict phase is '${inFlightStatus}' (actually in flight — never touched)`, () => {
      const fs = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-2"] },
        files: {
          "/orch/workers/CTL-2": ["phase-resolve-conflict.json", "resolve-conflict-brief.json", "phase-implement.json"],
          "/orch/workers/CTL-2/phase-resolve-conflict.json": JSON.stringify({ status: inFlightStatus }),
          "/orch/workers/CTL-2/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
          "/orch/workers/CTL-2/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_resolvable" }),
        },
      });
      expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
    });
  }

  test("skips a ticket with no resolve-conflict signal at all", () => {
    const fs = fakeFs({ workerDirs: { "/orch/workers": ["CTL-3"] }, files: { "/orch/workers/CTL-3": ["phase-implement.json"] } });
    expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
  });

  test("skips a failed signal with no brief — cannot know which phase to act on", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-4"] },
      files: {
        "/orch/workers/CTL-4": ["phase-resolve-conflict.json"],
        "/orch/workers/CTL-4/phase-resolve-conflict.json": JSON.stringify({ status: "failed" }),
      },
    });
    expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
  });

  // Idempotence guard — mirrors defaultCollectResolveConflictCompletions's own
  // Fix-1 guard exactly, so the SAME failure is not re-collected forever once
  // this sweep's failure-handling path has acted on it (reverted or escalated).
  describe("idempotence guard", () => {
    function filesFor(stalledSignalRaw) {
      const files = {
        "/orch/workers/CTL-1": ["phase-resolve-conflict.json", "resolve-conflict-brief.json", "phase-implement.json"],
        "/orch/workers/CTL-1/phase-resolve-conflict.json": JSON.stringify({ status: "failed" }),
        "/orch/workers/CTL-1/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
      };
      if (stalledSignalRaw !== undefined) {
        files["/orch/workers/CTL-1/phase-implement.json"] = JSON.stringify(stalledSignalRaw);
      }
      return files;
    }

    test("(a) a failure is collected once when the stalled phase is still marked RESOLVED_MARKER_REASON", () => {
      const fs = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-1"] },
        files: filesFor({ status: "stalled", failureReason: "source_conflict_resolvable" }),
      });
      expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs }))
        .toEqual([{ ticket: "CTL-1", stalledPhase: "implement", workerDir: "/orch/workers/CTL-1" }]);
    });

    test("(b) NOT re-collected once the stalled-phase reason has been reverted back to RESOLVE_CONFLICT_STALL_REASON (simulates defaultRevertStallAndResetCycle having run)", () => {
      const fs = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-1"] },
        files: filesFor({ status: "stalled", failureReason: RESOLVE_CONFLICT_STALL_REASON }),
      });
      expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
    });

    test("(c) NOT re-collected once escalated (CAP_EXHAUSTED_REASON)", () => {
      const fs = fakeFs({
        workerDirs: { "/orch/workers": ["CTL-1"] },
        files: filesFor({ status: "stalled", failureReason: CAP_EXHAUSTED_REASON }),
      });
      expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
    });

    test("(d) NOT re-collected once the stalled-phase signal file is gone entirely", () => {
      const files = filesFor(undefined);
      const fs = fakeFs({ workerDirs: { "/orch/workers": ["CTL-1"] }, files });
      expect(defaultCollectResolveConflictFailures({ orchDir: "/orch", ...fs })).toEqual([]);
    });
  });
});

describe("defaultRevertStallAndResetCycle (#1461 escalation-gap fix)", () => {
  const orchDir = "/orch";
  const ticket = "CTL-1";
  const workerDir = `${orchDir}/workers/${ticket}`;

  test("reverts failureReason from RESOLVED_MARKER_REASON back to RESOLVE_CONFLICT_STALL_REASON, preserves other fields", () => {
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", failureReason: RESOLVED_MARKER_REASON, bg_job_id: "abc123" }),
    });
    const ok = defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps);
    expect(ok).toBe(true);
    const written = JSON.parse(files[`${workerDir}/phase-implement.json`]);
    expect(written.status).toBe("stalled");
    expect(written.failureReason).toBe(RESOLVE_CONFLICT_STALL_REASON);
    expect(written.bg_job_id).toBe("abc123"); // untouched
  });

  test("reverts the legacy stalledReason field the same way", () => {
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", stalledReason: RESOLVED_MARKER_REASON }),
    });
    defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps);
    expect(JSON.parse(files[`${workerDir}/phase-implement.json`]).stalledReason).toBe(RESOLVE_CONFLICT_STALL_REASON);
  });

  // REUSES maybeResetForResolveConflictCycle verbatim: the stale terminal
  // phase-resolve-conflict.json (+ brief + claim tombstones/progress marker) is
  // cleared in the same call, so a later re-classification doesn't immediately
  // hit phase-agent-dispatch's own idempotency no-op.
  test("also clears the stale terminal phase-resolve-conflict.json + brief + claim tombstone via the existing cycle-reset logic", () => {
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", failureReason: RESOLVED_MARKER_REASON }),
      [`${workerDir}/phase-resolve-conflict.json`]: JSON.stringify({ status: "failed", generation: 1 }),
      [`${workerDir}/resolve-conflict-brief.json`]: JSON.stringify({ stalledPhase: "implement", attempt: 1 }),
      [`${workerDir}/resolve-conflict.claim.1`]: "{}",
      [`${workerDir}/.progress-resolve-conflict`]: "3",
    });
    const ok = defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps);
    expect(ok).toBe(true);
    expect(`${workerDir}/phase-resolve-conflict.json` in files).toBe(false);
    expect(`${workerDir}/resolve-conflict-brief.json` in files).toBe(false);
    expect(`${workerDir}/resolve-conflict.claim.1` in files).toBe(false);
    expect(`${workerDir}/.progress-resolve-conflict` in files).toBe(false);
  });

  test("malformed original signal JSON returns false instead of throwing, and never touches the reset", () => {
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-implement.json`]: "{not valid json",
      [`${workerDir}/phase-resolve-conflict.json`]: JSON.stringify({ status: "failed" }),
    });
    expect(() => defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps)).not.toThrow();
    const ok = defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps);
    expect(ok).toBe(false);
    // The step-1 revert failed, so the reset (step 2) is skipped — the stale
    // signal is left exactly as it was, for the next tick to retry cleanly.
    expect(`${workerDir}/phase-resolve-conflict.json` in files).toBe(true);
  });

  // Safety-critical (c): even if this function were ever reached for a
  // genuinely in-flight resolve-conflict run (it shouldn't be — the failures
  // collector's status:"failed" filter is the real guarantee), the cycle-reset
  // it reuses (maybeResetForResolveConflictCycle) independently refuses to
  // touch a dispatched/running signal. Proven directly here for defense in depth.
  test("never touches an in-flight ('running') phase-resolve-conflict.json, even if reached", () => {
    const runningSignal = JSON.stringify({ status: "running", generation: 1 });
    const { files, deps } = inMemoryFs({
      [`${workerDir}/phase-implement.json`]: JSON.stringify({ status: "stalled", failureReason: RESOLVED_MARKER_REASON }),
      [`${workerDir}/phase-resolve-conflict.json`]: runningSignal,
    });
    defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps);
    expect(files[`${workerDir}/phase-resolve-conflict.json`]).toBe(runningSignal);
  });
});

describe("runResolveConflictSweepPass", () => {
  test("mode 'off' skips everything, no census called", () => {
    const collectCandidates = () => { throw new Error("must not be called"); };
    const report = runResolveConflictSweepPass({ mode: "off", collectCandidates });
    expect(report).toEqual({
      marked: [],
      wouldMark: [],
      escalated: [],
      wouldEscalate: [],
      cleared: [],
      wouldClear: [],
      retried: [],
      wouldRetry: [],
      skipped: [],
      failed: [],
    });
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

  // #1461 escalation-gap fix: the failures sub-pass. A status:"failed"
  // phase-resolve-conflict.json is a NEW, parallel path — never clearStall
  // (which would let the original phase redispatch fresh with no memory of the
  // failed attempt, silently discarding the failure without ever checking the
  // cap).
  describe("failures sub-pass (#1461 escalation-gap fix)", () => {
    test("(a) UNDER the cap: reverts the original stall + resets the stale cycle via revertStallAndResetCycle, does NOT escalate", async () => {
      const reverted = [];
      const report = await runResolveConflictSweepPass({
        mode: "enforce",
        collectCandidates: () => [],
        collectCompletions: () => [],
        collectFailures: () => [{ ticket: "CTL-1", stalledPhase: "implement", workerDir: "/w" }],
        cycleCountOf: () => RESOLVE_CONFLICT_CYCLE_CAP - 1, // under the cap
        revertStallAndResetCycle: (f) => { reverted.push(f); return true; },
        escalateCapExhausted: () => { throw new Error("must not escalate — under the cap"); },
        emit: async () => true,
      });
      expect(report.retried).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
      expect(report.escalated).toEqual([]);
      expect(reverted).toEqual([{ ticket: "CTL-1", stalledPhase: "implement" }]);
    });

    test("(b) AT the cap: escalates via escalateCapExhausted instead of reverting", async () => {
      const escalated = [];
      const report = await runResolveConflictSweepPass({
        mode: "enforce",
        collectCandidates: () => [],
        collectCompletions: () => [],
        collectFailures: () => [{ ticket: "CTL-2", stalledPhase: "verify", workerDir: "/w2" }],
        cycleCountOf: () => RESOLVE_CONFLICT_CYCLE_CAP, // at the cap
        revertStallAndResetCycle: () => { throw new Error("must not revert — at/over the cap"); },
        escalateCapExhausted: (c) => { escalated.push(c); return true; },
        emit: async () => true,
      });
      expect(report.escalated).toEqual([{ ticket: "CTL-2", phase: "verify" }]);
      expect(report.retried).toEqual([]);
      expect(escalated).toEqual([{ ticket: "CTL-2", phase: "verify", workerDir: "/w2", cycleCount: RESOLVE_CONFLICT_CYCLE_CAP }]);
    });

    test("OVER the cap also escalates (not just exactly-at)", async () => {
      const escalated = [];
      const report = await runResolveConflictSweepPass({
        mode: "enforce",
        collectCandidates: () => [],
        collectCompletions: () => [],
        collectFailures: () => [{ ticket: "CTL-3", stalledPhase: "implement", workerDir: "/w3" }],
        cycleCountOf: () => RESOLVE_CONFLICT_CYCLE_CAP + 5,
        revertStallAndResetCycle: () => { throw new Error("must not revert — over the cap"); },
        escalateCapExhausted: (c) => { escalated.push(c); return true; },
        emit: async () => true,
      });
      expect(report.escalated).toEqual([{ ticket: "CTL-3", phase: "implement" }]);
    });

    test("shadow mode emits would-retry for an under-cap failure, takes no action", async () => {
      const emitted = [];
      const report = await runResolveConflictSweepPass({
        mode: "shadow",
        collectCandidates: () => [],
        collectCompletions: () => [],
        collectFailures: () => [{ ticket: "CTL-1", stalledPhase: "implement", workerDir: "/w" }],
        cycleCountOf: () => 0,
        revertStallAndResetCycle: () => { throw new Error("must not be called in shadow"); },
        emit: (type) => emitted.push(type),
      });
      expect(report.wouldRetry).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
      expect(emitted).toContain("resolve-conflict.would.retry");
    });

    test("shadow mode emits would-escalate for an at-cap failure, takes no action", async () => {
      const emitted = [];
      const report = await runResolveConflictSweepPass({
        mode: "shadow",
        collectCandidates: () => [],
        collectCompletions: () => [],
        collectFailures: () => [{ ticket: "CTL-1", stalledPhase: "implement", workerDir: "/w" }],
        cycleCountOf: () => RESOLVE_CONFLICT_CYCLE_CAP,
        escalateCapExhausted: () => { throw new Error("must not be called in shadow"); },
        emit: (type) => emitted.push(type),
      });
      expect(report.wouldEscalate).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
      expect(emitted).toContain("resolve-conflict.would.escalate");
    });

    test("a revertStallAndResetCycle returning false is reported as a failure, not silently swallowed", async () => {
      const report = await runResolveConflictSweepPass({
        mode: "enforce",
        collectCandidates: () => [],
        collectCompletions: () => [],
        collectFailures: () => [{ ticket: "CTL-1", stalledPhase: "implement", workerDir: "/w" }],
        cycleCountOf: () => 0,
        revertStallAndResetCycle: () => false,
        emit: async () => true,
      });
      expect(report.retried).toEqual([]);
      expect(report.failed).toEqual([{ ticket: "CTL-1", phase: "implement", reason: "revert-stall-and-reset-cycle-returned-false" }]);
    });

    test("a throwing collectFailures degrades to an empty failures sub-pass, never aborts the rest of the tick", async () => {
      const dispatched = [];
      const report = await runResolveConflictSweepPass({
        mode: "enforce",
        collectFailures: () => { throw new Error("failures census exploded"); },
        collectCandidates: () => [{ ticket: "CTL-4", phase: "implement", workerDir: "/w", raw: { failureReason: RESOLVE_CONFLICT_STALL_REASON }, worktreePath: "/wt", base: "main" }],
        collectCompletions: () => [],
        cycleCountOf: () => 0,
        classifyLive: async () => ({ resolvable: true, conflictFiles: [], conflictTypes: [] }),
        markAndDispatch: (c) => { dispatched.push(c.ticket); return { success: true, dispatched: true }; },
        emit: async () => true,
      });
      expect(report.retried).toEqual([]);
      expect(report.failed).toEqual([]);
      // the candidates sub-pass still ran normally — a throwing failures census
      // degrades ONLY its own sub-pass, never the whole tick.
      expect(dispatched).toEqual(["CTL-4"]);
    });
  });
});

// #1461 follow-up (final whole-branch re-review), test (d): a true end-to-end
// proof that RESOLVE_CONFLICT_CYCLE_CAP is now REACHABLE via genuinely repeated
// cycles — not the pre-fix world where cycle 2+ was silently swallowed as an
// idempotent no-op forever. Drives defaultMarkAndDispatch through
// RESOLVE_CONFLICT_CYCLE_CAP real cycles, using the REAL countResolveConflictAttempts
// (event-scan.mjs) against a real temp events.jsonl as the durable counter — the
// exact function production wires as cycleCountOf — and a fake `dispatch` that
// mirrors phase-agent-dispatch's own idempotency guard byte-for-byte, so a
// silently-swallowed redispatch would show up as a call returning
// `{idempotent:true}` instead of a fresh bg_job_id.
describe("#1461 follow-up: resolve-conflict cycle-cap end-to-end reachability", () => {
  test("N genuinely-redispatched cycles advance the durable counter until the cap trips and escalates", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-conflict-e2e-"));
    const eventLogPath = join(dir, "events.jsonl");
    try {
      const orchDir = "/orch";
      const ticket = "CTL-E2E";
      const workerDir = `${orchDir}/workers/${ticket}`;
      const { files, deps } = inMemoryFsForE2E();
      deps.isThenable = () => false;

      let dispatchGen = 0;
      let idempotentNoOps = 0;
      let realDispatches = 0;
      deps.dispatch = (_orchDir, tk, phase) => {
        const sigPath = `${workerDir}/phase-${phase}.json`;
        let existingStatus = null;
        if (sigPath in files) {
          try {
            existingStatus = JSON.parse(files[sigPath]).status;
          } catch {
            existingStatus = null;
          }
        }
        if (["dispatched", "running", "done"].includes(existingStatus)) {
          idempotentNoOps++;
          return { code: 0, signal: { idempotent: true } };
        }
        dispatchGen++;
        realDispatches++;
        // Simulate the worker completing this cycle: writes status:"done" and
        // emits the durable phase.resolve-conflict.complete.<ticket> event —
        // exactly what the real /catalyst-dev:phase-resolve-conflict skill does.
        files[sigPath] = JSON.stringify({ status: "done", generation: dispatchGen });
        appendFileSync(
          eventLogPath,
          JSON.stringify({
            ts: new Date().toISOString(),
            attributes: { "event.name": `phase.resolve-conflict.complete.${tk}`, "event.label": tk, "catalyst.orchestration": tk },
          }) + "\n",
        );
        return { code: 0, signal: { bg_job_id: `job-${dispatchGen}` } };
      };

      function freshStall() {
        // A brand-new stall on the ORIGINAL phase — as if defaultClearStall
        // already deleted the prior cycle's marked signal and a fresh dispatch
        // of that phase later stalled again for a genuinely NEW conflict.
        files[`${workerDir}/phase-implement.json`] = JSON.stringify({
          status: "stalled",
          failureReason: RESOLVE_CONFLICT_STALL_REASON,
        });
      }

      for (let cycle = 0; cycle < RESOLVE_CONFLICT_CYCLE_CAP; cycle++) {
        freshStall();
        const cycleCount = countResolveConflictAttempts({ ticket, path: eventLogPath });
        expect(cycleCount).toBe(cycle); // the durable counter is genuinely advancing
        const decision = classifyResolveConflictCandidate({
          stalledReasonMatches: true,
          alreadyResolving: false,
          cycleCount,
          classification: { resolvable: true, conflictFiles: [], conflictTypes: [] },
        });
        expect(decision.action).toBe("mark-and-dispatch");
        const result = defaultMarkAndDispatch(
          {
            ticket,
            phase: "implement",
            workerDir,
            worktreePath: `/wt/${ticket}`,
            base: "main",
            classification: { resolvable: true, conflictFiles: [], conflictTypes: [] },
            cycleCount,
            orchDir,
          },
          deps,
        );
        expect(result.success).toBe(true);
        expect(result.dispatched).toBe(true);
        // Simulate defaultCollectResolveConflictCompletions + clearStall having
        // run in a later tick: the original stalled-phase signal is deleted.
        delete files[`${workerDir}/phase-implement.json`];
      }

      // Every cycle was a REAL dispatch — the reset made sure none of them were
      // silently swallowed as a stale idempotent no-op (the pre-fix bug).
      expect(realDispatches).toBe(RESOLVE_CONFLICT_CYCLE_CAP);
      expect(idempotentNoOps).toBe(0);

      // The (cap+1)th stall: the durable counter now reflects CAP completed
      // cycles → the classifier must route to cap-exhausted, not mark-and-dispatch.
      freshStall();
      const finalCount = countResolveConflictAttempts({ ticket, path: eventLogPath });
      expect(finalCount).toBe(RESOLVE_CONFLICT_CYCLE_CAP);
      const finalDecision = classifyResolveConflictCandidate({
        stalledReasonMatches: true,
        alreadyResolving: false,
        cycleCount: finalCount,
        classification: { resolvable: true, conflictFiles: [], conflictTypes: [] },
      });
      expect(finalDecision.action).toBe("cap-exhausted");

      // And the escalation actually fires via the existing defaultEscalateCapExhausted seam.
      const posted = [];
      const escDeps = {
        readFileSync: (p) => files[p],
        writeFileSync: (p, body) => { files[p] = body; },
        renameSync: (from, to) => { files[to] = files[from]; delete files[from]; },
        postComment: (tk, body) => { posted.push([tk, body]); return true; },
      };
      const escalated = defaultEscalateCapExhausted(
        { ticket, phase: "implement", workerDir, cycleCount: finalCount },
        escDeps,
      );
      expect(escalated).toBe(true);
      expect(JSON.parse(files[`${workerDir}/phase-implement.json`]).failureReason).toBe(CAP_EXHAUSTED_REASON);
      expect(posted).toHaveLength(1);
      expect(posted[0][1]).toMatch(new RegExp(`cycle cap \\(${RESOLVE_CONFLICT_CYCLE_CAP}\\)`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #1461 escalation-gap fix, test (d): the end-to-end mirror of the E2E test
// above, but for REPEATED FAILURES specifically (never a successful "done").
// Before this fix, cycle 1's failure permanently stranded the ticket: the cap
// counter kept climbing (countResolveConflictAttempts correctly counts BOTH
// complete AND failed events — that part already worked), but nothing ever
// reverted the original stalled-phase's RESOLVED_MARKER_REASON marker, so
// classifyResolveConflictCandidate never got a fresh classify pass again and
// defaultEscalateCapExhausted never fired no matter how high the counter got.
// This test drives real dispatch → real failure → real revert-and-retry for
// RESOLVE_CONFLICT_CYCLE_CAP - 1 cycles (each one genuinely redispatched, never
// swallowed as an idempotent no-op), then proves the FINAL failure (the one
// that pushes the durable counter to the cap) escalates instead of reverting.
describe("#1461 escalation-gap fix: FAILURE cycle-cap end-to-end reachability", () => {
  test("repeated FAILED (never completed) resolve-conflict cycles revert+retry under the cap, then escalate once the cap is reached", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-conflict-failure-e2e-"));
    const eventLogPath = join(dir, "events.jsonl");
    try {
      const orchDir = "/orch";
      const ticket = "CTL-FAIL-E2E";
      const workerDir = `${orchDir}/workers/${ticket}`;
      const { files, deps } = inMemoryFsForE2E();
      deps.isThenable = () => false;

      let dispatchGen = 0;
      let idempotentNoOps = 0;
      let realDispatches = 0;
      deps.dispatch = (_orchDir, tk, phase) => {
        const sigPath = `${workerDir}/phase-${phase}.json`;
        let existingStatus = null;
        if (sigPath in files) {
          try {
            existingStatus = JSON.parse(files[sigPath]).status;
          } catch {
            existingStatus = null;
          }
        }
        if (["dispatched", "running", "done"].includes(existingStatus)) {
          idempotentNoOps++;
          return { code: 0, signal: { idempotent: true } };
        }
        dispatchGen++;
        realDispatches++;
        // Simulate the worker running and then genuinely FAILING this cycle —
        // writes status:"failed" + emits the durable
        // phase.resolve-conflict.failed.<ticket> event, exactly what the real
        // /catalyst-dev:phase-resolve-conflict skill does on a hard failure.
        files[sigPath] = JSON.stringify({ status: "failed", generation: dispatchGen });
        appendFileSync(
          eventLogPath,
          JSON.stringify({
            ts: new Date().toISOString(),
            attributes: { "event.name": `phase.resolve-conflict.failed.${tk}`, "event.label": tk, "catalyst.orchestration": tk },
          }) + "\n",
        );
        return { code: 0, signal: { bg_job_id: `job-${dispatchGen}` } };
      };

      function freshStall() {
        files[`${workerDir}/phase-implement.json`] = JSON.stringify({
          status: "stalled",
          failureReason: RESOLVE_CONFLICT_STALL_REASON,
        });
      }

      let escalatedPosted = null;

      for (let i = 0; i < RESOLVE_CONFLICT_CYCLE_CAP; i++) {
        freshStall();
        const cycleCountBefore = countResolveConflictAttempts({ ticket, path: eventLogPath });
        expect(cycleCountBefore).toBe(i); // the durable counter genuinely advancing on failures alone
        const decision = classifyResolveConflictCandidate({
          stalledReasonMatches: true,
          alreadyResolving: false,
          cycleCount: cycleCountBefore,
          classification: { resolvable: true, conflictFiles: [], conflictTypes: [] },
        });
        expect(decision.action).toBe("mark-and-dispatch");
        const result = defaultMarkAndDispatch(
          {
            ticket,
            phase: "implement",
            workerDir,
            worktreePath: `/wt/${ticket}`,
            base: "main",
            classification: { resolvable: true, conflictFiles: [], conflictTypes: [] },
            cycleCount: cycleCountBefore,
            orchDir,
          },
          deps,
        );
        expect(result.success).toBe(true);
        expect(result.dispatched).toBe(true);
        // markStalledSignalResolving ran as part of this dispatch — the original
        // phase is now marked RESOLVED_MARKER_REASON, awaiting completion.
        expect(JSON.parse(files[`${workerDir}/phase-implement.json`]).failureReason).toBe(RESOLVED_MARKER_REASON);

        // The dispatch above already simulated the worker FAILING (see deps.dispatch)
        // — a later tick's failure handling now runs.
        const cycleCountAfter = countResolveConflictAttempts({ ticket, path: eventLogPath });
        expect(cycleCountAfter).toBe(i + 1);

        if (cycleCountAfter >= RESOLVE_CONFLICT_CYCLE_CAP) {
          // The cap was reached BY this failure — must escalate, must NOT revert.
          const posted = [];
          const escDeps = { ...deps, postComment: (tk, body) => { posted.push([tk, body]); return true; } };
          const escalated = defaultEscalateCapExhausted(
            { ticket, phase: "implement", workerDir, cycleCount: cycleCountAfter },
            escDeps,
          );
          expect(escalated).toBe(true);
          escalatedPosted = posted;
          break;
        }

        // Still under the cap — this task's fix: revert the original stall back
        // to the ORIGINAL reason + reset the stale terminal cycle (REUSING
        // maybeResetForResolveConflictCycle), so the ticket genuinely becomes a
        // candidate again on the NEXT loop iteration instead of being
        // permanently stuck at RESOLVED_MARKER_REASON.
        const reverted = defaultRevertStallAndResetCycle(orchDir, ticket, "implement", deps);
        expect(reverted).toBe(true);
        expect(JSON.parse(files[`${workerDir}/phase-implement.json`]).failureReason).toBe(RESOLVE_CONFLICT_STALL_REASON);
        // the stale phase-resolve-conflict.json is gone — the NEXT dispatch
        // (loop's next iteration) will not be silently swallowed as idempotent.
        expect(`${workerDir}/phase-resolve-conflict.json` in files).toBe(false);
      }

      // Every cycle was a REAL dispatch that genuinely failed — none were
      // silently swallowed as a stale idempotent no-op (the pre-fix bug, now
      // proven closed for the FAILURE path specifically).
      expect(realDispatches).toBe(RESOLVE_CONFLICT_CYCLE_CAP);
      expect(idempotentNoOps).toBe(0);

      // The escalation genuinely fired, exactly once, at the cap.
      expect(escalatedPosted).toHaveLength(1);
      expect(escalatedPosted[0][1]).toMatch(new RegExp(`cycle cap \\(${RESOLVE_CONFLICT_CYCLE_CAP}\\)`));
      expect(JSON.parse(files[`${workerDir}/phase-implement.json`]).failureReason).toBe(CAP_EXHAUSTED_REASON);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// inMemoryFsForE2E — same shape as inMemoryFs above, duplicated locally so this
// describe block reads standalone (no cross-describe-block state coupling).
function inMemoryFsForE2E() {
  const files = {};
  return {
    files,
    deps: {
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      writeFileSync: (p, body) => {
        files[p] = body;
      },
      renameSync: (from, to) => {
        files[to] = files[from];
        delete files[from];
      },
      mkdirSync: () => {},
      rmSync: (p) => {
        delete files[p];
      },
      readdirSync: (dir) => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        return Object.keys(files)
          .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
          .map((f) => f.slice(prefix.length));
      },
    },
  };
}

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
