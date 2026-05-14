-- 005_claude_session_metadata.sql
-- Bind Claude Code session metadata to Catalyst sessions (CTL-374).
--
-- `claude_session_id` stores the Claude Code session UUID, distinct from
-- `session_id` (which is the Catalyst-internal `sess_YYYYMMDDTHHMMSS_XXXXXXXX`).
-- It is the join key that lets the statusline wrapper attribute Claude Code's
-- per-status JSON (context %, cost, model, turn) back to the right Catalyst
-- session.
--
-- `last_context_pct` is bookkeeping for threshold-crossing detection: the
-- `catalyst-session.sh emit-context` command compares the new % against the
-- previous % and emits `attention.context_pressure` when the 70% line is
-- crossed (upward).
--
-- Both columns default NULL; existing sessions remain valid.

ALTER TABLE sessions ADD COLUMN claude_session_id TEXT;
ALTER TABLE sessions ADD COLUMN last_context_pct  INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_claude_session_id
  ON sessions(claude_session_id);
