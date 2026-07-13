// record-worker-transition.test.mjs — CTL-764 Phase 3: recordWorkerTransition chokepoint.
// Run: cd plugins/dev/scripts/execution-core && bun test record-worker-transition.test.mjs
import { describe, test, expect } from "bun:test";
import { recordWorkerTransition } from "./record-worker-transition.mjs";

// Helpers to build call-recording fakes.
function makeApplyPhaseStatus(
  result = { applied: true, from_state: "Research", to_state: "Plan" }
) {
  const calls = [];
  return {
    calls,
    fn: (...args) => {
      calls.push(args);
      return result;
    },
  };
}
function makeConvergeLabel(result = 1) {
  const calls = [];
  return {
    calls,
    fn: (...args) => {
      calls.push(args);
      return result;
    },
  };
}
function makeAppendEvent(result = true) {
  const calls = [];
  return {
    calls,
    fn: (...args) => {
      calls.push(args);
      return result;
    },
  };
}

describe("recordWorkerTransition — happy path", () => {
  test("stage + disposition → applyPhaseStatus, convergeLabel, appendEvent each called once", async () => {
    const aps = makeApplyPhaseStatus();
    const cl = makeConvergeLabel();
    const ae = makeAppendEvent();

    const result = await recordWorkerTransition({
      ticket: "CTL-764",
      toStage: "plan",
      toDisposition: "queued",
      reason: "scheduler-advance",
      applyPhaseStatus: aps.fn,
      convergeLabel: cl.fn,
      appendWorkerTransitionEvent: ae.fn,
    });

    expect(aps.calls.length).toBe(1);
    expect(cl.calls.length).toBe(1);
    expect(ae.calls.length).toBe(1);
    expect(result.stageResult).toBeDefined();
    expect(result.labelWrites).toBe(1);
    expect(result.eventEmitted).toBe(true);
  });

  test("stageResult carries from_state/to_state from applyPhaseStatus", async () => {
    const aps = makeApplyPhaseStatus({ applied: true, from_state: "Triage", to_state: "Research" });
    const cl = makeConvergeLabel();
    const ae = makeAppendEvent();

    const result = await recordWorkerTransition({
      ticket: "CTL-764",
      toStage: "research",
      applyPhaseStatus: aps.fn,
      convergeLabel: cl.fn,
      appendWorkerTransitionEvent: ae.fn,
    });

    expect(result.stageResult.from_state).toBe("Triage");
    expect(result.stageResult.to_state).toBe("Research");
  });
});

describe("recordWorkerTransition — fail-open Sink 1", () => {
  test("applyPhaseStatus throws → convergeLabel AND appendEvent still called; no throw", async () => {
    const aps = {
      calls: [],
      fn: () => {
        throw new Error("linear API down");
      },
    };
    const cl = makeConvergeLabel();
    const ae = makeAppendEvent();

    await expect(
      recordWorkerTransition({
        ticket: "CTL-764",
        toStage: "plan",
        toDisposition: "queued",
        applyPhaseStatus: aps.fn,
        convergeLabel: cl.fn,
        appendWorkerTransitionEvent: ae.fn,
      })
    ).resolves.toBeDefined();

    expect(cl.calls.length).toBe(1);
    expect(ae.calls.length).toBe(1);
  });
});

describe("recordWorkerTransition — fail-open Sink 2", () => {
  test("convergeLabel throws → appendEvent still called; no throw", async () => {
    const aps = makeApplyPhaseStatus();
    const cl = {
      calls: [],
      fn: () => {
        throw new Error("label write failed");
      },
    };
    const ae = makeAppendEvent();

    await expect(
      recordWorkerTransition({
        ticket: "CTL-764",
        toStage: "plan",
        toDisposition: "queued",
        applyPhaseStatus: aps.fn,
        convergeLabel: cl.fn,
        appendWorkerTransitionEvent: ae.fn,
      })
    ).resolves.toBeDefined();

    expect(ae.calls.length).toBe(1);
  });
});

describe("recordWorkerTransition — fail-open Sink 3", () => {
  test("appendEvent throws → returns without throwing; stageResult still surfaced", async () => {
    const aps = makeApplyPhaseStatus({ applied: true, from_state: "Triage", to_state: "Plan" });
    const cl = makeConvergeLabel();
    const ae = {
      calls: [],
      fn: () => {
        throw new Error("event log full");
      },
    };

    const result = await recordWorkerTransition({
      ticket: "CTL-764",
      toStage: "plan",
      applyPhaseStatus: aps.fn,
      convergeLabel: cl.fn,
      appendWorkerTransitionEvent: ae.fn,
    });

    expect(result).toBeDefined();
    expect(result.stageResult?.from_state).toBe("Triage");
  });
});

describe("recordWorkerTransition — disposition-only transition", () => {
  test("no toStage → applyPhaseStatus NOT called; convergeLabel and appendEvent still run", async () => {
    const aps = makeApplyPhaseStatus();
    const cl = makeConvergeLabel();
    const ae = makeAppendEvent();

    await recordWorkerTransition({
      ticket: "CTL-764",
      toDisposition: "needs-human",
      reason: "escalation",
      applyPhaseStatus: aps.fn,
      convergeLabel: cl.fn,
      appendWorkerTransitionEvent: ae.fn,
    });

    expect(aps.calls.length).toBe(0);
    expect(cl.calls.length).toBe(1);
    expect(ae.calls.length).toBe(1);
  });
});

describe("recordWorkerTransition — event payload", () => {
  test("event receives from_state/to_state from runTransition when applyPhaseStatus returned them", async () => {
    const aps = makeApplyPhaseStatus({ applied: true, from_state: "Research", to_state: "Plan" });
    const cl = makeConvergeLabel();
    const appendedArgs = [];
    const ae = {
      calls: appendedArgs,
      fn: (args) => {
        appendedArgs.push(args);
        return true;
      },
    };

    await recordWorkerTransition({
      ticket: "CTL-764",
      toStage: "plan",
      fromDisposition: "queued",
      toDisposition: null,
      applyPhaseStatus: aps.fn,
      convergeLabel: cl.fn,
      appendWorkerTransitionEvent: ae.fn,
    });

    expect(appendedArgs.length).toBe(1);
    const eventArgs = appendedArgs[0];
    expect(eventArgs.fromStage).toBe("Research");
    expect(eventArgs.toStage).toBe("Plan");
    expect(eventArgs.fromDisposition).toBe("queued");
    expect(eventArgs.toDisposition).toBeNull();
  });
});
