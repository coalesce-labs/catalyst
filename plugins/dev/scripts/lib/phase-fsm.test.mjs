// phase-fsm.test.mjs — pure phase-FSM transition tests (CTL-531).
// Run: cd plugins/dev/scripts/broker && bun test ../lib/phase-fsm.test.mjs

import { describe, test, expect } from "bun:test";

import {
  PHASES,
  REVIVE_BUDGET,
  PhaseFsmError,
  initialState,
  isTerminal,
  transition,
} from "./phase-fsm.mjs";

// Render an arbitrary value as a readable test-name fragment.
const label = (v) => (v === undefined ? "undefined" : Array.isArray(v) ? "[]" : JSON.stringify(v));

// ─── Phase 1: module scaffold + happy-path pipeline ───

describe("initialState", () => {
  test("starts at triage with a clean counter", () => {
    expect(initialState()).toEqual({
      phase: "triage",
      reviveCount: 0,
      parkedFrom: null,
    });
  });
  test("returns a fresh object each call (no shared mutable reference)", () => {
    expect(initialState()).not.toBe(initialState());
  });
});

describe("transition — happy path (complete advances the pipeline)", () => {
  // All 8 advance edges, driven off the canonical sequence.
  for (let i = 0; i < PHASES.length - 1; i++) {
    const from = PHASES[i];
    const to = PHASES[i + 1];
    test(`${from} --complete--> ${to}`, () => {
      const next = transition(
        { phase: from, reviveCount: 0, parkedFrom: null },
        { type: "complete" }
      );
      expect(next).toEqual({ phase: to, reviveCount: 0, parkedFrom: null });
    });
  }

  test("monitor-deploy --complete--> done (terminal success)", () => {
    const next = transition(
      { phase: "monitor-deploy", reviveCount: 0, parkedFrom: null },
      { type: "complete" }
    );
    expect(next).toEqual({ phase: "done", reviveCount: 0, parkedFrom: null });
  });

  test("complete resets reviveCount for the new phase", () => {
    const next = transition(
      { phase: "implement", reviveCount: 1, parkedFrom: null },
      { type: "complete" }
    );
    expect(next.reviveCount).toBe(0);
  });

  test("transition does not mutate its state argument (purity)", () => {
    const state = { phase: "triage", reviveCount: 0, parkedFrom: null };
    transition(state, { type: "complete" });
    expect(state).toEqual({ phase: "triage", reviveCount: 0, parkedFrom: null });
  });
});

describe("isTerminal", () => {
  test("done and stalled are terminal", () => {
    expect(isTerminal({ phase: "done", reviveCount: 0, parkedFrom: null })).toBe(true);
    expect(isTerminal({ phase: "stalled", reviveCount: 0, parkedFrom: null })).toBe(true);
  });
  test("pipeline phases and needs-input are not terminal", () => {
    expect(isTerminal({ phase: "triage", reviveCount: 0, parkedFrom: null })).toBe(false);
    expect(isTerminal({ phase: "needs-input", reviveCount: 0, parkedFrom: "plan" })).toBe(false);
  });
});

describe("isTerminal — input validation throws PhaseFsmError", () => {
  // isTerminal funnels through the same assertState as transition; its
  // validation contract needs its own coverage so a dropped assertState
  // call would not silently return false.
  for (const bad of [null, undefined, 42, "done", []]) {
    test(`rejects bad state ${label(bad)}`, () => {
      expect(() => isTerminal(bad)).toThrow(PhaseFsmError);
    });
  }
});

describe("transition — terminal states have no outgoing edges", () => {
  test("any event from done throws", () => {
    expect(() =>
      transition({ phase: "done", reviveCount: 0, parkedFrom: null }, { type: "complete" })
    ).toThrow(PhaseFsmError);
  });
});

describe("transition — input validation throws PhaseFsmError", () => {
  // bun's test.each spreads array rows as args, so a bare `[]` row would pass
  // zero args and inject an uncalled `done` callback — the plain for-loops
  // below avoid that and match the happy-path block's idiom above.
  for (const bad of [null, undefined, 42, "triage", []]) {
    test(`rejects bad state ${label(bad)}`, () => {
      expect(() => transition(bad, { type: "complete" })).toThrow(PhaseFsmError);
    });
  }
  test("rejects unknown phase", () => {
    expect(() =>
      transition({ phase: "bogus", reviveCount: 0, parkedFrom: null }, { type: "complete" })
    ).toThrow(PhaseFsmError);
  });
  // -1 hits the `< 0` operand; 1.5 / "0" / NaN are caught only by the
  // !Number.isInteger operand — both sides of the predicate are exercised.
  for (const reviveCount of [-1, 1.5, "0", NaN]) {
    test(`rejects bad reviveCount ${String(reviveCount)}`, () => {
      expect(() =>
        transition({ phase: "triage", reviveCount, parkedFrom: null }, { type: "complete" })
      ).toThrow(PhaseFsmError);
    });
  }
  for (const bad of [null, undefined, 42, "complete", {}, []]) {
    test(`rejects bad event ${label(bad)}`, () => {
      expect(() => transition({ phase: "triage", reviveCount: 0, parkedFrom: null }, bad)).toThrow(
        PhaseFsmError
      );
    });
  }
  test("rejects unknown event type", () => {
    expect(() =>
      transition({ phase: "triage", reviveCount: 0, parkedFrom: null }, { type: "explode" })
    ).toThrow(PhaseFsmError);
  });
});

// ─── Phase 2: failure / revive / escalation + turn-cap + needs-input park ───

describe("transition — failed: revive once, then escalate", () => {
  test("REVIVE_BUDGET is 1", () => {
    expect(REVIVE_BUDGET).toBe(1);
  });

  for (const phase of PHASES) {
    test(`${phase}: 1st failure revives in place (reviveCount 0 -> 1)`, () => {
      const next = transition({ phase, reviveCount: 0, parkedFrom: null }, { type: "failed" });
      expect(next).toEqual({ phase, reviveCount: 1, parkedFrom: null });
    });

    test(`${phase}: 2nd failure escalates to stalled`, () => {
      const next = transition({ phase, reviveCount: 1, parkedFrom: null }, { type: "failed" });
      expect(next.phase).toBe("stalled");
    });
  }

  test("stalled is terminal — any event throws", () => {
    expect(() =>
      transition({ phase: "stalled", reviveCount: 1, parkedFrom: null }, { type: "failed" })
    ).toThrow(PhaseFsmError);
  });
});

describe("transition — turn-cap-exhausted: continuation self-loop", () => {
  for (const phase of PHASES) {
    test(`${phase}: stays in place, reviveCount preserved`, () => {
      expect(
        transition({ phase, reviveCount: 1, parkedFrom: null }, { type: "turn-cap-exhausted" })
      ).toEqual({ phase, reviveCount: 1, parkedFrom: null });
    });
  }
  test("does not consume the revive budget", () => {
    const next = transition(
      { phase: "implement", reviveCount: 0, parkedFrom: null },
      { type: "turn-cap-exhausted" }
    );
    expect(next.reviveCount).toBe(0);
  });
});

describe("transition — park: any phase parks into needs-input", () => {
  for (const phase of PHASES) {
    test(`${phase} --park--> needs-input (parkedFrom recorded)`, () => {
      expect(transition({ phase, reviveCount: 0, parkedFrom: null }, { type: "park" })).toEqual({
        phase: "needs-input",
        reviveCount: 0,
        parkedFrom: phase,
      });
    });
  }
  test("park preserves reviveCount", () => {
    const next = transition(
      { phase: "research", reviveCount: 1, parkedFrom: null },
      { type: "park" }
    );
    expect(next.reviveCount).toBe(1);
  });
});

describe("transition — resume: needs-input returns to the parked phase", () => {
  test("resume returns to parkedFrom and clears it", () => {
    expect(
      transition({ phase: "needs-input", reviveCount: 0, parkedFrom: "plan" }, { type: "resume" })
    ).toEqual({ phase: "plan", reviveCount: 0, parkedFrom: null });
  });
  test("resume preserves reviveCount", () => {
    const next = transition(
      { phase: "needs-input", reviveCount: 1, parkedFrom: "verify" },
      { type: "resume" }
    );
    expect(next.reviveCount).toBe(1);
  });

  for (const type of ["complete", "failed", "turn-cap-exhausted", "park"]) {
    test(`needs-input rejects event '${type}'`, () => {
      expect(() =>
        transition({ phase: "needs-input", reviveCount: 0, parkedFrom: "plan" }, { type })
      ).toThrow(PhaseFsmError);
    });
  }
  test("resume from a pipeline phase throws", () => {
    expect(() =>
      transition({ phase: "triage", reviveCount: 0, parkedFrom: null }, { type: "resume" })
    ).toThrow(PhaseFsmError);
  });
  test("needs-input with a missing parkedFrom throws", () => {
    expect(() =>
      transition({ phase: "needs-input", reviveCount: 0, parkedFrom: null }, { type: "resume" })
    ).toThrow(PhaseFsmError);
  });
  // parkedFrom must be a *pipeline* phase — a known-but-non-pipeline state
  // name (done / stalled / needs-input) must still be rejected, else resume
  // could jump straight into a terminal state.
  for (const parkedFrom of ["done", "stalled", "needs-input"]) {
    test(`needs-input with non-pipeline parkedFrom '${parkedFrom}' throws`, () => {
      expect(() =>
        transition({ phase: "needs-input", reviveCount: 0, parkedFrom }, { type: "resume" })
      ).toThrow(PhaseFsmError);
    });
  }
});
