// Type declarations for reply-ticket.mjs (CTL-1569 §4) — the inbox's conversational
// WRITE. A SIBLING of respond-ticket.mjs, not a replacement: /respond never touches
// Linear and hard-requires a held run, and the tickets this surface exists for are
// parked with no worker dir at all. Lets the strict TS server import it without a
// TS7016 implicit-any error. Keep in sync with reply-ticket.mjs.

import type { PostCommentResult } from "./linear-comment.d.mts";
import type { HeldRun } from "./respond-ticket.d.mts";

/**
 * Discriminated outcome; the route maps `status` to an HTTP code. `replied` is the
 * ONLY success — every other value is a non-2xx so the UI RESTORES the row (§4:
 * "a failed post … must restore the row — never silently lose the item").
 *
 * - replied      → 200 (a real, human-authored comment is live; CTL-1567 clears
 *                  the escalation hold via the webhook within seconds)
 * - empty_body   → 400 (nothing typed; never reached Linear)
 * - not_found    → 404 (no such Linear issue — e.g. a synthesized orphan-PR row)
 * - bot_identity → 502 (REFUSED before posting: this node's token is an app actor,
 *                  so the reply could not have cleared the ask)
 * - no_token     → 502 (no Linear credential on this node)
 * - error        → 502 (transport / API failure)
 */
export type ReplyTicketResult =
  | {
      status: "replied";
      ticket: string;
      commentId: string;
      author: { id: string; name: string | null } | null;
      /** The locally-held phase, when one happens to exist. Context only — it is
       *  deliberately NOT a precondition. */
      phase: string | null;
    }
  | ({ ticket: string } & Exclude<PostCommentResult, { status: "posted" }>);

export function replyToTicket(
  args: { ticket: string; body: unknown },
  opts?: {
    post?: (
      args: { ticket: string; body: string },
      opts?: {
        fetchImpl?: typeof fetch;
        env?: Record<string, string | undefined>;
        config?: unknown;
        projectConfig?: unknown;
      },
    ) => Promise<PostCommentResult>;
    findHeld?: (ticket: string) => HeldRun | null;
    record?: (args: { ticket: string; phase: string; response: unknown }) => unknown;
    clearMarker?: (args: { ticket: string }) => unknown;
    env?: Record<string, string | undefined>;
    config?: unknown;
    /** Layer-2 project config (personal `linear.apiToken`) — the launchd path's
     *  only credential source. */
    projectConfig?: unknown;
    fetchImpl?: typeof fetch;
  },
): Promise<ReplyTicketResult>;
