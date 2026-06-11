// integration-ctl-1005.test.mjs — CTL-1005 J3 end-to-end: schedulerTick Pass 0j
// stall-clear. Drives the REAL schedulerTick (and the REAL defaultClearStall seam
// — clearStall is NOT injected) over a fixture worker dir carrying a
// prior-artifact-retry-exhausted stall, asserting the actual filesystem unstick:
// the synthetic stalled signal is deleted, needs-human + .orphan-detected markers
// are cleared, the .janitor-cleared-<phase>.applied once-marker is written, and the
// janitor.stall.cleared event is emitted. Models integration-ctl-1004.test.mjs.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1005-int-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

const TICKET = "CTL-854";
const PHASE = "plan";

function workerDir() {
  return join(orchDir, "workers", TICKET);
}

// Seed a prior-artifact-retry-exhausted stall + the needs-human / orphan-detected
// leftovers escalateDispatchExhausted + the terminal sweep would have written.
function seedStall() {
  const d = workerDir();
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `phase-${PHASE}.json`),
    JSON.stringify({ ticket: TICKET, phase: PHASE, status: "stalled", stalledReason: "prior-artifact-retry-exhausted", dispatchFailureCode: 2 }),
  );
  // The completed prior-phase (research) signal that should survive the clear so
  // the scheduler can re-derive `plan` next tick.
  writeFileSync(
    join(d, "phase-research.json"),
    JSON.stringify({ ticket: TICKET, phase: "research", status: "done" }),
  );
  // needs-human once-marker + orphan-detected marker (the frozen-state leftovers).
  writeFileSync(join(d, ".linear-label-needs-human.applied"), "");
  writeFileSync(join(d, ".orphan-detected.applied"), "");
}

// Tick opts: inert reclaim/watchdog; J3 census injected (artifact verified
// complete) but clearStall NOT injected → the REAL defaultClearStall runs.
function makeTickOpts({ mode, events = [], stallCtx } = {}) {
  return {
    readEligible: () => [],
    // A clean rc==0 dispatch stub: after J3 clears the stalled signal, the
    // scheduler's normal advancement path may re-dispatch `plan` the same tick.
    // rc==0 routes through the verify-failure (no real signal) branch WITHOUT
    // arming the cool-down — the J3 assertions below are unaffected either way.
    dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
    exec: () => ({ code: null }),
    reclaimDeadWork: () => ({ class: "alive-suppressed" }),
    writeStatus: {
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ removed: true }),
      runTransition: () => ({ applied: false }),
    },
    watchdog: { mode: "off" },
    stallJanitor: {
      mode,
      collectStallClearCandidates: () => [
        stallCtx ?? {
          ticket: TICKET,
          phase: PHASE,
          stalledReason: "prior-artifact-retry-exhausted",
          linearTerminal: false,
          liveSessionInWorktree: false,
          artifactPresent: true,
          artifactComplete: true,
          alreadyCleared: false,
          dispatchFailureCode: 2,       // CTL-1045 Bug 2
          priorDoneSignalPresent: true, // CTL-1045 Bug 3
        },
      ],
      emit: (type, fields) => {
        events.push({ type, ...fields });
        return Promise.resolve(true);
      },
      // clearStall intentionally NOT injected → exercises the real defaultClearStall.
    },
  };
}

describe("CTL-1005 J3 integration — enforce performs the real clear", () => {
  test("deletes the synthetic stalled signal, clears needs-human + orphan markers, writes the once-marker, emits janitor.stall.cleared", () => {
    seedStall();
    const events = [];
    const result = schedulerTick(orchDir, makeTickOpts({ mode: "enforce", events }));

    // The synthetic stalled signal is GONE (the unstick) …
    expect(existsSync(join(workerDir(), `phase-${PHASE}.json`))).toBe(false);
    // … but the completed prior-phase signal SURVIVES (so the scheduler re-dispatches).
    expect(existsSync(join(workerDir(), "phase-research.json"))).toBe(true);
    // needs-human once-marker cleared (re-arms a future genuine escalation).
    expect(existsSync(join(workerDir(), ".linear-label-needs-human.applied"))).toBe(false);
    // .orphan-detected.applied cleared (a future stall re-emits, not silently suppressed).
    expect(existsSync(join(workerDir(), ".orphan-detected.applied"))).toBe(false);
    // .janitor-cleared-<phase>.applied once-marker written (one clear per lifetime).
    expect(existsSync(join(workerDir(), `.janitor-cleared-${PHASE}.applied`))).toBe(true);
    // The event + the tick report.
    const ev = events.find((e) => e.type === "janitor.stall.cleared");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe(TICKET);
    expect(ev.artifact_verified ?? ev.artifactVerified).toBe(true);
    expect(result.janitorStallsCleared).toEqual([{ ticket: TICKET, phase: PHASE }]);
  });

  test("a re-stall after one clear (once-marker already present) is NOT re-cleared", () => {
    seedStall();
    // Pretend J3 already cleared this phase once this lifetime.
    writeFileSync(join(workerDir(), `.janitor-cleared-${PHASE}.applied`), "");
    const events = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "enforce",
        events,
        stallCtx: {
          ticket: TICKET,
          phase: PHASE,
          stalledReason: "prior-artifact-retry-exhausted",
          linearTerminal: false,
          liveSessionInWorktree: false,
          artifactPresent: true,
          artifactComplete: true,
          alreadyCleared: true, // the marker the census would have read
          dispatchFailureCode: 2,
          priorDoneSignalPresent: true,
        },
      }),
    );
    // The stalled signal STAYS (frozen for operator review).
    expect(existsSync(join(workerDir(), `phase-${PHASE}.json`))).toBe(true);
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    expect(result.janitorStallsCleared).toEqual([]);
  });

  test("a truncated/missing prior artifact stays frozen — no clear, no event", () => {
    seedStall();
    const events = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "enforce",
        events,
        stallCtx: {
          ticket: TICKET,
          phase: PHASE,
          stalledReason: "prior-artifact-retry-exhausted",
          linearTerminal: false,
          liveSessionInWorktree: false,
          artifactPresent: true,
          artifactComplete: false, // present but truncated
          alreadyCleared: false,
          dispatchFailureCode: 2,
          priorDoneSignalPresent: true,
        },
      }),
    );
    expect(existsSync(join(workerDir(), `phase-${PHASE}.json`))).toBe(true);
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    expect(result.janitorStallsCleared).toEqual([]);
  });
});

describe("CTL-1045 J3 integration — new gates", () => {
  test("CTL-1045 Bug 2: stall with non-benign dispatchFailureCode stays frozen (verify_failed code=0)", () => {
    seedStall();
    const events = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "enforce",
        events,
        stallCtx: {
          ticket: TICKET,
          phase: PHASE,
          stalledReason: "prior-artifact-retry-exhausted",
          linearTerminal: false,
          liveSessionInWorktree: false,
          artifactPresent: true,
          artifactComplete: true,
          alreadyCleared: false,
          dispatchFailureCode: 0,       // verify_failed — NOT clearable
          priorDoneSignalPresent: true,
        },
      }),
    );
    expect(existsSync(join(workerDir(), `phase-${PHASE}.json`))).toBe(true);
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    expect(result.janitorStallsCleared).toEqual([]);
  });

  test("CTL-1045 Bug 3: stall with code=2 but no prior-done signal stays frozen (empty-dir re-walk guard)", () => {
    seedStall();
    const events = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "enforce",
        events,
        stallCtx: {
          ticket: TICKET,
          phase: PHASE,
          stalledReason: "prior-artifact-retry-exhausted",
          linearTerminal: false,
          liveSessionInWorktree: false,
          artifactPresent: true,
          artifactComplete: true,
          alreadyCleared: false,
          dispatchFailureCode: 2,
          priorDoneSignalPresent: false, // prior-done signal absent
        },
      }),
    );
    expect(existsSync(join(workerDir(), `phase-${PHASE}.json`))).toBe(true);
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    expect(result.janitorStallsCleared).toEqual([]);
  });
});

describe("CTL-1005 J3 integration — shadow mutates nothing", () => {
  test("shadow emits janitor.would.clear but deletes no signal and writes no marker", () => {
    seedStall();
    const events = [];
    const result = schedulerTick(orchDir, makeTickOpts({ mode: "shadow", events }));

    // Nothing mutated.
    expect(existsSync(join(workerDir(), `phase-${PHASE}.json`))).toBe(true);
    expect(existsSync(join(workerDir(), ".linear-label-needs-human.applied"))).toBe(true);
    expect(existsSync(join(workerDir(), ".orphan-detected.applied"))).toBe(true);
    expect(existsSync(join(workerDir(), `.janitor-cleared-${PHASE}.applied`))).toBe(false);
    // Only the would-event.
    expect(events.filter((e) => e.type === "janitor.stall.cleared")).toHaveLength(0);
    expect(events.some((e) => e.type === "janitor.would.clear")).toBe(true);
    expect(result.janitorWouldClear).toEqual([{ ticket: TICKET, phase: PHASE }]);
  });
});
