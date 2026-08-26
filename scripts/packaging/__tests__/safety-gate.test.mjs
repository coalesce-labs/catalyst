// safety-gate.test.mjs — CTL-1461 Phase 2.
//
// Run: bun test scripts/packaging/__tests__/safety-gate.test.mjs
//
// One fixture per axis the code branches on — a hooks-bearing pack, an
// unclassified skill, an internal-only exposure, an explicit-invocation
// skill on a capable target, the same on an incapable target. A mutation
// control that comes back green because the fixture was easy proves nothing.

import { describe, test, expect } from "bun:test";

import { TARGET_CAPABILITIES, REASON, classifySkillEmission, checkInvocationParity } from "../core/safety-gate.mjs";

function skill(overrides = {}) {
  return {
    id: "s",
    name: "s",
    description: "d",
    body: "body",
    files: [],
    neutral: { effects: [], invocation: "auto", exposure: ["catalog"] },
    claudeOnly: {},
    ...overrides,
  };
}

const NO_HOOKS = { present: false, entryCount: 0 };
const HOOKS = { present: true, entryCount: 5 };

describe("TARGET_CAPABILITIES — declared shape", () => {
  test("claude can express an invocation constraint; codex and agentsSkills cannot (day-one)", () => {
    expect(TARGET_CAPABILITIES.claude.canExpressInvocationConstraint).toBe(true);
    expect(TARGET_CAPABILITIES.codex.canExpressInvocationConstraint).toBe(false);
    expect(TARGET_CAPABILITIES.agentsSkills.canExpressInvocationConstraint).toBe(false);
  });
});

describe("classifySkillEmission — claude never loses anything (early return)", () => {
  test("claude target always emits cleanly, regardless of hooks/neutral/exposure", () => {
    const verdict = classifySkillEmission(skill({ neutral: null }), HOOKS, "claude");
    expect(verdict).toEqual({ emit: true, reasonCode: null, reason: null });
  });
});

describe("classifySkillEmission — axis: pack hooks present (safety, omit)", () => {
  test("hooks.present true omits, reasonCode pack-hooks-present", () => {
    const verdict = classifySkillEmission(skill(), HOOKS, "codex");
    expect(verdict.emit).toBe(false);
    expect(verdict.reasonCode).toBe(REASON.HOOKS_PRESENT);
    expect(verdict.reason).toContain("hooks.toml");
  });

  test("negative control: hooks.present false does not trip this rule", () => {
    const verdict = classifySkillEmission(skill(), NO_HOOKS, "codex");
    expect(verdict.reasonCode).not.toBe(REASON.HOOKS_PRESENT);
  });
});

describe("classifySkillEmission — axis: unclassified skill (safety, omit)", () => {
  test("neutral: null omits, reasonCode no-neutral-declaration", () => {
    const verdict = classifySkillEmission(skill({ neutral: null }), NO_HOOKS, "codex");
    expect(verdict.emit).toBe(false);
    expect(verdict.reasonCode).toBe(REASON.NO_NEUTRAL);
  });

  test("negative control: a classified skill does not trip this rule", () => {
    const verdict = classifySkillEmission(skill(), NO_HOOKS, "codex");
    expect(verdict.reasonCode).not.toBe(REASON.NO_NEUTRAL);
  });
});

describe("classifySkillEmission — axis: exposure not catalog (safety, omit)", () => {
  test("exposure ['internal'] omits, reasonCode exposure-not-catalog", () => {
    const verdict = classifySkillEmission(
      skill({ neutral: { effects: [], invocation: "auto", exposure: ["internal"] } }),
      NO_HOOKS,
      "codex"
    );
    expect(verdict.emit).toBe(false);
    expect(verdict.reasonCode).toBe(REASON.EXPOSURE_NOT_CATALOG);
  });

  test("negative control: exposure ['catalog'] does not trip this rule", () => {
    const verdict = classifySkillEmission(skill(), NO_HOOKS, "codex");
    expect(verdict.reasonCode).not.toBe(REASON.EXPOSURE_NOT_CATALOG);
  });
});

describe("classifySkillEmission — axis: explicit invocation on an INCAPABLE target (degraded, day-one emit)", () => {
  test("codex (incapable) — emitted but degraded, reasonCode invocation-not-expressible", () => {
    const verdict = classifySkillEmission(
      skill({ neutral: { effects: [], invocation: "explicit", exposure: ["catalog"] } }),
      NO_HOOKS,
      "codex"
    );
    expect(verdict.emit).toBe(true);
    expect(verdict.reasonCode).toBe(REASON.INVOCATION_NOT_EXPRESSIBLE);
  });

  test("agentsSkills (incapable) — same shortfall", () => {
    const verdict = classifySkillEmission(
      skill({ neutral: { effects: [], invocation: "explicit", exposure: ["catalog"] } }),
      NO_HOOKS,
      "agentsSkills"
    );
    expect(verdict.emit).toBe(true);
    expect(verdict.reasonCode).toBe(REASON.INVOCATION_NOT_EXPRESSIBLE);
  });
});

describe("classifySkillEmission — axis: explicit invocation on a CAPABLE target (clean)", () => {
  test("claude (capable, via the early-return) — clean, no reasonCode", () => {
    const verdict = classifySkillEmission(
      skill({ neutral: { effects: [], invocation: "explicit", exposure: ["catalog"] } }),
      NO_HOOKS,
      "claude"
    );
    expect(verdict.emit).toBe(true);
    expect(verdict.reasonCode).toBeNull();
  });

  test("auto invocation on an incapable target is clean (the shortfall only applies to explicit)", () => {
    const verdict = classifySkillEmission(skill(), NO_HOOKS, "codex"); // invocation: "auto"
    expect(verdict.emit).toBe(true);
    expect(verdict.reasonCode).toBeNull();
  });
});

describe("checkInvocationParity — the four (mutating, non-mutating) × (explicit, auto) combinations", () => {
  test("non-mutating + auto — passes (vacuously)", () => {
    expect(() => checkInvocationParity(skill({ neutral: { effects: [], invocation: "auto", exposure: ["catalog"] } }), "x/s")).not.toThrow();
  });

  test("non-mutating + explicit — passes (vacuously; the rule only applies to mutating skills)", () => {
    expect(() =>
      checkInvocationParity(
        skill({ neutral: { effects: [], invocation: "explicit", exposure: ["catalog"] }, claudeOnly: { "disable-model-invocation": false } }),
        "x/s"
      )
    ).not.toThrow();
  });

  test("mutating + explicit + disable-model-invocation:true — passes (both sides agree)", () => {
    expect(() =>
      checkInvocationParity(
        skill({
          neutral: { effects: ["file-write"], invocation: "explicit", exposure: ["catalog"] },
          claudeOnly: { "disable-model-invocation": true },
        }),
        "x/s"
      )
    ).not.toThrow();
  });

  test("mutating + auto — FAILS (the core violation)", () => {
    expect(() =>
      checkInvocationParity(
        skill({ neutral: { effects: ["shell-exec"], invocation: "auto", exposure: ["catalog"] }, claudeOnly: {} }),
        "x/s"
      )
    ).toThrow(/explicit-invocation-only/);
  });

  test("the failing case names BOTH sides in the error message", () => {
    try {
      checkInvocationParity(
        skill({ neutral: { effects: ["shell-exec"], invocation: "auto", exposure: ["catalog"] }, claudeOnly: {} }),
        "x/s"
      );
      throw new Error("expected checkInvocationParity to throw");
    } catch (err) {
      expect(String(err.message)).toContain("x/s");
      expect(String(err.message)).toContain('"auto"');
      expect(String(err.message)).toContain("disable-model-invocation");
    }
  });
});

describe("checkInvocationParity — the neutral says explicit but SKILL.md says disable-model-invocation: false (real regression fixture)", () => {
  test("reproduces today's real catalyst-meta/validate-frontmatter violation shape — throws before the fix", () => {
    const violating = skill({
      id: "validate-frontmatter",
      neutral: { effects: ["file-read", "file-write"], invocation: "explicit", exposure: ["catalog"] },
      claudeOnly: { "disable-model-invocation": false },
    });
    expect(() => checkInvocationParity(violating, "catalyst-meta/validate-frontmatter")).toThrow();
    try {
      checkInvocationParity(violating, "catalyst-meta/validate-frontmatter");
    } catch (err) {
      expect(String(err.message)).toContain("catalyst-meta/validate-frontmatter");
      expect(String(err.message)).toContain("false");
    }
  });

  test("passes after the fix (disable-model-invocation: true)", () => {
    const fixed = skill({
      id: "validate-frontmatter",
      neutral: { effects: ["file-read", "file-write"], invocation: "explicit", exposure: ["catalog"] },
      claudeOnly: { "disable-model-invocation": true },
    });
    expect(() => checkInvocationParity(fixed, "catalyst-meta/validate-frontmatter")).not.toThrow();
  });
});

describe("checkInvocationParity — neutral: null is a no-op (already omitted upstream)", () => {
  test("does not throw", () => {
    expect(() => checkInvocationParity(skill({ neutral: null }), "x/s")).not.toThrow();
  });
});
