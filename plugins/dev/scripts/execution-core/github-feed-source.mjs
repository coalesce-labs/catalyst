// github-feed-source.mjs — CTL-1929, the replica read layer for the GitHub leg of
// the cloud-feed dispatch producer.
//
// The Linear leg's twin is `linear-feed-source.mjs`. This module is deliberately
// NOT a copy of it, because the tables underneath are a different shape and the
// difference decides the whole design.
//
// ── ⛔ THE STRUCTURAL DIFFERENCE FROM THE LINEAR LEG ────────────────────────
// `linear-feed-source.mjs` reads `issue_history`: an APPEND-ONLY log with a
// PRIMARY KEY, so a keyset over `(created_at, id)` replays the edge sequence
// exactly. **Every GitHub table in the replica is a LAST-STATE PROJECTION**,
// verified against the live schema on mini-2 (2026-08-17):
//
//   pull_requests       PRIMARY KEY (repo_id, number)     — one row per PR
//   pushes              PRIMARY KEY (repo_id, ref)        — one row per ref
//   check_runs          PRIMARY KEY (check_run_id)        — updated in place
//   pr_review_threads   PRIMARY KEY (id)                  — `resolved` flips in place
//   reviews / pr_review_comments / deployments / deployment_statuses — id PK
//
// A row is UPDATED IN PLACE, so `updated_at` is not a log position: a PR that is
// opened and then merged carries one `updated_at`, and a producer keyed on it
// that reads the row after the merge can no longer tell that an `opened` edge
// was ever owed. Keying dispatch on `updated_at` would silently drop transitions.
//
// ── ⭐ WHAT MAKES A LAST-STATE TABLE REPLAYABLE ANYWAY ──────────────────────
// Each edge we emit has its own timestamp column that is written EXACTLY ONCE,
// at the moment that edge happens, and never moves afterwards:
//
//   github.pr.opened                 pull_requests.created_at
//   github.pr.merged                 pull_requests.merged_at
//   github.pr.closed                 pull_requests.closed_at   (merged = 0)
//   github.pr_review.submitted       reviews.submitted_at
//   github.pr_review_comment.created pr_review_comments.created_at
//   github.pr_review_thread.resolved pr_review_threads.resolved_at
//   github.deployment.created        deployments.created_at
//   github.deployment_status.*       deployment_statuses.created_at
//
// Keyed on THOSE columns, each stream is append-only again — the table mutates,
// but the coordinate we page over does not. Population was verified by content on
// mini-2 before this design was built on it, because a NULL in one of these
// columns is a silently skipped dispatch and nothing downstream would say so:
//
//   pull_requests    4230 rows · created_at 4230/4230 · closed_at 4143 · merged_at 3995
//                    · merged=1 rows with a NULL merged_at: **0**
//   reviews          6619 · submitted_at 6619/6619
//   pr_review_comments 10155 · created_at 10155/10155
//   pr_review_threads   32 · resolved=1 32 · resolved_at 32/32 · resolved-but-null: **0**
//   deployments 2 · deployment_statuses 4 — both created_at complete
//
// `REQUIRED_COLUMNS` below is the CI-side half of that check; the live-schema
// conformance test re-runs it against the host replica and reports INCONCLUSIVE
// rather than passing when no replica is present.
//
// ── ⚠️ THE LATE-ARRIVAL HAZARD, AND WHY THE CURSOR IS NOT THE EMIT POSITION ──
// The coordinate is EVENT time; rows appear at INGEST time, which is later and
// out of order. A sweep that advanced its cursor to the newest event time it saw
// would permanently skip any row that lands afterwards carrying an older stamp.
//
// Measured on mini-2, 6 h window, rows whose `updated_at` is inside the window so
// historical backfill cannot flatter the number (n = 62, `synced_at - updated_at`):
//
//   <=5s 21 · <=15s 12 · <=60s 6 · <=120s 11 · <=300s 11 · >300s 1 · max 333s
//
// ⛔ **37% arrive more than 60 s after their own event time, and the tail reaches
// 333 s.** So a settle window wide enough to be safe (>= ~600 s) would delay every
// CI-wait edge by ten minutes — on the one path (`monitor-merge`) where latency is
// the whole point. That trade is refused. Instead the two positions are SPLIT:
//
//   EMIT position   — every row past the cursor is emitted immediately, at replica
//                     speed (median <= 5 s). Latency is not sacrificed.
//   CURSOR position — advanced only to `min(lastKeySeen, now - settleMs)`, so the
//                     window a late row can still land in stays BEHIND the cursor
//                     and is re-read on the next tick rather than skipped.
//
// The cost of that split is re-emission of the rows inside the settle window, and
// it is paid with a stable identity rather than absorbed: every edge id below is
// derived from a PRIMARY KEY plus the edge name, so re-reading a row yields the
// byte-identical id and the seen-set suppresses it. This is the same bargain the
// Linear leg strikes with `issue_history.id` — dedup by primary key is what lets
// an overlapping sweep be a no-op instead of a duplicate storm — reached here from
// the other direction because our tables have no log to key on.
//
// ⚠️ `synced_at - updated_at` OVERSTATES ingestion lag whenever GitHub's
// `updated_at` predates the webhook that carried the row. That is the conservative
// direction for sizing a settle window, so the bound above is an upper bound and
// is used as one. It is not a claim about the median path.
//
// ── ⛔ TWO DECLARED GAPS. NEITHER IS SILENT. ────────────────────────────────
// 1. `github.push` is LOSSY BY SCHEMA. `pushes` is keyed `(repo_id, ref)`, so two
//    pushes to one ref between ticks collapse to one row and the intermediate
//    `before`/`after` pair is unrecoverable — no producer can reconstruct it.
//    Measured: 36 rows in `pushes` against 111 `github.push` events in 3 h.
//    It also has no once-set timestamp, so it is the one stream keyed on the
//    mutable `updated_at`. The consumer is rebase detection (CTL-381), which asks
//    "did this ref move", not "how many times" — so the collapse is survivable.
//    It is declared here rather than discovered later, and `PUSH_IS_LOSSY` exists
//    so a caller can assert on the fact rather than on a comment.
// 2. `github.check_suite.completed` HAS NO STREAM AT ALL. The mirror accepts the
//    `check_suite` payload and deliberately stores no row (`return []`), so there
//    is nothing to page over. `check_runs` holds the constituent data (60,249 rows)
//    but a suite is not reconstructable from it safely: one head sha carried **10
//    distinct `check_suite_id`s** on mini-2, several with runs still incomplete, so
//    "every run I can see has completed" fires early and green on a partial view —
//    a false CI-pass on the merge gate. The derivation is CTC-667 item 4 and is
//    theirs to declare; this module exports the gap as `UNBACKED_EVENT_NAMES`
//    rather than inventing a second answer.

import { Database } from "bun:sqlite";
import { getReplicaDbPath } from "./config.mjs";

/** Default rows per stream per sweep. Bounded so one call can never materialise a table. */
export const DEFAULT_BATCH_LIMIT = 500;

/**
 * How far behind the newest key the durable cursor is held, so a row that arrives
 * late carrying an older stamp is still ahead of it and gets re-read.
 *
 * 600 s = 1.8x the largest lag observed on the live fleet (333 s, see the header).
 * It bounds RE-READ cost, never emission latency — emission does not wait for it.
 */
export const DEFAULT_SETTLE_MS = 600_000;

/**
 * Consumed `github.*` names with no replica stream behind them. Exported so a
 * caller can refuse to claim coverage it does not have, and so the parity ledger
 * can account for them as EXPECTED absences instead of as unexplained diffs.
 */
export const UNBACKED_EVENT_NAMES = Object.freeze(["github.check_suite.completed"]);

/** `github.push` cannot be replayed faithfully. See gap (1) in the header. */
export const PUSH_IS_LOSSY = true;

/**
 * The streams, in the order a sweep should read them.
 *
 * `tsCol` is the once-set edge timestamp (the keyset's major coordinate).
 * `idExpr` is SQL yielding a value that is UNIQUE within the stream — it is both
 * the keyset tie-break and the dedup identity, which is why it must come from a
 * PRIMARY KEY and never from a mutable column.
 *
 * ⚠️ `repo_id || '#' || number` is a TEXT ordering over an integer, so `#10` sorts
 * before `#9`. That is deliberate and harmless: the tie-break only has to be a
 * TOTAL order over rows sharing one millisecond, not a meaningful one. What it
 * must never be is non-unique, and `(repo_id, number)` is the table's PRIMARY KEY.
 */
export const STREAMS = Object.freeze([
  {
    key: "prOpened",
    event: "github.pr.opened",
    table: "pull_requests",
    tsCol: "created_at",
    idExpr: "repo_id || '#' || number",
    where: null,
  },
  {
    key: "prMerged",
    event: "github.pr.merged",
    table: "pull_requests",
    tsCol: "merged_at",
    idExpr: "repo_id || '#' || number",
    // `merged_at IS NOT NULL` is implied by the keyset (NULL never compares > a
    // number) but is stated so the index can be used and the intent is readable.
    where: "merged_at IS NOT NULL",
  },
  {
    key: "prClosed",
    event: "github.pr.closed",
    table: "pull_requests",
    tsCol: "closed_at",
    idExpr: "repo_id || '#' || number",
    // ⛔ A MERGED PR IS NOT A CLOSED PR on this path. GitHub closes a PR when it
    // merges, so `closed_at` is set on both; the webhook producer emits
    // `github.pr.merged` for one and `github.pr.closed` for the other, never both.
    // Live counts on mini-2 over 3 h agree (merged 22, closed 3) — without this
    // predicate the feed would emit a spurious `closed` for every merge and the
    // PR-lifecycle router would see a close it never sees today.
    where: "closed_at IS NOT NULL AND (merged IS NULL OR merged = 0)",
  },
  {
    key: "reviewSubmitted",
    event: "github.pr_review.submitted",
    table: "reviews",
    tsCol: "submitted_at",
    idExpr: "review_id",
    where: null,
  },
  {
    key: "reviewCommentCreated",
    event: "github.pr_review_comment.created",
    table: "pr_review_comments",
    tsCol: "created_at",
    idExpr: "id",
    // A comment removed after the fact is not un-created; the edge still happened
    // and its webhook twin was delivered. `removed_at` is carried in the row for
    // the envelope, not used to filter the stream.
    where: null,
  },
  {
    key: "threadResolved",
    event: "github.pr_review_thread.resolved",
    table: "pr_review_threads",
    tsCol: "resolved_at",
    idExpr: "id",
    where: "resolved = 1 AND resolved_at IS NOT NULL",
  },
  {
    key: "deploymentCreated",
    event: "github.deployment.created",
    table: "deployments",
    tsCol: "created_at",
    idExpr: "id",
    where: null,
  },
  {
    key: "deploymentStatus",
    // The action is per-row (`state`), so the name is resolved by the event
    // builder rather than fixed here; this is the one stream whose event name is
    // not a constant.
    event: null,
    table: "deployment_statuses",
    tsCol: "created_at",
    idExpr: "id",
    where: null,
  },
  {
    key: "push",
    event: "github.push",
    table: "pushes",
    // ⛔ The one mutable coordinate in this table — see gap (1). `pushes` has no
    // once-set column because the row IS the ref's current head.
    tsCol: "updated_at",
    idExpr: "repo_id || '@' || ref",
    where: null,
    lossy: true,
  },
]);

/** Stream lookup by key, so callers name a stream instead of indexing an array. */
export const STREAM_BY_KEY = Object.freeze(
  Object.fromEntries(STREAMS.map((s) => [s.key, s])),
);

/**
 * Columns this module reads, per table. Checked against the live replica by
 * `github-feed-source.test.mjs`, which reports INCONCLUSIVE — never PASS — when
 * no replica is present. A missing column here is a stream that silently returns
 * nothing, which is the failure this list exists to make loud.
 */
export const REQUIRED_COLUMNS = Object.freeze({
  pull_requests: [
    "repo_id", "number", "state", "draft", "merged", "merged_at", "head_sha",
    "base_ref", "head_ref", "title", "author_login", "created_at", "closed_at",
    "updated_at", "linear_issue_identifier",
  ],
  reviews: ["repo_id", "pr_number", "review_id", "user_id", "state", "submitted_at", "body"],
  pr_review_comments: [
    "id", "repo_id", "pr_number", "review_id", "path", "line", "in_reply_to_id",
    "author_id", "body", "created_at", "updated_at", "removed_at",
  ],
  pr_review_threads: [
    "id", "repo_id", "pr_number", "resolved", "resolved_at", "resolver_id",
    "first_comment_id", "comment_count", "updated_at",
  ],
  deployments: [
    "id", "repo_id", "ref", "sha", "task", "environment", "production_environment",
    "description", "creator_id", "created_at",
  ],
  deployment_statuses: [
    "id", "repo_id", "deployment_id", "state", "environment", "target_url",
    "environment_url", "description", "creator_id", "created_at",
  ],
  pushes: [
    "repo_id", "ref", "before", "after", "forced", "created", "deleted",
    "base_ref", "pusher_id", "head_commit_sha", "updated_at",
  ],
});

/**
 * Build one stream's keyset query.
 *
 * The comparison is the standard keyset form and the reasoning is the Linear leg's
 * verbatim, because the hazard is a property of SQL and not of Linear:
 *   `ts >  last`  skips every same-millisecond sibling not yet read when the batch
 *                 was cut — a silently dropped dispatch edge;
 *   `ts >= last`  re-reads the whole millisecond forever, and wedges permanently if
 *                 one timestamp ever holds more rows than the batch limit.
 */
export function buildStreamQuery(stream) {
  const s = typeof stream === "string" ? STREAM_BY_KEY[stream] : stream;
  if (!s) throw new Error(`buildStreamQuery: unknown stream ${String(stream)}`);
  const extra = s.where ? `(${s.where}) AND ` : "";
  return `
    SELECT *, ${s.tsCol} AS __ts, ${s.idExpr} AS __id
    FROM ${s.table}
    WHERE ${extra}(
      (${s.tsCol} > $sinceMs)
      OR (${s.tsCol} = $sinceMs AND ${s.idExpr} > $sinceId)
    )
    ORDER BY ${s.tsCol} ASC, ${s.idExpr} ASC
    LIMIT $limit
  `;
}

/**
 * The position AFTER a page of rows: the keyset coordinate of its last row.
 *
 * ⛔ Returns `null` for an empty page. Advancing on an empty read is exactly how a
 * producer skips a row that arrives a moment later carrying an equal timestamp.
 */
export function positionAfter(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const ts = last?.__ts;
  if (!Number.isInteger(ts)) return null;
  return { lastCreatedAt: ts, lastId: typeof last.__id === "string" ? last.__id : String(last.__id ?? "") };
}

/**
 * Compare two keyset positions. Total order, matching the SQL `ORDER BY ts, id`.
 */
function keyCmp(a, b) {
  if (a.lastCreatedAt !== b.lastCreatedAt) return a.lastCreatedAt < b.lastCreatedAt ? -1 : 1;
  const ai = typeof a.lastId === "string" ? a.lastId : "";
  const bi = typeof b.lastId === "string" ? b.lastId : "";
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}

/**
 * Hold the durable cursor behind the newest key the sweep may safely claim.
 *
 * ⭐ This is the emit/cursor split from the header, isolated as a pure function so it
 * can be asserted on directly. `emitted` is where the sweep actually GOT to; the
 * return value is all it is allowed to WRITE DOWN. Everything between the two is
 * re-read next tick, and that gap is precisely what turns a late arrival into a
 * duplicate (which the seen-set absorbs) instead of a permanent loss (which nothing
 * would report).
 *
 * Two cases:
 *   - the page ended at or before the horizon → claim it exactly; we have provably
 *     seen everything up to there, and there is no reason to hold back further.
 *   - the page ended PAST the horizon → we necessarily read every row at or before
 *     the horizon, so claim the HORIZON ITSELF and leave the late-arrival window
 *     open behind us. Claiming `emitted` here is the bug this function exists to
 *     prevent; refusing to advance at all is the other one, and would wedge the
 *     cursor permanently on a busy repo where every page ends inside the window.
 *
 * ⛔ The cursor NEVER moves backwards. A clock step, a shortened settle window, or a
 * sparse page must not re-open a window already closed — the seen-set is bounded and
 * may since have evicted those ids, so a backward step is a duplicate storm.
 */
export function settleCursor(emitted, { now, settleMs = DEFAULT_SETTLE_MS, previous = null } = {}) {
  if (!Number.isInteger(now)) throw new Error("settleCursor: now must be an integer epoch-ms");
  const bound = Number.isInteger(settleMs) && settleMs >= 0 ? settleMs : DEFAULT_SETTLE_MS;
  const horizon = now - bound;
  const prev = previous && Number.isInteger(previous.lastCreatedAt)
    ? { lastCreatedAt: previous.lastCreatedAt, lastId: typeof previous.lastId === "string" ? previous.lastId : "" }
    : null;

  let claim;
  if (!emitted || !Number.isInteger(emitted.lastCreatedAt)) {
    // No usable page. The cursor may still advance to the horizon if we are already
    // past it — but only when we HAVE a previous position, because a producer that
    // has never read anything must not claim a window it never looked at.
    claim = prev && prev.lastCreatedAt < horizon ? { lastCreatedAt: horizon, lastId: "" } : null;
  } else if (emitted.lastCreatedAt <= horizon) {
    claim = { lastCreatedAt: emitted.lastCreatedAt, lastId: typeof emitted.lastId === "string" ? emitted.lastId : "" };
  } else {
    claim = { lastCreatedAt: horizon, lastId: "" };
  }

  if (!claim) return prev;
  if (!prev) return claim;
  return keyCmp(claim, prev) > 0 ? claim : prev;
}

/**
 * A read-only handle over the replica.
 *
 * Deliberately a separate handle from `createReplicaReader`'s: that one exposes
 * domain methods, not a general query surface, and WAL exists precisely so
 * concurrent readers do not contend.
 */
export function createGithubFeedSource({ dbPath = getReplicaDbPath(), limit = DEFAULT_BATCH_LIMIT } = {}) {
  let db = null;
  const open = () => {
    if (db) return db;
    db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
    return db;
  };

  /**
   * Page one stream. Coerces defensively: a non-integer `lastCreatedAt` reads as 0
   * and a non-string `lastId` as "" — and "" sorts before every id, so a cold start
   * is inclusive of its own instant rather than one row short of it.
   */
  const page = (streamKey, position, batchLimit) => {
    const sinceMs = Number.isInteger(position?.lastCreatedAt) ? position.lastCreatedAt : 0;
    const sinceId = typeof position?.lastId === "string" ? position.lastId : "";
    const lim = Number.isInteger(batchLimit) && batchLimit > 0 ? batchLimit : limit;
    return open()
      .prepare(buildStreamQuery(streamKey))
      .all({ $sinceMs: sinceMs, $sinceId: sinceId, $limit: lim });
  };

  return {
    /** Rows of a named stream strictly after `position`, oldest first. */
    rowsSince: (streamKey, position, batchLimit) => page(streamKey, position, batchLimit),
    /** Every stream key, in sweep order. */
    streamKeys: () => STREAMS.map((s) => s.key),
    positionAfter,
    /**
     * `PRAGMA table_info` for a table, so a caller can verify REQUIRED_COLUMNS
     * against the schema actually on disk rather than against this file's belief.
     */
    columnsOf: (table) => open().prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name),
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
