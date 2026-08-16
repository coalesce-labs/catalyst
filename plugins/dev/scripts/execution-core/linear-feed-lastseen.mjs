// linear-feed-lastseen.mjs — CTL-1847, the baseline the issues-diff edge source
// derives edges against.
//
// ── WHY SQLITE AND NOT A JSON FILE ──────────────────────────────────────────
// The baseline holds one snapshot per issue — ~4,000 rows on this fleet today. A
// JSON map would mean rewriting the WHOLE file every tick to record that two issues
// changed, at a tick cadence of ≤10s. SQLite gives incremental upserts and atomic
// commits for exactly this shape, and `bun:sqlite` is already a dependency of this
// tree, so it costs no new install.
//
// ── ⛔ THE SEEDED FLAG IS THE COLD-START SAFETY ─────────────────────────────
// The store records whether it has been SEEDED, separately from whether it is
// non-empty. Those are different, and conflating them is how a cold start turns into
// a 4,000-event burst:
//
//   not seeded          → the producer has no baseline. Every issue would diff
//                         against null and look like a brand-new edge.
//   seeded but empty    → impossible in practice, but if it happened it would be
//                         indistinguishable from "not seeded" under a size check.
//   seeded and populated→ normal steady state.
//
// A size check (`count > 0`) answers the wrong question: mid-seed interruption
// leaves a partial store that is non-empty and NOT a valid baseline. So seeding is
// recorded explicitly, and only after it completes.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen (
  issue_id   TEXT PRIMARY KEY,
  snapshot   TEXT NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SEEDED_KEY = "seeded_at";

/**
 * Open (creating if needed) the per-tenant baseline store.
 *
 * Every method is synchronous and small; the caller is a tick, not a request path.
 */
export function createLastSeenStore({ path } = {}) {
  if (typeof path !== "string" || path === "") {
    throw new Error("createLastSeenStore: path is required");
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 250");
  db.run(SCHEMA);

  const getStmt = db.prepare("SELECT snapshot FROM seen WHERE issue_id = ?");
  const putStmt = db.prepare(
    "INSERT INTO seen (issue_id, snapshot, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(issue_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at",
  );
  const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?");
  const metaPut = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  return {
    /** The stored snapshot, or null when this issue has never been seen. */
    get(issueId) {
      if (typeof issueId !== "string" || issueId === "") return null;
      const row = getStmt.get(issueId);
      if (!row?.snapshot) return null;
      try {
        return JSON.parse(row.snapshot);
      } catch {
        // A corrupt row is NOT a baseline. Returning null makes the next diff treat
        // the issue as new — which over-reports one issue rather than silently
        // comparing against garbage.
        return null;
      }
    },

    put(issueId, snapshot, updatedAt = null) {
      if (typeof issueId !== "string" || issueId === "") return false;
      putStmt.run(issueId, JSON.stringify(snapshot ?? null), Number.isInteger(updatedAt) ? updatedAt : null);
      return true;
    },

    /** Upsert many in ONE transaction — the seeding path writes thousands. */
    putMany(entries) {
      const rows = Array.isArray(entries) ? entries : [];
      if (rows.length === 0) return 0;
      const tx = db.transaction((list) => {
        for (const e of list) {
          if (!e || typeof e.issueId !== "string" || e.issueId === "") continue;
          putStmt.run(e.issueId, JSON.stringify(e.snapshot ?? null), Number.isInteger(e.updatedAt) ? e.updatedAt : null);
        }
        return list.length;
      });
      return tx(rows);
    },

    /**
     * Has a baseline been established? Deliberately NOT `count > 0` — a mid-seed
     * interruption leaves a non-empty store that is not a valid baseline, and a size
     * check cannot tell those apart.
     */
    isSeeded() {
      return Boolean(metaGet.get(SEEDED_KEY)?.value);
    },

    /** Record seeding as complete. Called only AFTER every snapshot is written. */
    markSeeded(at = Date.now()) {
      metaPut.run(SEEDED_KEY, String(at));
    },

    size() {
      return db.prepare("SELECT COUNT(*) n FROM seen").get()?.n ?? 0;
    },

    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
