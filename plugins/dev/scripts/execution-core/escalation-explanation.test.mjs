// escalation-explanation.test.mjs — CTL-1065: contract + tautology validator tests.
import { describe, test, expect } from "bun:test";
import {
  validateExplanation,
  buildExplanation,
  coerceExplanation,
  buildRemediateCapExplanation,
} from "./escalation-explanation.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHIM_PATH = fileURLToPath(new URL("./escalation-explain.mjs", import.meta.url));

const good = {
  what_failed: "implement phase worker made no commits in 42 minutes",
  observed: { elapsedMin: 42, commitCount: 0, bgJobId: "ab12ef34" },
  attempts: [{ attempt: 1, outcome: "revived", reason: "watchdog_revive" }],
  why_gave_up: "revive budget (1) exhausted after attempt 2 produced no commits",
  human_question: "restart CTL-1 implement from scratch, or is this a known flaky env?",
};

describe("validateExplanation", () => {
  test("accepts a fully-formed explanation", () => {
    expect(validateExplanation(good)).toEqual({ valid: true, errors: [] });
  });

  test("requires all five fields present and non-empty", () => {
    for (const k of ["what_failed", "observed", "why_gave_up", "human_question"]) {
      const bad = { ...good, [k]: "" };
      const r = validateExplanation(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.join(" ")).toContain(k);
    }
  });

  test("observed must be a non-null, non-array object", () => {
    expect(validateExplanation({ ...good, observed: null }).valid).toBe(false);
    expect(validateExplanation({ ...good, observed: [] }).valid).toBe(false);
    expect(validateExplanation({ ...good, observed: "string" }).valid).toBe(false);
  });

  test("attempts must be an array (empty allowed)", () => {
    expect(validateExplanation({ ...good, attempts: [] }).valid).toBe(true);
    expect(validateExplanation({ ...good, attempts: "nope" }).valid).toBe(false);
  });

  test("rejects a human_question that just says 'needs a human'", () => {
    for (const q of [
      "this requires a human",
      "needs human intervention",
      "escalate to operator",
      "a human must decide",
    ]) {
      const r = validateExplanation({ ...good, human_question: q });
      expect(r.valid).toBe(false);
    }
  });

  test("rejects a human_question that merely restates what_failed", () => {
    const r = validateExplanation({ ...good, human_question: good.what_failed });
    expect(r.valid).toBe(false);
  });

  test("rejects null / non-object input", () => {
    expect(validateExplanation(null).valid).toBe(false);
    expect(validateExplanation("string").valid).toBe(false);
  });
});

describe("buildExplanation", () => {
  test("returns a valid object", () => {
    const e = buildExplanation({
      what_failed: "x failed in y",
      observed: { a: 1 },
      attempts: [],
      why_gave_up: "budget spent",
      human_question: "should we retry x with a clean checkout?",
    });
    expect(e.human_question).toContain("retry");
    expect(validateExplanation(e).valid).toBe(true);
  });

  test("throws on invalid input", () => {
    expect(() =>
      buildExplanation({ what_failed: "", observed: {}, attempts: [], why_gave_up: "", human_question: "" }),
    ).toThrow();
  });
});

describe("coerceExplanation", () => {
  test("never throws; degrades an invalid question to a safe fallback", () => {
    const e = coerceExplanation(
      {
        what_failed: "worker hung",
        observed: { elapsedMin: 42 },
        attempts: [],
        why_gave_up: "no progress",
        human_question: "needs human",
      },
      { ticket: "CTL-1", phase: "implement" },
    );
    expect(e.degraded).toBe(true);
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.human_question).toContain("CTL-1");
  });

  test("returns valid object unchanged when fields are valid", () => {
    const e = coerceExplanation(good, { ticket: "CTL-1" });
    expect(e.degraded).toBeUndefined();
    expect(validateExplanation(e).valid).toBe(true);
  });

  test("never throws on completely empty input", () => {
    expect(() => coerceExplanation({}, { ticket: "CTL-99", phase: "plan" })).not.toThrow();
    const e = coerceExplanation({}, { ticket: "CTL-99" });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.degraded).toBe(true);
  });
});

// CTL-1108: buildRemediateCapExplanation unit tests
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

  test("names the blocking HIGH finding in what_failed", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(e.what_failed).toContain("broker/router.mjs:352");
    expect(e.what_failed).toContain("getEventScope reads retired attr vcs.revision");
  });

  test("surfaces the exhausted cycle count in why_gave_up", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(e.why_gave_up).toContain("3");
  });

  test("human_question names the decision fork and is non-tautological", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.human_question.toLowerCase()).toContain("fix");
    expect(e.human_question.toLowerCase()).toMatch(/abandon|re-?scope/);
  });

  test("observed carries regression_risk and high-finding count", () => {
    const e = buildRemediateCapExplanation(verify, { ticket: "CTL-1047", cycleCount: 3 });
    expect(e.observed.regression_risk).toBe(6);
    expect(e.observed.highFindingCount).toBe(1);
  });

  test("no HIGH findings but risk>=5 → still produces a valid, non-empty explanation", () => {
    const riskOnly = { regression_risk: 5, findings: [] };
    const e = buildRemediateCapExplanation(riskOnly, { ticket: "CTL-9", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
    expect(e.what_failed.trim()).not.toBe("");
  });

  test("malformed/empty verify.json → valid explanation via safe defaults", () => {
    const e = buildRemediateCapExplanation(null, { ticket: "CTL-9", cycleCount: 3 });
    expect(validateExplanation(e).valid).toBe(true);
  });
});

// CTL-1119: workflow-scope human_question passes the tautology gate
describe("workflow-scope escalation (CTL-1119)", () => {
  test("workflow-scope human_question is accepted (not degraded)", () => {
    const e = coerceExplanation(
      {
        what_failed: "push rejected: missing workflow scope",
        observed: { branch: "CTL-1119", scope_missing: "workflow" },
        attempts: ["git push", "git push --force-with-lease"],
        why_gave_up: "No workflow-scoped credential is configured on this host (CATALYST_WORKFLOW_GITHUB_TOKEN unset)",
        human_question:
          "Grant the daemon token 'workflow' scope (gh auth refresh -s workflow) or set CATALYST_WORKFLOW_GITHUB_TOKEN, then re-run phase-pr — or push branch CTL-1119 manually. Which?",
      },
      { ticket: "CTL-1119", phase: "pr" },
    );
    expect(e.degraded ?? false).toBe(false);
    expect(e.human_question).toMatch(/workflow/);
    const { valid, errors } = validateExplanation(e);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe("CLI shim (escalation-explain.mjs)", () => {
  test("emits validated JSON on stdout, exit 0", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--what-failed", "rebase conflict on thoughts/",
      "--observed", JSON.stringify({ files: ["a.md"], rc: 1 }),
      "--why-gave-up", "auto-rebase refused a dirty tree",
      "--human-question", "resolve a.md by hand then re-run, or discard the local thoughts edit?",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.what_failed).toContain("rebase");
  });

  test("degrades a tautological question but still exits 0", () => {
    const r = spawnSync("node", [
      SHIM_PATH,
      "--ticket", "CTL-9", "--phase", "implement",
      "--what-failed", "x", "--why-gave-up", "y", "--human-question", "needs a human",
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).degraded).toBe(true);
  });
});
