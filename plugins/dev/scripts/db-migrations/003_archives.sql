-- 003_archives.sql
-- Archive of completed orchestrators: SQLite index + filesystem blobs.
-- See CTL-110. Companion to 001 sessions + 002 session_context.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orchestrators (
  orch_id           TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  status            TEXT NOT NULL DEFAULT 'completed',
  waves_count       INTEGER NOT NULL DEFAULT 0,
  workers_count     INTEGER NOT NULL DEFAULT 0,
  prs_merged_count  INTEGER NOT NULL DEFAULT 0,
  tickets_touched   TEXT,
  archive_path      TEXT NOT NULL,
  has_rollup        INTEGER NOT NULL DEFAULT 0,
  archived_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orchestrators_started   ON orchestrators(started_at);
CREATE INDEX IF NOT EXISTS idx_orchestrators_completed ON orchestrators(completed_at);
CREATE INDEX IF NOT EXISTS idx_orchestrators_status    ON orchestrators(status);

CREATE TABLE IF NOT EXISTS archived_workers (
  worker_id            TEXT NOT NULL,
  orch_id              TEXT NOT NULL REFERENCES orchestrators(orch_id) ON DELETE CASCADE,
  ticket               TEXT,
  pr_number            INTEGER,
  pr_state             TEXT,
  final_status         TEXT,
  duration_ms          INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,
  has_summary          INTEGER NOT NULL DEFAULT 0,
  has_rollup_fragment  INTEGER NOT NULL DEFAULT 0,
  archived_at          TEXT NOT NULL,
  PRIMARY KEY (orch_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_archived_workers_ticket ON archived_workers(ticket);
CREATE INDEX IF NOT EXISTS idx_archived_workers_pr     ON archived_workers(pr_number);

CREATE TABLE IF NOT EXISTS archived_artifacts (
  artifact_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  orch_id      TEXT NOT NULL REFERENCES orchestrators(orch_id) ON DELETE CASCADE,
  worker_id    TEXT,
  kind         TEXT NOT NULL,
  path         TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_artifacts_orch   ON archived_artifacts(orch_id);
CREATE INDEX IF NOT EXISTS idx_archived_artifacts_kind   ON archived_artifacts(kind);
CREATE INDEX IF NOT EXISTS idx_archived_artifacts_worker ON archived_artifacts(orch_id, worker_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_archived_artifacts_unique ON archived_artifacts(orch_id, path);
