import { describe, expect, test } from "bun:test";
import { hasProbe } from "./work-done-probes.mjs";
import {
  INVERTIBLE_PHASES,
  PROBE_CLASS,
  UNKNOWN_REASONS,
  VERDICT,
  classifyPhase,
  describeOutcome,
  evaluateOutcome,
  probeClassFor,
  shouldWriteFailed,
} from "./outcome-verdict.mjs";

const CANONICAL_PHASES = [
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
  "monitor-deploy",
  "teardown",
];

describe("the safety invariant: UNKNOWN never writes failed", () => {
  // This is the whole design. Three prior rounds were blocked because a boolean
  // probe conflates "absent" with "could not look"; if this test ever fails, the
  // inversion has become capable of manufacturing terminal failures again.
  test("no UNKNOWN reason, on any phase, can produce a failed write", () => {
    for (const reason of Object.values(UNKNOWN_REASONS)) {
      for (const phase of CANONICAL_PHASES) {
        const outcome = { verdict: VERDICT.UNKNOWN, reason, phase };
        expect(shouldWriteFailed(outcome, "enforce")).toBe(false);
      }
    }
  });

  test("only an explicit NOT_DONE in enforce mode writes failed", () => {
    const notDone = { verdict: VERDICT.NOT_DONE, phase: "implement" };
    expect(shouldWriteFailed(notDone, "enforce")).toBe(true);
    for (const mode of ["off", "shadow", undefined, null, "", "ENFORCE"]) {
      expect(shouldWriteFailed(notDone, mode)).toBe(false);
    }
    expect(shouldWriteFailed({ verdict: VERDICT.DONE }, "enforce")).toBe(false);
    // A malformed/absent outcome must never be a reason to fail work.
    expect(shouldWriteFailed(null, "enforce")).toBe(false);
    expect(shouldWriteFailed(undefined, "enforce")).toBe(false);
    expect(shouldWriteFailed({}, "enforce")).toBe(false);
  });

  test("a future verdict value cannot become a reason to fail work", () => {
    // shouldWriteFailed tests POSITIVELY for NOT_DONE rather than `!== DONE`,
    // so an enum value added later defaults to safe.
    expect(shouldWriteFailed({ verdict: "some-future-state" }, "enforce")).toBe(false);
  });
});

describe("phase allowlist — the post-PR phases are structurally exempt", () => {
  test("teardown is UNKNOWN(no-probe-for-phase) and never invertible", () => {
    // Grounding assertion: teardown genuinely has no probe. Positive control
    // below proves hasProbe can say yes, so this zero is a measurement.
    expect(hasProbe("teardown")).toBe(false);
    expect(hasProbe("implement")).toBe(true); // positive control
    const g = classifyPhase("teardown");
    expect(g.invertible).toBe(false);
    expect(g.reason).toBe(UNKNOWN_REASONS.NO_PROBE_FOR_PHASE);
  });

  test("monitor-deploy is UNKNOWN(circular-probe) even though it HAS a probe", () => {
    // The distinction matters: monitor-deploy is exempt because its probe reads
    // the same file its writer writes, NOT because a probe is missing.
    expect(hasProbe("monitor-deploy")).toBe(true);
    const g = classifyPhase("monitor-deploy");
    expect(g.invertible).toBe(false);
    expect(g.reason).toBe(UNKNOWN_REASONS.CIRCULAR_PROBE);
    expect(probeClassFor("monitor-deploy")).toBe(PROBE_CLASS.CIRCULAR);
  });

  test("neither post-PR phase is in the allowlist", () => {
    expect(INVERTIBLE_PHASES.has("monitor-deploy")).toBe(false);
    expect(INVERTIBLE_PHASES.has("teardown")).toBe(false);
  });

  test("a phase invented later is exempt by default (allowlist, not denylist)", () => {
    const g = classifyPhase("some-new-phase");
    expect(g.invertible).toBe(false);
    expect(g.reason).toBe(UNKNOWN_REASONS.NO_PROBE_FOR_PHASE);
  });

  test("the eight admitted phases are invertible", () => {
    for (const p of INVERTIBLE_PHASES) {
      expect(classifyPhase(p).invertible).toBe(true);
    }
    expect(INVERTIBLE_PHASES.size).toBe(8);
  });

  test("a malformed phase is exempt, not crashing", () => {
    for (const bad of [null, undefined, "", 42, {}]) {
      expect(classifyPhase(bad).invertible).toBe(false);
    }
  });
});

describe("evaluateOutcome — a probe that cannot answer is UNKNOWN, never NOT_DONE", () => {
  const call = (phase, runProbe) => evaluateOutcome({ phase, ticket: "PROJ-1" }, { runProbe });

  test("probe true -> DONE (the flip stands)", () => {
    expect(call("implement", () => true).verdict).toBe(VERDICT.DONE);
  });

  test("probe false -> NOT_DONE (the only path to failed)", () => {
    const o = call("implement", () => false);
    expect(o.verdict).toBe(VERDICT.NOT_DONE);
    expect(shouldWriteFailed(o, "enforce")).toBe(true);
  });

  test("probe THROWS -> UNKNOWN(probe-threw), not a failure", () => {
    const o = call("implement", () => {
      throw new Error("gh exited 128");
    });
    expect(o.verdict).toBe(VERDICT.UNKNOWN);
    expect(o.reason).toBe(UNKNOWN_REASONS.PROBE_THREW);
    expect(o.detail).toContain("gh exited 128");
    expect(shouldWriteFailed(o, "enforce")).toBe(false);
  });

  test("probe returns a NON-BOOLEAN -> UNKNOWN, never coerced to false", () => {
    // `undefined` is falsy. Coercing it would terminally fail work on a
    // malformed call — the arity-bug shape that produced 11 false negatives
    // elsewhere in this repo.
    for (const bad of [undefined, null, 0, "", "false"]) {
      const o = call("implement", () => bad);
      expect(o.verdict).toBe(VERDICT.UNKNOWN);
      expect(o.reason).toBe(UNKNOWN_REASONS.PROBE_TRANSPORT_FAIL);
      expect(shouldWriteFailed(o, "enforce")).toBe(false);
    }
  });

  test("a missing runProbe seam is UNKNOWN, not a failure", () => {
    const o = evaluateOutcome({ phase: "implement", ticket: "PROJ-1" }, {});
    expect(o.verdict).toBe(VERDICT.UNKNOWN);
    expect(o.reason).toBe(UNKNOWN_REASONS.PROBE_INPUT_MISSING);
  });

  test("an EXEMPT phase never invokes the probe at all", () => {
    // Cost matters: the probe spawns git/gh synchronously, and the daemon tick
    // has a documented event-loop-stall history. An exempt phase must not pay.
    let called = 0;
    for (const phase of ["monitor-deploy", "teardown"]) {
      const o = evaluateOutcome({ phase, ticket: "PROJ-1" }, { runProbe: () => { called += 1; return false; } });
      expect(o.verdict).toBe(VERDICT.UNKNOWN);
    }
    expect(called).toBe(0);
  });
});

describe("describeOutcome — the shadow-window telemetry", () => {
  test("carries the reason so a shadow window can be read", () => {
    const o = evaluateOutcome({ phase: "teardown", ticket: "PROJ-9" }, { runProbe: () => false });
    const d = describeOutcome(o, "shadow");
    expect(d).toMatchObject({
      phase: "teardown",
      ticket: "PROJ-9",
      verdict: VERDICT.UNKNOWN,
      unknown_reason: UNKNOWN_REASONS.NO_PROBE_FOR_PHASE,
      probe_class: PROBE_CLASS.NO_PROBE,
      mode: "shadow",
      would_write_failed: false,
    });
  });

  test("would_write_failed marks the shadow cases that enforce WOULD have failed", () => {
    const o = evaluateOutcome({ phase: "monitor-merge", ticket: "PROJ-56" }, { runProbe: () => false });
    const d = describeOutcome(o, "shadow");
    expect(d.verdict).toBe(VERDICT.NOT_DONE);
    // In shadow nothing is written, but the counter that drives the exit
    // criterion is exactly this flag.
    expect(d.would_write_failed).toBe(true);
  });

  test("never throws on a malformed outcome", () => {
    expect(() => describeOutcome(null, "shadow")).not.toThrow();
    expect(describeOutcome(null, "shadow").verdict).toBe(VERDICT.UNKNOWN);
  });
});

describe("the measured 2026-08-12 sample replays correctly", () => {
  // Decomposition of the live 16 declared / 15 fabricated on host mini:
  // all 15 fabricated advances sit on two edges of ONE ticket —
  //   14x monitor-merge -> monitor-deploy, and 1x monitor-deploy -> teardown.
  // Under this design exactly ONE changes outcome, and it is a true positive:
  // PR #3277 was still unmerged when the pipeline advanced past monitor-merge
  // (it merged 36m34s later).
  test("the monitor-merge advance on an unmerged PR becomes NOT_DONE", () => {
    const o = evaluateOutcome(
      { phase: "monitor-merge", ticket: "PROJ-56" },
      { runProbe: () => false }, // gh: merged=false at 05:12:34Z
    );
    expect(o.verdict).toBe(VERDICT.NOT_DONE);
    expect(shouldWriteFailed(o, "enforce")).toBe(true);
  });

  test("the monitor-deploy -> teardown advance is UNCHANGED (exempt)", () => {
    const o = evaluateOutcome({ phase: "monitor-deploy", ticket: "PROJ-56" }, { runProbe: () => false });
    expect(o.verdict).toBe(VERDICT.UNKNOWN);
    expect(shouldWriteFailed(o, "enforce")).toBe(false);
  });

  test("a transient GitHub failure on that same edge is UNKNOWN, not a failure", () => {
    // The difference between a true positive and a manufactured one is entirely
    // whether the probe could look. Same phase, same ticket, opposite handling.
    const o = evaluateOutcome(
      { phase: "monitor-merge", ticket: "PROJ-56" },
      { runProbe: () => { throw new Error("gh api 502"); } },
    );
    expect(o.verdict).toBe(VERDICT.UNKNOWN);
    expect(shouldWriteFailed(o, "enforce")).toBe(false);
  });
});
