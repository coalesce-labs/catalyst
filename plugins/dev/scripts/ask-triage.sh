#!/bin/bash
# ask-triage.sh — rank what's waiting on the human by BLAST RADIUS, not by age.
#
# Ryan's model (2026-08-21): "there are 12 things waiting for you right now but the two
# biggest are A and B — do A first because the most important new feature is blocked, and
# B because this production bug is waiting on your call."
#
# Blast radius = how much work an ask is holding up, weighted by that work's priority.
# Linear priority: 1=Urgent 2=High 3=Medium 4=Low 0=None. We weight urgent/high heavily
# because "blocks one urgent bug" should outrank "blocks three low-priority chores".
#
# Reads the local replica ONLY (never Linear's API — shared fleet quota).
# Usage: bash ~/catalyst/comms/coord/ask-triage.sh
set -uo pipefail

# ── Replica access goes through the canonical helper (CTL-2151 review round 1) ──
# Round-1 review caught three separate defects in the hand-rolled version this replaces:
#   • `stat -f %m` was probed BEFORE `stat -c %Y`; on GNU/Linux `-f` prints a filesystem
#     report to stdout and still fails, so the mtime came back non-numeric and the
#     arithmetic below aborted under `set -u` before any output;
#   • WAL mtime is not a freshness signal at all — a quiet healthy writer never touches
#     the WAL, and a half-finished reseed can have a recent one;
#   • an undocumented $CATALYST_REPLICA ignored the supported CATALYST_REPLICA_DB /
#     CATALYST_DIR ladder, so a relocated install ranked the WRONG replica.
# lib/linear-read-replica.sh already owns all three (path ladder + `replica_fresh`, which
# gates on writer-lock recency AND a non-empty sync_meta cursor). Two gates maintained
# separately is the drift this repo has already paid for, so source it, don't re-derive it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/lib/linear-read-replica.sh"
DB="$CATALYST_REPLICA_DB"

# ⛔ A stale or absent replica is INCONCLUSIVE, not "nothing is waiting on you". This
# script publishes an authoritative ranking of what a human must decide; emitting one from
# partial data is worse than emitting nothing, so fail loudly instead of degrading.
if ! replica_fresh "$DB"; then
  echo "⚠️  INCONCLUSIVE — replica is absent, stale, or mid-reseed: $DB" >&2
  echo "    Not publishing a ranking from partial data. Check the replica writer, then re-run." >&2
  exit 1
fi

# Canonical ask labels, matched EXACTLY. The predicate this replaces read
# json_extract(raw,'$.labels.nodes') and matched LIKE '%ask%' — wrong on both axes:
# the replica's raw.labels is an ARRAY (the .nodes path silently matched nothing for
# those rows), and '%ask%' also swallows unrelated labels such as `task` and
# `ask/readiness`. Measured on the live replica 2026-08-21: the old predicate returned
# 5 open asks, this one returns 11 — six were invisible, including five that block
# real work. The normalized issue_labels/labels tables are the stable shape.
sqlite3 -noheader "$DB" "
WITH asks AS (
  SELECT i.identifier, i.state, i.title, i.updated_at,
         CAST((strftime('%s','now') - i.updated_at/1000)/3600 AS INT) AS hours
  FROM issues i
  WHERE i.removed_at IS NULL
    AND i.state NOT IN ('Done','Canceled','Duplicate')
    AND EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
                WHERE il.issue_id = i.id AND l.name IN ('catalyst-ask','ask/decision'))
),
blocked AS (
  SELECT a.identifier AS ask, w.identifier AS work, w.state AS work_state,
         COALESCE(w.priority,0) AS pri, substr(w.title,1,52) AS work_title
  FROM asks a
  JOIN relations r ON r.issue_identifier = a.identifier AND r.type='blocks'
  JOIN issues w ON w.identifier = r.related_identifier
  WHERE w.removed_at IS NULL AND w.state NOT IN ('Done','Canceled','Duplicate')
),
scored AS (
  SELECT a.identifier, a.state, a.hours, substr(a.title,1,66) AS title,
         COUNT(b.work) AS n_blocked,
         -- weight: Urgent=8 High=4 Medium=2 Low/None=1
         COALESCE(SUM(CASE WHEN b.work IS NULL THEN 0
                           WHEN b.pri=1 THEN 8 WHEN b.pri=2 THEN 4 WHEN b.pri=3 THEN 2
                           ELSE 1 END),0) AS score,
         COALESCE(MIN(NULLIF(b.pri,0)),9) AS top_pri,
         COALESCE(group_concat(b.work || ' (P' || b.pri || ' ' || b.work_state || ')', ', '),'') AS blocks_list
  FROM asks a LEFT JOIN blocked b ON b.ask = a.identifier
  GROUP BY a.identifier
)
SELECT
  '### ' || identifier || '  [' || state || ']  waiting ' || hours || 'h' || char(10) ||
  '    ' || title || char(10) ||
  '    blast radius: ' || n_blocked || ' open ticket(s) held, weighted score ' || score ||
  CASE WHEN n_blocked=0 THEN '   ⚠️  NO BLOCKING LINK — nothing records what this holds up' ELSE '' END ||
  CASE WHEN blocks_list<>'' THEN char(10) || '    blocking: ' || blocks_list ELSE '' END
FROM scored
ORDER BY score DESC, top_pri ASC, hours DESC;
"

echo
echo "── the one-line roll-up ──"
sqlite3 -noheader "$DB" "
WITH asks AS (
  SELECT i.identifier FROM issues i
  WHERE i.removed_at IS NULL AND i.state NOT IN ('Done','Canceled','Duplicate')
    AND EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
                WHERE il.issue_id = i.id AND l.name IN ('catalyst-ask','ask/decision'))
)
SELECT COUNT(*) || ' thing(s) waiting on you.' FROM asks;"
sqlite3 -noheader "$DB" "
WITH asks AS (
  SELECT i.identifier FROM issues i
  WHERE i.removed_at IS NULL AND i.state NOT IN ('Done','Canceled','Duplicate')
    AND EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
                WHERE il.issue_id = i.id AND l.name IN ('catalyst-ask','ask/decision'))
)
SELECT COUNT(*) || ' of them have NO blocking link, so their true cost is unknown.'
FROM asks a WHERE NOT EXISTS (
  SELECT 1 FROM relations r WHERE r.issue_identifier=a.identifier AND r.type='blocks');"
