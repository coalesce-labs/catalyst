// Type declarations for ticket-discussion-reader.mjs (CTL-1574). Keep in sync
// with the object the .mjs assembles.
//
// PROVENANCE: `TicketComment` / `TicketActivityEvent` / `TicketActivityLabel`
// are field-for-field copies of `IssueComment` / `IssueActivityEvent` /
// `IssueActivityLabel` in catalyst-cloud's
// `apps/web/src/lib/mirror-client.ts` (L227-296) — the client-side view of the
// SAME `@catalyst-cloud/read-model` `buildIssueDetail` return this reader runs.
// They are re-declared here rather than imported because the published package
// exports raw `.ts` sources and this file must stay resolvable by the monitor's
// own tsc pass. If the read-model's shape changes, these move with it.

/** A resolved label reference on an activity event. `id` is always present;
 *  `name`/`color` resolve HISTORICALLY (they survive a later label deletion) and
 *  are null when the label id isn't mirrored — never fabricated. */
export interface TicketActivityLabel {
  id: string;
  name: string | null;
  color: string | null;
}

/** One mirrored Linear comment. Ordered oldest-to-newest by `updated_at` (the
 *  timeline's sort key). Author fields are nullable — a pre-backfill or
 *  bot-authored comment may lack them, so the UI falls back rather than invents. */
export interface TicketComment {
  id: string;
  body: string | null;
  author_id: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
  /** 1 when an agent/integration authored it (drives the "agent" marker). */
  is_bot: number | null;
  parent_id: string | null;
  updated_at: number;
}

/** One `issue_history` transition. Ordered by `created_at` (ms epoch). Id-bearing
 *  fields are resolved to display values by the read-model; raw scalars (state
 *  NAMES, priority 0-4, estimate points, title, `due_date` as a "YYYY-MM-DD"
 *  TimelessDate string) and the NULL-PRESERVING booleans (null = untouched,
 *  0 = explicit false, 1 = true) are formatted by the client. Every field is
 *  nullable — null on a from/to pair means this event did not touch that
 *  property. */
export interface TicketActivityEvent {
  id: string;
  created_at: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar_url: string | null;
  from_state: string | null;
  to_state: string | null;
  from_assignee_id: string | null;
  from_assignee_name: string | null;
  to_assignee_id: string | null;
  to_assignee_name: string | null;
  from_priority: number | null;
  to_priority: number | null;
  from_estimate: number | null;
  to_estimate: number | null;
  from_title: string | null;
  to_title: string | null;
  from_cycle_id: string | null;
  from_cycle_number: number | null;
  to_cycle_id: string | null;
  to_cycle_number: number | null;
  from_project_id: string | null;
  from_project_name: string | null;
  to_project_id: string | null;
  to_project_name: string | null;
  from_parent_id: string | null;
  from_parent_identifier: string | null;
  to_parent_id: string | null;
  to_parent_identifier: string | null;
  from_team_id: string | null;
  to_team_id: string | null;
  from_due_date: string | null;
  to_due_date: string | null;
  added_labels: TicketActivityLabel[];
  removed_labels: TicketActivityLabel[];
  updated_description: number | null;
  archived: number | null;
  auto_archived: number | null;
  auto_closed: number | null;
  trashed: number | null;
}

/** The `/api/ticket-discussion/<id>` payload. */
export interface TicketDiscussion {
  /** false when the replica could not be read OR the ticket is not mirrored —
   *  distinct from an available read that simply found no comments/activity, so
   *  the UI never claims "no discussion" about a source it never reached. */
  available: boolean;
  /** The mirrored identifier, or null when unavailable. */
  identifier: string | null;
  /** The mirrored issue title, or null. */
  title: string | null;
  /** Issue creation instant (ms epoch), or null when unavailable/unmirrored. */
  createdAt: number | null;
  /** Comments oldest-first (by `updated_at`); [] when unavailable. */
  comments: TicketComment[];
  /** Activity events oldest-first (by `created_at`); [] when unavailable. */
  activity: TicketActivityEvent[];
}

export interface ReadTicketDiscussionOptions {
  /** Replica path override (default: CATALYST_REPLICA_DB, else
   *  $CATALYST_DIR/catalyst-replica.db, else ~/catalyst/catalyst-replica.db). */
  dbPath?: string;
  /** The server's resolved catalyst dir — takes the place of $CATALYST_DIR in
   *  the default path resolution (a createServer({catalystDir}) install must
   *  not read another installation's replica). */
  catalystDir?: string;
  /** Database opener seam for tests. Must return a bun:sqlite-shaped handle
   *  exposing `query(sql).all(...bindings)` and `close()`. */
  openDb?: (path: string) => {
    query: (sql: string) => { all: (...bindings: unknown[]) => unknown[] };
    close: () => void;
  };
}

/** Read a ticket's Linear comments + activity from the local replica. Never
 *  throws: every failure yields `{ available: false, comments: [], activity: [] }`. */
export function readTicketDiscussion(
  identifier: string,
  opts?: ReadTicketDiscussionOptions,
): Promise<TicketDiscussion>;
