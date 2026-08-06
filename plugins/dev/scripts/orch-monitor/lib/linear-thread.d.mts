// Type declarations for linear-thread.mjs (CTL-1569 §2/§3) — the parked ticket's
// conversation, read from the REPLICA with zero Linear API calls. Lets the strict
// TS server and the .ts test files import it without a TS7016 implicit-any error.
// Keep in sync with the objects returned in linear-thread.mjs.

/** One normalized comment, newest-first within a thread. */
export interface ThreadComment {
  id: string;
  body: string;
  /** True when the author is the AGENT — an integration bot (`is_bot = 1`) OR a
   *  Catalyst app actor, whose comments arrive with `is_bot = 0` because Linear
   *  models an app actor as a user. See normalizeComment's header note. */
  /** Not the operator — a Catalyst app actor OR an integration bot. */
  isAgent: boolean;
  /** Only a Catalyst app actor — the one whose question is being answered. This,
   *  not `isAgent`, is what the ask derivation keys on, so integration plumbing
   *  can never masquerade as the agent's question. */
  isCatalystAgent: boolean;
  /** GitHub/Linear plumbing. Rendered for context; never an ask candidate. */
  isIntegration: boolean;
  authorName: string;
  authorAvatarUrl: string | null;
  /** Epoch ms, or null when the replica carried no honest timestamp. */
  at: number | null;
  parentId: string | null;
  /** The body is long enough that the UI should clamp it with expand-in-place. */
  truncated: boolean;
}

/** The full thread read. `available:false` means the replica could not be read —
 *  distinct from an available-but-empty thread, so the UI can stay silent about a
 *  source it never reached instead of claiming "no comments". */
export interface TicketThread {
  ticket: string;
  available: boolean;
  comments: ThreadComment[];
  /** The ticket's own Linear URL, mirrored in the replica's `issues` table (§3). */
  url: string | null;
  title: string | null;
  /** Agent comment bodies NEWER than the operator's last reply, NEWEST FIRST —
   *  the LIVE ask candidates. Bounded by the answered-turn boundary so a question
   *  the operator has already answered is never re-surfaced. */
  agentComments: string[];
  /** Every agent comment in the scan window, ignoring the boundary. */
  allAgentComments: string[];
  /** Whether the replica holds an issue ROW. Distinct from `url`, which is an
   *  optional deep link and can be null on a real issue. */
  issueExists: boolean;
  lastAgentComment: string | null;
  reason: string | null;
}

/** A minimal read-only sqlite handle, as injected by tests. */
export interface ThreadDbLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  run?(sql: string): unknown;
  close?(): void;
}

export function defaultReplicaDbPath(): string;

/** How many comments the pane shows by default — "the last few", not all history. */
export const DEFAULT_THREAD_LIMIT: number;

export function normalizeComment(
  row: unknown,
  opts?: { botUserIds?: ReadonlySet<string> },
): ThreadComment | null;

export function readTicketThread(
  ticket: string,
  opts?: {
    dbPath?: string;
    limit?: number;
    openDb?: ((args: { dbPath: string }) => ThreadDbLike) | null;
    /** App-actor user ids whose comments are the AGENT's. */
    botUserIds?: ReadonlySet<string>;
  },
): Promise<TicketThread>;
