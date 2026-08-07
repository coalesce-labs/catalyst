// linear-thread.mjs — the parked ticket's conversation, read from the REPLICA
// (CTL-1569 §2 / §3). Zero Linear API calls, by construction.
//
// WHY THE REPLICA IS NON-NEGOTIABLE HERE: the inbox renders a thread per selected
// row, and the operator clicks through rows quickly. A per-row Linear read would
// put an API call on a hover-speed path against a SHARED, rate-limited fleet quota
// (the fleet had an active 429 problem the week this shipped). The replica
// (`~/catalyst/catalyst-replica.db`) already mirrors every comment in real time —
// `comments(id, issue_id, body, updated_at, created_at, removed_at, author_id,
// author_name, author_avatar_url, is_bot, parent_id)` — so one indexed local SELECT
// serves the whole thread at sub-ms cost. (The agent/human split §2 requires needs
// MORE than the `is_bot` column, though — see normalizeComment.)
//
// NEWEST FIRST (§2, deliberate and load-bearing): the agent's question is almost
// always the newest comment and the operator's prior reply the one before it.
// Chronological order buries both under history the operator has already read, so
// this module returns reverse-chronological and the UI renders in that order.
//
// FAIL-OPEN, ALWAYS: the inbox must never break or hang because the replica is
// absent, locked, mid-migration, or on a node that doesn't run the sync writer.
// Every failure degrades to an EMPTY thread (`available:false`), never a throw —
// the row still renders, still links to Linear, and still accepts a reply. An
// empty thread and an unavailable thread are reported DISTINCTLY so the UI can say
// "no comments yet" vs stay silent about a source it couldn't read.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `bun:sqlite` is reached through a COMPUTED specifier for the same reason
// linear-cache-reader.mjs does it for replica-read.mjs: a static specifier would
// let esbuild pull sqlite into a browser bundle through the shared module graph.
// We open our own read-only handle rather than borrowing execution-core's
// createReplicaReader — that reader exposes a fixed set of dispatch-path queries
// (terminal lookup / titles / freshness) and no general query seam, so reusing it
// would mean widening a correctness-path module for a display read.
const SQLITE_MODULE = ["bun", "sqlite"].join(":");

const HOME = homedir();

/** Default replica path, honoring the same env overrides as the rest of the tree. */
export function defaultReplicaDbPath() {
  if (process.env.CATALYST_REPLICA_DB) return process.env.CATALYST_REPLICA_DB;
  return join(process.env.CATALYST_DIR || join(HOME, "catalyst"), "catalyst-replica.db");
}

/** How many comments the pane shows by default — "the last few" (§2), not the
 *  whole history. Deep history lives in Linear, one click away. */
export const DEFAULT_THREAD_LIMIT = 8;

/** How deep to scan for an ASK candidate, independent of how many comments are
 *  DISPLAYED. Still bounded (one indexed local query), but wide enough that a run
 *  of human replies or GitHub chatter cannot hide the agent's question. */
export const ASK_SCAN_LIMIT = 40;

/** Bodies longer than this are marked `truncated` so the UI can clamp them with
 *  expand-in-place (§2) instead of letting one wall of agent prose own the pane.
 *  The FULL body is still sent — expansion must not need a second round trip. */
const LONG_BODY_CHARS = 600;

/**
 * Normalize one replica comment row into the closed shape the UI consumes.
 *
 * ── the agent/human split is NOT just `is_bot` ────────────────────────────────
 * CTL-1569 assumed `is_bot` "gives the agent/human split for free". Verified
 * against the live replica, it does not — `is_bot = 1` is set only for INTEGRATION
 * authors, which have a null `author_id`:
 *
 *     author_id                             author_name             is_bot   n
 *     2edb25eb-…  (the human operator)      Ryan Rozich             0     3131
 *     null                                  GitHub                  1     1420
 *     7b5480e0-…  (the WORKER app actor)    Catalyst                0      410
 *     null                                  Linear                  1      126
 *     ff78d890-…  (the ORCHESTRATOR actor)  Catalyst Orchestrator    0        4
 *
 * Linear models an app actor as a USER, so the Catalyst agents' own comments —
 * precisely the ones whose question the operator is answering — arrive with
 * `is_bot = 0`. Trusting `is_bot` alone renders every agent comment as if the
 * operator wrote it, and makes the "newest agent comment" ask fallback select the
 * operator's own words.
 *
 * So the split is `is_bot` OR a known app-actor `author_id`. That is the SAME
 * discriminator the daemon's self-echo guard uses (`catalyst.…bot.*.botUserId`),
 * which keeps one definition of "the agent" across the system.
 *
 * A null/unknown `is_bot` with an unrecognized author falls to HUMAN — the
 * conservative direction for a display split, and consistent with CTL-1567's own
 * fail-open posture toward unidentified authors.
 */
export function normalizeComment(row, { botUserIds = new Set() } = {}) {
  if (!row || typeof row !== "object") return null;
  const body = typeof row.body === "string" ? row.body : "";
  const id = row.id != null ? String(row.id) : null;
  if (id == null) return null;
  const authorId = row.author_id != null ? String(row.author_id) : null;

  // THREE actor classes, not two. An earlier cut collapsed these to a boolean and
  // it produced a visibly wrong ask: GitHub's "this thread is synced to a
  // corresponding GitHub issue" notice was classed as the AGENT, so it became the
  // derived ask summary — the inbox told the operator that a sync notice was the
  // question they needed to answer.
  //
  //   integration — GitHub / Linear plumbing (is_bot=1, null author_id). Shown in
  //                 the thread for context, but it never speaks FOR the agent and
  //                 is never an ask candidate.
  //   agent       — a Catalyst app actor (a configured botUserId). The one whose
  //                 question the operator is actually answering.
  //   human       — everyone else, including the operator.
  const isIntegration = (row.is_bot === 1 || row.is_bot === true) && authorId == null;
  const isCatalystAgent = authorId != null && botUserIds.has(authorId);

  return {
    id,
    body,
    // The agent/human split the UI renders visibly distinct (§2). An integration
    // comment counts as non-human for styling (the operator didn't write it) …
    isAgent: isCatalystAgent || isIntegration,
    // … but `isCatalystAgent` is the narrow signal the ask derivation uses, so
    // plumbing chatter can never masquerade as the agent's question.
    isCatalystAgent,
    isIntegration,
    authorName:
      typeof row.author_name === "string" && row.author_name !== ""
        ? row.author_name
        : isCatalystAgent || isIntegration
          ? "agent"
          : "you",
    authorAvatarUrl:
      typeof row.author_avatar_url === "string" && row.author_avatar_url !== ""
        ? row.author_avatar_url
        : null,
    // Epoch ms as stored by the sync writer; null when absent (the UI omits the
    // timestamp rather than fabricating one).
    at: Number.isFinite(row.updated_at)
      ? row.updated_at
      : Number.isFinite(row.created_at)
        ? row.created_at
        : null,
    parentId: row.parent_id != null ? String(row.parent_id) : null,
    truncated: body.length > LONG_BODY_CHARS,
  };
}

/**
 * Build the thread SELECT for the columns this replica ACTUALLY has.
 *
 * `comments.created_at` is NOT universal. The committed replica fixture
 * (execution-core/linear-cli.test.mjs) defines `comments` without it, and any
 * installation at that schema version behaves the same way. Naming the column
 * unconditionally makes SQLite raise `no such column: c.created_at`, which
 * readTicketThread catches as a replica failure — so the whole conversation
 * surface (thread AND the Linear deep link) silently disappears rather than
 * degrading. Probing `PRAGMA table_info` is one cheap local call and keeps the
 * feature working across schema versions.
 *
 * Newest-first, tombstones excluded, bounded by LIMIT. Joins through
 * `issues.identifier` so callers pass the human key and never the issue UUID.
 */
export function buildThreadSql({ hasCreatedAt }) {
  const createdCol = hasCreatedAt ? "c.created_at" : "NULL AS created_at";
  const order = hasCreatedAt ? "COALESCE(c.updated_at, c.created_at)" : "c.updated_at";
  return `
  SELECT c.id, c.body, c.updated_at, ${createdCol},
         c.author_id, c.author_name, c.author_avatar_url, c.is_bot, c.parent_id
    FROM comments c
    JOIN issues i ON i.id = c.issue_id
   WHERE i.identifier = ?
     AND i.removed_at IS NULL
     AND c.removed_at IS NULL
   ORDER BY ${order} DESC, c.id DESC
   LIMIT ?
`;
}

/** Does this replica's `comments` table carry `created_at`? Fail-safe: any probe
 *  problem answers "no", which yields the narrower query that always works. */
export function commentsHasCreatedAt(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(comments)").all() ?? [];
    return cols.some((c) => c?.name === "created_at");
  } catch {
    return false;
  }
}

/** The ticket's own Linear URL + title, for the "link straight to the ticket"
 *  requirement (§3). Read from the same local DB in the same open. */
const ISSUE_SQL = `
  SELECT identifier, title, url FROM issues
   WHERE identifier = ? AND removed_at IS NULL LIMIT 1
`;

/**
 * Read a ticket's thread (newest first) + its Linear URL from the replica.
 *
 * Returns, ALWAYS (never throws):
 *   {
 *     ticket, available: boolean, comments: [...], url: string|null,
 *     title: string|null, lastAgentComment: string|null, reason: string|null
 *   }
 *
 * `available:false` + `reason` means the replica could not be read — the caller
 * renders the thread section silently absent, which is honest, instead of showing
 * "no comments" for a source it never reached. `available:true` with an empty
 * `comments` array is the genuine "nothing said yet" case.
 *
 * `lastAgentComment` is lifted here because it is the ask-derivation fallback
 * input (inbox-ask.mjs::askFromComment) and this is the one place that already has
 * the ordered thread — re-scanning it downstream would duplicate the ordering rule.
 *
 * `openDb` is injectable so the whole contract is unit-tested with no real DB.
 */
export async function readTicketThread(
  ticket,
  {
    dbPath = defaultReplicaDbPath(),
    limit = DEFAULT_THREAD_LIMIT,
    openDb = null,
    /** App-actor user ids whose comments are the AGENT's — see normalizeComment.
     *  Defaults to empty, which degrades to `is_bot`-only classification; the
     *  composition layer passes the configured set. */
    botUserIds = new Set(),
  } = {},
) {
  const empty = (reason) => ({
    ticket,
    available: false,
    comments: [],
    url: null,
    title: null,
    agentComments: [],
    allAgentComments: [],
    lastAgentComment: null,
    issueExists: false,
    reason,
  });

  if (typeof ticket !== "string" || ticket.trim() === "") return empty("no-ticket");

  // File-presence gate (skipped when a test injects a reader — the fake IS the DB).
  if (!openDb) {
    try {
      if (!existsSync(dbPath)) return empty("replica-absent");
    } catch {
      return empty("replica-unreadable");
    }
  }

  let db = null;
  try {
    if (openDb) {
      db = openDb({ dbPath });
    } else {
      const { Database } = await import(SQLITE_MODULE);
      db = new Database(dbPath, { readonly: true });
      // Readonly + WAL: writers never block readers, but a checkpoint can hold the
      // lock briefly — wait a beat rather than failing the read (same posture and
      // timeout as execution-core/replica-read.mjs).
      db.run("PRAGMA busy_timeout = 250");
    }
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_THREAD_LIMIT;
    const sql = buildThreadSql({ hasCreatedAt: commentsHasCreatedAt(db) });
    // Scan a WIDER window than we display. The display limit is "the last few"
    // (§2), but the ask fallback needs the newest CATALYST-AGENT comment — and on a
    // ticket whose recent entries are all human replies or integration chatter, the
    // agent's question sits just outside the display window. Limiting first would
    // report "no ask" while the replica plainly holds one.
    const scanRows = db.prepare(sql).all(ticket, Math.max(bounded, ASK_SCAN_LIMIT)) ?? [];
    const rows = scanRows.slice(0, bounded);
    const issue = db.prepare(ISSUE_SQL).get(ticket) ?? null;

    const comments = (Array.isArray(rows) ? rows : [])
      .map((r) => normalizeComment(r, { botUserIds }))
      .filter(Boolean);
    // Ask candidates come from the WIDE scan, not the displayed slice.
    const scanned = (Array.isArray(scanRows) ? scanRows : [])
      .map((r) => normalizeComment(r, { botUserIds }))
      .filter(Boolean);
    // The thread is already newest-first, so these stay newest-first too. The full
    // ORDERED list is surfaced (not just the newest) because the ask derivation has
    // to skip content-free escalation notices — see inbox-ask.mjs::pickAskComment.
    //
    // Filtered on `isCatalystAgent`, NOT `isAgent`: integration plumbing (a GitHub
    // sync notice, a Linear automation note) is not the agent asking anything, and
    // letting it into this list makes it the derived ask.
    // ANSWERED-TURN BOUNDARY. Human turns are filtered out of `agentComments`, so
    // the ranked candidate pick has no way to tell a question the operator ALREADY
    // answered from the current one — and class-first ranking would happily promote
    // an older approval question over a newer blocker, prompting the operator to
    // re-answer the previous cycle. Only agent comments NEWER than the operator's
    // most recent reply are live candidates. (If the operator never replied, every
    // agent comment is live.)
    const lastHumanIdx = scanned.findIndex((c) => !c.isAgent);
    const liveAgent = lastHumanIdx === -1 ? scanned : scanned.slice(0, lastHumanIdx);
    const agentComments = liveAgent.filter((c) => c.isCatalystAgent).map((c) => c.body);
    // Every agent comment regardless of the boundary — kept for callers that want
    // history rather than the live ask.
    const allAgentComments = scanned.filter((c) => c.isCatalystAgent).map((c) => c.body);

    return {
      ticket,
      available: true,
      comments,
      url: typeof issue?.url === "string" && issue.url !== "" ? issue.url : null,
      title: typeof issue?.title === "string" && issue.title !== "" ? issue.title : null,
      agentComments,
      allAgentComments,
      lastAgentComment: agentComments[0] ?? null,
      // EXPLICIT existence bit. `url` is an OPTIONAL deep link and can be null on a
      // real issue row (unpopulated or mid-sync), so using it as the existence
      // predicate hid the composer on tickets the POST path can resolve perfectly
      // well by identifier.
      issueExists: issue != null,
      reason: null,
    };
  } catch (e) {
    // Locked / schema drift / import failure → degrade, never throw into a request.
    return empty(`replica-error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try {
      db?.close?.();
    } catch {
      /* already closed */
    }
  }
}
