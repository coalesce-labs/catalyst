// wait-watcher.test.mjs — CTL-650 Phase 3. The watcher tick: enumerate agents,
// poll each tracker, classify, and emit transition events through a per-session
// debounce. All dependencies injected so the tick runs with no real I/O; tick()
// is exposed and called directly (no real timer needed).

import { test, expect } from "bun:test";
import { startWaitWatcher } from "./wait-watcher.mjs";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const SHORT = "aaaaaaaa";

// A clock that records the registered handle and whether clearInterval fired.
function recordingClock() {
  const handle = { id: Symbol("interval") };
  let cleared = false;
  return {
    setInterval: () => handle,
    clearInterval: (h) => {
      if (h === handle) cleared = true;
    },
    wasCleared: () => cleared,
  };
}

// snapshots for the classifier (status is merged in by the watcher from the agent)
const MID_TURN_SNAP = {
  hasTranscript: true,
  lastBlockType: "tool_use",
  lastTool: "Bash",
  stopReason: null,
  postUserOrResultCount: 1,
};
const WAITING_USER_SNAP = {
  hasTranscript: true,
  lastBlockType: "text",
  stopReason: "end_turn",
  lastText: "Should I proceed?",
  postUserOrResultCount: 0,
};
const ACTIVE_SNAP = { hasTranscript: true, lastBlockType: "text", stopReason: "end_turn" };

// Build a watcher whose tracker returns whatever `snapRef.current` holds, and
// whose agent list is whatever `agentsRef.current` holds, so a test can mutate
// state between manual tick() calls.
function harness({ agentsRef, snapRef, sigIndex = new Map() }) {
  const emitted = [];
  const clock = recordingClock();
  const w = startWaitWatcher({
    clock,
    listAgents: () => agentsRef.current,
    indexSignals: () => sigIndex,
    makeTracker: () => ({ poll() {}, snapshot: () => snapRef.current }),
    findTranscriptFn: () => "/fake/transcript.jsonl",
    emit: (name, payload) => emitted.push({ name, payload }),
  });
  return { w, emitted, clock };
}

test("nonWaiting→WAITING_USER emits exactly one agent.waiting_on_user", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "idle", cwd: "/wt" }] };
  const snapRef = { current: MID_TURN_SNAP };
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick(); // MID_TURN — not waiting
  expect(emitted).toEqual([]);

  snapRef.current = WAITING_USER_SNAP;
  w.tick(); // → WAITING_USER
  expect(emitted.length).toBe(1);
  expect(emitted[0].name).toBe("agent.waiting_on_user");
});

test("staying WAITING_USER across ticks does NOT re-emit (debounce)", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "idle", cwd: "/wt" }] };
  const snapRef = { current: WAITING_USER_SNAP };
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick();
  w.tick();
  w.tick();
  expect(emitted.length).toBe(1);
});

test("WAITING_*→ACTIVE emits exactly one agent.resumed", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "idle", cwd: "/wt" }] };
  const snapRef = { current: WAITING_USER_SNAP };
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick(); // WAITING_USER → waiting_on_user
  agentsRef.current = [{ sessionId: SID, status: "busy", cwd: "/wt" }];
  snapRef.current = ACTIVE_SNAP;
  w.tick(); // busy → ACTIVE → resumed
  expect(emitted.length).toBe(2);
  expect(emitted[1].name).toBe("agent.resumed");
});

test("busy session never emits waiting even if last stop_reason=end_turn", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "busy", cwd: "/wt" }] };
  const snapRef = { current: WAITING_USER_SNAP }; // end_turn text, but busy wins
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick();
  w.tick();
  expect(emitted).toEqual([]);
});

test("emitted payload carries ticket/phase/meta from indexSignalsByBgJobId", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "idle", cwd: "/wt" }] };
  const snapRef = { current: WAITING_USER_SNAP };
  const sigIndex = new Map([
    [SHORT, { ticket: "CTL-650", phase: "implement", orchestratorId: "CTL-650" }],
  ]);
  const { w, emitted } = harness({ agentsRef, snapRef, sigIndex });

  w.tick();
  expect(emitted[0].payload.meta).toMatchObject({ ticket: "CTL-650", phase: "implement" });
  expect(emitted[0].payload.state).toBe("WAITING_USER");
  expect(emitted[0].payload.waitingText).toContain("Should I proceed?");
});

test("a session that disappears is purged (re-emits if it reappears)", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "idle", cwd: "/wt" }] };
  const snapRef = { current: WAITING_USER_SNAP };
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick(); // emit #1
  agentsRef.current = []; // session gone → purge lastState
  w.tick(); // no emit
  agentsRef.current = [{ sessionId: SID, status: "idle", cwd: "/wt" }];
  w.tick(); // prev purged → emits again
  expect(emitted.length).toBe(2);
  expect(emitted.every((e) => e.name === "agent.waiting_on_user")).toBe(true);
});

test("NO_TRANSCRIPT does not emit waiting", () => {
  const agentsRef = { current: [{ sessionId: SID, status: "idle", cwd: "/wt" }] };
  const snapRef = { current: { hasTranscript: false } };
  const emitted = [];
  const w = startWaitWatcher({
    clock: recordingClock(),
    listAgents: () => agentsRef.current,
    indexSignals: () => new Map(),
    makeTracker: () => ({ poll() {}, snapshot: () => snapRef.current }),
    findTranscriptFn: () => null, // no transcript → no tracker created
    emit: (name, payload) => emitted.push({ name, payload }),
  });
  w.tick();
  w.tick();
  expect(emitted).toEqual([]);
});

test("stop() clears the interval", () => {
  const agentsRef = { current: [] };
  const snapRef = { current: WAITING_USER_SNAP };
  const { w, clock } = harness({ agentsRef, snapRef });
  expect(clock.wasCleared()).toBe(false);
  w.stop();
  expect(clock.wasCleared()).toBe(true);
});

test("background agent with end_turn snapshot emits nothing (CTL-682)", () => {
  // Same WAITING_USER snapshot, but kind:"background" → the loop must skip it
  // before classify/emit, so no agent.waiting_on_user is produced.
  const agentsRef = {
    current: [{ sessionId: SID, status: "idle", kind: "background", cwd: "/wt" }],
  };
  const snapRef = { current: WAITING_USER_SNAP };
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick();
  expect(emitted).toEqual([]);
  w.stop();
});

test("interactive agent still emits agent.waiting_on_user (CTL-682 guard is background-only)", () => {
  const agentsRef = {
    current: [{ sessionId: SID, status: "idle", kind: "interactive", cwd: "/wt" }],
  };
  const snapRef = { current: WAITING_USER_SNAP };
  const { w, emitted } = harness({ agentsRef, snapRef });

  w.tick();
  expect(emitted.map((e) => e.name)).toEqual(["agent.waiting_on_user"]);
  w.stop();
});
