// board-health-seam.test.mjs — CTL-1290. The THIN scheduler-seam test (§9.4).
//
// Run: cd plugins/dev/scripts/execution-core && bun test board-health-seam.test.mjs
//
// Lives in its OWN file (not scheduler.test.mjs) so it runs in CI:
// scheduler.test.mjs is excluded from the CI allowlist for its real-timer /
// fs.watch "debounced tick" suite. These three cases call schedulerTick ONCE,
// synchronously, with injected stubs — no timers, no fs.watch — so they are
// CI-safe. The pass LOGIC is covered by board-health.test.mjs; here we assert
// ONLY the seam: the hook fires the injected boardHealthPassFn with the in-scope
// capacity + eligible when the daemon threads `boardHealth`, honors the mode
// gate, and is INERT on a bare tick (the property that keeps every other
// schedulerTick test from doing real board-health IO).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerTick, holisticBoardHealthAct } from "./scheduler.mjs";
import { boardHealthPass } from "./board-health.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "bh-seam-"));
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "bh-seam-cat-"));
  process.env.CATALYST_DIR = catalystDir; // getEventLogPath() resolves under the fixture
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

describe("schedulerTick — board-health seam (CTL-1290 §9.4)", () => {
  test("CAT-76 production binding reads the dedicated recovery-pass signal path", () => {
    const source = readFileSync(join(import.meta.dir, "scheduler.mjs"), "utf8");
    expect(source).toContain('join(orchDir, "workers", ticket, "phase-recovery-pass.json")');
  });
  test("threads boardHealth → boardHealthPassFn called once with capacity + eligible", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [{ identifier: "CTL-1" }, { identifier: "CTL-2" }],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      concurrency: { maxParallel: 4 },
      liveBackgroundCount: () => 4, // freeSlots=0 → Pass 2 dispatch is a clean no-op
      boardHealth: { mode: "shadow" },
      boardHealthPassFn: (opts) => {
        calls.push(opts);
        return { ran: true, ranAtMs: 1 };
      },
    });
    expect(calls.length).toBe(1);
    const o = calls[0];
    expect(o.mode).toBe("shadow");
    expect(o.capacity).toEqual({ maxParallel: 4, liveCount: 4, freeSlots: 0, admissionGated: false });
    expect(o.getEligible().map((e) => e.identifier)).toEqual(["CTL-1", "CTL-2"]);
    expect(typeof o.getWorkerSignals).toBe("function");
  });

  test("threads boardHealth.act through to boardHealthPassFn (CTL-1300 holistic seam)", () => {
    const calls = [];
    const actStub = () => ({ dispatched: true });
    schedulerTick(orchDir, {
      readEligible: () => [{ identifier: "CTL-1" }],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      concurrency: { maxParallel: 4 },
      liveBackgroundCount: () => 4,
      boardHealth: { mode: "enforce", act: actStub },
      boardHealthPassFn: (opts) => {
        calls.push(opts);
        return { ran: true, ranAtMs: 1 };
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].act).toBe(actStub); // the daemon-bound act seam reaches the pass
  });

  test("boardHealth.mode:off → boardHealthPassFn NOT called", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      liveBackgroundCount: () => 0,
      boardHealth: { mode: "off" },
      boardHealthPassFn: (opts) => calls.push(opts),
    });
    expect(calls.length).toBe(0);
  });

  test("no boardHealth seam (bare tick) → boardHealthPassFn NOT called (inert)", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      liveBackgroundCount: () => 0,
      boardHealthPassFn: (opts) => calls.push(opts),
    });
    expect(calls.length).toBe(0);
  });
});

// CTL-1644: getStrandedEvidence seam — verifies the evidence thunk threads from the
// boardHealth binding through schedulerTick → boardHealthPassFn, and that shadow mode
// does not invoke act even when evidence is injected (the ADR-023 dark-by-default guarantee).
describe("schedulerTick — getStrandedEvidence seam (CTL-1644)", () => {
  test("threads boardHealth.getStrandedEvidence → boardHealthPassFn opts.getStrandedEvidence", () => {
    const calls = [];
    const getStrandedEvidenceStub = () =>
      new Map([["CTL-42", { id: "CTL-42", hasWorkerDir: true, hasLiveBg: false, hasFreshIntent: false, openPr: null }]]);
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      liveBackgroundCount: () => 0,
      boardHealth: { mode: "shadow", getStrandedEvidence: getStrandedEvidenceStub },
      boardHealthPassFn: (opts) => {
        calls.push(opts);
        return { ran: true, ranAtMs: 1 };
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].getStrandedEvidence).toBe(getStrandedEvidenceStub);
  });

  test("shadow mode with getStrandedEvidence: boardHealthPassFn called, act seam NOT invoked", () => {
    const actCalls = [];
    const getStrandedEvidenceStub = () =>
      new Map([["CTL-99", { id: "CTL-99", hasWorkerDir: false, hasLiveBg: false, hasFreshIntent: false, openPr: null }]]);
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      liveBackgroundCount: () => 0,
      boardHealth: {
        mode: "shadow",
        getStrandedEvidence: getStrandedEvidenceStub,
        act: () => actCalls.push("act-called"),
      },
      boardHealthPassFn: (_opts) => ({ ran: true, ranAtMs: 1 }),
    });
    expect(actCalls.length).toBe(0);
  });
});

// CTL-1644 Phase 3: end-to-end enforce-mode flow through boardHealthPass.
// Verifies that stranded tickets become holistic `act` candidates with the classified
// route in boardContext (not merely in the invariant output), and that shadow mode
// is mutation-free (act never called). These tests call boardHealthPass directly
// with injected stubs — no timers, no fs.watch, CI-safe.
describe("boardHealthPass — stranded route dispatch (CTL-1644 Phase 3)", () => {
  // Stub a ticket that is "in-flight with no actuation past threshold" so the
  // invariant flags it. 72h age, state=Implement, no labels.
  const NOW_MS = 1_750_000_000_000;
  const STALE_TS = new Date(NOW_MS - 72 * 3_600_000).toISOString();
  const strandedEvidence = (id, overrides = {}) =>
    new Map([[id, { id, hasWorkerDir: false, hasLiveBg: false, hasFreshIntent: false,
      openPr: null, remoteBranchExists: false, worktreeUnpushed: false, ...overrides }]]);
  const mkOpts = (mode, actStub, extraOpts = {}) => ({
    mode,
    orchDir,
    getBoard: () => [{ identifier: "CTL-99", state: "Implement",
      updatedAt: STALE_TS, labels: [] }],
    getWorkerSignals: () => [],
    getEligible: () => [],
    getStrandedEvidence: () => strandedEvidence("CTL-99"),
    // Provide free slots so decideBoardHealth's gate-2 (no-free-slots) doesn't block.
    capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4, admissionGated: false },
    isThrottledFn: () => false, // bypass 5-min throttle in tests
    now: () => NOW_MS,
    emit: () => {},
    act: actStub,
    ...extraOpts,
  });

  test("enforce: stranded ticket (restart-fresh) is in candidates passed to act", () => {
    const actArgs = [];
    boardHealthPass(mkOpts("enforce", (args) => {
      actArgs.push(args);
      return { dispatched: true, candidate: "CTL-99" };
    }));
    expect(actArgs.length).toBe(1);
    expect(actArgs[0].candidates).toContain("CTL-99");
  });

  test("CAT-76 actuation log separates intended and dispatched candidates", () => {
    const records = [];
    boardHealthPass(mkOpts("enforce", ({ candidates }) => ({ dispatched: true, candidate: candidates[1] }), {
      getEligible: () => [{ identifier: "CTL-100" }],
      log: (record, message) => records.push({ record, message }),
    }));
    const line = records.find((entry) => entry.message === "board-health: holistic recovery-pass delegate actuated");
    expect(line.record.anchorCandidate).toBe("CTL-99");
    expect(line.record.dispatchedCandidate).toBe("CTL-100");
  });

  test("enforce: boardContext.strandedMidPipeline carries classified route for the delegate", () => {
    let capturedCtx = null;
    boardHealthPass(mkOpts("enforce", ({ boardContext }) => {
      capturedCtx = boardContext;
      return { dispatched: true, candidate: "CTL-99" };
    }));
    expect(capturedCtx?.strandedMidPipeline?.["CTL-99"]).toBeDefined();
    expect(capturedCtx.strandedMidPipeline["CTL-99"].route).toBe("restart-fresh");
  });

  test("enforce: pr-not-merged route (openPr set) is classified and boardContext reflects it", () => {
    let capturedCtx = null;
    boardHealthPass(mkOpts("enforce", ({ boardContext }) => {
      capturedCtx = boardContext;
      return { dispatched: true, candidate: "CTL-99" };
    }, {
      getStrandedEvidence: () => strandedEvidence("CTL-99",
        { openPr: { number: 42, status: "open" } }),
    }));
    expect(capturedCtx?.strandedMidPipeline?.["CTL-99"]?.route).toBe("pr-not-merged");
  });

  test("enforce: adopt route (worktreeUnpushed, dispatchable:false) is classified but NEVER anchored [Codex P2 round 2]", () => {
    // A non-dispatchable route must NOT trigger an autonomous recovery-pass
    // dispatch — the recovery-pass skill has no route-aware hold branch. The
    // ticket is still CLASSIFIED (visible via the invariant), just never anchored.
    const actArgs = [];
    const result = boardHealthPass(mkOpts("enforce", (args) => {
      actArgs.push(args);
      return { dispatched: true, candidate: "CTL-99" };
    }, {
      getStrandedEvidence: () => strandedEvidence("CTL-99", { worktreeUnpushed: true }),
    }));
    // Classified correctly as a held adopt route...
    expect(result.invariants?.strandedMidPipeline?.classified?.["CTL-99"]?.route).toBe("adopt");
    expect(result.invariants.strandedMidPipeline.classified["CTL-99"].dispatchable).toBe(false);
    // ...but a held route is not an anchorable move → no autonomous dispatch.
    expect(actArgs.length).toBe(0);
  });

  test("enforce: unknown-salvage route (Phase-2 unchecked evidence) is classified but NEVER anchored [Codex P2 round 2]", () => {
    // The production Phase-2 case: evidence omits both salvage fields → unknown-salvage
    // (dispatchable:false). Must be surfaced-but-held, never auto-actuated.
    const actArgs = [];
    const result = boardHealthPass(mkOpts("enforce", (args) => {
      actArgs.push(args);
      return { dispatched: true, candidate: "CTL-99" };
    }, {
      // Omit both salvage fields to mirror the real scheduler.getStrandedEvidence.
      getStrandedEvidence: () => new Map([["CTL-99", { id: "CTL-99",
        hasWorkerDir: false, hasLiveBg: false, hasFreshIntent: false, openPr: null }]]),
    }));
    expect(result.invariants?.strandedMidPipeline?.classified?.["CTL-99"]?.route).toBe("unknown-salvage");
    expect(result.invariants.strandedMidPipeline.classified["CTL-99"].dispatchable).toBe(false);
    expect(actArgs.length).toBe(0);
  });

  test("shadow: stranded ticket detected — invariants flagged — but act NOT called", () => {
    const actArgs = [];
    const result = boardHealthPass(mkOpts("shadow", (...a) => actArgs.push(a)));
    expect(actArgs.length).toBe(0); // shadow never actuates
    // invariant IS observable and the ticket IS flagged (detection still works)
    expect(result.invariants?.strandedMidPipeline?.ok).toBe(false);
    expect(result.invariants?.strandedMidPipeline?.flagged).toContain("CTL-99");
  });

  test("enforce: ticket with active worker dir is NOT in candidates (actuation present)", () => {
    const actArgs = [];
    boardHealthPass(mkOpts("enforce", (args) => {
      actArgs.push(args);
      return { dispatched: false, reason: "no-owned-anchor" };
    }, {
      getStrandedEvidence: () => strandedEvidence("CTL-99", { hasWorkerDir: true }),
    }));
    // worker dir = actuated → not flagged → not a stranded candidate
    // act may still be called (eligible queue could have it), but candidates must not
    // contain CTL-99 as a STRANDED candidate from tier2 moves
    if (actArgs.length > 0) {
      // The ticket should not appear as a stranded tier2 move candidate
      // (it would only appear if it were in the eligible queue, which it's not here)
      const boardCtxStranded = actArgs[0].boardContext?.strandedMidPipeline ?? {};
      expect(boardCtxStranded["CTL-99"]).toBeUndefined();
    }
  });
});

// CTL-1608 (Codex P1): boardHealthPass must DESTRUCTURE and FORWARD getStalledPrState.
// The scheduler passed the thunk from the start, but an option boardHealthPass does not
// name is silently dropped by the destructure — so the map never reached
// assembleBoardState, checkStalledPr stayed pinned to its empty-Map default, and
// `nudge-stalled-pr` was unreachable even with the sweep enabled. These assert the wire
// end-to-end (thunk invoked → invariant observable → move proposed), not just its shape.
describe("boardHealthPass — getStalledPrState is forwarded to board assembly (CTL-1608)", () => {
  const NOW_MS = 1_750_000_000_000;
  const DAY_MS = 24 * 3_600_000;
  const iso = (msAgo) => new Date(NOW_MS - msAgo).toISOString();

  // A PR whose CI has been failing for 3 days — past the 2-day stalledPrCiMs default.
  const stalledMap = () =>
    new Map([["CTL-77", {
      ticket: "CTL-77", prNumber: 7, repo: "coalesce-labs/catalyst", state: "OPEN",
      observedAt: iso(0), ciFirstFailedAt: iso(3 * DAY_MS),
      reviewRequestedAt: null, lastPushAt: iso(0), lastKnownHeadOid: "abc123",
    }]]);

  const mkOpts = (mode, extraOpts = {}) => ({
    mode,
    orchDir,
    getBoard: () => [{ identifier: "CTL-77", state: "In Review",
      updatedAt: iso(3 * DAY_MS), labels: [], pr_number: 7 }],
    getWorkerSignals: () => [],
    getEligible: () => [],
    capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4, admissionGated: false },
    isThrottledFn: () => false,
    now: () => NOW_MS,
    emit: () => {},
    ...extraOpts,
  });

  test("invokes the injected getStalledPrState thunk (it is not silently dropped)", () => {
    let called = 0;
    boardHealthPass(mkOpts("shadow", {
      getStalledPrState: () => { called += 1; return stalledMap(); },
    }));
    expect(called).toBe(1);
  });

  test("forwarded map makes checkStalledPr observable and flags the stalled ticket", () => {
    const result = boardHealthPass(mkOpts("shadow", { getStalledPrState: stalledMap }));
    expect(result.invariants?.stalledPr?.observable).toBe(true);
    expect(result.invariants?.stalledPr?.ok).toBe(false);
    expect(result.invariants?.stalledPr?.flagged).toContain("CTL-77");
  });

  test("unwired (no thunk) stays observable:false — the shadow-first default is preserved", () => {
    const result = boardHealthPass(mkOpts("shadow"));
    expect(result.invariants?.stalledPr?.observable).toBe(false);
    expect(result.invariants?.stalledPr?.ok).toBe(true);
  });

  test("enforce: the forwarded map reaches the delegate as a nudge-stalled-pr candidate", () => {
    const actArgs = [];
    boardHealthPass(mkOpts("enforce", {
      getStalledPrState: stalledMap,
      act: (args) => { actArgs.push(args); return { dispatched: true, candidate: "CTL-77" }; },
    }));
    expect(actArgs.length).toBe(1);
    expect(actArgs[0].candidates).toContain("CTL-77");
    expect(actArgs[0].boardContext?.stalledPrs).toContain("CTL-77");
  });

  test("off mode never invokes the thunk (off stays byte-identical)", () => {
    let called = 0;
    boardHealthPass(mkOpts("off", {
      getStalledPrState: () => { called += 1; return stalledMap(); },
    }));
    expect(called).toBe(0);
  });
});

// CTL-1157 (MUST-FIX 2 + GROUP-3 #3): the holistic board-health `act` loop, tested
// pure via the extracted holisticBoardHealthAct (the daemon binds the real recovery
// seams around it).
describe("holisticBoardHealthAct — one real dispatch per scan, skip non-dispatch (CTL-1157)", () => {
  const ctx = { candidates: [], boardContext: { anomaly: "wip" }, decision: { gate: { reason: "wip-spike" } } };

  test("dispatches the FIRST actionable candidate and stops (exactly one dispatch)", () => {
    const invoked = [];
    const recorded = [];
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2", "CTL-3"] },
      {
        shouldSkipItem: () => false,
        invokeRecoveryPass: (cand) => { invoked.push(cand); return { dispatched: true, ticket: cand }; },
        recordIntent: (cand, intent) => recorded.push({ cand, intent }),
      },
    );
    expect(r.dispatched).toBe(true);
    expect(r.ticket).toBe("CTL-1");
    expect(invoked).toEqual(["CTL-1"]); // stopped after the first real dispatch
    expect(recorded).toHaveLength(1);
    expect(recorded[0].intent.outcome).toBe(true);
    // CTL-1439 (P0a): the dispatch-time ledger write is a DISPATCH marker, not a
    // verdict — the session's actual conclusion arrives later via recordVerdict.
    expect(recorded[0].intent.decision).toBe("dispatched");
  });

  test("a ledger-latched candidate (shouldSkipItem) is skipped without invoking (MUST-FIX 2)", () => {
    const invoked = [];
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-latched", "CTL-ok"] },
      {
        shouldSkipItem: (cand) => cand === "CTL-latched",
        invokeRecoveryPass: (cand) => { invoked.push(cand); return { dispatched: true, ticket: cand }; },
        recordIntent: () => {},
      },
    );
    expect(invoked).toEqual(["CTL-ok"]); // latched one never invoked
    expect(r.ticket).toBe("CTL-ok");
  });

  test("a NON-dispatch RESULT (cap-exhausted) is a SKIP → CONTINUE to the next candidate (GROUP-3 #3)", () => {
    // CTL-1 passes the ledger gate but its RESULT is a cap-exhausted no-op; the loop
    // must NOT return there (which would starve the cohort) — it dispatches CTL-2.
    const invoked = [];
    const recorded = [];
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2"] },
      {
        shouldSkipItem: () => false, // ledger gate does NOT see the event-counted cycle cap
        invokeRecoveryPass: (cand) => {
          invoked.push(cand);
          return cand === "CTL-1"
            ? { dispatched: false, reason: "recovery-pass-cycle-cap-exhausted" }
            : { dispatched: true, ticket: cand };
        },
        recordIntent: (cand, intent) => recorded.push({ cand, intent }),
      },
    );
    expect(invoked).toEqual(["CTL-1", "CTL-2"]); // continued past the cap-exhausted one
    expect(r.dispatched).toBe(true);
    expect(r.ticket).toBe("CTL-2");
    // Both attempts recorded an intent (cooldown started on the failure too).
    expect(recorded.map((x) => x.cand)).toEqual(["CTL-1", "CTL-2"]);
    expect(recorded[0].intent.outcome).toBe(false);
  });

  test("ALL candidates ledger-skipped as attempts-exhausted → reason 'all-candidates-exhausted' (CTL-1440 truth)", () => {
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2"] },
      {
        shouldSkipItem: () => true,
        skipReason: () => "attempts-exhausted",
        invokeRecoveryPass: () => { throw new Error("must not invoke"); },
        recordIntent: () => {},
      },
    );
    expect(r.dispatched).toBe(false);
    expect(r.reason).toBe("all-candidates-exhausted");
  });

  test("a SWEPT cohort (escalated) + a leave-alone verdict still reads 'all-candidates-exhausted' (terminal set, Codex R1)", () => {
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2"] },
      {
        shouldSkipItem: () => true,
        skipReason: (c) => (c === "CTL-1" ? "escalated" : "leave-alone"),
        invokeRecoveryPass: () => { throw new Error("must not invoke"); },
        recordIntent: () => {},
      },
    );
    expect(r.reason).toBe("all-candidates-exhausted");
  });

  test("an INVOKED non-dispatch candidate forces 'all-candidates-cooldown' even beside exhausted skips (Codex R1)", () => {
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2"] },
      {
        shouldSkipItem: (c) => c === "CTL-1",
        skipReason: () => "attempts-exhausted",
        invokeRecoveryPass: () => ({ dispatched: false, reason: "recovery-pass-cycle-cap-exhausted" }),
        recordIntent: () => {},
      },
    );
    expect(r.reason).toBe("all-candidates-cooldown"); // CTL-2 was actionable, just capped
  });

  test("MIXED ledger skips (exhausted + cooldown) → stays 'all-candidates-cooldown' (retryable)", () => {
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2"] },
      {
        shouldSkipItem: () => true,
        skipReason: (c) => (c === "CTL-1" ? "attempts-exhausted" : "cooldown"),
        invokeRecoveryPass: () => { throw new Error("must not invoke"); },
        recordIntent: () => {},
      },
    );
    expect(r.reason).toBe("all-candidates-cooldown");
  });

  test("ALL candidates non-dispatch → {dispatched:false, all-candidates-cooldown} (no starvation, no false dispatch)", () => {
    const r = holisticBoardHealthAct(
      { ...ctx, candidates: ["CTL-1", "CTL-2"] },
      {
        shouldSkipItem: () => false,
        invokeRecoveryPass: () => ({ dispatched: false, reason: "recovery-pass-cycle-cap-exhausted" }),
        recordIntent: () => {},
      },
    );
    expect(r.dispatched).toBe(false);
    expect(r.reason).toBe("all-candidates-cooldown");
  });

  test("empty cohort falls back to the anchor", () => {
    const invoked = [];
    const r = holisticBoardHealthAct(
      { anchor: "CTL-anchor", candidates: [], boardContext: null, decision: null },
      {
        shouldSkipItem: () => false,
        invokeRecoveryPass: (cand) => { invoked.push(cand); return { dispatched: true, ticket: cand }; },
        recordIntent: () => {},
      },
    );
    expect(invoked).toEqual(["CTL-anchor"]);
    expect(r.ticket).toBe("CTL-anchor");
  });
});

// ─── CTL-1608 — scheduler threads getStalledPrState into boardHealthPassFn ───
describe("schedulerTick — CTL-1608 getStalledPrState seam", () => {
  test("boardHealthPassFn receives getStalledPrState that returns a Map", () => {
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: () => {},
      reclaimDeadWork: () => "noop",
      concurrency: { maxParallel: 4 },
      liveBackgroundCount: () => 4,
      boardHealth: { mode: "shadow" },
      boardHealthPassFn: (opts) => {
        calls.push(opts);
        return { ran: true, ranAtMs: 1 };
      },
    });
    expect(calls.length).toBe(1);
    const o = calls[0];
    expect(typeof o.getStalledPrState).toBe("function");
    expect(o.getStalledPrState()).toBeInstanceOf(Map);
  });
});
