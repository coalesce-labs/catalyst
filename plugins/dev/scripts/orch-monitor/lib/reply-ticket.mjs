// reply-ticket.mjs — the inbox's conversational WRITE: post the operator's reply
// to Linear as a real, human-authored comment (CTL-1569 §4).
//
// ── why this is a SIBLING of respond-ticket.mjs, not an edit to it ────────────
// The existing BFF12 route (`POST /api/ticket/<t>/respond`, respond-ticket.mjs) is
// a different verb with two properties that make it unusable for this surface:
//
//   1. It NEVER TOUCHES LINEAR. It records a local `.respond-<phase>.json`, clears
//      the local once-marker, and appends a SYNTHETIC `linear.comment.created`
//      event to the unified log with `authorId: null`. That synthetic event is now
//      actively wrong as a resolution mechanism: CTL-1567's provenance gate
//      requires a POSITIVELY-IDENTIFIED HUMAN author, so a null-author event is
//      exactly what it declines to act on. The reply must be a REAL comment.
//   2. It hard-requires a HELD RUN — `findHeldRun` scans the ticket's worker dir
//      for a `needs-input`/`stalled` phase signal and returns 404 `not_held` when
//      there is none. But the case this feature exists for is a ticket parked with
//      NO WORKER DIR AT ALL (verified live: the host that cleared OTL-63 in four
//      seconds had no worker dir). Gating the reply on a held run would 404 exactly
//      the rows the operator most needs to answer.
//
// So this module owns the conversational path and leaves BFF12's "record + resume a
// locally-held worker" semantics untouched for the callers that want them.
//
// ── what actually resolves the ask ───────────────────────────────────────────
// The Linear comment IS the resolution. Once it lands, Linear's webhook →
// orch-monitor's Linear handler → a `linear.comment.created` event carrying the
// REAL human author → the daemon's comment-wake path clears the escalation hold
// unconditionally and first (CTL-1567). Measured end-to-end at ~4 seconds.
//
// This module therefore does NOT synthesize a resume event. Doing so would be both
// redundant (the genuine webhook event is coming) and hazardous (two wake events
// for one human reply invites a double-dispatch). We post the comment and let the
// verified path do its job.
//
// ── local best-effort hygiene ────────────────────────────────────────────────
// After a successful post we clear the local escalation once-marker, re-arming
// the daemon's labelOnce guard. This is the SAFE half of the known CTL-1552
// half-mutation: clearing the marker without the label lets the daemon re-apply if
// the ticket is genuinely still held, whereas clearing the label without the marker
// would wedge the guard. It is strictly best-effort — a ticket with no worker dir
// has no marker, which is not an error, and never affects the result.

import { clearEscalationMarker, findHeldRun, recordResponse } from "./respond-ticket.mjs";
import { postOperatorComment } from "./linear-comment.mjs";

/**
 * Post the operator's inbox reply to Linear.
 *
 * Discriminated result. The ONLY success is `replied`; the route maps every other
 * outcome to a non-2xx so the UI RESTORES the row (§4: "a failed post … must
 * restore the row — never silently lose the item"):
 *
 *   { status: "replied", ticket, commentId, author, phase }
 *        → the comment is live and human-authored. The escalation hold clears via the
 *          webhook within seconds; the UI marks the row resolved optimistically and
 *          reconciles against the label on the next frame.
 *   { status: "empty_body" }        → 400: nothing typed.
 *   { status: "bot_identity", … }   → 502: REFUSED before posting — this node's
 *          Linear token is an app actor, so the reply could not have cleared the
 *          ask. Loud, because the alternative is a silently inert feature.
 *   { status: "no_token" }          → 502: no Linear credential on this node.
 *   { status: "not_found", ticket }  → 404: no such Linear issue (e.g. a
 *          synthesized orphan-PR row, which the UI should not offer a reply box for
 *          in the first place — this is the server-side backstop).
 *   { status: "error", message }    → 502: transport / API failure.
 *
 * `phase` is reported when a held run happens to exist locally (useful context for
 * the caller/log) and is null otherwise — it is deliberately NOT a precondition.
 */
export async function replyToTicket(
  { ticket, body },
  {
    post = postOperatorComment,
    findHeld = findHeldRun,
    record = recordResponse,
    clearMarker = clearEscalationMarker,
    env = process.env,
    config = null,
    /** Layer-2 project config — carries the personal `linear.apiToken` that is the
     *  ONLY credential source on the launchd path (catalyst-monitor.sh exports
     *  none). Without it the reply is inert there. */
    projectConfig = null,
    fetchImpl = fetch,
  } = {},
) {
  const text = typeof body === "string" ? body.trim() : "";
  if (text === "") return { status: "empty_body", ticket };
  if (typeof ticket !== "string" || ticket.trim() === "") {
    return { status: "not_found", ticket, message: "no ticket" };
  }

  // Post FIRST. Linear is the system of record for the conversation, and the local
  // bookkeeping below is meaningless if the comment never landed — so nothing local
  // is mutated until the comment is confirmed live.
  // The VERBATIM body is posted (the poster strips only trailing whitespace) —
  // `text` is used above solely to validate emptiness, because trimming leading
  // whitespace would rewrite an indented Markdown code block into prose.
  const posted = await post({ ticket, body }, { fetchImpl, env, config, projectConfig });
  if (posted.status !== "posted") {
    // Pass the refusal/failure through verbatim; the route maps it and the row is
    // restored. No local state was touched.
    return { ...posted, ticket };
  }

  // ── post-success local hygiene (best-effort, never fails the reply) ─────────
  let phase = null;
  try {
    const held = findHeld(ticket);
    phase = held?.phase ?? null;
    // Record the operator's words next to the phase signal they answer, when there
    // IS a phase signal. Purely a local breadcrumb — Linear holds the real record.
    if (phase != null) record({ ticket, phase, response: text });
  } catch {
    /* no worker dir / unreadable signals → nothing to record; not an error */
  }
  try {
    clearMarker({ ticket });
  } catch {
    /* no marker → the daemon's guard is already un-armed; not an error */
  }

  return {
    status: "replied",
    ticket,
    commentId: posted.commentId,
    author: posted.author ?? null,
    phase,
  };
}
