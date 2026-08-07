// Type declarations for linear-comment.mjs (CTL-1569 §4) — post a REAL Linear
// comment authored as the OPERATOR, refusing loudly if the token in hand is an app
// actor (whose comments CTL-1567 deliberately ignores). Lets the strict TS server
// and the .ts test files import it without a TS7016 implicit-any error.
// Keep in sync with linear-comment.mjs.

/** Who the Linear token in hand actually is. */
export type AuthorIdentity =
  | {
      ok: true;
      id: string;
      name: string | null;
      email: string | null;
      isMe: boolean;
      /** True when this token is an app actor — the identity that CANNOT resolve
       *  an ask, because CTL-1567's provenance gate ignores it. */
      isBot: boolean;
    }
  | { ok: false; error: string };

/**
 * Discriminated outcome of postOperatorComment. `posted` is the ONLY success;
 * every other value must cause the inbox row to be restored (§4).
 */
export type PostCommentResult =
  | {
      status: "posted";
      ticket: string;
      commentId: string;
      createdAt: string | null;
      /** The authorship the SERVER recorded, not what we assumed. */
      author: { id: string; name: string | null };
    }
  | { status: "empty_body" }
  | { status: "no_token" }
  | {
      status: "bot_identity";
      author: { id: string; name: string | null };
      message: string;
    }
  | { status: "not_found"; ticket: string; message: string }
  | { status: "error"; message: string };

/** Every configured personal-token candidate, in priority order, deduplicated,
 *  empty/falsy entries dropped. `postOperatorComment` identity-checks each in
 *  turn instead of trusting the first non-empty string. */
export function linearTokenCandidates(
  env?: Record<string, string | undefined>,
  opts?: { projectConfig?: unknown },
): string[];

/** The single highest-priority candidate (`linearTokenCandidates(...)[0]`). */
export function resolveLinearToken(
  env?: Record<string, string | undefined>,
  opts?: { projectConfig?: unknown },
): string | null;

/** App-actor user ids from `catalyst.linear.bot.<app>.botUserId`. Fails open to an
 *  empty set — the primary defense is the `viewer` shape check, which needs no
 *  config at all. */
export function knownBotUserIds(opts?: {
  config?: unknown;
  projectConfig?: unknown;
}): Set<string>;

export function resolveAuthorIdentity(
  args: { token: string; botUserIds?: ReadonlySet<string> },
  opts?: { fetchImpl?: typeof fetch },
): Promise<AuthorIdentity>;

export function resolveIssueId(
  args: { token: string; ticket: string },
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ok: true; id: string } | { ok: false; error: string }>;

export function postOperatorComment(
  args: { ticket: string; body: unknown },
  opts?: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
    config?: unknown;
    projectConfig?: unknown;
    resolveIdentity?: (
      args: { token: string; botUserIds?: ReadonlySet<string> },
      opts?: { fetchImpl?: typeof fetch },
    ) => Promise<AuthorIdentity>;
    resolveIssue?: (
      args: { token: string; ticket: string },
      opts?: { fetchImpl?: typeof fetch },
    ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  },
): Promise<PostCommentResult>;

/** The exact text to post: leading whitespace preserved (an indented Markdown
 *  code block must survive), only trailing whitespace stripped. */
export function postBody(raw: unknown): string;
