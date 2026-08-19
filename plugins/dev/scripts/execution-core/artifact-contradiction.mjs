// artifact-contradiction.mjs — CTL-2050. Does an ARTIFACT contradict a phase's
// recorded FAILURE?
//
// ─── The trap this exists to open ─────────────────────────────────────────────
//
// Measured on mini-2, 2026-08-18. Three tickets (CTC-239, CTC-266, CTC-772),
// byte-identical in shape:
//
//   triage.json              present and complete   (classification: "bug")
//   phase-triage.json        status: "failed", failureReason: "cluster_fence_stale"
//   phase-recovery-pass.json status: "needs-human"
//
// ⭐ The triage work SUCCEEDED — its artifact is on disk. What failed was the
// cluster-fence guard AT THE EMIT STEP, which (pre-CTL-2048) reported an
// UNREADABLE fence as a STALE one and converted a completed phase into `failed`.
// The work was done; only the RECORD of it was falsified.
//
// Three gates, each individually correct, with no exit between them:
//
//   1. the triage sweep will not re-run it — dispatchTriage is idempotent and
//      artifacts skip; `triage.json` exists.
//   2. advancement will not advance it — deriveAdvancement gates on `done`;
//      `failed` is terminal and not advance-eligible.
//   3. orchestrate-revive will not touch it — it targets NON-terminal workers.
//
// CTL-2048 fixed the PRODUCER (the guard now says `cluster_fence_unverified`
// when it could not read the fence). It cannot retract signals already written.
// This module is the retraction.
//
// ─── Why it is not keyed on the fence ─────────────────────────────────────────
//
// A retraction keyed on `cluster_fence_stale` would be a point fix. ANY
// emit-time infrastructure guard can falsify a completed phase the same way, so
// the durable question is the general one: *is there an artifact that
// contradicts this failure reason?* The registry below is the answer's first
// half; WORK_DONE_PROBES (work-done-probes.mjs) — already the fleet's tested
// answer to "did this phase produce its artifact" — is the second. We reuse it
// rather than writing a second artifact validator that can drift from it.
//
// ─── ⛔ NARROWNESS IS THE ACCEPTANCE CRITERION, NOT A NICETY ──────────────────
//
// A retraction that fires broadly is a way to LAUNDER ANY FAILURE INTO A
// SUCCESS. Both conjuncts are required and neither is negotiable:
//
//   (a) the failure reason is in INFRA_FAILURE_REASONS — the guard failed, NOT
//       the phase's own work; and
//   (b) the phase's own output artifact is present AND structurally valid.
//
// Every other input — a real test failure, an unregistered reason, an absent or
// malformed artifact, a probe that threw, a phase with no probe — HOLDS. The
// fail direction is always "leave it alone": a ticket that stays stuck is
// visible and fixable; a failure quietly rewritten as a success is neither.
//
// ─── ZERO-IMPORT LEAF ─────────────────────────────────────────────────────────
//
// No node builtins, no sibling modules (same discipline as assertion-evidence.mjs
// and lib/secret-contract.mjs). The probe and the filesystem live in the CALLER;
// this module only decides. That is what makes every branch below unit-testable
// without a worker directory.

// INFRA_FAILURE_REASONS — failure reasons attributable to an EMIT-TIME
// INFRASTRUCTURE GUARD rather than to the phase's own work.
//
// ⛔ THE BAR FOR ADDING A ROW. A reason belongs here only if a phase carrying it
// may have COMPLETED ITS WORK SUCCESSFULLY — i.e. the guard sits between the
// finished work and the record of it. `test_failed`, `turn-cap-exhausted`,
// `yield-expired` and every escalation reason do NOT qualify: they describe the
// work itself, and a retraction on them would be the laundering above.
//
// Deliberately opened at TWO rows, both measured, rather than at the wider set a
// first reading suggests. Adding a row later is one line; a row added wrongly
// now is a silent false success on every ticket that carries it.
export const INFRA_FAILURE_REASONS = Object.freeze([
  // The fence was READ and another host owned it. Pre-CTL-2048 this string was
  // ALSO written when the fence could not be read at all — which is the exact
  // population of the three measured tickets, and why it is registered even
  // though a genuine stale fence is a legitimate bow-out. A genuine bow-out
  // still has no artifact of its own (the host that owned the fence did the
  // work elsewhere), so conjunct (b) excludes it.
  "cluster_fence_stale",
  // CTL-2048's new string: the fence was NOT read after every retry. By
  // construction this says nothing about the phase's work.
  "cluster_fence_unverified",
]);

const INFRA_REASON_SET = new Set(INFRA_FAILURE_REASONS);

// THE STATUS THIS RETRACTS. Only `failed`. `stalled` is deliberately excluded:
// it routes through the terminal sweep to needs-human and is the shape a REAL
// escalation takes, so retracting it would be the widest possible version of
// the laundering this module refuses.
export const RETRACTABLE_STATUS = "failed";

// CONTRADICTION_REASONS — the closed set of verdict reasons. Every branch names
// itself; there is no unnamed hold. `contradicted` is the ONLY one that retracts.
export const CONTRADICTION_REASONS = Object.freeze([
  "contradicted", // ⭐ retract: infra-class failure + a valid artifact
  "unreadable-signal", // the signal was null/not-an-object
  "not-failed", // status is not `failed`
  "reason-absent", // `failed` with no failureReason at all
  "reason-not-infra-class", // a real failure of the phase's own work
  "no-probe", // no registered artifact probe for this phase → cannot look
  "artifact-absent", // the probe ran and said the artifact is not there
  "artifact-inconclusive", // ⚠️ the probe could not answer (threw) — NOT "absent"
]);

const hold = (reason, failureReason = null) =>
  Object.freeze({ retract: false, reason, failureReason });

// isRetractableFailure — PURE, and CONJUNCT (a) ALONE: is this signal a `failed`
// carrying an infra-class reason?
//
// Exported separately because it is the CHEAP half and the expensive half is not
// free: conjunct (b) runs a WORK_DONE_PROBE, and two of those
// (`pr`, `monitor-merge`) hit the GitHub API. A sweep that probed every `failed`
// signal every tick to find out whether it cared would spend quota on the
// overwhelming majority of failures it is about to decline anyway. So the caller
// gates on this first, then probes, then calls the full classifier — which calls
// THIS function again rather than re-implementing it, so the two can never
// disagree about what "infra-class" means.
//
// Returns { eligible, reason, failureReason }. `reason` on an ineligible signal
// is the same CONTRADICTION_REASONS string the full classifier would report.
export function isRetractableFailure({ signal, failureReason: failureReasonOverride } = {}) {
  if (signal === null || signal === undefined || typeof signal !== "object" || Array.isArray(signal)) {
    return { eligible: false, reason: "unreadable-signal", failureReason: null };
  }
  if (String(signal.status) !== RETRACTABLE_STATUS) {
    return { eligible: false, reason: "not-failed", failureReason: null };
  }
  const raw = failureReasonOverride !== undefined ? failureReasonOverride : signal.failureReason;
  // A non-string (null, undefined, a number, an object) is `reason-absent`, not
  // a reason that merely fails the set test — the two are diagnostically
  // different and only one of them suggests a producer bug.
  if (typeof raw !== "string" || raw.trim() === "") {
    return { eligible: false, reason: "reason-absent", failureReason: null };
  }
  const reason = raw.trim();
  if (!INFRA_REASON_SET.has(reason)) {
    return { eligible: false, reason: "reason-not-infra-class", failureReason: reason };
  }
  return { eligible: true, reason: null, failureReason: reason };
}

// classifyArtifactContradiction — PURE. The whole decision, in one place.
//
// `signal`          the parsed phase signal record (or the reader's view of it).
// `failureReason`   optional override; defaults to signal.failureReason. Present
//                   because the reader and the on-disk record spell it the same
//                   way today but the writer re-reads the file itself, and a
//                   caller that has already read the canonical bytes should be
//                   able to classify THOSE rather than a second-hand copy.
// `hasProbe`        boolean — does this phase have a registered artifact probe?
// `artifactPresent` ⚠️ THREE-VALUED and it matters: true (probe ran, artifact
//                   valid), false (probe ran, artifact absent/malformed), or
//                   null/undefined (the probe could not be run — it threw, or
//                   the caller declined). `null` is NOT `false`: collapsing
//                   "I could not look" into "it is not there" is the exact
//                   false-negative mechanism this repo keeps re-learning, and
//                   here it fails in the SAFE direction only by accident. Named
//                   explicitly so it stays that way on purpose.
//
// Returns a frozen { retract, reason, failureReason }. Never throws.
export function classifyArtifactContradiction({
  signal,
  failureReason: failureReasonOverride,
  hasProbe,
  artifactPresent,
} = {}) {
  const cheap = isRetractableFailure({ signal, failureReason: failureReasonOverride });
  if (!cheap.eligible) return hold(cheap.reason, cheap.failureReason);
  const reason = cheap.failureReason;

  // Conjunct (b). Order matters: `no-probe` is a statement about the PHASE and
  // must be distinguishable from a probe that ran and found nothing.
  if (hasProbe !== true) return hold("no-probe", reason);
  if (artifactPresent === true) {
    return Object.freeze({ retract: true, reason: "contradicted", failureReason: reason });
  }
  if (artifactPresent === false) return hold("artifact-absent", reason);
  return hold("artifact-inconclusive", reason);
}
