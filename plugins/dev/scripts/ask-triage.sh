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
DB="${CATALYST_REPLICA:-$HOME/catalyst/catalyst-replica.db}"
[ -f "$DB" ] || { echo "replica not found: $DB" >&2; exit 1; }

WAL="$DB-wal"; NOW=$(date +%s)
MT=$(stat -f %m "$WAL" 2>/dev/null || stat -c %Y "$WAL" 2>/dev/null || echo 0)
AGE=$(( NOW - MT ))
[ "$AGE" -gt 900 ] && echo "⚠️  replica ${AGE}s stale (>15m) — figures may lag." >&2

sqlite3 -noheader "$DB" "
WITH asks AS (
  SELECT i.identifier, i.state, i.title, i.updated_at,
         CAST((strftime('%s','now') - i.updated_at/1000)/3600 AS INT) AS hours
  FROM issues i
  WHERE i.removed_at IS NULL
    AND i.state NOT IN ('Done','Canceled','Duplicate')
    AND EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes'))
                WHERE json_extract(value,'\$.name') LIKE '%ask%')
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
         COALESCE(SUM(CASE b.pri WHEN 1 THEN 8 WHEN 2 THEN 4 WHEN 3 THEN 2 ELSE 1 END),0) AS score,
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
    AND EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes'))
                WHERE json_extract(value,'\$.name') LIKE '%ask%')
)
SELECT COUNT(*) || ' thing(s) waiting on you.' FROM asks;"
sqlite3 -noheader "$DB" "
WITH asks AS (
  SELECT i.identifier FROM issues i
  WHERE i.removed_at IS NULL AND i.state NOT IN ('Done','Canceled','Duplicate')
    AND EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes'))
                WHERE json_extract(value,'\$.name') LIKE '%ask%')
)
SELECT COUNT(*) || ' of them have NO blocking link, so their true cost is unknown.'
FROM asks a WHERE NOT EXISTS (
  SELECT 1 FROM relations r WHERE r.issue_identifier=a.identifier AND r.type='blocks');"
