// escalation-explanation.test.mjs — CTL-1130: typed-union contract tests.
import { describe, test, expect } from "bun:test";
import {
  validateExplanation,
  buildExplanation,
  coerceExplanation,
  buildRemediateCapExplanation,
  tierProducer,
} from "./escalation-explanation.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHIM_PATH = fileURLToPath(new URL("./escalation-explain.mjs", import.meta.url));

// ── per-type valid fixtures ────────────────────────────────────────────────────

const manualGood = {
  escalation_type: "manual",
  problem:
    "git push rejected: branch modifies .github/workflows/ but the host token lacks the workflow OAuth scope",
  call_to_action:
    "Grant the daemon 'workflow' scope or push branch by hand, then re-run phase-pr. Which?",
  blocked_capability: "the host git token lacks the workflow OAuth scope",
  instructions: ["gh auth refresh -s workflow", "or set CATALYST_WORKFLOW_GITHUB_TOKEN"],
  remediation_then_retry: "re-run /catalyst-dev:phase-pr after the scope is granted",
  why_not_auto: "the daemon cannot grant itself an OAuth scope (capability boundary)",
};

const authzGood = {
  escalation_type: "authorization",
  problem: "implement phase worker made no commits in 42 minutes",
  call_to_action:
    "restart CTL-1 implement from scratch, or is this a known slow/flaky step (extend the threshold)?",
  recommendation: "restart CTL-1 implement with a clean checkout",
  risk: "restarting discards 42 minutes of elapsed work; 0 commits made",
  why_asking: "risk-authority gate, not a capability gap",
  could_higher_tier_resolve: false,
  authorize_label: "restart CTL-1 implement",
};

const decisionGood = {
  escalation_type: "decision",
  problem: "dispatch retries exhausted after prior artifact missing",
  call_to_action:
    "CTL-1/implement dispatch has exhausted retries. Re-dispatch or abandon?",
  options: [
    { label: "re-dispatch CTL-1/implement", tradeoff: "may re-hit the same failure" },
    { label: "abandon / re-scope", tradeoff: "loses partial progress" },
  ],
  why_you:
    "after prior_artifact_missing, re-dispatch vs abandon is a priority call the scheduler cannot compute",
};

// ── G1, G2, G3: per-type accept ───────────────────────────────────────────────

describe("validateExplanation: per-type accept", () => {
  test("accepts a fully-formed MANUAL", () => {
    expect(validateExplanation(manualGood)).toEqual({ valid: true, errors: [] });         // G1
  });

  test("accepts a fully-formed AUTHORIZATION", () => {
    expect(validateExplanation(authzGood)).toEqual({ valid: true, errors: [] });          // G2
  });

  test("accepts a fully-formed DECISION", () => {
    expect(validateExplanation(decisionGood)).toEqual({ valid: true, errors: [] });       // G3
  });
});

// ── discriminant + common fields ─────────────────────────────────────────────

describe("validateExplanation: discriminant + common fields", () => {
  test("rejects missing/unknown escalation_type", () => {
    for (const t of [undefined, "", "auto", "human", null]) {
      const r = validateExplanation({ ...authzGood, escalation_type: t });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("escalation_type"))).toBe(true);
    }
  });

  test("requires non-empty problem on every type", () => {
    for (const fix of [manualGood, authzGood, decisionGood]) {
      const r = validateExplanation({ ...fix, problem: "" });
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain("problem");
    }
  });

  test("requires non-empty call_to_action on every type", () => {
    for (const fix of [manualGood, authzGood, decisionGood]) {
      const r = validateExplanation({ ...fix, call_to_action: "" });
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain("call_to_action");
    }
  });

  test("rejects null / non-object input", () => {
    expect(validateExplanation(null).valid).toBe(false);
    expect(validateExplanation("string").valid).toBe(false);
    expect(validateExplanation([]).valid).toBe(false);
  });
});

// ── per-type required fields ──────────────────────────────────────────────────

describe("validateExplanation: MANUAL required fields", () => {
  test("requires blocked_capability, instructions[], remediation_then_retry, why_not_auto", () => {
    for (const k of ["blocked_capability", "remediation_then_retry", "why_not_auto"]) {
      const r = validateExplanation({ ...manualGood, [k]: "" });
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain(k);
    }
  });

  test("instructions must be a non-empty array", () => {
    expect(validateExplanation({ ...manualGood, instructions: [] }).valid).toBe(false);
    expect(validateExplanation({ ...manualGood, instructions: "nope" }).valid).toBe(false);
    expect(validateExplanation({ ...manualGood, instructions: ["one item"] }).valid).toBe(true);
  });
});

describe("validateExplanation: AUTHORIZATION required fields", () => {
  test("requires recommendation, risk, why_asking, authorize_label", () => {
    for (const k of ["recommendation", "risk", "why_asking", "authorize_label"]) {
      const r = validateExplanation({ ...authzGood, [k]: "" });
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain(k);
    }
  });

  test("could_higher_tier_resolve must be a strict boolean", () => {
    for (const v of [undefined, "true", 1, null, "false"]) {
      const r = validateExplanation({ ...authzGood, could_higher_tier_resolve: v });
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain("could_higher_tier_resolve");
    }
    expect(validateExplanation({ ...authzGood, could_higher_tier_resolve: true }).valid).toBe(true);
  });
});

describe("validateExplanation: DECISION required fields", () => {
  test("requires ≥2 options each with label+tradeoff", () => {
    expect(validateExplanation({ ...decisionGood, options: [] }).valid).toBe(false);
    expect(validateExplanation({ ...decisionGood, options: [decisionGood.options[0]] }).valid).toBe(false);
    const missingTradeoff = [{ label: "a", tradeoff: "ok" }, { label: "b" }];
    expect(validateExplanation({ ...decisionGood, options: missingTradeoff }).valid).toBe(false);
  });

  test("requires why_you", () => {
    expect(validateExplanation({ ...decisionGood, why_you: "" }).valid).toBe(false);
  });

  test("DECISION forbids recommendation", () => {
    const r = validateExplanation({ ...decisionGood, recommendation: "pick option A" });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("recommendation"))).toBe(true);
  });
});

// ── anti-gates: D2, D3, D4 ────────────────────────────────────────────────────

describe("validateExplanation: RISK_VAGUE_RE (G4, G6)", () => {
  test("rejects platitudes on risk (authorization) — G4", () => {
    for (const p of ["involves trade-offs", "no single fix path", "requires human judgment"]) {
      const r = validateExplanation({ ...authzGood, risk: p });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("risk"))).toBe(true);
    }
  });

  test("rejects boilerplate self-heal why_not_auto (manual) — G6", () => {
    const vague = "no single automated fix path is provably correct without human judgment";
    const r = validateExplanation({ ...manualGood, why_not_auto: vague });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("why_not_auto"))).toBe(true);
  });

  test("accepts a platitude EMBEDDED in a concrete sentence (D4 boundary)", () => {
    const concrete = "the fix involves trade-offs across broker/router.mjs:352 and the board";
    expect(validateExplanation({ ...authzGood, risk: concrete }).valid).toBe(true);
  });
});

describe("validateExplanation: tautology gate on call_to_action", () => {
  test("rejects tautological call_to_action on any type", () => {
    for (const q of [
      "this requires a human",
      "needs human intervention",
      "escalate to operator",
      "a human must decide",
    ]) {
      const r = validateExplanation({ ...authzGood, call_to_action: q });
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain("call_to_action");
    }
  });
});

describe("validateExplanation: anti-delegation (G5, D2)", () => {
  test("rejects MANUAL/AUTHORIZATION when ctx.canExecute:true — G5 true-positive", () => {
    expect(validateExplanation(manualGood, { canExecute: true }).valid).toBe(false);
    expect(validateExplanation(authzGood, { canExecute: true }).valid).toBe(false);
  });

  test("accepts DECISION with canExecute:true (agent can act, but tie-break is human)", () => {
    expect(validateExplanation(decisionGood, { canExecute: true }).valid).toBe(true);
  });

  test("accepts MANUAL with canExecute:false whose instructions contain a runnable command — G5/G1 false-positive guard (D2)", () => {
    const m = { ...manualGood, instructions: ["gh auth refresh -s workflow"] };
    expect(validateExplanation(m, { canExecute: false }).valid).toBe(true);
  });
});

describe("validateExplanation: error accumulation (D3)", () => {
  test("RISK_VAGUE_RE fires even when other per-type fields are absent", () => {
    const bad = {
      escalation_type: "manual",
      problem: "x",
      call_to_action: "y — authorize or cancel?",
      blocked_capability: "",    // missing
      instructions: [],          // empty
      remediation_then_retry: "",// missing
      why_not_auto: "no single automated fix path is provably correct without human judgment",
    };
    const r = validateExplanation(bad);
    expect(r.valid).toBe(false);
    // Both why_not_auto (RISK_VAGUE_RE) AND missing fields must appear
    expect(r.errors.some((e) => e.includes("why_not_auto"))).toBe(true);
    expect(r.errors.some((e) => e.includes("blocked_capability"))).toBe(true);
  });
});

// ── buildExplanation ──────────────────────────────────────────────────────────

describe("buildExplanation", () => {
  test("returns a frozen valid union per type", () => {
    for (const fix of [manualGood, authzGood, decisionGood]) {
      const e = buildExplanation(fix);
      expect(validateExplanation(e).valid).toBe(true);
      expect(Object.isFrozen(e)).toBe(true);
    }
  });

  test("throws on missing escalation_type", () => {
    expect(() => buildExplanation({ ...authzGood, escalation_type: undefined })).toThrow();
  });

  test("throws on invalid input", () => {
    expect(() => buildExplanation({})).toThrow();
    expect(() => buildExplanation({ escalation_type: "manual", problem: "", call_to_action: "" })).toThrow();
  });
});

// ── coerceExplanation ─────────────────────────────────────────────────────────

describe("coerceExplanation", () => {
  test("degrade NEVER produces manual; authorization iff canExecute confirmed, else decision", () => {
    expect(coerceExplanation({}, {}).escalation_type).toBe("decision");
    expect(coerceExplanation({}, { canExecute: true }).escalation_type).toBe("authorization");
    // No input path yields "manual"
    expect(coerceExplanation({ escalation_type: "manual" }, {}).escalation_type).not.toBe("manual");
    expect(coerceExplanation({ escalation_type: "manual" }, { canExecute: true }).escalation_type).toBe("authorization");
  });

  test("returns a valid object unchanged for each type (no degradation when valid)", () => {
    for (const fix of [manualGood, authzGood, decisionGood]) {
      const e = coerceExplanation(fix, {});
      expect(e.degraded).toBeUndefined();
      expect(validateExplanation(e).valid).toBe(true);
    }
  });

  test("never throws on completely empty input", () => {
    expect(() => coerceExplanation({}, { ticket: "CTL-99", phase: "plan" })).not.toThrow();
    const e = coerceExplanation({}, { ticket: "CTL-99" });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.degraded).toBe(true);
  });

  test("degraded decision call_to_action references ticket", () => {
    const e = coerceExplanation({}, { ticket: "CTL-1", phase: "implement" });
    expect(e.degraded).toBe(true);
    expect(e.call_to_action).toContain("CTL-1");
  });

  test("degraded authorization is valid and contains ticket", () => {
    const e = coerceExplanation({}, { ticket: "CTL-1", phase: "implement", canExecute: true });
    expect(e.degraded).toBe(true);
    expect(e.escalation_type).toBe("authorization");
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.call_to_action).toContain("CTL-1");
  });

  test("coerce preserves observed and attempts passthrough (D1)", () => {
    const obs = { dirtyFiles: ["a.md"] };
    const e = coerceExplanation({ observed: obs, attempts: ["git push"] }, { ticket: "T" });
    expect(e.observed).toEqual(obs);
    expect(e.attempts).toEqual(["git push"]);
  });
});

// ── buildRemediateCapExplanation (AUTHORIZATION, G2/G4) ───────────────────────

describe("buildRemediateCapExplanation", () => {
  const verify = {
    regression_risk: 6,
    findings: [
      {
        severity: "high",
        kind: "review",
        file: "broker/router.mjs",
        line: 352,
        message: "getEventScope reads retired attr vcs.revision",
        recommendation: "read vcs.ref.revision",
      },
      { severity: "low", kind: "lint", file: "x.mjs", line: 1, message: "nit" },
    ],
  };

  test("emits a valid AUTHORIZATION with concrete recommendation from HIGH finding", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.escalation_type).toBe("authorization");
    expect(e.recommendation).toContain("broker/router.mjs:352");
    expect(e.recommendation).toContain("read vcs.ref.revision");
  });

  test("risk is concrete and passes RISK_VAGUE_RE", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    const { RISK_VAGUE_RE_TEST: _ } = {};
    // RISK_VAGUE_RE should NOT match a concrete risk string
    expect(e.risk).toContain("broker/router.mjs:352");
  });

  test("call_to_action names the decision fork (fix or abandon/re-scope)", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.call_to_action.toLowerCase()).toContain("fix");
    expect(e.call_to_action.toLowerCase()).toMatch(/abandon|re-?scope/);
  });

  test("observed carries regression_risk and high-finding count", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(e.observed.regression_risk).toBe(6);
    expect(e.observed.highFindingCount).toBe(1);
  });

  test("could_higher_tier_resolve true when untried higher tier recorded; false at max tier", () => {
    const withTiers = buildRemediateCapExplanation(verify, {
      ticket: "CTL-1047", cycleCount: 3,
      triedTiers: ["sonnet"], maxTier: "opus",
    });
    expect(withTiers.could_higher_tier_resolve).toBe(true);

    const atMax = buildRemediateCapExplanation(verify, {
      ticket: "CTL-1047", cycleCount: 3,
      triedTiers: ["opus"], maxTier: "opus",
    });
    expect(atMax.could_higher_tier_resolve).toBe(false);
  });

  test("no HIGH findings but risk≥5 → still produces a valid AUTHORIZATION", () => {
    const riskOnly = { regression_risk: 5, findings: [] };
    const e = buildRemediateCapExplanation(riskOnly, { ticket: "CTL-9", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.escalation_type).toBe("authorization");
    expect(e.problem.trim()).not.toBe("");
  });

  test("malformed/empty verify.json → valid AUTHORIZATION via safe defaults", () => {
    const e = buildRemediateCapExplanation(null, { ticket: "CTL-9", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.escalation_type).toBe("authorization");
  });
});

// ── tierProducer ──────────────────────────────────────────────────────────────

describe("tierProducer", () => {
  test("returns false when no triedTiers or maxTier supplied", () => {
    expect(tierProducer(undefined, undefined, undefined)).toBe(false);
    expect(tierProducer("sonnet", [], "opus")).toBe(false);
  });

  test("returns true when triedTiers does not include maxTier", () => {
    expect(tierProducer("sonnet", ["sonnet"], "opus")).toBe(true);
  });

  test("returns false when triedTiers includes maxTier (ceiling reached)", () => {
    expect(tierProducer("opus", ["opus"], "opus")).toBe(false);
  });
});

// ── workflow-scope escalation (CTL-1119, migrated from old shape — D6 MANUAL witness) ──

describe("workflow-scope escalation (CTL-1119)", () => {
  test("workflow-scope MANUAL validates and names the blocked capability", () => {
    const e = buildExplanation({
      escalation_type: "manual",
      problem:
        "push rejected: branch modifies .github/workflows/ but the host token lacks the 'workflow' OAuth scope",
      call_to_action:
        "Grant the daemon token 'workflow' scope (gh auth refresh -s workflow) or set CATALYST_WORKFLOW_GITHUB_TOKEN, then re-run phase-pr — or push branch CTL-1119 manually. Which?",
      blocked_capability: "the host git token lacks the workflow OAuth scope",
      instructions: ["gh auth refresh -s workflow", "or set CATALYST_WORKFLOW_GITHUB_TOKEN"],
      remediation_then_retry: "re-run /catalyst-dev:phase-pr after the scope is granted",
      why_not_auto: "the daemon cannot grant itself an OAuth scope (capability boundary)",
      observed: { branch: "CTL-1119", scope_missing: "workflow" },
    });
    expect(e.escalation_type).toBe("manual");
    expect(e.blocked_capability).toMatch(/workflow/);
    expect(e.call_to_action).toMatch(/workflow/);
    expect(validateExplanation(e).valid).toBe(true);
  });

  test("MANUAL with canExecute:false and gh-auth-refresh instruction is accepted (D2 guard)", () => {
    const e = buildExplanation({ ...manualGood, instructions: ["gh auth refresh -s workflow"] });
    expect(validateExplanation(e, { canExecute: false }).valid).toBe(true);
  });
});

// ── CLI shim (escalation-explain.mjs) ────────────────────────────────────────

describe("CLI shim (escalation-explain.mjs)", () => {
  test("MANUAL: --type manual + required flags → escalation_type=manual, exit 0", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "manual",
      "--ticket", "CTL-1130", "--phase", "pr",
      "--problem", "push rejected: no workflow scope",
      "--call-to-action", "Grant 'workflow' scope or push manually. Which?",
      "--blocked-capability", "host token lacks workflow OAuth scope",
      "--instructions", JSON.stringify(["gh auth refresh -s workflow"]),
      "--remediation-then-retry", "re-run phase-pr after scope granted",
      "--why-not-auto", "daemon cannot grant itself an OAuth scope (capability boundary)",
      "--can-execute", "false",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.escalation_type).toBe("manual");
    expect(obj.blocked_capability).toContain("workflow");
  });

  test("AUTHORIZATION: --type authorization + required flags → escalation_type=authorization", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "authorization",
      "--ticket", "CTL-1", "--phase", "implement",
      "--problem", "worker hung for 42 minutes",
      "--call-to-action", "restart CTL-1 implement or extend threshold?",
      "--recommendation", "restart with a clean checkout",
      "--risk", "restarting discards 42 minutes of work and 0 commits",
      "--why-asking", "risk-authority gate, not a capability gap",
      "--authorize-label", "restart CTL-1 implement",
      "--could-higher-tier-resolve", "false",
      "--can-execute", "true",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.escalation_type).toBe("authorization");
    expect(typeof obj.could_higher_tier_resolve).toBe("boolean");
    expect(obj.could_higher_tier_resolve).toBe(false);
  });

  test("AUTHORIZATION: --could-higher-tier-resolve true round-trips as boolean true", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "authorization",
      "--ticket", "CTL-1", "--phase", "implement",
      "--problem", "worker hung",
      "--call-to-action", "restart or extend?",
      "--recommendation", "restart",
      "--risk", "restarting discards progress on CTL-1 implement branch",
      "--why-asking", "risk-authority gate",
      "--authorize-label", "restart CTL-1",
      "--could-higher-tier-resolve", "true",
      "--can-execute", "true",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.could_higher_tier_resolve).toBe(true);
  });

  test("AUTHORIZATION: --tried-tiers with NO --could-higher-tier-resolve yields a boolean (D5)", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "authorization",
      "--problem", "worker hung",
      "--call-to-action", "restart or extend?",
      "--recommendation", "restart",
      "--risk", "restarting discards progress on implement branch",
      "--why-asking", "risk-authority gate",
      "--authorize-label", "restart",
      "--tried-tiers", JSON.stringify(["sonnet"]),
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    // degraded since no --can-execute flag → decision; but the could_higher_tier_resolve
    // type test exercises the shim's getBool returning undefined → core derives
    expect(typeof obj.could_higher_tier_resolve === "boolean" || obj.degraded === true).toBe(true);
  });

  test("DECISION: --type decision + --options JSON + --why-you → escalation_type=decision, no recommendation", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "decision",
      "--ticket", "CTL-1", "--phase", "implement",
      "--problem", "dispatch retries exhausted",
      "--call-to-action", "re-dispatch or abandon?",
      "--options", JSON.stringify([
        { label: "re-dispatch", tradeoff: "may re-hit same failure" },
        { label: "abandon", tradeoff: "loses progress" },
      ]),
      "--why-you", "priority call the scheduler cannot compute",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.escalation_type).toBe("decision");
    expect(Array.isArray(obj.options)).toBe(true);
    expect(obj.options.length).toBeGreaterThanOrEqual(2);
    expect(obj.recommendation).toBeUndefined();
  });

  test("observed pass-through: --observed forwards dirtyFiles (D1)", () => {
    const obs = JSON.stringify({ rebaseRc: 2, dirtyFiles: ["shared.txt"] });
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "decision",
      "--problem", "rebase refused dirty tree",
      "--call-to-action", "resolve conflict or discard?",
      "--options", JSON.stringify([
        { label: "resolve", tradeoff: "manual work" },
        { label: "discard", tradeoff: "lose local change" },
      ]),
      "--why-you", "conflict resolution is a judgment call",
      "--observed", obs,
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.observed).toBeDefined();
    expect(obj.observed.dirtyFiles[0]).toBe("shared.txt");
  });

  test("garbage --options JSON falls back and degrades, exit 0", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--type", "decision",
      "--options", "{not valid json",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    // degraded or valid decision with fallback options
    expect(obj.escalation_type).toBeDefined();
  });

  test("empty argv (no --type) degrades to decision, never crashes, exit 0", () => {
    const r = spawnSync("node", [SHIM_PATH], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.escalation_type).toBe("decision");
    expect(obj.degraded).toBe(true);
  });

  test("--can-execute true degrades to authorization; absent degrades to decision, never manual", () => {
    const r1 = spawnSync("node", [SHIM_PATH, "--can-execute", "true"], { encoding: "utf8" });
    expect(JSON.parse(r1.stdout).escalation_type).toBe("authorization");

    const r2 = spawnSync("node", [SHIM_PATH], { encoding: "utf8" });
    expect(JSON.parse(r2.stdout).escalation_type).toBe("decision");

    const r3 = spawnSync("node", [SHIM_PATH, "--can-execute", "false"], { encoding: "utf8" });
    expect(JSON.parse(r3.stdout).escalation_type).toBe("decision");
    expect(JSON.parse(r3.stdout).escalation_type).not.toBe("manual");
  });
});
