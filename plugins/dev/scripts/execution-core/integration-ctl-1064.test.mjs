// integration-ctl-1064.test.mjs — CTL-1064 Pass 0u end-to-end: schedulerTick
// unstuck-sweep. Drives the REAL schedulerTick with injected census/emit/act/
// postComment seams (no filesystem cleanup seams — the actByCategory stubs
// simulate actions without touching disk). Mirrors integration-ctl-1005.test.mjs.
//
// Test matrix:
//   1. shadow mode — emits would-* events, no act, no intent, no comment
//   2. enforce mode — dirty-tree candidate acted, event emitted, report populated
//   3. enforce mode — escalate path (unknown reason) pages, event emitted
//   4. throttle guard — second tick within window skips the pass entirely
//   5. mode='off' — census never called, no events
//   6. stale-label candidate in shadow → would-clear-label event

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick, __resetForTests } from "./scheduler.mjs";

let orchDir;
beforeEach(() => {
  __resetForTests(); // resets _unstuckLastRunMs + debounce timers
  orchDir = mkdtempSync(join(tmpdir(), "ctl1064-int-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

const TICKET_DIRTY = "CTL-1064-DIRTY";
const TICKET_UNKNOWN = "CTL-1064-UNKNOWN";
const PHASE = "implement";

function workerDir(ticket) {
  return join(orchDir, "workers", ticket);
}

// Seed a stalled signal for a given ticket.
function seedStall(ticket, phase, stalledReason) {
  const d = workerDir(ticket);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status: "stalled", stalledReason }),
  );
}

// Minimal schedulerTick options: inert reclaim/watchdog/dispatch + the unstuck
// census injected. actByCategory and escalate are stubbed to record calls.
function makeTickOpts({
  mode,
  events = [],
  actCalls = [],
  escalateCalls = [],
  commentCalls = [],
  nowMs = undefined,
  candidates = [],
  intervalMs = 1, // very short so the throttle never blocks in tests
} = {}) {
  return {
    readEligible: () => [],
    dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
    exec: () => ({ code: null }),
    reclaimDeadWork: () => ({ class: "alive-suppressed" }),
    writeStatus: {
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ removed: true }),
      runTransition: () => ({ applied: false }),
    },
    watchdog: { mode: "off" },
    unstuckSweep: {
      mode,
      intervalMs,
      collectCandidates: () => candidates,
      actByCategory: {
        "dirty-tree": (c) => actCalls.push({ ticket: c.ticket, category: "dirty-tree" }),
        "stale-label": (c) => actCalls.push({ ticket: c.ticket, category: "stale-label" }),
      },
      escalate: (c) => escalateCalls.push({ ticket: c.ticket, phase: c.phase }),
      emit: (type, fields) => {
        events.push({ type, ...fields });
        return Promise.resolve(true);
      },
      postComment: (ticket, category, phase) => {
        commentCalls.push({ ticket, category, phase });
      },
      nowMs: typeof nowMs === "function" ? nowMs : (nowMs != null ? () => nowMs : undefined),
    },
  };
}

describe("CTL-1064 Pass 0u integration — mode=shadow", () => {
  test("shadow emits would-clear-noise but does NOT act, record intent, or post comment", () => {
    seedStall(TICKET_DIRTY, PHASE, "rebase_refused_dirty_tree");
    const events = [];
    const actCalls = [];
    const commentCalls = [];
    const candidates = [{
      ticket: TICKET_DIRTY,
      phase: PHASE,
      evidence: { reason: "rebase_refused_dirty_tree", ticket: TICKET_DIRTY, phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
    }];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "shadow", events, actCalls, commentCalls, candidates }));

    // shadow: would-* event emitted
    const ev = events.find((e) => e.type === "unstuck.would.clear-noise");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe(TICKET_DIRTY);
    // no act seam called
    expect(actCalls).toHaveLength(0);
    // no comment posted
    expect(commentCalls).toHaveLength(0);
    // tick report
    expect(result.unstuckWouldAct).toHaveLength(1);
    expect(result.unstuckWouldAct[0].ticket).toBe(TICKET_DIRTY);
    expect(result.unstuckActed).toHaveLength(0);
  });

  test("shadow escalate path emits would-escalate but does NOT escalate or comment", () => {
    seedStall(TICKET_UNKNOWN, PHASE, "some_unrecognized_reason");
    const events = [];
    const escalateCalls = [];
    const commentCalls = [];
    const candidates = [{
      ticket: TICKET_UNKNOWN,
      phase: PHASE,
      evidence: { reason: "some_unrecognized_reason", ticket: TICKET_UNKNOWN, phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
    }];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "shadow", events, escalateCalls, commentCalls, candidates }));

    const ev = events.find((e) => e.type === "unstuck.would.escalate");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe(TICKET_UNKNOWN);
    expect(escalateCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(0);
    expect(result.unstuckWouldEscalate).toHaveLength(1);
  });
});

describe("CTL-1064 Pass 0u integration — mode=enforce", () => {
  test("enforce dirty-tree candidate: calls actByCategory, emits cleared-noise, posts comment, reports acted", () => {
    seedStall(TICKET_DIRTY, PHASE, "rebase_refused_dirty_tree");
    const events = [];
    const actCalls = [];
    const commentCalls = [];
    const candidates = [{
      ticket: TICKET_DIRTY,
      phase: PHASE,
      evidence: { reason: "rebase_refused_dirty_tree", ticket: TICKET_DIRTY, phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
    }];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "enforce", events, actCalls, commentCalls, candidates }));

    // act seam called once
    expect(actCalls).toHaveLength(1);
    expect(actCalls[0]).toMatchObject({ ticket: TICKET_DIRTY, category: "dirty-tree" });
    // enforce event emitted
    const ev = events.find((e) => e.type === "unstuck.cleared.noise");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe(TICKET_DIRTY);
    // comment posted
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0].ticket).toBe(TICKET_DIRTY);
    // tick report
    expect(result.unstuckActed).toHaveLength(1);
    expect(result.unstuckActed[0].ticket).toBe(TICKET_DIRTY);
    expect(result.unstuckActed[0].category).toBe("dirty-tree");
    expect(result.unstuckWouldAct).toHaveLength(0);
  });

  test("enforce unknown-reason candidate: calls escalate seam + emits escalated + posts comment", () => {
    seedStall(TICKET_UNKNOWN, PHASE, "some_unrecognized_reason");
    const events = [];
    const escalateCalls = [];
    const commentCalls = [];
    const candidates = [{
      ticket: TICKET_UNKNOWN,
      phase: PHASE,
      evidence: { reason: "some_unrecognized_reason", ticket: TICKET_UNKNOWN, phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
    }];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "enforce", events, escalateCalls, commentCalls, candidates }));

    expect(escalateCalls).toHaveLength(1);
    expect(escalateCalls[0].ticket).toBe(TICKET_UNKNOWN);
    const ev = events.find((e) => e.type === "unstuck.escalated");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe(TICKET_UNKNOWN);
    expect(commentCalls).toHaveLength(1);
    expect(result.unstuckEscalated).toHaveLength(1);
    expect(result.unstuckWouldEscalate).toHaveLength(0);
  });

  test("live-session candidate: classified as skip, no act, no event", () => {
    const events = [];
    const actCalls = [];
    const candidates = [{
      ticket: TICKET_DIRTY,
      phase: PHASE,
      evidence: { reason: "rebase_refused_dirty_tree", ticket: TICKET_DIRTY, phase: PHASE, liveSessionInWorktree: true, linearTerminal: false },
    }];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "enforce", events, actCalls, candidates }));

    expect(actCalls).toHaveLength(0);
    expect(events.filter((e) => e.type?.startsWith("unstuck."))).toHaveLength(0);
    expect(result.unstuckActed).toHaveLength(0);
  });

  test("linear-terminal candidate: classified as skip, no act, no event", () => {
    const events = [];
    const actCalls = [];
    const candidates = [{
      ticket: TICKET_DIRTY,
      phase: PHASE,
      evidence: { reason: "rebase_refused_dirty_tree", ticket: TICKET_DIRTY, phase: PHASE, liveSessionInWorktree: false, linearTerminal: true },
    }];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "enforce", events, actCalls, candidates }));

    expect(actCalls).toHaveLength(0);
    expect(events.filter((e) => e.type?.startsWith("unstuck."))).toHaveLength(0);
  });
});

describe("CTL-1064 Pass 0u integration — throttle guard", () => {
  test("second tick within the throttle window skips the pass (census not called)", () => {
    const events = [];
    let censusCalls = 0;
    const candidates = [{
      ticket: TICKET_DIRTY,
      phase: PHASE,
      evidence: { reason: "rebase_refused_dirty_tree", ticket: TICKET_DIRTY, phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
    }];
    const opts = {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
      exec: () => ({ code: null }),
      reclaimDeadWork: () => ({ class: "alive-suppressed" }),
      writeStatus: {
        applyLabel: () => ({ applied: true }),
        removeLabel: () => ({ removed: true }),
        runTransition: () => ({ applied: false }),
      },
      watchdog: { mode: "off" },
      unstuckSweep: {
        mode: "shadow",
        intervalMs: 900_000, // 15-min throttle
        collectCandidates: () => { censusCalls++; return candidates; },
        emit: (type, fields) => { events.push({ type, ...fields }); return Promise.resolve(true); },
        nowMs: () => Date.now(),
      },
    };

    // Tick 1: should run (first run).
    schedulerTick(orchDir, opts);
    expect(censusCalls).toBe(1);

    // Tick 2 immediately after: throttled — census must NOT be called again.
    schedulerTick(orchDir, opts);
    expect(censusCalls).toBe(1); // unchanged
  });

  test("tick outside the throttle window (elapsed > intervalMs) runs the pass again", () => {
    let censusCalls = 0;
    let fakeNow = 1_000_000;
    const opts = {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
      exec: () => ({ code: null }),
      reclaimDeadWork: () => ({ class: "alive-suppressed" }),
      writeStatus: {
        applyLabel: () => ({ applied: true }),
        removeLabel: () => ({ removed: true }),
        runTransition: () => ({ applied: false }),
      },
      watchdog: { mode: "off" },
      unstuckSweep: {
        mode: "shadow",
        intervalMs: 60_000,
        collectCandidates: () => { censusCalls++; return []; },
        emit: () => Promise.resolve(true),
        nowMs: () => fakeNow,
      },
    };

    schedulerTick(orchDir, opts); // run at t=1_000_000
    expect(censusCalls).toBe(1);

    fakeNow += 60_001; // advance past the interval
    schedulerTick(orchDir, opts);
    expect(censusCalls).toBe(2);
  });
});

describe("CTL-1064 Pass 0u integration — mode=off", () => {
  test("mode=off: census never called, no events, no report entries", () => {
    let censusCalls = 0;
    const events = [];
    const opts = {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
      exec: () => ({ code: null }),
      reclaimDeadWork: () => ({ class: "alive-suppressed" }),
      writeStatus: {
        applyLabel: () => ({ applied: true }),
        removeLabel: () => ({ removed: true }),
        runTransition: () => ({ applied: false }),
      },
      watchdog: { mode: "off" },
      unstuckSweep: {
        mode: "off",
        collectCandidates: () => { censusCalls++; return []; },
        emit: (type, fields) => { events.push({ type, ...fields }); return Promise.resolve(true); },
      },
    };

    const result = schedulerTick(orchDir, opts);

    expect(censusCalls).toBe(0);
    expect(events.filter((e) => e.type?.startsWith("unstuck."))).toHaveLength(0);
    expect(result.unstuckActed).toHaveLength(0);
    expect(result.unstuckWouldAct).toHaveLength(0);
  });
});

describe("CTL-1064 Pass 0u integration — multiple candidates", () => {
  test("two candidates in shadow → two would-* events (one dirty-tree, one escalate)", () => {
    const events = [];
    const candidates = [
      {
        ticket: "CTL-A",
        phase: PHASE,
        evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-A", phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
      },
      {
        ticket: "CTL-B",
        phase: PHASE,
        evidence: { reason: "some_unknown_reason", ticket: "CTL-B", phase: PHASE, liveSessionInWorktree: false, linearTerminal: false },
      },
    ];

    const result = schedulerTick(orchDir, makeTickOpts({ mode: "shadow", events, candidates }));

    expect(result.unstuckWouldAct).toHaveLength(1);
    expect(result.unstuckWouldAct[0].ticket).toBe("CTL-A");
    expect(result.unstuckWouldEscalate).toHaveLength(1);
    expect(result.unstuckWouldEscalate[0].ticket).toBe("CTL-B");
    expect(events.find((e) => e.type === "unstuck.would.clear-noise")).toBeDefined();
    expect(events.find((e) => e.type === "unstuck.would.escalate")).toBeDefined();
  });
});
