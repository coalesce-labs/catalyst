// infra-class-backoff.mjs — CTL-2061. What to DO once infra-class-reasons.mjs has said
// "this failure is the fleet's own plumbing, not the human's problem": retry it with
// exponential backoff, and only after the attempt budget is exhausted, page the STEWARD
// — never label needs-human. An API-capacity transient must never sit in an operator's
// inbox; a human cannot fix "the model provider was busy."
//
// ⛔ REUSES recovery-fix-backoff.mjs'S LEDGER VERBATIM (docs/architecture.md's own framing
// for that module) rather than inventing a second backoff mechanism: same ledger file
// shape, same threshold/exponential-window decision, same delivery-confirmed comment
// dedup for the steward page. Keyed under its own `fixClass` ("infra-retry") so it can
// never collide with a recovery-pass fix-class row in the same ledger directory.

import {
  clearFixFailures,
  fixCommentHash,
  inFixBackoff,
  recordFixFailure,
  shouldPostFixComment,
  commitFixCommentHash,
} from "./recovery-fix-backoff.mjs";
import { postLinearComment } from "./linear-comment-write.mjs";

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The ledger's fixClass for this mechanism — never reused by recovery-pass fix classes. */
export const INFRA_RETRY_FIX_CLASS = "infra-retry";

/**
 * ⛔ The bounded attempt budget (AC3). Below this many recorded attempts, an infra-class
 * reason keeps retrying (subject to recovery-fix-backoff's own exponential window); at or
 * above it, retrying has stopped being useful and the steward gets paged instead — still
 * never the human.
 */
export const INFRA_RETRY_MAX_ATTEMPTS = envNum("INFRA_RETRY_MAX_ATTEMPTS", 10);

export const INFRA_RETRY_ACTION = Object.freeze({
  RETRY: "retry",
  WAIT: "wait",
  PAGE_STEWARD: "page-steward",
});

/**
 * decideInfraClassAction(orchDir, ticket, reason, opts) -> { action, count, until, reason }
 *
 * Pure decision over the on-disk ledger — never throws (same discipline as
 * classifyFailureReason and inFixBackoff, both of which this sits directly downstream of
 * on the escalation write path) and performs no writes itself.
 *
 *   count >= INFRA_RETRY_MAX_ATTEMPTS  -> PAGE_STEWARD (sticky: stays paged, never
 *                                         reverts to retry on its own — clearFixFailures
 *                                         is the only way out, e.g. once the phase
 *                                         actually advances)
 *   backoff.blocked                    -> WAIT (do nothing this tick; do not record
 *                                         another attempt while still inside the window)
 *   otherwise                          -> RETRY (abstain from escalating; the fleet's
 *                                         normal dispatch/reclaim machinery is what
 *                                         actually retries the ticket)
 */
export function decideInfraClassAction(orchDir, ticket, reason, { nowMs = Date.now() } = {}) {
  const backoff = inFixBackoff(orchDir, ticket, INFRA_RETRY_FIX_CLASS, nowMs);
  if (backoff.count >= INFRA_RETRY_MAX_ATTEMPTS) {
    return { action: INFRA_RETRY_ACTION.PAGE_STEWARD, count: backoff.count, until: null, reason };
  }
  if (backoff.blocked) {
    return { action: INFRA_RETRY_ACTION.WAIT, count: backoff.count, until: backoff.until, reason };
  }
  return { action: INFRA_RETRY_ACTION.RETRY, count: backoff.count, until: null, reason };
}

/** The comment body posted to the ticket when the attempt budget is exhausted. */
export function buildStewardPageBody(ticket, reason, count) {
  return (
    `instrument/infra-class-backoff: ${ticket} has failed with the infra-class reason ` +
    `\`${reason}\` ${count}× and exhausted its retry budget (${INFRA_RETRY_MAX_ATTEMPTS}). ` +
    `This is an API-capacity/transport transient, not a product defect — paging the ` +
    `steward of this scope rather than labelling needs-human.`
  );
}

/**
 * applyInfraClassAction — the I/O half. Decides, then (RETRY) records the attempt or
 * (PAGE_STEWARD) posts a deduplicated steward page. Never labels needs-human — that is
 * the entire point of this module existing on the escalation path.
 *
 * Returns `{ ...decision, labelled: false }` so a caller checking `result.labelled` (the
 * existing routeStuckTicketToDelegate/labelDirect contract) sees the same shape it
 * already checks, and correctly sees no label was applied.
 */
export function applyInfraClassAction(
  orchDir,
  ticket,
  reason,
  { nowMs = Date.now(), log = () => {}, postComment = postLinearComment, appendEvent = () => {} } = {}
) {
  const decision = decideInfraClassAction(orchDir, ticket, reason, { nowMs });

  if (decision.action === INFRA_RETRY_ACTION.PAGE_STEWARD) {
    const body = buildStewardPageBody(ticket, reason, decision.count);
    const hash = fixCommentHash(body);
    if (shouldPostFixComment(orchDir, ticket, INFRA_RETRY_FIX_CLASS, hash, nowMs)) {
      appendEvent({ name: "infra-retry.page-steward", ticket, reason, count: decision.count });
      const posted = postComment(ticket, body, { caller: "infra-class-backoff" });
      if (posted?.posted) commitFixCommentHash(orchDir, ticket, INFRA_RETRY_FIX_CLASS, hash, nowMs);
    }
    return { ...decision, labelled: false };
  }

  if (decision.action === INFRA_RETRY_ACTION.WAIT) {
    appendEvent({ name: "infra-retry.wait", ticket, reason, count: decision.count, until: decision.until });
    return { ...decision, labelled: false };
  }

  // RETRY — record the attempt (this is the counter recovery-fix-backoff's own
  // exponential window is computed from) and abstain from escalating.
  recordFixFailure(orchDir, ticket, INFRA_RETRY_FIX_CLASS, reason, nowMs, { log });
  appendEvent({ name: "infra-retry.retry", ticket, reason, count: decision.count + 1 });
  return { ...decision, labelled: false };
}

/** Clears the infra-retry ledger for a ticket — call once the phase actually advances. */
export function clearInfraClassBackoff(orchDir, ticket) {
  clearFixFailures(orchDir, ticket, INFRA_RETRY_FIX_CLASS);
}
