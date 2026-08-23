// infra-class-reasons.mjs — CTL-2061. Is this failure the fleet's own plumbing, or is it
// the work?
//
// ⛔ THE RULE THIS ENCODES (Ryan, standing): an API-capacity transient must NEVER park on
// a human. A human cannot fix "the model provider was busy"; putting it in their inbox
// costs them attention and buys nothing, and the ticket sits parked until they clear it
// by hand.
//
// ⭐ WHY IT IS URGENT, MEASURED. Every `phase.triage.failed` on the fleet, split at
// CTL-2048's merge (2026-08-19T03:39:12Z), as RATES (the windows are 22.7 h before /
// 6.4 h after, so raw counts would mislead):
//
//   failure_reason              before/h   after/h
//   cluster_fence_stale           1.19      0.00     ← CTL-2048
//   artifact_not_gate_visible     1.06      0.00     ← CTL-2050
//   codex-rate-park-exhausted     1.06      0.00     ← Codex quota returned
//   sdk-overloaded-exhausted      0.35      2.82     ⛔ 8× — now 82% of all failures
//   TOTAL                         3.74      3.44     ⚠️ barely moved
//
// Three classes went to zero and the total did not move, because one pure API-capacity
// transient surged into the space they freed. ⚠️ And it retries with NO backoff — CTC-778
// and CTC-790 each failed triage at 05:11, 05:21 and 05:31 CT, every ~10 minutes,
// indefinitely. At 2.82/h that is how a capacity transient becomes self-sustaining,
// burning a slot and a worker per lap.
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ⛔ THE REGISTRY IS FROZEN AND EXPLICIT, AND "NOT LISTED" MEANS "NOT INFRA".
// ══════════════════════════════════════════════════════════════════════════════════════
//
// The default must be the SAFE direction, and here the safe direction is `unknown` →
// treated as product-class → the human still gets told. A pattern-matched classifier (a
// regex for `/rate|overload|timeout/`) would silently absorb a novel reason that DOES
// need judgement, and the failure would be invisible: the ticket retries forever and
// nobody is ever told it is stuck. An explicit list fails the other way — a genuinely
// new infra reason parks a human once, someone adds a row, and it never parks again.
//
// ⚠️ EVERY ROW IS A STRING SOME PRODUCER ACTUALLY WRITES, verified against its producer
// rather than recalled. `artifact_not_gate_visible` is produced by a SKILL
// (plugins/dev/skills/phase-pr/SKILL.md), not by any .mjs — a JS-only grep reports it
// absent, which is why it is cited with its real source here.

/**
 * ⛔ TWO SPELLINGS OF ONE FACT, and mixing them up is this ticket's own defect one
 * surface over. Signal FILES spell the key `failureReason` (camelCase); EVENTS spell it
 * `failure_reason` (snake_case). The VALUES below are identical on both surfaces — it is
 * the KEY that differs — so this registry is surface-independent. Resolving the key is
 * `escalation-explanation.mjs`'s job (CTL-1754) for signals; a consumer reading the event
 * stream must use the snake_case key or it gets `undefined` for 100% of inputs, every
 * transient classifies `unknown`, and every one of them parks a human.
 */
export const INFRA_CLASS_REASONS = Object.freeze({
  // ── Model/provider capacity. The dominant population, and the pure transient. ──
  "sdk-overloaded-exhausted": "provider-capacity", // sdk-run-phase-agent.mjs
  "sdk-overloaded": "provider-capacity", // sdk-run-phase-agent.mjs
  "sdk-launch-failed": "provider-capacity", // sdk-run-phase-agent.mjs
  "codex-rate-park-exhausted": "provider-capacity", // codex-run-phase-agent.mjs

  // ── Cross-host claim/fence transport. The host could not take or verify a fence. ──
  cluster_fence_stale: "fence-transport", // scheduler.mjs, lib/cluster-fence-guard.sh
  cluster_fence_unverified: "fence-transport", // artifact-contradiction.mjs, cluster-fence-guard.sh

  // ── Artifact visibility across the gate. CTL-2050's population. ──
  artifact_not_gate_visible: "artifact-visibility", // plugins/dev/skills/phase-pr/SKILL.md

  // ── Park/attempt exhaustion that is itself a symptom of the above, never of the work. ──
  "prior-artifact-retry-exhausted": "park-exhausted", // scheduler.mjs, stall-janitor.mjs
});

/** The classes a reason can land in. `unknown` is NOT infra — see the header. */
export const REASON_CLASS = Object.freeze({
  INFRA: "infra",
  PRODUCT: "product",
  UNKNOWN: "unknown",
});

/**
 * ⛔ EXPLICITLY PRODUCT-CLASS. These are named rather than left to fall through to
 * `unknown` so the distinction is TESTABLE: a suite whose only non-infra fixture is a
 * made-up string cannot tell "the classifier routes on the registry" from "the classifier
 * returns a constant". Each of these is a real reason a human genuinely must judge.
 */
export const PRODUCT_CLASS_REASONS = Object.freeze({
  "merge-conflict": "needs-judgement",
  test_failed: "needs-judgement",
  pr_not_merged: "needs-judgement",
  source_conflict_ctl708_unavailable: "needs-judgement",
  "remediate-cycle-cap-exhausted": "needs-judgement",
});

/**
 * classifyFailureReason(reason) -> { class, family, matched }
 *
 * Never throws — it sits on the escalation write path, and a classifier that throws turns
 * a recoverable transient into a lost escalation.
 *
 * ⚠️ Matching is EXACT, not prefix or substring. `sdk-overloaded` and
 * `sdk-overloaded-exhausted` are different reasons from the same producer with different
 * meanings, and a `startsWith` would collapse them; worse, a substring match would let a
 * novel `sdk-overloaded-but-actually-your-code-is-wrong` classify as infra and retry
 * forever.
 */
export function classifyFailureReason(reason) {
  if (typeof reason !== "string" || reason === "") {
    return { class: REASON_CLASS.UNKNOWN, family: null, matched: null };
  }
  // ⛔ Object.hasOwn, NOT a truthiness test on the lookup. A frozen object literal still
  // inherits from Object.prototype, so `INFRA_CLASS_REASONS["toString"]` is a FUNCTION —
  // truthy — and a bare lookup would classify the reason string "toString" as infra and
  // retry it forever. Same for "constructor" and "__proto__".
  if (Object.hasOwn(INFRA_CLASS_REASONS, reason)) {
    return { class: REASON_CLASS.INFRA, family: INFRA_CLASS_REASONS[reason], matched: reason };
  }
  if (Object.hasOwn(PRODUCT_CLASS_REASONS, reason)) {
    return { class: REASON_CLASS.PRODUCT, family: PRODUCT_CLASS_REASONS[reason], matched: reason };
  }
  return { class: REASON_CLASS.UNKNOWN, family: null, matched: null };
}

/** The one predicate callers gate on. `unknown` is deliberately NOT infra. */
export function isInfraClassReason(reason) {
  return classifyFailureReason(reason).class === REASON_CLASS.INFRA;
}
