// replica-comment-read.mjs — CTL-1958. Credential-free "latest human comment" +
// issue-id reads from the local Catalyst-Cloud replica (~/catalyst/catalyst-replica.db),
// replacing the app-actor GraphQL read that linear-reply.mjs / linear-ack.mjs used to
// mint a client_credentials token for. Moving this read to the replica is what lets
// the per-host "Catalyst Orchestrator" Linear app be uninstalled (CTL-1889).
//
// ⛔ CONTRACT DIVERGES FROM replica-read.mjs ON PURPOSE. replica-read.mjs is a hot
// accelerator and is FAIL-OPEN (any trouble → undefined → the caller falls through to a
// live read). This leaf is the ONLY read path the tools have left — the mint is being
// DELETED — so an absent/unreadable replica must be a LOUD, NAMED throw, never a silent
// "no comment" (AGENTS.md: a check that cannot fail loudly is not evidence). A well-formed
// replica that simply has no matching human comment stays a clean `null`.
//
// ⛔ CROSS-RUNTIME. The owner comms tools run under `node` (node:sqlite → DatabaseSync,
// { readOnly }); the tests run under `bun test` (bun:sqlite → Database, { readonly }).
// node:sqlite is absent under bun and bun:sqlite is absent under node, so the backend is
// selected at open time. The prepared-statement surface (.prepare(sql).get()/.all()) is
// identical across both, so only the constructor + option key differ.
//
// zero-npm-import: node:sqlite / bun:sqlite are runtime built-ins; getReplicaDbPath comes
// from the sibling config.mjs (which the tools already import) and isReplicaFresh from the
// SQLite-free replica-freshness.mjs leaf.
import { getReplicaDbPath } from "./config.mjs";
import { isReplicaFresh } from "./replica-freshness.mjs";

// The ASK_HUMAN default: the fleet's single human decision-maker. Kept here as the leaf's
// documented default so both tools resolve the same id; callers may override via env at
// their call site (process.env.ASK_HUMAN_ID) and pass it in — the leaf stays pure.
export const DEFAULT_ASK_HUMAN_ID = "c2a8cc92-cab6-4536-9500-0f24abdf702b";

// A NAMED error (not a falsy sentinel) for an absent/unreadable replica, so a missing DB
// is a loud failure the tools surface — never a silent empty read that reads as "no human
// comment" and drops threading/eyes-clear.
export class ReplicaUnavailableError extends Error {
  constructor(dbPath, cause) {
    super(`replica unreadable at ${dbPath}: ${cause?.message ?? cause}`);
    this.name = "ReplicaUnavailableError";
    this.dbPath = dbPath;
    // eslint-disable-next-line no-unused-expressions -- carry the cause for callers/logs
    this.cause = cause;
  }
}

// Open the replica strictly READONLY, selecting the backend for the current runtime. A
// failure to open (absent file, bad perms, wrong runtime) is rethrown as the NAMED error.
async function openReadonly(dbPath) {
  try {
    if (typeof process !== "undefined" && process.versions && process.versions.bun) {
      const { Database } = await import("bun:sqlite");
      return new Database(dbPath, { readonly: true });
    }
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new ReplicaUnavailableError(dbPath, err);
  }
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    /* already closed / nothing to do */
  }
}

// readLatestHumanComment({ dbPath, identifier, humanId }) → { id, parentId } | null
//   The newest non-removed, non-bot comment authored by `humanId` on issue `identifier`.
//   parentId is the thread ROOT (Linear threads are one level deep, so a reply-to-a-reply
//   targets the root): parent_id when set, else the comment's own id. Empty string is
//   treated as "no parent" — the replica stores '' for a root comment, which `??` would
//   wrongly keep — so a truthy check is used, not nullish-coalescing.
//   null = DB fine, no matching human comment. Throws ReplicaUnavailableError if the DB
//   cannot be opened.
export async function readLatestHumanComment({
  dbPath = getReplicaDbPath(),
  identifier,
  humanId = DEFAULT_ASK_HUMAN_ID,
} = {}) {
  if (!identifier) return null;
  const db = await openReadonly(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT c.id AS id, c.parent_id AS parentId
           FROM comments c JOIN issues i ON i.id = c.issue_id
          WHERE i.identifier = ? AND c.removed_at IS NULL
            AND c.is_bot = 0 AND c.author_id = ?
          ORDER BY c.created_at DESC LIMIT 1`
      )
      .get(identifier, humanId);
    if (!row) return null;
    return { id: row.id, parentId: row.parentId ? row.parentId : row.id };
  } finally {
    closeQuietly(db);
  }
}

// readIssueId({ dbPath, identifier }) → issueId | null
//   The replica's internal issue id (comments.issue_id / issues.id) for a display
//   identifier. linear-reply needs it for the proxy `comment` payload now that it holds
//   no GraphQL client. null = absent/removed; throws ReplicaUnavailableError on an
//   unreadable DB (same loud contract as the comment read).
export async function readIssueId({ dbPath = getReplicaDbPath(), identifier } = {}) {
  if (!identifier) return null;
  const db = await openReadonly(dbPath);
  try {
    const row = db
      .prepare(`SELECT id FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1`)
      .get(identifier);
    return row ? row.id : null;
  } finally {
    closeQuietly(db);
  }
}

// readReplyContext({ dbPath, identifier, humanId }) → { issueId, latest }
//   One open serving both reads linear-reply needs: the issue's internal id and its latest
//   human comment ({ id, parentId } | null). Same loud contract — a missing DB throws.
export async function readReplyContext({
  dbPath = getReplicaDbPath(),
  identifier,
  humanId = DEFAULT_ASK_HUMAN_ID,
} = {}) {
  if (!identifier) return { issueId: null, latest: null };
  const db = await openReadonly(dbPath);
  try {
    const issueRow = db
      .prepare(`SELECT id FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1`)
      .get(identifier);
    const commentRow = db
      .prepare(
        `SELECT c.id AS id, c.parent_id AS parentId
           FROM comments c JOIN issues i ON i.id = c.issue_id
          WHERE i.identifier = ? AND c.removed_at IS NULL
            AND c.is_bot = 0 AND c.author_id = ?
          ORDER BY c.created_at DESC LIMIT 1`
      )
      .get(identifier, humanId);
    return {
      issueId: issueRow ? issueRow.id : null,
      latest: commentRow ? { id: commentRow.id, parentId: commentRow.parentId ? commentRow.parentId : commentRow.id } : null,
    };
  } finally {
    closeQuietly(db);
  }
}

// isReplicaCurrent(dbPath) → boolean. The writer-liveness gate (reused, one
// implementation) so callers can WARN on a stale answer rather than silently trust it. A
// stale replica could miss a very-recently-posted human comment (bounded by the ≤5-min
// freshness threshold), which is acceptable for a threading/read-receipt target as long as
// it is surfaced.
export function isReplicaCurrent(dbPath = getReplicaDbPath()) {
  return isReplicaFresh(dbPath);
}
