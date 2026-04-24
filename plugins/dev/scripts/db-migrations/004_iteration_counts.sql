-- 004_iteration_counts.sql
-- Track plan-replan and implement-fix iteration counts per session.
--
-- Incremented via `catalyst-session.sh iteration <sid> --kind plan|fix` from
-- skills that drive plan-implement-validate loops. Flushed to OTLP as the
-- `iteration_count` counter at session end (see CTL-158).
--
-- Additive migration — defaults to 0 so existing rows remain valid.

ALTER TABLE session_metrics ADD COLUMN plan_iterations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_metrics ADD COLUMN fix_iterations  INTEGER NOT NULL DEFAULT 0;
