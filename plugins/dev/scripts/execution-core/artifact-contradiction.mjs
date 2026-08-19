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
// ⛔ THE AMBIGUITY WINDOW — the correction Codex forced on #3690, and the reason
// this registry is a MAP and not a list.
//
// The first cut registered `cluster_fence_stale` on the argument that *a genuine
// bow-out has no artifact of its own — the host that owned the fence did the work
// elsewhere, so conjunct (b) excludes it*. ⛔ THAT CLAIM IS FALSE, and it is false
// for the very phase this module was built for: `phase-triage` writes
// `triage.json` (phase-triage/SKILL.md:255-273) BEFORE it invokes the fence
// (:316-317), and every other fenced phase likewise produces its output before
// the side-effect fence. A worker that GENUINELY lost the fence therefore leaves
// a valid artifact on disk — and retracting on it would advance a ticket from
// output the fence deliberately refused to publish. That is the double-act the
// fence exists to prevent, manufactured by the recovery meant to be safe.
//
// Artifact presence cannot separate the two. TIME can. `cluster_fence_stale` was
// ambiguous only while the PRODUCER conflated an unreadable fence with a stale
// one; CTL-2048 (#3685) closed that window at its merge. Before that instant the
// string means "stale OR unreadable" — the measured residue lives there. At or
// after it the string means what it says, and this module must not touch it.
//
// ⚠️ THE CUTOFF IS THE MERGE, NOT THE ROLLOUT. A host runs the old producer for
// the few minutes between the merge and its plugin refresh, so a genuinely
// ambiguous signal written in that gap is HELD, not retracted. That is the safe
// direction on purpose: a ticket left stuck is visible and fixable; a genuine
// ownership loss laundered into a success is neither.
export const CTL_2048_PRODUCER_FIX_MS = Date.parse("2026-08-19T03:39:12Z"); // #3685, 2026-08-18 22:39:12 CT

// INFRA_FAILURE_REASON_RULES — failure reasons attributable to an EMIT-TIME
// INFRASTRUCTURE GUARD rather than to the phase's own work, each with the window
// in which it is ambiguous (`ambiguousBeforeMs: null` = no window; the string is
// unconditionally infra-class).
//
// ⛔ THE BAR FOR ADDING A ROW. A reason belongs here only if a phase carrying it
// may have COMPLETED ITS WORK SUCCESSFULLY — i.e. the guard sits between the
// finished work and the record of it. `test_failed`, `turn-cap-exhausted`,
// `yield-expired` and every escalation reason do NOT qualify: they describe the
// work itself, and a retraction on them would be the laundering above. And a row
// whose string is ALSO written for a legitimate, non-retractable condition needs
// a window — otherwise it is only safe by an accident of ordering.
export const INFRA_FAILURE_REASON_RULES = Object.freeze({
  // The fence was READ and another host owned it — a legitimate bow-out, EXCEPT
  // in the pre-CTL-2048 window where the same string was also written for a
  // fence that could not be read at all. That window is the measured residue
  // (CTC-239/266/772) and is the only population this row may retract.
  cluster_fence_stale: Object.freeze({ ambiguousBeforeMs: CTL_2048_PRODUCER_FIX_MS }),
  // CTL-2048's new string: the fence was NOT read after every retry. By
  // construction it says nothing about the phase's work and nothing about
  // ownership, so it carries no window.
  cluster_fence_unverified: Object.freeze({ ambiguousBeforeMs: null }),
});

// Retained as the flat name list — parity tests and operators read this.
export const INFRA_FAILURE_REASONS = Object.freeze(Object.keys(INFRA_FAILURE_REASON_RULES));

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
  "signal-age-unknown", // ⚠️ a windowed reason whose signal cannot be dated — NOT "outside the window"
  "reason-window-expired", // the producer no longer conflates this string; it means what it says
  "no-probe", // no registered artifact probe for this phase → cannot look
  "probe-not-local", // ⛔ the probe answers over the network — a tick sweep must not poll it
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
export function isRetractableFailure({
  signal,
  failureReason: failureReasonOverride,
  // ⚠️ THREE-VALUED, and the third value is the point: a finite epoch-ms for when
  // this signal was WRITTEN, or null/undefined for "I could not date it". A
  // windowed reason cannot be proved to sit inside its window without a date, so
  // an undatable signal HOLDS (`signal-age-unknown`) rather than defaulting to
  // either edge. Defaulting to 0 would retract everything undatable; defaulting
  // to now() would retract nothing and read as the feature working.
  writtenAtMs,
} = {}) {
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
  // The ambiguity window. A reason with no window passes straight through.
  const cutoff = INFRA_FAILURE_REASON_RULES[reason].ambiguousBeforeMs;
  if (cutoff !== null) {
    if (typeof writtenAtMs !== "number" || !Number.isFinite(writtenAtMs)) {
      return { eligible: false, reason: "signal-age-unknown", failureReason: reason };
    }
    if (writtenAtMs >= cutoff) {
      return { eligible: false, reason: "reason-window-expired", failureReason: reason };
    }
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
  writtenAtMs,
  hasProbe,
  probeIsLocal,
  artifactPresent,
} = {}) {
  const cheap = isRetractableFailure({ signal, failureReason: failureReasonOverride, writtenAtMs });
  if (!cheap.eligible) return hold(cheap.reason, cheap.failureReason);
  const reason = cheap.failureReason;

  // Conjunct (b). Order matters: `no-probe` is a statement about the PHASE and
  // must be distinguishable from a probe that ran and found nothing.
  if (hasProbe !== true) return hold("no-probe", reason);
  // ⛔ AND THE PROBE MUST ANSWER FROM DISK. `pr` and `monitor-merge` answer by
  // calling the GitHub API, and this classifier is consulted from a scheduler
  // TICK — so registering them would make every unmerged, fence-failed PR spend
  // an authenticated request per tick, forever, on a signal the sweep is about
  // to decline anyway. That is the poll loop AGENTS.md forbids, wearing a
  // recovery's clothes. Those phases are not unreachable in principle; reaching
  // them needs an EVENT (the PR's own merge event), not a sweep, and that is a
  // separate ticket. Defaulting to `undefined` holds — a caller that does not
  // answer this question does not get to probe.
  if (probeIsLocal !== true) return hold("probe-not-local", reason);
  if (artifactPresent === true) {
    return Object.freeze({ retract: true, reason: "contradicted", failureReason: reason });
  }
  if (artifactPresent === false) return hold("artifact-absent", reason);
  return hold("artifact-inconclusive", reason);
}
