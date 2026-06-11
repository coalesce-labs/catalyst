// phase-fsm.test.mjs — pure phase-FSM transition tests (CTL-531).
// Run: cd plugins/dev/scripts/broker && bun test ../lib/phase-fsm.test.mjs

import { describe, test, expect } from "bun:test";

import {
  PHASES,
  NEXT_PHASE,
  REVIVE_BUDGET,
  REMEDIATE_PHASE,
  REMEDIATE_CYCLE_CAP,
  ANCILLARY_PHASES,
  isKnownPhase,
  PhaseFsmError,
  PHASE_LINEAR_KEY,
  TERMINAL_LINEAR_KEY,
  linearKeyForPhase,
  phaseIndex,
  initialState,
  isTerminal,
  transition,
} from "./phase-fsm.mjs";

// Render an arbitrary value as a readable test-name fragment.
const label = (v) => (v === undefined ? "undefined" : Array.isArray(v) ? "[]" : JSON.stringify(v));

// ─── CTL-606: phaseIndex — the canonical 0-based phase-order comparator ───

describe("phaseIndex", () => {
  test("returns the canonical 0-based index for every pipeline phase", () => {
    PHASES.forEach((p, i) => expect(phaseIndex(p)).toBe(i));
  });
  test("triage < research < … < monitor-deploy (monotonic ordering)", () => {
    expect(phaseIndex("triage")).toBeLessThan(phaseIndex("research"));
    expect(phaseIndex("implement")).toBeLessThan(phaseIndex("verify"));
    expect(phaseIndex("monitor-merge")).toBeLessThan(phaseIndex("monitor-deploy"));
    expect(phaseIndex("monitor-deploy")).toBeLessThan(phaseIndex("teardown"));
  });
  test("throws PhaseFsmError on an unknown phase (fail loud, never silent -1)", () => {
    expect(() => phaseIndex("bogus")).toThrow(PhaseFsmError);
    expect(() => phaseIndex(null)).toThrow(PhaseFsmError);
  });
});

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

  test("monitor-deploy --complete--> teardown", () => {
    const next = transition(
      { phase: "monitor-deploy", reviveCount: 0, parkedFrom: null },
      { type: "complete" }
    );
    expect(next).toEqual({ phase: "teardown", reviveCount: 0, parkedFrom: null });
  });

  test("teardown --complete--> done (terminal success)", () => {
    const next = transition(
      { phase: "teardown", reviveCount: 0, parkedFrom: null },
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

// ─── CTL-558: phase → Linear stateMap-key declaration (the 9→5 collapse) ───

describe("PHASE_LINEAR_KEY — the 9→5 collapse (CTL-558)", () => {
  test("declares an entry for every one of the 9 phases", () => {
    for (const p of PHASES) expect(p in PHASE_LINEAR_KEY).toBe(true);
  });
  test("maps the in-flight phases to their stateMap keys", () => {
    expect(PHASE_LINEAR_KEY).toMatchObject({
      research: "research",
      plan: "planning",
      implement: "inProgress",
      verify: "verifying",
      review: "reviewing",
      pr: "inReview",
      "monitor-merge": "inReview",
      "monitor-deploy": "inReview",
      teardown: "inReview",
    });
  });
  test("triage has no status key — the human owns the Triage state", () => {
    expect(PHASE_LINEAR_KEY.triage).toBeNull();
  });
  test("verify and review carry the legacy verifying/reviewing keys (both resolve to Validate)", () => {
    // The keys stay distinct (verifying ≠ reviewing) — the 9→5 collapse happens
    // at the resolved state-NAME level: an execution-core stateMap re-targets both
    // keys onto the single `Validate` state. linear-transition.sh owns key→name.
    expect(PHASE_LINEAR_KEY.verify).toBe("verifying");
    expect(PHASE_LINEAR_KEY.review).toBe("reviewing");
  });
  test("pr, monitor-merge, monitor-deploy collapse onto the PR-equivalent key", () => {
    expect(PHASE_LINEAR_KEY.pr).toBe(PHASE_LINEAR_KEY["monitor-merge"]);
    expect(PHASE_LINEAR_KEY.pr).toBe(PHASE_LINEAR_KEY["monitor-deploy"]);
  });
  test("TERMINAL_LINEAR_KEY is the done key", () => {
    expect(TERMINAL_LINEAR_KEY).toBe("done");
  });
  test("linearKeyForPhase returns the key, or null for triage", () => {
    expect(linearKeyForPhase("research")).toBe("research");
    expect(linearKeyForPhase("triage")).toBeNull();
  });
  test("linearKeyForPhase throws PhaseFsmError on an unknown phase", () => {
    expect(() => linearKeyForPhase("bogus")).toThrow(PhaseFsmError);
  });
});

// ─── CTL-653: remediate — a router-orchestrated conditional detour, NOT a linear edge ───

describe("CTL-653: remediate ancillary phase", () => {
  test("REMEDIATE_CYCLE_CAP is 3 and distinct from REVIVE_BUDGET (1)", () => {
    expect(REMEDIATE_CYCLE_CAP).toBe(3);
    expect(REMEDIATE_CYCLE_CAP).not.toBe(REVIVE_BUDGET);
  });
  test("remediate is NOT a member of the linear PHASES chain", () => {
    expect(PHASES).not.toContain("remediate"); // happy-path edge loop stays 9 phases
    expect(NEXT_PHASE).not.toHaveProperty("remediate"); // no linear successor edge
    expect(NEXT_PHASE.verify).toBe("review"); // happy path unchanged
  });
  test("remediate IS a known ancillary phase", () => {
    expect(REMEDIATE_PHASE).toBe("remediate");
    expect(ANCILLARY_PHASES).toContain("remediate");
    expect(isKnownPhase("remediate")).toBe(true);
    expect(isKnownPhase("bogus")).toBe(false);
  });
  test("isKnownPhase accepts every linear phase too", () => {
    for (const p of PHASES) expect(isKnownPhase(p)).toBe(true);
  });
  test("phaseIndex(remediate) returns verify's index (it sits at the verify position)", () => {
    expect(phaseIndex("remediate")).toBe(phaseIndex("verify"));
  });
  test("linearKeyForPhase(remediate) maps to the 'remediating' stateMap key", () => {
    expect(linearKeyForPhase("remediate")).toBe("remediating");
    expect(PHASE_LINEAR_KEY.remediate).toBe("remediating");
  });
  test("transition() refuses a remediate state — routing is router-owned, not a linear edge", () => {
    expect(() =>
      transition({ phase: "remediate", reviveCount: 0, parkedFrom: null }, { type: "complete" })
    ).toThrow(PhaseFsmError);
  });
  test("a needs-input parked FROM remediate is rejected (remediate is not a pipeline park source)", () => {
    // parkedFrom must be a *pipeline* phase; remediate is ancillary, so resuming
    // into it would re-enter a non-linear edge — keep the park contract pipeline-only.
    expect(() =>
      transition({ phase: "needs-input", reviveCount: 0, parkedFrom: "remediate" }, { type: "resume" })
    ).toThrow(PhaseFsmError);
  });
});
