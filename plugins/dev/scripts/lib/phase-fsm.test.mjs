// phase-fsm.test.mjs — pure phase-FSM transition tests (CTL-531).
// Run: cd plugins/dev/scripts/broker && bun test ../lib/phase-fsm.test.mjs

import { describe, test, expect } from "bun:test";

import { PHASES, PhaseFsmError, initialState, isTerminal, transition } from "./phase-fsm.mjs";

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

describe("transition — terminal states have no outgoing edges", () => {
  test("any event from done throws", () => {
    expect(() =>
      transition({ phase: "done", reviveCount: 0, parkedFrom: null }, { type: "complete" })
    ).toThrow(PhaseFsmError);
  });
});

describe("transition — input validation throws PhaseFsmError", () => {
  // bun's test.each spreads array rows as args, so a bare `[]` row would pass
  // zero args and inject an uncalled `done` callback — a plain for-loop avoids
  // that and matches the happy-path block's idiom above.
  const label = (v) =>
    v === undefined ? "undefined" : Array.isArray(v) ? "[]" : JSON.stringify(v);

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
  test("rejects negative / non-integer reviveCount", () => {
    expect(() =>
      transition({ phase: "triage", reviveCount: -1, parkedFrom: null }, { type: "complete" })
    ).toThrow(PhaseFsmError);
  });
  for (const bad of [null, undefined, 42, "complete", {}]) {
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
