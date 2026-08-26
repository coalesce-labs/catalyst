// safety-gate.mjs — the non-negotiable safety gate, as a first-class, tested
// component (CTL-1461 Phase 2).
//
// Lifts the emit/omit decision out of loss.mjs's inline conditionals into a
// declared table plus a generalized invocation-parity rule, so a policy
// change (e.g. flipping `invocation-not-expressible` from `emit` to `omit`)
// is a one-line table edit, not an inline conditional to relearn.

import { MUTATING_EFFECTS } from "./neutral-schema.mjs";

/**
 * TARGET_CAPABILITIES — per target, which neutral constraints that target's
 * generated artifact can EXPRESS (i.e. guarantee enforcement of).
 *
 * `canExpressInvocationConstraint`: does this target carry a mechanism
 * equivalent to Claude's `disable-model-invocation`? Claude: yes, natively,
 * on the original SKILL.md. Codex's `.codex-plugin/` distribution and the
 * generic `.agents/skills/` bundle: no *guaranteed* enforcement today — the
 * bundle's per-skill `agents/openai.yaml` is read by some but not every
 * harness that consumes it, so the day-one policy for both is `emit` (never
 * a silent `omit`), with the shortfall recorded as a named, counted
 * `degraded` entry. Flipping either target to `true`/`false` is a one-line
 * change here — the mechanism this table exists to provide.
 */
export const TARGET_CAPABILITIES = Object.freeze({
  claude: Object.freeze({ canExpressInvocationConstraint: true }),
  codex: Object.freeze({ canExpressInvocationConstraint: false }),
  agentsSkills: Object.freeze({ canExpressInvocationConstraint: false }),
});

/** REASON — the closed set of reason codes a caller can match on without string-matching prose. */
export const REASON = Object.freeze({
  HOOKS_PRESENT: "pack-hooks-present",
  NO_NEUTRAL: "no-neutral-declaration",
  EXPOSURE_NOT_CATALOG: "exposure-not-catalog",
  INVOCATION_NOT_EXPRESSIBLE: "invocation-not-expressible",
});

/**
 * classifySkillEmission(skill, packHooks, targetName) → { emit, reasonCode, reason }
 *
 * `emit: false` means OMIT (safety) — reasonCode/reason are always set.
 * `emit: true, reasonCode: null` means a clean emission.
 * `emit: true, reasonCode: <set>` means DEGRADED — emitted, but with a
 * named, counted capability shortfall (never silent).
 */
export function classifySkillEmission(skill, packHooks, targetName) {
  if (targetName === "claude") {
    return { emit: true, reasonCode: null, reason: null };
  }

  if (packHooks.present) {
    return {
      emit: false,
      reasonCode: REASON.HOOKS_PRESENT,
      reason: `hooks.toml is never projected to non-Claude targets (${packHooks.entryCount} entr${packHooks.entryCount === 1 ? "y" : "ies"}) — emitting this skill would silently remove a pack-level safety guard`,
    };
  }

  if (skill.neutral === null) {
    return {
      emit: false,
      reasonCode: REASON.NO_NEUTRAL,
      reason: "no neutral effects/invocation/exposure classification declared (agents/portability.yaml absent) — missing classification is an error, and a safety-bearing loss must omit, never ship silently",
    };
  }

  if (!skill.neutral.exposure.includes("catalog")) {
    return {
      emit: false,
      reasonCode: REASON.EXPOSURE_NOT_CATALOG,
      reason: `exposure ${JSON.stringify(skill.neutral.exposure)} does not include "catalog" — this skill is maintainer-facing only ("internal"), not for a public distribution catalog`,
    };
  }

  const capability = TARGET_CAPABILITIES[targetName];
  if (skill.neutral.invocation === "explicit" && !capability?.canExpressInvocationConstraint) {
    return {
      emit: true,
      reasonCode: REASON.INVOCATION_NOT_EXPRESSIBLE,
      reason: `neutral.invocation is "explicit" but target "${targetName}" cannot guarantee enforcement of an explicit-invocation-only constraint — emitted anyway per the day-one policy; flipping to omit is a one-line TARGET_CAPABILITIES change`,
    };
  }

  return { emit: true, reasonCode: null, reason: null };
}

/**
 * checkInvocationParity(skill, label) — the generalized mutating-pair rule,
 * lifted from catalyst-cloud's proven `tools/validate-skills.mjs`: a skill
 * whose `effects` intersect `MUTATING_EFFECTS` must declare
 * `invocation: "explicit"` AND its SKILL.md must declare
 * `disable-model-invocation: true`. A violation is a HARD ERROR at render
 * time — never a warning — naming the skill, both declarations, and what
 * each must be. The whole point of the rule is cross-vendor *parity*: a
 * skill that is explicit-only in one vocabulary and auto-invocable in the
 * other is not safe, it is inconsistently unsafe.
 */
export function checkInvocationParity(skill, label) {
  if (skill.neutral === null) return; // unclassified skills are already omitted upstream by the safety gate
  const mutates = skill.neutral.effects.some((effect) => MUTATING_EFFECTS.includes(effect));
  if (!mutates) return;

  const neutralExplicit = skill.neutral.invocation === "explicit";
  const claudeOnlyDisabled = skill.claudeOnly?.["disable-model-invocation"] === true;

  if (!neutralExplicit || !claudeOnlyDisabled) {
    throw new Error(
      `safety-gate: ${label} has mutating effects ${JSON.stringify(skill.neutral.effects)} but is not explicit-invocation-only in BOTH vocabularies — ` +
        `neutral.invocation=${JSON.stringify(skill.neutral.invocation)} (must be "explicit"), ` +
        `SKILL.md disable-model-invocation=${JSON.stringify(skill.claudeOnly?.["disable-model-invocation"] ?? null)} (must be true). ` +
        `A mutating skill that is explicit-only in one vocabulary and auto-invocable in the other is inconsistently unsafe.`
    );
  }
}
