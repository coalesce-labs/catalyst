// label-failure-class.mjs — ONE classification of `applyLabel`'s failure reasons,
// and the answer to a single question: may this write be re-issued on the very
// next tick, or must the caller back off?
//
// ⛔ THE MEASURED DEFECT (COORD-236, 2026-08-18). mini's admission converger
// re-issued `applyLabel` for the same three tickets ~220 times each in 20 minutes
// and spent the host's ENTIRE 300-write daily Linear budget by lunchtime. The
// downstream damage was not the labels: the exhausted budget then refused the
// cross-host CLAIM writes, and 36 held tickets across both minis reported a lost
// claim on tickets they owned (CTL-2033/CTL-879). One retry loop froze fleet
// dispatch for the rest of the UTC day.
//
// ⛔ WHY THE EXISTING GUARD DID NOT FIRE. `convergeHeldLabel` and
// `convergeDispositionLabel` already arm a 60-second, time-boxed cool-down
// (CTL-834) — but ONLY for reasons in `UNRECOVERABLE_LABEL_REASONS`, a set
// written before the write proxy existed. A budget refusal
// (`budget:day-exhausted`) and a rate-limit (`rate-limited`) are in NEITHER set,
// so the converger read "retryable next tick" and did exactly that, every tick,
// for hours. The mechanism COORD-236 asked for ("≤1 retry per minute") was
// already built and simply could not see the reason that needed it.
//
// ⚠️ THE TWO CLASSES ARE NOT THE SAME AND MUST NOT BE MERGED.
//
//   TERMINAL   — cannot land this daemon lifetime (the workspace has no such
//                label; an exclusive sibling holds the slot; the name resolved
//                against the wrong team). Correct response: STOP retrying, and
//                for `labelOnce`, write the permanent `.skipped` marker.
//
//   THROTTLED  — will land later without anyone doing anything: the host budget
//                rolls at 00:00 UTC, an operator lifts a limit, a rate-limit
//                window passes. Correct response: back off, then retry.
//
// ⛔ Writing `.skipped` for a THROTTLED reason would be a strictly WORSE bug than
// the storm: a `needs-human` label refused during one exhausted minute would be
// permanently abandoned for the rest of the daemon's life, and the operator it
// exists to page would never be paged. `labelOnce` therefore takes ONLY the
// terminal set — that is the reason these are two exported predicates and not one
// "should I back off" boolean, and there is a test pinning it.

/**
 * TERMINAL_LABEL_REASONS — cannot land this daemon lifetime (CTL-834).
 *
 * "team-mismatch" was split out of "missing-label" by CTL-1085 and MUST stay
 * here: dropping it loses the cool-down on cross-team label failures and
 * re-introduces the original per-tick retry storm.
 */
export const TERMINAL_LABEL_REASONS = Object.freeze(
  new Set(["missing-label", "exclusive-conflict", "team-mismatch"]),
);

/**
 * BUDGET_REASON_PREFIX — every host-budget refusal shares this prefix. The real
 * members are `linear-write-budget.mjs`'s frozen `REASONS`: `budget:day-exhausted`,
 * `budget:ticket-cap`, `budget:already-converged`.
 *
 * ⚠️ A `budget:*` refusal is raised by THIS HOST'S OWN LEDGER before the request
 * is sent — it does NOT mean the cloud refused anything. The ledger counts writes
 * that LEFT the host and gates them against `DEFAULT_DAILY_BUDGET`, a constant its
 * own doc-comment calls "the cloud-side daily cap this MIRRORS". Attempts, not
 * arrivals. On 2026-08-18 the host ledger read 300 with 674 refusals while the
 * cloud's `/admin/write-budget` for the same key read 3 of 300, and a P1 to raise
 * the cloud cap was issued on that misreading and then refused after measurement.
 * Read `~/catalyst/linear-write-budget.json` on the HOST. Defect: CTL-2035.
 *
 * Matched by PREFIX rather than enumerated, deliberately: the gate's reason set
 * has grown twice, and an enumeration that falls behind fails in the SILENT
 * direction — the new reason reads as "retryable next tick" and the storm comes
 * back with no test failing. A prefix cannot fall behind.
 */
export const BUDGET_REASON_PREFIX = "budget:";

/**
 * THROTTLED_LABEL_REASONS — the non-budget reasons that also need a cool-down.
 *
 * `rate-limited` is the cloud's own 429 (`classifyProxyResponse`) and the linearis
 * rate-cap (`classifyLabelFailure`); re-issuing into a 429 next tick is the same
 * storm by another name.
 *
 * `unauthorized` is the cloud's 403 (`linear-write-proxy.mjs`'s
 * `classifyProxyResponse`). ⛔ IT BELONGS HERE AND NOT IN THE TERMINAL SET, and the
 * reason is the marker's lifetime: `labelOnce`'s `.skipped` lives under
 * `workers/<ticket>/` and SURVIVES A RESTART, so a terminal classification would
 * outlive the very re-mint that clears the 403 — the label would stay unwritten
 * after the credential was fixed. "Not right now" is the honest reading of an auth
 * failure a human is about to repair. Found by FLEET's peer read on #3667; it was in
 * NEITHER class, so a 403 retried every tick and each attempt spent a budget unit.
 *
 * ⚠️ `Object.freeze` on a Set does NOT prevent `.add()`/`.delete()` — it only seals
 * the object's own properties. It is kept as a statement of intent; the thing that
 * actually pins these contents is the exact-contents test in
 * `label-budget-backoff.test.mjs`. Same caveat applies to TERMINAL_LABEL_REASONS.
 */
export const THROTTLED_LABEL_REASONS = Object.freeze(new Set(["rate-limited", "unauthorized"]));

/** isTerminalLabelReason — may never land this run; stop retrying entirely. */
export function isTerminalLabelReason(reason) {
  return typeof reason === "string" && TERMINAL_LABEL_REASONS.has(reason);
}

/** isThrottledLabelReason — will land later on its own; back off, then retry. */
export function isThrottledLabelReason(reason) {
  if (typeof reason !== "string") return false;
  return reason.startsWith(BUDGET_REASON_PREFIX) || THROTTLED_LABEL_REASONS.has(reason);
}

/**
 * shouldCoolDownLabel — should the caller arm the time-boxed cool-down?
 *
 * TRUE for both classes, because the cool-down is the right response to each:
 * it is time-boxed and self-healing, so a terminal reason simply re-fails after
 * the window (and `labelOnce`'s permanent marker is what actually stops those),
 * while a throttled reason gets exactly the "≤1 retry per minute" COORD-236
 * asked for.
 *
 * ⚠️ Deliberately NOT the predicate `labelOnce` uses. See the header: `.skipped`
 * is permanent, and a throttled reason must never earn it.
 */
export function shouldCoolDownLabel(reason) {
  return isTerminalLabelReason(reason) || isThrottledLabelReason(reason);
}
