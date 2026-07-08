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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerTick, holisticBoardHealthAct } from "./scheduler.mjs";

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
    expect(o.capacity).toEqual({ maxParallel: 4, liveCount: 4, freeSlots: 0 });
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
