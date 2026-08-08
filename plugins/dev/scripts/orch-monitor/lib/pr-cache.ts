import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const DEFAULT_DB_PATH = resolve(CATALYST_DIR, "filter-state.db");

export interface PrStatusRow {
  repo: string;
  pr_number: number;
  status: string;
  updated_at: string;
}

export interface PrCacheLike {
  put(repo: string, headSha: string, headBranch: string, prNumber: number): void;
  get(repo: string, headSha: string): number | null;
  // CTL-1606: persistent per-PR status, keyed on (repo, pr_number).
  putStatus(repo: string, prNumber: number, status: string): void;
  getAllStatuses(): PrStatusRow[];
}

export function createFileBasedPrCache(dbPath = DEFAULT_DB_PATH): PrCacheLike {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  // CTL-1606: the broker + orch-monitor hold concurrent handles on this same
  // filter-state.db, and putStatus now fires on EVERY pull_request webhook
  // (far more frequent than the opened/synchronize-gated put), raising WAL
  // write-contention. Without busy_timeout (default 0 = fail-immediately),
  // an SQLITE_BUSY throw in putStatus aborts dispatch()'s write and is silently
  // swallowed by the webhook try/catch. Mirror broker-state.mjs (CTL-821) so
  // transient lock contention retries instead of dropping the status write.
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS pr_cache (
      repo        TEXT NOT NULL,
      head_sha    TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      pr_number   INTEGER NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (repo, head_sha)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pr_status_cache (
      repo       TEXT NOT NULL,
      pr_number  INTEGER NOT NULL,
      status     TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo, pr_number)
    )
  `);
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO pr_cache (repo, head_sha, head_branch, pr_number, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const selectStmt = db.prepare<{ pr_number: number }, [string, string]>(
    `SELECT pr_number FROM pr_cache WHERE repo = ? AND head_sha = ?`,
  );
  // CTL-1606 (Codex #2878 P1): `merged` is TERMINAL and must never be walked back.
  // Webhook delivery is not ordered: startup replay overlaps live delivery, and GitHub
  // retries older deliveries. Without this guard a `closed`+merged event processed
  // before an older `opened`/`synchronize` (which carries `merged:false`) is overwritten
  // by that stale event — the row flips to `open` AND takes a newer updated_at, so the
  // newest-wins read in getAllPrStatuses prefers the wrong answer and board-health
  // misclassifies a merged PR as an orphaned open one. That is precisely the
  // phantom-merged blindness this ticket exists to fix, re-entering through delivery order.
  //
  // Enforced in SQL (not in JS) so it holds atomically against the concurrent
  // broker/orch-monitor writers on this same file, with no read-then-write race.
  // Only `merged` is latched: `closed` -> `open` is a legitimate REOPEN, and
  // `closed` -> `merged` is the ordinary merge, so both stay allowed.
  const upsertStatusStmt = db.prepare(
    `INSERT INTO pr_status_cache (repo, pr_number, status, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
       WHERE pr_status_cache.status != 'merged'`,
  );
  const allStatusStmt = db.prepare<PrStatusRow, []>(
    `SELECT repo, pr_number, status, updated_at FROM pr_status_cache`,
  );
  return {
    put(repo, headSha, headBranch, prNumber) {
      insertStmt.run(repo, headSha, headBranch, prNumber, new Date().toISOString());
    },
    get(repo, headSha) {
      const row = selectStmt.get(repo, headSha);
      return row?.pr_number ?? null;
    },
    putStatus(repo, prNumber, status) {
      upsertStatusStmt.run(repo, prNumber, status, new Date().toISOString());
    },
    getAllStatuses() {
      return allStatusStmt.all();
    },
  };
}
