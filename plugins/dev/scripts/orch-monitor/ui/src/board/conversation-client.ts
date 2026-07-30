// conversation-client.ts — the read AND write paths of the inbox CONVERSATION
// surface (CTL-1569). Sibling of inbox-read-client.ts (reads) and
// respond-client.ts (writes), and isolated from the React tree for the same two
// reasons: the home tree's no-fetch invariant keeps literal `fetch(` out of the
// components, and a module-graph-free file can be unit-tested with an injected
// fetch, no DOM and no server.
//
// TWO CALLS, TWO POSTURES:
//   • fetchConversation — a REPLICA-only read (zero Linear API calls server-side),
//     so it is safe to fire on every row selection. FAILS SOFT: any IO problem
//     resolves to `ok:false` and the pane simply renders no conversation section.
//   • postReply — the one mutation. FAILS LOUD, by design: every non-success maps
//     to a typed outcome carrying operator-facing copy, because §4 requires that a
//     failed post RESTORE the row rather than silently swallow the operator's words.

import type { AskKind } from "./inbox-ask-model";

// ── the read: thread + ask + deep link ───────────────────────────────────────

/** One comment in the thread, as the server normalized it. */
export interface ThreadComment {
  id: string;
  body: string;
  /** True when the author is NOT the operator — a Catalyst app actor OR an
   *  integration bot. Drives the "someone else wrote this" styling. */
  isAgent: boolean;
  /** True only for a Catalyst app actor — the one whose question is being
   *  answered. This, not `isAgent`, is what the ask derivation keys on. */
  isCatalystAgent: boolean;
  /** True for GitHub/Linear plumbing. Shown for context; never an ask. */
  isIntegration: boolean;
  authorName: string;
  authorAvatarUrl: string | null;
  /** Epoch ms, or null when the replica carried no honest timestamp. */
  at: number | null;
  parentId: string | null;
  /** The server's hint that this body is long enough to clamp + expand in place. */
  truncated: boolean;
}

/** "What this needs from you" — the derived ask (CTL-1569 §1). */
export interface ConversationAsk {
  kind: AskKind;
  summary: string;
  suggestedReplies: string[];
  /** THE bit the operator cares about: can I finish this by replying alone? */
  canResolveByReply: boolean;
  /** Where it came from — "structured" is producer-authored; the others are
   *  reader-side derivations the UI marks as inferred. */
  source: "structured" | "explanation" | "comment";
}

export interface ConversationResponse {
  ticket: string;
  /** Deep link to the Linear ticket (§3); null when the issue did not resolve. */
  url: string | null;
  title: string | null;
  thread: {
    /** false = the replica could not be read. Distinct from an empty thread, so
     *  the UI can stay silent rather than claiming "no comments". */
    available: boolean;
    comments: ThreadComment[];
    reason: string | null;
  };
  ask: ConversationAsk | null;
  /** false for a synthesized row with no Linear issue behind it → no reply box. */
  canReply: boolean;
}

export type ConversationResult =
  | { ok: true; conversation: ConversationResponse }
  | { ok: false };

interface Deps {
  fetchImpl?: typeof fetch;
}

/** The read endpoint URL (exported so the no-fetch invariant test can assert it). */
export function conversationUrl(ticket: string, limit?: number): string {
  const base = `/api/ticket/${encodeURIComponent(ticket)}/thread`;
  return limit != null && Number.isFinite(limit) ? `${base}?limit=${Math.floor(limit)}` : base;
}

/**
 * Fetch a ticket's conversation (ask + thread + deep link). Fails soft: a non-ok
 * status or a network throw becomes `{ ok:false }`, and the pane renders no
 * conversation section rather than an error card. Nothing here is load-bearing for
 * the operator's ability to reply — the reply box is driven by its own state.
 */
export async function fetchConversation(
  ticket: string,
  { fetchImpl = fetch }: Deps = {},
  limit?: number,
): Promise<ConversationResult> {
  try {
    const res = await fetchImpl(conversationUrl(ticket, limit));
    if (!res.ok) return { ok: false };
    const conversation = (await res.json()) as ConversationResponse;
    return { ok: true, conversation };
  } catch {
    return { ok: false };
  }
}

// ── the write: post the operator's reply ─────────────────────────────────────

/**
 * The closed outcome of a reply. ONLY `replied` may clear the row; every other
 * value must restore it (§4: "a failed post … must restore the row — never
 * silently lose the item").
 *
 * `bot_identity` is called out separately from `error` on purpose: it is the
 * failure that would otherwise make the whole feature silently inert (an app-actor
 * comment is ignored by CTL-1567's provenance gate), so it gets its own explicit
 * operator-facing explanation instead of a generic "something went wrong".
 */
export type ReplyOutcome =
  | { status: "replied"; ticket: string; commentId: string; author: { id: string; name: string | null } | null }
  | { status: "empty"; ticket: string }
  | { status: "not_found"; ticket: string; message: string }
  | { status: "bot_identity"; ticket: string; message: string }
  | { status: "error"; ticket: string; message: string };

export function replyUrl(ticket: string): string {
  return `/api/ticket/${encodeURIComponent(ticket)}/reply`;
}

interface ReplyServerResult {
  status?: string;
  ticket?: string;
  commentId?: string;
  author?: { id: string; name: string | null } | null;
  message?: string;
  error?: string;
}

/** Operator-facing copy per failure. Specific, and honest about what happened to
 *  their words — the row is coming back and the text is preserved. */
const FAILURE_COPY: Record<string, string> = {
  bot_identity:
    "Not sent — this monitor is authenticated as the Catalyst app, and an app-authored " +
    "comment would not clear the ask. Your reply was kept.",
  no_token: "Not sent — this node has no Linear credential. Your reply was kept.",
  not_found: "Not sent — no Linear ticket to reply to.",
};

/**
 * Post the operator's reply. Maps the endpoint's discriminated result onto a
 * `ReplyOutcome`:
 *   • 200 replied      → the comment is live and human-authored; the row clears.
 *   • 400 empty_body   → nothing typed.
 *   • 404 not_found    → no such Linear issue.
 *   • 502 bot_identity → REFUSED before posting (the inert-feature guard).
 *   • anything else / a throw → `error` (never a false success).
 */
export async function postReply(
  { ticket, body }: { ticket: string; body: string },
  { fetchImpl = fetch }: Deps = {},
): Promise<ReplyOutcome> {
  let raw: ReplyServerResult;
  try {
    const res = await fetchImpl(replyUrl(ticket), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    raw = (await res.json()) as ReplyServerResult;
  } catch (e) {
    return {
      status: "error",
      ticket,
      message: `Not sent — ${e instanceof Error ? e.message : String(e)}. Your reply was kept.`,
    };
  }

  const message = raw.message ?? raw.error ?? "";
  switch (raw.status) {
    case "replied":
      if (typeof raw.commentId !== "string" || raw.commentId === "") {
        // Success without a comment id is not a verified post — refuse to clear.
        return { status: "error", ticket, message: "Not sent — the post was not confirmed." };
      }
      return {
        status: "replied",
        ticket: raw.ticket ?? ticket,
        commentId: raw.commentId,
        author: raw.author ?? null,
      };
    case "empty_body":
      return { status: "empty", ticket };
    case "not_found":
      return { status: "not_found", ticket, message: FAILURE_COPY.not_found };
    case "bot_identity":
      return { status: "bot_identity", ticket, message: FAILURE_COPY.bot_identity };
    case "no_token":
      return { status: "error", ticket, message: FAILURE_COPY.no_token };
    default:
      return {
        status: "error",
        ticket,
        message: message !== "" ? `Not sent — ${message}` : "Not sent — your reply was kept.",
      };
  }
}
