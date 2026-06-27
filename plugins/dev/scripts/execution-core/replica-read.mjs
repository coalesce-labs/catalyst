// replica-read.mjs — CTL-1340: the daemon's READ client for the local
// Catalyst-Cloud SQLite replica (~/catalyst/catalyst-replica.db, seeded from the
// cloud change-feed). The flag-gated "replica tier" of fetchTicketState: when the
// CATALYST_LINEAR_REPLICA flag is ON, the scheduler's hot per-signal terminal
// checks read terminal-ness from this sub-ms local DB instead of the
// rate-limited per-tick `linearis` exec.
//
// Sibling of gateway-read.mjs (CTL-823) and built to the SAME contract:
//   - Deliberately NOT an HTTP client — the scheduler tick is synchronous, so an
//     HTTP hop would mean another per-call subprocess (the exact cost this tier
//     removes). SQLite WAL exists for this shape: the replica daemon stays the
//     single WRITER; this module opens the same file strictly READONLY.
//   - LIGHT single-row read (NOT the cloud's full buildIssueDetail, which runs
//     7+ queries): one index-backed SELECT of exactly the three terminal columns.
//   - Fail-open contract: ANY failure (file absent, schema mismatch, lock
//     contention, corrupt row, absent ticket) returns `undefined` — and
//     fetchTicketState FALLS THROUGH to today's gateway+live read path. The
//     replica is a HIT-only accelerator, NEVER the source of truth; a MISS must
//     never let the terminal sweep re-flag a finished ticket needs-human.
//
// Terminal mapping (robust against team-specific state names): on a HIT we
// synthesize the canonical Linear category name from the timestamp columns —
// canceled_at != null → "Canceled", else completed_at != null → "Done" — so
// isLinearTerminal (terminal-state.mjs: {Done, Canceled}) recognizes terminality
// even if a team's terminal workflow state carries a custom display name. A
// non-terminal HIT returns the row's actual `state` name (or null).
import { Database } from "bun:sqlite";
import { getReplicaDbPath } from "./config.mjs";

// The light terminal SELECT. Index-backed by idx_issues_identifier (confirmed).
// removed_at IS NULL excludes tombstoned rows (a removed ticket is a MISS → the
// caller falls through to the live read, never a stale terminal verdict).
const TERMINAL_SELECT = `SELECT state, completed_at, canceled_at FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1`;

// CTL-1366: the cheap freshness probe. One aggregate scan of the replica's
// `issues` table → the newest mirror timestamp + the row count. Drives the
// catalyst.linear.replica.staleness gauge (now − maxUpdatedAtMs). Deliberately
// unindexed/whole-table — it runs on a low cadence (once alongside cache.stats),
// not in the hot per-signal path.
const FRESHNESS_SELECT = `SELECT MAX(updated_at) AS maxUpdated, COUNT(*) AS n FROM issues`;

// coerce a replica `updated_at` cell to epoch-ms. Accepts an epoch-ms integer
// (the cloud change-feed shape) OR an ISO-8601 string (Date.parse fallback).
// Anything that resolves to neither (null, NaN, garbage) → undefined → the
// caller fails open (no gauge emitted) rather than reporting a bogus staleness.
function coerceMs(v) {
  if (v == null) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n; // epoch-ms integer
  const p = Date.parse(v); // ISO-8601 text
  return Number.isFinite(p) ? p : undefined;
}

export function createReplicaReader({ dbPath = getReplicaDbPath() } = {}) {
  let db = null;

  const open = () => {
    if (db) return db;
    db = new Database(dbPath, { readonly: true });
    // Readonly + WAL: writers never block readers, but a checkpoint can hold the
    // lock briefly — wait a beat instead of failing the read.
    db.run("PRAGMA busy_timeout = 250");
    return db;
  };

  const dropHandle = () => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  };

  // lookup(identifier) → { terminal, state } | undefined
  //   HIT canceled_at != null  → { terminal: true,  state: "Canceled" }
  //   HIT completed_at != null → { terminal: true,  state: "Done" }
  //   HIT otherwise            → { terminal: false, state: row.state || null }
  //   no row / no db / any throw → undefined  (fail-open; caller falls through)
  const lookup = (identifier) => {
    if (!identifier) return undefined;
    try {
      const row = open().prepare(TERMINAL_SELECT).get(identifier);
      if (!row) return undefined; // absent / removed → MISS, fall through to live
      if (row.canceled_at != null) return { terminal: true, state: "Canceled" };
      if (row.completed_at != null) return { terminal: true, state: "Done" };
      return { terminal: false, state: row.state || null };
    } catch {
      // Drop the handle so a later call re-opens fresh — the DB may be
      // created/migrated/re-seeded by the replica daemon between calls.
      dropHandle();
      return undefined;
    }
  };

  // freshness() → { maxUpdatedAtMs, rowCount } | undefined  (CTL-1366)
  //   HIT (≥1 row, parseable MAX(updated_at)) → { maxUpdatedAtMs, rowCount }
  //   no db / no rows / null MAX / unparseable / any throw → undefined
  // Fail-open, mirroring lookup(): a freshness failure must NEVER throw out of
  // the scheduler tick — the gauge is simply skipped that tick.
  const freshness = () => {
    try {
      const row = open().prepare(FRESHNESS_SELECT).get();
      if (!row) return undefined;
      const maxUpdatedAtMs = coerceMs(row.maxUpdated);
      if (maxUpdatedAtMs === undefined) return undefined; // empty table / unparseable
      return { maxUpdatedAtMs, rowCount: Number(row.n) || 0 };
    } catch {
      // Drop the handle so a later call re-opens fresh (DB may be re-seeded).
      dropHandle();
      return undefined;
    }
  };

  return { lookup, freshness, close: dropHandle };
}
