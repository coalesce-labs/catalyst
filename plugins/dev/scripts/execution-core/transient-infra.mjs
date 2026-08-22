// transient-infra.mjs — CTL-1563. The canonical transient-infra failure class.
//
// A worker that dies to a provider/infra condition that WILL clear on its own
// (an Anthropic 429/529 overload burst, a codex rate park) exits BEFORE recording
// a verdict. The recovery-intent ledger increments `attempts` EAGERLY at dispatch
// time, so each such death reads to the exhaustion sweep as one more "dispatch
// without a recorded verdict" — and after RECOVERY_MAX_ATTEMPTS of them the ticket
// is escalated to a terminal needs-human latch that survives 7 days. In the
// 2026-07-29 incident that falsely escalated ~6 healthy tickets a delegate had to
// un-stick by hand. The cause is infrastructure, not the ticket's work.
//
// This module is the ONE place that answers "was this death transient?". It is a
// ZERO-IMPORT LEAF (no node: builtins, no sibling modules) so any consumer —
// including a bare-Node one — can load it without pulling in a dependency graph.
//
// ⚠️ SCOPE IS THE SAFETY ARGUMENT. The predicate gates a REFUND of a self-heal
// attempt, i.e. an exemption from the escalation sweep. Widen this set only for
// reasons that genuinely self-clear. STRUCTURAL failures — empty_branch,
// dispatch_nonzero_exit, cluster_fence_stale, ended-without-declaration — are
// deliberately excluded: they do not clear on their own, and exempting them
// would turn a scoped exemption into a blanket suppression of the sweep, which
// is the failure mode (a silently un-escalating pipeline) that is strictly worse
// than the false escalation this fixes.
//
// The reason strings are a LIVE contract with the two backstop writers, both of
// which land the value on the signal's `attentionReason` (never `failureReason` —
// that field split is load-bearing: attentionReason stays revive-retryable):
//   sdk-run-phase-agent.mjs   → emitBackstop(reason: "sdk-overloaded-exhausted")
//   codex-run-phase-agent.mjs → emitBackstop(reason: "codex-rate-park-exhausted")

/**
 * The canonical transient-infra reasons. Frozen: a consumer must not be able to
 * widen the exemption for every other consumer in the process by mutating it.
 * (`Object.freeze` on a Set blocks property writes, not `add()`, so the real
 * protection is that `resolveTransientInfraReasons` always returns a COPY and
 * nothing here ever hands out this instance for mutation.)
 * @type {ReadonlySet<string>}
 */
export const TRANSIENT_INFRA_REASONS = Object.freeze(
  new Set(["sdk-overloaded-exhausted", "codex-rate-park-exhausted"]),
);

/**
 * Is this death reason a transient-infra condition (retryable), rather than a
 * structural defect in the ticket's work (escalatable)?
 *
 * FAIL-CLOSED by construction: anything that is not a non-empty string present
 * in the set — null, undefined, a number, an object, a blank string, an
 * unrecognized reason — answers `false`. "I could not tell" must read as "not
 * transient", so an unreadable signal escalates exactly as it does today rather
 * than silently buying an unbounded retry budget.
 *
 * @param {unknown} reason the reason recorded on the dead worker's phase signal
 * @param {ReadonlySet<string>} [reasons] an explicit set — pass the result of
 *   `resolveTransientInfraReasons(env)` to honor the env-extended set. Defaults
 *   to the canonical set so a bare call is never accidentally widened.
 * @returns {boolean}
 */
export function isTransientInfraReason(reason, reasons = TRANSIENT_INFRA_REASONS) {
  if (typeof reason !== "string") return false;
  const trimmed = reason.trim();
  if (trimmed === "") return false;
  // A caller may hand in anything; a malformed `reasons` must not throw on this
  // path (it sits inside the escalation sweep, where a throw would suppress a
  // real escalation).
  if (!reasons || typeof reasons.has !== "function") return false;
  return reasons.has(trimmed) === true;
}

/**
 * The effective transient-infra set: the canonical members unioned with any
 * comma-separated extras from `CATALYST_TRANSIENT_INFRA_EXTRA_REASONS`. The env
 * hook exists so an operator riding out a novel provider condition can widen the
 * exemption without a deploy; it can only ADD, never remove a canonical member.
 *
 * Always returns a FRESH Set — never the frozen canonical instance — so a caller
 * that mutates the result cannot widen the exemption process-wide.
 *
 * Never throws: a hostile/absent env object degrades to the canonical set.
 *
 * @param {Record<string, unknown>|null|undefined} [env]
 * @returns {Set<string>}
 */
export function resolveTransientInfraReasons(
  env = typeof process === "undefined" ? {} : process.env,
) {
  const set = new Set(TRANSIENT_INFRA_REASONS);
  let extra;
  try {
    extra = env?.CATALYST_TRANSIENT_INFRA_EXTRA_REASONS;
  } catch {
    return set; // a throwing getter must not break the classifier
  }
  if (typeof extra !== "string") return set;
  for (const r of extra.split(",")) {
    const trimmed = r.trim();
    if (trimmed !== "") set.add(trimmed);
  }
  return set;
}
