// Type declarations for inbox-conversation.mjs (CTL-1569) — the composition layer
// behind the inbox conversation surface. Lets the strict TS server import it without
// a TS7016 implicit-any error. Keep in sync with inbox-conversation.mjs.

import type { InboxAsk } from "./inbox-ask.d.mts";
import type { ThreadComment, TicketThread } from "./linear-thread.d.mts";

/** The single payload the GET /api/ticket/<t>/thread route serves. */
export interface Conversation {
  ticket: string;
  /** Deep link to the Linear ticket (§3); null when the issue did not resolve. */
  url: string | null;
  title: string | null;
  thread: {
    /** false = the replica could not be READ. Distinct from an empty thread, so
     *  the UI can stay silent rather than claiming "no comments". */
    available: boolean;
    /** NEWEST FIRST (§2). */
    comments: ThreadComment[];
    reason: string | null;
  };
  ask: InboxAsk | null;
  /** false ONLY when a READABLE replica positively has no such issue — i.e. a
   *  synthesized row with nothing to reply to (§4 / orphan-PR rows). An UNREADABLE
   *  replica is not evidence of absence, so it stays true and the server-side post
   *  404s honestly if the issue really is gone. */
  canReply: boolean;
}

/** The global config carrying the app-actor `botUserId`s. Fails open to null. */
export function loadGlobalConfig(opts?: { path?: string }): Promise<unknown>;

/** The ticket's phase signals in canonical order. A missing worker dir yields []
 *  — the common parked case, not an error. */
export function readPhaseSignals(
  ticket: string,
  opts?: {
    workersDir?: string;
    read?: (path: string, encoding: "utf8") => Promise<string>;
  },
): Promise<Record<string, unknown>[]>;

export function getConversation(
  ticket: string,
  opts?: {
    limit?: number;
    readThread?: (
      ticket: string,
      opts: { limit: number; botUserIds: ReadonlySet<string> },
    ) => Promise<TicketThread>;
    readSignals?: (
      ticket: string,
      opts: { workersDir: string },
    ) => Promise<Record<string, unknown>[]>;
    workersDir?: string;
    config?: unknown;
  },
): Promise<Conversation>;
