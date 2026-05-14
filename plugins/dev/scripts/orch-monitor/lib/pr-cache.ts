import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const DEFAULT_DB_PATH = resolve(CATALYST_DIR, "filter-state.db");

export interface PrCacheLike {
  put(repo: string, headSha: string, headBranch: string, prNumber: number): void;
  get(repo: string, headSha: string): number | null;
}

export function createFileBasedPrCache(dbPath = DEFAULT_DB_PATH): PrCacheLike {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
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
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO pr_cache (repo, head_sha, head_branch, pr_number, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const selectStmt = db.prepare<{ pr_number: number }, [string, string]>(
    `SELECT pr_number FROM pr_cache WHERE repo = ? AND head_sha = ?`,
  );
  return {
    put(repo, headSha, headBranch, prNumber) {
      insertStmt.run(repo, headSha, headBranch, prNumber, new Date().toISOString());
    },
    get(repo, headSha) {
      const row = selectStmt.get(repo, headSha);
      return row?.pr_number ?? null;
    },
  };
}
