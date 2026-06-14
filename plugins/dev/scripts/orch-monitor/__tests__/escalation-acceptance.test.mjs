// escalation-acceptance.test.mjs — CTL-1130: 6-scenario end-to-end acceptance matrix.
// Fixtures built from the real buildExplanation/buildRemediateCapExplanation builders
// so they track the live contract field names, not frozen literals.
//
//   cd plugins/dev/scripts/orch-monitor && bun test __tests__/escalation-acceptance.test.mjs

import { describe, test, expect } from "bun:test";
import {
  buildExplanation,
  buildRemediateCapExplanation,
  validateExplanation,
} from "../../execution-core/escalation-explanation.mjs";
import { deriveHumanQuestion } from "../lib/board-data.mjs";

// ── G1: MANUAL — push blocked by missing OAuth scope ────────────────────────

describe("G1: MANUAL — push blocked by missing workflow OAuth scope", () => {
  const e = buildExplanation({
    escalation_type: "manual",
    problem:
      "git push rejected: branch modifies .github/workflows/ but the host token lacks the 'workflow' OAuth scope",
    call_to_action:
      "Grant the daemon token 'workflow' scope (gh auth refresh -s workflow) or set CATALYST_WORKFLOW_GITHUB_TOKEN, then re-run phase-pr — or push branch CTL-9 manually. Which?",
    blocked_capability: "the host git token lacks the workflow OAuth scope",
    instructions: ["gh auth refresh -s workflow", "or set CATALYST_WORKFLOW_GITHUB_TOKEN"],
    remediation_then_retry: "re-run /catalyst-dev:phase-pr after the scope is granted",
    why_not_auto: "the daemon cannot grant itself an OAuth scope (capability boundary)",
    observed: { branch: "CTL-9", scope_missing: "workflow" },
  });

  test("escalation_type is manual", () => expect(e.escalation_type).toBe("manual"));
  test("blocked_capability names the scope", () => expect(e.blocked_capability).toMatch(/workflow/));
  test("validation passes", () => expect(validateExplanation(e).valid).toBe(true));
  test("board surfaces call_to_action", () => {
    const sigs = [{ explanation: e }];
    expect(deriveHumanQuestion(sigs)).toBe(e.call_to_action);
  });
});

// ── G2: AUTHORIZATION — known fix held by blast-radius risk ─────────────────

describe("G2: AUTHORIZATION — known fix held by blast-radius risk", () => {
  const verifyWithHigh = {
    regression_risk: 7,
    findings: [
      {
        severity: "high",
        kind: "review",
        file: "broker/router.mjs",
        line: 352,
        message: "getEventScope reads retired attr vcs.revision",
        recommendation: "read vcs.ref.revision",
      },
    ],
  };
  const e = buildRemediateCapExplanation(verifyWithHigh, { ticket: "CTL-9", cycleCount: 3 });

  test("escalation_type is authorization", () => expect(e.escalation_type).toBe("authorization"));
  test("recommendation contains finding file:line", () =>
    expect(e.recommendation).toContain("broker/router.mjs:352"));
  test("validation passes", () => expect(validateExplanation(e).valid).toBe(true));
  test("board surfaces call_to_action", () => {
    const sigs = [{ explanation: e }];
    expect(deriveHumanQuestion(sigs)).toBe(e.call_to_action);
  });
});

// ── G3: DECISION — architectural fork, no dominant option ───────────────────

describe("G3: DECISION — dispatch retries exhausted, no dominant option", () => {
  const e = buildExplanation({
    escalation_type: "decision",
    problem: "CTL-9/implement dispatch has exhausted retries (prior_artifact_missing)",
    call_to_action: "CTL-9/implement dispatch exhausted retries. Re-dispatch or abandon?",
    options: [
      { label: "re-dispatch CTL-9/implement", tradeoff: "may re-hit the same failure if root cause unresolved" },
      { label: "abandon / re-scope", tradeoff: "loses partial progress toward current phase goals" },
    ],
    why_you: "after prior_artifact_missing, re-dispatch vs abandon is a priority call the scheduler cannot compute",
  });

  test("escalation_type is decision", () => expect(e.escalation_type).toBe("decision"));
  test("options has ≥2 entries each with tradeoffs", () => {
    expect(e.options.length).toBeGreaterThanOrEqual(2);
    for (const opt of e.options) {
      expect(typeof opt.tradeoff).toBe("string");
      expect(opt.tradeoff.trim()).not.toBe("");
    }
  });
  test("no recommendation field", () => expect(e.recommendation).toBeUndefined());
  test("validation passes", () => expect(validateExplanation(e).valid).toBe(true));
});

// ── G4: AUTHORIZATION risk is concrete (passes RISK_VAGUE_RE) ───────────────

describe("G4: AUTHORIZATION risk is concrete — not a vague platitude", () => {
  const e = buildRemediateCapExplanation(
    {
      regression_risk: 6,
      findings: [
        { severity: "high", kind: "review", file: "src/index.mjs", line: 12, message: "null deref", recommendation: "add null check" },
      ],
    },
    { ticket: "CTL-9", cycleCount: 2 },
  );

  test("risk field is non-empty and concrete (not 'involves trade-offs' etc.)", () => {
    expect(e.risk.trim()).not.toBe("");
    expect(e.risk).not.toMatch(/^involves trade-?offs?$/i);
    expect(e.risk).not.toMatch(/^no single (automated )?fix path/i);
    expect(e.risk).not.toMatch(/^requires human judg/i);
  });
  test("why_asking names risk-authority gate, not capability gap", () => {
    expect(e.why_asking).toContain("risk-authority gate");
  });
  test("validation passes", () => expect(validateExplanation(e).valid).toBe(true));
});

// ── G5: anti-delegation — runnable fix is AUTHORIZATION; canExecute:false MANUAL accepted ──

describe("G5: anti-delegation guard (D2)", () => {
  test("a runnable fix must be AUTHORIZATION, not MANUAL (canExecute:true)", () => {
    const authz = buildExplanation({
      escalation_type: "authorization",
      problem: "worker hung for 42 minutes",
      call_to_action: "restart or extend threshold?",
      recommendation: "restart with clean checkout",
      risk: "restarting discards 42 minutes of elapsed work and 0 commits",
      why_asking: "risk-authority gate, not a capability gap",
      could_higher_tier_resolve: false,
      authorize_label: "restart",
    });
    expect(validateExplanation(authz, { canExecute: true }).valid).toBe(false);
  });

  test("a MANUAL with canExecute:false whose instructions contain gh-auth-refresh is ACCEPTED", () => {
    const manual = buildExplanation({
      escalation_type: "manual",
      problem: "push rejected: host token lacks workflow OAuth scope",
      call_to_action: "grant workflow scope or push manually?",
      blocked_capability: "host token lacks workflow OAuth scope",
      instructions: ["gh auth refresh -s workflow", "or set CATALYST_WORKFLOW_GITHUB_TOKEN"],
      remediation_then_retry: "re-run phase-pr after granting scope",
      why_not_auto: "daemon cannot grant itself an OAuth scope (capability boundary)",
    });
    expect(validateExplanation(manual, { canExecute: false }).valid).toBe(true);
  });
});

// ── G6: boilerplate self-heal why_not_auto rejected at validation ─────────────

describe("G6: RISK_VAGUE_RE rejects boilerplate why_not_auto", () => {
  const vaguePhrases = [
    "no single automated fix path is provably correct without human judgment",
    "involves trade-offs",
    "requires human judgment",
  ];

  test.each(vaguePhrases)("rejects '%s' in why_not_auto", (phrase) => {
    const r = validateExplanation({
      escalation_type: "manual",
      problem: "x",
      call_to_action: "y — what to do?",
      blocked_capability: "some capability",
      instructions: ["some step"],
      remediation_then_retry: "re-run after fix",
      why_not_auto: phrase,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("why_not_auto"))).toBe(true);
  });
});
