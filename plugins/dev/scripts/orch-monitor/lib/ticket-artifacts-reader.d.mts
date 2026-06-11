// Type declarations for ticket-artifacts-reader.mjs (CTL-889, P9). Keep in sync
// with the object assembled in the .mjs.

/** One research/plan artifact resolved for a ticket. */
export interface TicketArtifact {
  /** The artifact kind — "research" or "plan". */
  kind: "research" | "plan";
  /** Repo-root-relative path to the markdown file. */
  path: string;
  /** First few KB of the file for the peek pane, or null when unreadable. */
  peek: string | null;
}

export interface TicketArtifacts {
  /** The requested ticket identifier. */
  ticket: string;
  /** Resolved artifacts, ordered research-before-plan then by path. */
  artifacts: TicketArtifact[];
  /** Eventual-consistency note (CTL-866 multi-host thoughts-sync caveat). */
  crossNodeCaveat: string;
}

export interface BuildArtifactListOptions {
  /** Repo-root-relative thoughts/shared dir (default "thoughts/shared"). */
  thoughtsRel?: string;
  /** Absolute path to the thoughts/shared dir to scan. */
  thoughtsDir?: string;
  /** Directory lister (default fs/promises readdir). */
  lister?: (dir: string) => string[] | Promise<string[]>;
  /** File reader (default fs/promises readFile utf8). */
  reader?: (path: string) => string | Promise<string>;
}

/** Pure-ish assembler: scan thoughts dirs for a ticket's artifacts. */
export function buildArtifactList(
  ticket: string,
  opts?: BuildArtifactListOptions,
): Promise<TicketArtifacts>;

export interface ReadTicketArtifactsOptions {
  /** Working directory the thoughts tree is resolved against (default cwd). */
  cwd?: string;
  lister?: (dir: string) => string[] | Promise<string[]>;
  reader?: (path: string) => string | Promise<string>;
}

/** Route-facing reader: resolve a ticket's artifacts from the local thoughts tree. */
export function readTicketArtifacts(
  ticket: string,
  opts?: ReadTicketArtifactsOptions,
): Promise<TicketArtifacts>;

/** A single artifact's resolved content (CTL-1042 by-kind deep-dive serve). */
export interface TicketArtifactContent {
  /** The artifact kind served. */
  kind: "research" | "plan";
  /** Repo-root-relative path the content was read from. */
  path: string;
  /** The full markdown file content. */
  content: string;
}

/** Serve a single artifact's full CONTENT by kind for the reading-pane deep-dive
 *  pills. Returns null when no artifact of that kind exists OR the file cannot be
 *  read (the route maps null to a 404). */
export function readTicketArtifactContent(
  ticket: string,
  kind: "research" | "plan",
  opts?: ReadTicketArtifactsOptions,
): Promise<TicketArtifactContent | null>;
