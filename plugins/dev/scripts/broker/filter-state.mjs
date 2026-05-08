// Persistent SHA → PR-interest correlation store for the filter daemon (CTL-284).
//
// Tracks each `pr_lifecycle` interest through its merge → deploy lifecycle so
// `github.deployment.created` (carries SHA) and `github.deployment_status.*`
// (carries deploymentId) can be correlated back to the originating PR after
// daemon restarts. Mirrors the singleton pattern from
// `orch-monitor/lib/annotations.ts`.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

let db = null;

const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const DEFAULT_DB_PATH = resolve(CATALYST_DIR, "filter-state.db");

export function openFilterStateDb(dbPath = DEFAULT_DB_PATH) {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS filter_state (
      interest_id      TEXT PRIMARY KEY,
      pr_number        INTEGER NOT NULL,
      repo             TEXT NOT NULL,
      merge_commit_sha TEXT,
      deployment_id    INTEGER,
      environment      TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      updated_at       TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_filter_state_sha
      ON filter_state(merge_commit_sha)
      WHERE merge_commit_sha IS NOT NULL
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_filter_state_deployment
      ON filter_state(deployment_id)
      WHERE deployment_id IS NOT NULL
  `);
  return db;
}

export function closeFilterStateDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function ensure() {
  if (!db) throw new Error("filter-state DB not opened — call openFilterStateDb() first");
  return db;
}

function rowToObj(row) {
  if (!row) return null;
  return {
    interestId: row.interest_id,
    prNumber: row.pr_number,
    repo: row.repo,
    mergeCommitSha: row.merge_commit_sha,
    deploymentId: row.deployment_id,
    environment: row.environment,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

const nowIso = () => new Date().toISOString();

export function upsertFilterStateOpen({ interestId, prNumber, repo }) {
  ensure().run(
    `INSERT INTO filter_state (interest_id, pr_number, repo, status, updated_at)
     VALUES (?, ?, ?, 'open', ?)
     ON CONFLICT(interest_id) DO UPDATE SET
       pr_number = excluded.pr_number,
       repo = excluded.repo,
       status = 'open',
       merge_commit_sha = NULL,
       deployment_id = NULL,
       environment = NULL,
       updated_at = excluded.updated_at`,
    [interestId, prNumber, repo, nowIso()],
  );
}

export function setFilterStateMerged(interestId, mergeCommitSha) {
  const result = ensure().run(
    `UPDATE filter_state
       SET merge_commit_sha = ?, status = 'merged', updated_at = ?
       WHERE interest_id = ?`,
    [mergeCommitSha, nowIso(), interestId],
  );
  return result.changes > 0 ? { interestId } : null;
}

export function setFilterStateDeploying(mergeCommitSha, deploymentId, environment) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE merge_commit_sha = ? LIMIT 1`)
    .get(mergeCommitSha);
  if (!row) return null;
  ensure().run(
    `UPDATE filter_state
       SET deployment_id = ?, environment = ?, status = 'deploying', updated_at = ?
       WHERE interest_id = ?`,
    [deploymentId, environment, nowIso(), row.interest_id],
  );
  return { interestId: row.interest_id };
}

export function setFilterStateDeployed(deploymentId) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE deployment_id = ? LIMIT 1`)
    .get(deploymentId);
  if (!row) return null;
  ensure().run(
    `UPDATE filter_state SET status = 'deployed', updated_at = ? WHERE interest_id = ?`,
    [nowIso(), row.interest_id],
  );
  return { interestId: row.interest_id };
}

export function setFilterStateFailed(deploymentId) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE deployment_id = ? LIMIT 1`)
    .get(deploymentId);
  if (!row) return null;
  ensure().run(
    `UPDATE filter_state SET status = 'failed', updated_at = ? WHERE interest_id = ?`,
    [nowIso(), row.interest_id],
  );
  return { interestId: row.interest_id };
}

export function deleteFilterState(interestId) {
  ensure().run(`DELETE FROM filter_state WHERE interest_id = ?`, [interestId]);
}

export function getFilterStateByInterest(interestId) {
  const row = ensure()
    .prepare(`SELECT * FROM filter_state WHERE interest_id = ?`)
    .get(interestId);
  return rowToObj(row);
}
