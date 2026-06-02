-- CTL-748: add num_turns to session_metrics so orchestrate-roll-usage.sh
-- can persist the per-phase turn count alongside cost/token columns.
ALTER TABLE session_metrics ADD COLUMN num_turns INTEGER NOT NULL DEFAULT 0;
