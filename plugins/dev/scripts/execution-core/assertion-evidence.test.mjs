// assertion-evidence.test.mjs — CTL-1789 classifier truth table.
//
// Run: cd plugins/dev/scripts/execution-core && bun test assertion-evidence.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ASSERTED_BY,
  EVIDENCE,
  EVIDENCE_VALUES,
  EVIDENCE_REASONS,
  classifyAdvanceEvidence,
  explainAdvanceEvidence,
} from "./assertion-evidence.mjs";

describe("CTL-1789 assertion-evidence contract", () => {
  test("EVIDENCE_VALUES is exactly the three-valued contract", () => {
    expect(EVIDENCE_VALUES).toEqual(["declared", "fabricated", "absent"]);
  });

  test("every ASSERTED_BY id is classified (no id falls through to unknown-writer)", () => {
    for (const id of Object.values(ASSERTED_BY)) {
      const r = explainAdvanceEvidence({ assertedBy: id }, { predecessorPhase: "implement" });
      expect(r.evidenceReason, `${id} is registered but not classified`).toBeNull();
      expect([EVIDENCE.DECLARED, EVIDENCE.FABRICATED]).toContain(r.evidence);
    }
  });

  test("the wrapper's own id is the ONLY declared writer", () => {
    const declared = Object.values(ASSERTED_BY).filter(
      (id) => classifyAdvanceEvidence({ assertedBy: id }) === EVIDENCE.DECLARED
    );
    expect(declared).toEqual([ASSERTED_BY.PHASE_AGENT]);
    expect(ASSERTED_BY.PHASE_AGENT).toBe("phase-agent-emit-complete");
  });
});

describe("classifyAdvanceEvidence", () => {
  test("phase-agent-emit-complete → declared", () => {
    expect(classifyAdvanceEvidence({ assertedBy: ASSERTED_BY.PHASE_AGENT })).toBe("declared");
  });

  test.each([
    ASSERTED_BY.SDK_SUCCESS_FLIP,
    ASSERTED_BY.SDK_BACKSTOP,
    ASSERTED_BY.RECOVERY_RECLAIM,
    ASSERTED_BY.REVIVE_SYNTHESIZED,
  ])("%s → fabricated", (id) => {
    expect(classifyAdvanceEvidence({ assertedBy: id })).toBe("fabricated");
  });

  test("a signal with no assertedBy (legacy, pre-CTL-1789) → absent", () => {
    expect(classifyAdvanceEvidence({ status: "done", ticket: "CTL-1" })).toBe("absent");
  });

  // The fail direction is the whole point: an unrecognized writer must NOT be
  // read as the agent's own claim.
  test("an UNKNOWN writer id fails to absent, never to declared", () => {
    expect(classifyAdvanceEvidence({ assertedBy: "some-future-writer" })).toBe("absent");
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "done"],
    ["an array", []],
    ["a number", 7],
  ])("a non-object signal (%s) → absent", (_label, sig) => {
    expect(classifyAdvanceEvidence(sig)).toBe("absent");
  });

  test.each([
    ["empty string", ""],
    ["a number", 3],
    ["null", null],
    ["an object", {}],
  ])("a non-string assertedBy (%s) → absent", (_label, a) => {
    expect(classifyAdvanceEvidence({ assertedBy: a })).toBe("absent");
  });
});

describe("explainAdvanceEvidence — diagnosable absent", () => {
  test("no predecessor phase → no-predecessor", () => {
    expect(explainAdvanceEvidence({ assertedBy: ASSERTED_BY.PHASE_AGENT })).toEqual({
      evidence: "absent",
      evidenceReason: "no-predecessor",
      assertedBy: null,
    });
  });

  test("unreadable/absent signal for a real predecessor → unreadable-signal", () => {
    expect(explainAdvanceEvidence(null, { predecessorPhase: "implement" })).toEqual({
      evidence: "absent",
      evidenceReason: "unreadable-signal",
      assertedBy: null,
    });
  });

  test("legacy signal with no marker → no-marker", () => {
    expect(explainAdvanceEvidence({ status: "done" }, { predecessorPhase: "plan" })).toEqual({
      evidence: "absent",
      evidenceReason: "no-marker",
      assertedBy: null,
    });
  });

  test("unregistered writer → unknown-writer, and the raw id is preserved", () => {
    expect(
      explainAdvanceEvidence({ assertedBy: "mystery-flip" }, { predecessorPhase: "verify" })
    ).toEqual({
      evidence: "absent",
      evidenceReason: "unknown-writer",
      assertedBy: "mystery-flip",
    });
  });

  test("declared/fabricated carry a null reason and the raw id", () => {
    expect(
      explainAdvanceEvidence(
        { assertedBy: ASSERTED_BY.PHASE_AGENT },
        { predecessorPhase: "research" }
      )
    ).toEqual({
      evidence: "declared",
      evidenceReason: null,
      assertedBy: "phase-agent-emit-complete",
    });
    expect(
      explainAdvanceEvidence(
        { assertedBy: ASSERTED_BY.SDK_SUCCESS_FLIP },
        { predecessorPhase: "research" }
      )
    ).toEqual({
      evidence: "fabricated",
      evidenceReason: null,
      assertedBy: "sdk-success-flip",
    });
  });

  test("every emitted evidenceReason is in the documented EVIDENCE_REASONS set", () => {
    const seen = [
      explainAdvanceEvidence({}, {}),
      explainAdvanceEvidence(null, { predecessorPhase: "implement" }),
      explainAdvanceEvidence({ status: "done" }, { predecessorPhase: "implement" }),
      explainAdvanceEvidence({ assertedBy: "x" }, { predecessorPhase: "implement" }),
    ].map((r) => r.evidenceReason);
    expect(seen).toEqual(EVIDENCE_REASONS.slice());
    for (const r of seen) expect(EVIDENCE_REASONS).toContain(r);
  });

  test("explain and classify never disagree on the evidence value", () => {
    const fixtures = [
      { assertedBy: ASSERTED_BY.PHASE_AGENT },
      { assertedBy: ASSERTED_BY.SDK_SUCCESS_FLIP },
      { assertedBy: "unknown" },
      { status: "done" },
      null,
    ];
    for (const f of fixtures) {
      expect(explainAdvanceEvidence(f, { predecessorPhase: "implement" }).evidence).toBe(
        classifyAdvanceEvidence(f)
      );
    }
  });

  test("the module is a zero-import leaf (no imports at all)", () => {
    // The contract that lets catalyst doctor's bare-node runtime consume it.
    const src = readFileSync(new URL("./assertion-evidence.mjs", import.meta.url), "utf8");
    expect(/^\s*import\s/m.test(src)).toBe(false);
    expect(/\brequire\s*\(/.test(src)).toBe(false);
  });
});
