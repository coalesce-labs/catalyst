-- 001_initial_schema.sql
-- Durable session store for Catalyst agent activity (solo and orchestrated).
--
-- See CTL-36. This schema replaces the per-worker JSON signal files and
-- ~/catalyst/events/*.jsonl as the source of truth over time. Dual-write
-- from catalyst-state.sh continues during the migration period.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  workflow_id   TEXT,
  ticket_key    TEXT,
  label         TEXT,
  skill_name    TEXT,
  status        TEXT NOT NULL DEFAULT 'dispatched',
  phase         INTEGER NOT NULL DEFAULT 0,
  pid           INTEGER,
  started_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_workflow ON sessions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_sessions_ticket   ON sessions(ticket_key);
CREATE INDEX IF NOT EXISTS idx_sessions_status   ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started  ON sessions(started_at);

CREATE TABLE IF NOT EXISTS session_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  payload     TEXT,
  ts          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type    ON session_events(event_type, ts);

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id            TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  cost_usd              REAL NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tools (
  session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_name         TEXT NOT NULL,
  call_count        INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_name)
);

CREATE TABLE IF NOT EXISTS session_prs (
  session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  pr_number   INTEGER NOT NULL,
  pr_url      TEXT,
  ci_status   TEXT,
  opened_at   TEXT,
  merged_at   TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_prs_number ON session_prs(pr_number);
