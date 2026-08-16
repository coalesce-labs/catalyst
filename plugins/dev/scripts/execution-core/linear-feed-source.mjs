// linear-feed-source.mjs — CTL-1847, the replica-join read layer for the
// cloud-feed dispatch producer.
//
// The feed says WHEN (a `LiveSyncClient` frame applied for `issue_history` /
// `comments`); this module says WHAT — it reads the edge and resolves the scoping
// fields the dispatch envelope needs, entirely from the local replica. **Zero
// Linear API calls on the event path.** That is not an optimisation: the envelope
// `orch-monitor/lib/linear-webhook-handler.ts` emits is deliberately fat because,
// in CTL-681's own words, the thinner one "dropped these and forced a full poll per
// event". A producer that resolved scoping over the network would reintroduce
// exactly that cost while looking like a working cutover.
//
// ── ⚠️ KEYSET PAGINATION, NOT A TIMESTAMP WATERMARK ─────────────────────────
// `issue_history.created_at` is NOT unique — several rows routinely share one
// millisecond (a single Linear update writes several history rows). A cursor that
// stores only `lastCreatedAt` has no safe comparison:
//   `created_at > last`  skips every same-millisecond sibling that hadn't been read
//                        when the batch was cut — a silently dropped dispatch edge;
//   `created_at >= last` re-reads the whole millisecond forever, and if a single
//                        timestamp ever holds more rows than the batch limit the
//                        producer wedges, re-reading the same page for good.
// So the cursor is the COMPOSITE `(created_at, id)` and the comparison is the
// standard keyset form. `id` is a PRIMARY KEY, so the ordering is total and the
// pagination is exact — no skips, no repeats, and no dependence on how many rows
// happen to share a timestamp. This is why `linear-feed-cursor.mjs` carries
// `lastId` beside `lastCreatedAt` rather than a bare watermark.
//
// Read-only handle, and a separate one from `createReplicaReader`'s on purpose:
// that reader exposes domain methods (terminal state, freshness, batch identity
// reads), not a general query surface, and WAL exists precisely so concurrent
// readers don't contend.

import { Database } from "bun:sqlite";
import { getReplicaDbPath } from "./config.mjs";

/** Default rows per sweep. Bounded so one call can never materialise the table. */
export const DEFAULT_BATCH_LIMIT = 500;

// The edge, joined to its scoping rows. Mirrors the webhook envelope field-for-field
// so shadow-parity can diff the two producers directly.
//
// `toLabels` is resolved as a correlated subquery rather than a JOIN + GROUP BY:
// grouping would collapse the history rows themselves (an issue with three labels
// would otherwise multiply into three edge rows, and a naive DISTINCT would then
// hide it).
const EDGE_SELECT = `
  SELECT
    h.id                AS id,
    h.issue_id          AS issue_id,
    h.actor_id          AS actor_id,
    h.created_at        AS created_at,
    h.from_state        AS from_state,
    h.to_state          AS to_state,
    h.from_assignee_id  AS from_assignee_id,
    h.to_assignee_id    AS to_assignee_id,
    h.from_priority     AS from_priority,
    h.to_priority       AS to_priority,
    h.from_estimate     AS from_estimate,
    h.to_estimate       AS to_estimate,
    h.from_project_id   AS from_project_id,
    h.to_project_id     AS to_project_id,
    h.from_cycle_id     AS from_cycle_id,
    h.to_cycle_id       AS to_cycle_id,
    h.from_parent_id    AS from_parent_id,
    h.to_parent_id      AS to_parent_id,
    h.from_team_id      AS from_team_id,
    h.to_team_id        AS to_team_id,
    h.from_title        AS from_title,
    h.to_title          AS to_title,
    h.from_due_date     AS from_due_date,
    h.to_due_date       AS to_due_date,
    h.updated_description AS updated_description,
    h.added_label_ids   AS added_label_ids,
    h.removed_label_ids AS removed_label_ids,
    i.id                AS issue__id,
    i.identifier        AS issue__identifier,
    i.team_key          AS issue__team_key,
    i.description       AS issue__description,
    i.estimate          AS issue__estimate,
    i.delegate_id       AS issue__delegate_id,
    i.project_id        AS issue__project_id,
    u.name              AS actor__name,
    au.name             AS assignee__name,
    p.name              AS project__name,
    (SELECT group_concat(l.name, char(31))
       FROM issue_labels il JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id = h.issue_id)          AS labels__joined
  FROM issue_history h
  JOIN issues   i  ON i.id  = h.issue_id
  LEFT JOIN users    u  ON u.id  = h.actor_id
  LEFT JOIN users    au ON au.id = h.to_assignee_id
  LEFT JOIN projects p  ON p.id  = COALESCE(h.to_project_id, i.project_id)
  WHERE (h.created_at > $sinceMs)
     OR (h.created_at = $sinceMs AND h.id > $sinceId)
  ORDER BY h.created_at ASC, h.id ASC
  LIMIT $limit
`;

// ⚠️ Column names here are the REPLICA's, verified against the live schema — not
// inferred from the builder. The first cut of this query selected `c.user_id` and a
// `users` join for the author name; the real table has `author_id`, `author_name`
// and `is_bot` ON THE ROW, so it failed with `no such column` the first time it ran
// against a real database. The unit fixture had declared `user_id` because THIS
// QUERY assumed it, so the test could only ever agree with the mistake. See the
// schema-conformance test, which now checks these names against the real replica.
const COMMENT_SELECT = `
  SELECT
    c.id          AS id,
    c.issue_id    AS issue_id,
    c.body        AS body,
    c.created_at  AS created_at,
    c.author_id   AS author_id,
    c.is_bot      AS is_bot,
    c.author_name AS author__name,
    i.id          AS issue__id,
    i.identifier  AS issue__identifier,
    i.team_key    AS issue__team_key
  FROM comments c
  JOIN issues i ON i.id = c.issue_id
  WHERE (c.created_at > $sinceMs)
     OR (c.created_at = $sinceMs AND c.id > $sinceId)
  ORDER BY c.created_at ASC, c.id ASC
  LIMIT $limit
`;


// The issues-diff edge source (CTL-1847). Same keyset discipline as the history
// query — `issues.updated_at` is no more unique than `issue_history.created_at`, so
// a timestamp-only watermark would skip same-millisecond siblings or re-read them
// forever. Column names verified against the live replica, not inferred.
const ISSUE_SELECT = `
  SELECT
    i.id           AS id,
    i.identifier   AS identifier,
    i.team_key     AS team_key,
    i.state        AS state,
    i.assignee_id  AS assignee_id,
    i.priority     AS priority,
    i.estimate     AS estimate,
    i.project_id   AS project_id,
    i.cycle_id     AS cycle_id,
    i.parent_id    AS parent_id,
    i.team_id      AS team_id,
    i.title        AS title,
    i.due_date     AS due_date,
    i.delegate_id  AS delegate_id,
    i.description  AS description,
    i.updated_at   AS updated_at,
    p.name         AS project__name,
    (SELECT group_concat(l.name, char(31))
       FROM issue_labels il JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id = i.id)   AS labels__joined
  FROM issues i
  LEFT JOIN projects p ON p.id = i.project_id
  WHERE (i.updated_at > $sinceMs)
     OR (i.updated_at = $sinceMs AND i.id > $sinceId)
  ORDER BY i.updated_at ASC, i.id ASC
  LIMIT $limit
`;

/** Every column this module reads, per table — asserted against the live replica. */
export const REQUIRED_COLUMNS = Object.freeze({
  issue_history: [
    "id", "issue_id", "actor_id", "created_at", "from_state", "to_state",
    "from_assignee_id", "to_assignee_id", "from_priority", "to_priority",
    "from_estimate", "to_estimate", "from_project_id", "to_project_id",
    "from_cycle_id", "to_cycle_id", "from_parent_id", "to_parent_id",
    "from_team_id", "to_team_id", "from_title", "to_title",
    "from_due_date", "to_due_date", "updated_description",
    "added_label_ids", "removed_label_ids",
  ],
  issues: ["id", "identifier", "team_key", "description", "estimate", "delegate_id", "project_id",
    "state", "assignee_id", "priority", "cycle_id", "parent_id", "team_id", "title", "due_date", "updated_at"],
  comments: ["id", "issue_id", "body", "created_at", "author_id", "author_name", "is_bot"],
  users: ["id", "name"],
  projects: ["id", "name"],
  labels: ["id", "name"],
  issue_labels: ["issue_id", "label_id"],
});

// group_concat with the default "," separator would be ambiguous — a Linear label
// may legitimately contain a comma. ASCII Unit Separator (0x1F) cannot appear in a
// label name, so the split is unambiguous.
const LABEL_SEP = String.fromCharCode(31);


/** Shape an issues row for the diff path: the row itself plus its labels. */
export function shapeIssueRow(row) {
  if (!row || typeof row !== "object") return null;
  const issue = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "labels__joined" || k === "project__name") continue;
    issue[k] = v;
  }
  return {
    issue,
    project: row.project__name ? { name: row.project__name } : null,
    labels:
      typeof row.labels__joined === "string" && row.labels__joined !== ""
        ? row.labels__joined.split(LABEL_SEP)
        : [],
  };
}

/** Split the flat `alias__field` row into the nested shape the builder expects. */
export function shapeEdgeRow(row) {
  if (!row || typeof row !== "object") return null;
  const history = {};
  const issue = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("issue__")) issue[k.slice(7)] = v;
    else if (k.startsWith("actor__") || k.startsWith("assignee__") || k.startsWith("project__")) continue;
    else if (k === "labels__joined") continue;
    else history[k] = v;
  }
  return {
    history,
    issue,
    actor: row.actor__name ? { name: row.actor__name } : null,
    assignee: row.assignee__name ? { name: row.assignee__name } : null,
    project: row.project__name ? { name: row.project__name } : null,
    labels: typeof row.labels__joined === "string" && row.labels__joined !== ""
      ? row.labels__joined.split(LABEL_SEP)
      : [],
  };
}

export function shapeCommentRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    comment: {
      id: row.id, issue_id: row.issue_id, body: row.body,
      author_id: row.author_id, is_bot: row.is_bot, created_at: row.created_at,
    },
    issue: { id: row.issue__id, identifier: row.issue__identifier, team_key: row.issue__team_key },
    author: row.author__name ? { name: row.author__name } : null,
  };
}

/**
 * Open a read-only view of the replica for the producer.
 *
 * `position` is the composite `{ lastCreatedAt, lastId }` from
 * `linear-feed-cursor.mjs`; `lastId` may be null on a cold start or reset, in which
 * case the tie-break degenerates harmlessly (no row has an id less than "").
 */
export function createFeedSource({ dbPath = getReplicaDbPath(), limit = DEFAULT_BATCH_LIMIT } = {}) {
  let db = null;
  const open = () => {
    if (db) return db;
    db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
    return db;
  };

  const page = (sql, position, shape, batchLimit) => {
    const sinceMs = Number.isInteger(position?.lastCreatedAt) ? position.lastCreatedAt : 0;
    const sinceId = typeof position?.lastId === "string" ? position.lastId : "";
    const rows = open()
      .prepare(sql)
      .all({ $sinceMs: sinceMs, $sinceId: sinceId, $limit: batchLimit ?? limit });
    return rows.map(shape).filter(Boolean);
  };

  return {
    /** Edges strictly after `position`, oldest first. */
    edgesSince(position, batchLimit) {
      return page(EDGE_SELECT, position, shapeEdgeRow, batchLimit);
    },
    /** Issue rows whose `updated_at` is strictly after `position`, oldest first. */
    issuesSince(position, batchLimit) {
      return page(ISSUE_SELECT, position, shapeIssueRow, batchLimit);
    },
    /** Comment rows strictly after `position`, oldest first. */
    commentsSince(position, batchLimit) {
      return page(COMMENT_SELECT, position, shapeCommentRow, batchLimit);
    },
    /**
     * The composite cursor to persist after processing `items`. Returns null for an
     * empty page so the caller never advances past nothing — advancing on an empty
     * read is how a producer skips rows that arrive a moment later with an equal
     * timestamp.
     */
    positionAfter(items) {
      if (!Array.isArray(items) || items.length === 0) return null;
      const last = items[items.length - 1];
      // Accepts all three row shapes: a history edge, a comment, or an issues-diff
      // row (whose watermark is `updated_at`, not `created_at`).
      const row = last?.history ?? last?.comment ?? (last?.issue ? { id: last.issue.id, created_at: last.issue.updated_at } : null);
      if (!row || !Number.isInteger(row.created_at) || typeof row.id !== "string") return null;
      return { lastCreatedAt: row.created_at, lastId: row.id };
    },
    close() {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
      db = null;
    },
  };
}
