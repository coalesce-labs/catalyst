// board-recovery-pass-explanation.test.ts — CTL-1239: the recovery-pass /
// remediate explanation must surface in the inbox row (deriveHumanQuestion),
// the escalation_type passthrough (deriveEscalationType), and the detail card
// (deriveExplanation).
//
// The bug: the explanation derivers were fed the PHASE_ORDER-aligned `phaseSigs`
// array only. recovery-pass and remediate are NOT in PHASE_ORDER, so a ticket
// whose ONLY structured explanation lived in phase-recovery-pass.json surfaced a
// bare "Respond" with no message. The fix assembles an explanation-scan array
// (canonical PHASE_ORDER signals first, then ancillary remediate, then
// recovery-pass LAST so it wins the newest-first scan) via explanationScan().
//
//   cd plugins/dev/scripts/orch-monitor && bun test __tests__/board-recovery-pass-explanation.test.ts

import { describe, it, expect } from "bun:test";
import {
  explanationScan,
  deriveHumanQuestion,
  deriveEscalationType,
  deriveExplanation,
  PHASE_ORDER,
  ANCILLARY_EXPLANATION_PHASES,
  REMEDIATE_PHASE,
  RECOVERY_PASS_PHASE,
} from "../lib/board-data.mjs";

// A fully-empty PHASE_ORDER-aligned signal array (no canonical phase wrote a
// structured explanation) — the recovery-pass-only escalation case.
const emptyCanonical = () => PHASE_ORDER.map(() => null);

// A recovery-pass escalation signal as recovery-emit writes it: status
// needs-human + a rich structured explanation.
const recoveryPassSig = {
  status: "needs-human",
  needsHumanSince: "2026-06-17T10:00:00.000Z",
  updatedAt: "2026-06-17T10:00:00.000Z",
  explanation: {
    escalation_type: "decision",
    problem: "CTL-9 has been stuck at implement for 90 minutes with no commits",
    call_to_action: "Re-dispatch implement on a clean checkout, or abandon and re-scope?",
    options: [
      { label: "re-dispatch", tradeoff: "may re-hit the same wedge" },
      { label: "abandon", tradeoff: "loses partial progress" },
    ],
  },
};

const remediateSig = {
  status: "needs-human",
  updatedAt: "2026-06-17T09:00:00.000Z",
  explanation: {
    escalation_type: "authorization",
    problem: "remediate cap reached after 3 verify cycles",
    call_to_action: "Authorize the known fix despite the blast-radius risk?",
  },
};

describe("CTL-1239: ANCILLARY_EXPLANATION_PHASES ordering", () => {
  it("is [remediate, recovery-pass] so recovery-pass is the newest scanned", () => {
    expect(ANCILLARY_EXPLANATION_PHASES).toEqual([REMEDIATE_PHASE, RECOVERY_PASS_PHASE]);
    expect(REMEDIATE_PHASE).toBe("remediate");
    expect(RECOVERY_PASS_PHASE).toBe("recovery-pass");
  });

  it("does NOT mutate PHASE_ORDER (ancillary phases stay out of the pipeline order)", () => {
    expect(PHASE_ORDER).not.toContain("recovery-pass");
    expect(PHASE_ORDER).not.toContain("remediate");
  });
});

describe("CTL-1239: recovery-pass-only explanation surfaces in all three consumers", () => {
  // ancillarySigs in run order: [remediateSig=null, recoveryPassSig].
  const scan = explanationScan(emptyCanonical(), [null, recoveryPassSig]);

  it("deriveHumanQuestion surfaces the recovery-pass call_to_action (was null — the regression)", () => {
    expect(deriveHumanQuestion(scan)).toBe(recoveryPassSig.explanation.call_to_action);
    // Regression proof: the PHASE_ORDER-aligned array alone returns null.
    expect(deriveHumanQuestion(emptyCanonical())).toBeNull();
  });

  it("deriveEscalationType surfaces the recovery-pass escalation_type", () => {
    expect(deriveEscalationType(scan)).toBe("decision");
    expect(deriveEscalationType(emptyCanonical())).toBeNull();
  });

  it("deriveExplanation surfaces the recovery-pass detail-card fields", () => {
    const expl = deriveExplanation(scan);
    expect(expl).not.toBeNull();
    expect(expl?.call_to_action).toBe(recoveryPassSig.explanation.call_to_action);
    expect(expl?.problem).toBe(recoveryPassSig.explanation.problem);
    expect(deriveExplanation(emptyCanonical())).toBeNull();
  });
});

describe("CTL-1239: remediate-only explanation surfaces too", () => {
  const scan = explanationScan(emptyCanonical(), [remediateSig, null]);

  it("deriveHumanQuestion surfaces the remediate call_to_action", () => {
    expect(deriveHumanQuestion(scan)).toBe(remediateSig.explanation.call_to_action);
  });

  it("deriveEscalationType surfaces the remediate escalation_type", () => {
    expect(deriveEscalationType(scan)).toBe("authorization");
  });
});

describe("CTL-1239: recovery-pass wins over an earlier canonical-phase explanation", () => {
  // A failed verify phase wrote an explanation; recovery-pass ran AFTER it.
  const canonical = emptyCanonical();
  canonical[PHASE_ORDER.indexOf("verify")] = {
    status: "failed",
    explanation: {
      escalation_type: "manual",
      call_to_action: "an OLDER question from verify",
    },
  } as never;
  const scan = explanationScan(canonical, [null, recoveryPassSig]);

  it("recovery-pass (newest) wins the newest-first scan", () => {
    expect(deriveHumanQuestion(scan)).toBe(recoveryPassSig.explanation.call_to_action);
    expect(deriveEscalationType(scan)).toBe("decision");
  });
});

describe("CTL-1239: fail-open on missing/corrupt ancillary signals", () => {
  it("a fully-empty ancillary set does not throw and yields null derivers", () => {
    const scan = explanationScan(emptyCanonical(), [null, null]);
    expect(deriveHumanQuestion(scan)).toBeNull();
    expect(deriveEscalationType(scan)).toBeNull();
    expect(deriveExplanation(scan)).toBeNull();
  });

  it("a non-object ancillary entry (corrupt parse fallback) is skipped, not thrown", () => {
    const scan = explanationScan(emptyCanonical(), [null, recoveryPassSig]);
    // splice in a junk entry to mimic a corrupt readJSON result mixed in
    const junky = [...scan, "not-an-object" as never, 42 as never];
    expect(() => deriveHumanQuestion(junky)).not.toThrow();
    // recovery-pass still wins (the junk entries carry no explanation.call_to_action)
    expect(deriveHumanQuestion(junky)).toBe(recoveryPassSig.explanation.call_to_action);
  });
});
