#!/bin/bash
# human-blocked.sh — what is actually blocked on a human decision, and what only claims to be.
#
# Ryan's model (2026-08-21): a human block is an ASK TICKET that BLOCKS the work ticket.
# Anything else — a stale label, a machine verdict, a capacity failure — is not a human block.
#
# Reads the local replica ONLY (never the Linear API — shared fleet quota).
# Usage: bash ~/catalyst/comms/coord/human-blocked.sh [--all]
set -uo pipefail
DB="${CATALYST_REPLICA:-$HOME/catalyst/catalyst-replica.db}"
[ -f "$DB" ] || { echo "replica not found: $DB" >&2; exit 1; }

# Freshness gate — a stale replica silently reports yesterday's world as today's.
WAL="$DB-wal"; NOW=$(date +%s)
MT=$(stat -f %m "$WAL" 2>/dev/null || stat -c %Y "$WAL" 2>/dev/null || echo 0)
AGE=$(( NOW - MT ))
if [ "$AGE" -gt 900 ]; then
  echo "⚠️  replica is ${AGE}s stale (>15m) — figures below may be out of date." >&2
fi

# NOTE: fully qualified on purpose — section 1 joins `issues` twice, and an
# unqualified removed_at is ambiguous there (silently fatal, not silently wrong).
OPEN="state NOT IN ('Done','Canceled','Duplicate') AND i.removed_at IS NULL"
ASK_LABEL="EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes')) WHERE json_extract(value,'\$.name') LIKE '%ask%')"

echo "════ 1. GENUINELY BLOCKED ON A HUMAN ════"
echo "   (an open ask ticket that BLOCKS a work ticket — the real signal)"
sqlite3 -column -header "$DB" "
SELECT i.identifier AS ask, i.state AS ask_state,
       r.related_identifier AS blocks_work, w.state AS work_state,
       CAST((strftime('%s','now') - i.updated_at/1000)/3600 AS INT) || 'h' AS waiting,
       substr(i.title,1,58) AS ask_title
FROM issues i
JOIN relations r ON r.issue_identifier = i.identifier AND r.type = 'blocks'
LEFT JOIN issues w ON w.identifier = r.related_identifier
WHERE i.$OPEN AND $ASK_LABEL
ORDER BY i.updated_at ASC;"

echo
echo "════ 2. ASKS WITH NO BLOCKING LINK ════"
echo "   (a human is being asked, but nothing records what it holds up — needs the relation)"
sqlite3 -column -header "$DB" "
SELECT i.identifier AS ask, i.state,
       CAST((strftime('%s','now') - i.updated_at/1000)/3600 AS INT) || 'h' AS waiting,
       substr(i.title,1,70) AS title
FROM issues i
WHERE i.$OPEN AND $ASK_LABEL
  AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.issue_identifier = i.identifier AND r.type='blocks')
ORDER BY i.updated_at ASC;"

echo
echo "════ 3. CLAIMS A HUMAN BUT HAS NO ASK ════"
echo "   (carries a needs-human label with no ask ticket behind it — these are the false ones)"
sqlite3 -column -header "$DB" "
SELECT i.identifier, i.state,
       CAST((strftime('%s','now') - i.updated_at/1000)/3600 AS INT) || 'h' AS stale,
       substr(i.title,1,66) AS title
FROM issues i
WHERE i.$OPEN
  AND EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes')) WHERE json_extract(value,'\$.name')='needs-human')
  AND NOT EXISTS (
    SELECT 1 FROM relations r JOIN issues a ON a.identifier = r.issue_identifier
    WHERE r.related_identifier = i.identifier AND r.type='blocks'
      AND EXISTS (SELECT 1 FROM json_each(json_extract(a.raw,'\$.labels.nodes')) WHERE json_extract(value,'\$.name') LIKE '%ask%')
  )
ORDER BY i.updated_at ASC;"

echo
echo "════ SUMMARY ════"
sqlite3 "$DB" "
SELECT 'genuinely human-blocked (ask blocks work): ' || COUNT(DISTINCT i.identifier)
FROM issues i JOIN relations r ON r.issue_identifier=i.identifier AND r.type='blocks'
WHERE i.$OPEN AND $ASK_LABEL;
SELECT 'asks missing a blocking link:              ' || COUNT(*)
FROM issues i WHERE i.$OPEN AND $ASK_LABEL
  AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.issue_identifier=i.identifier AND r.type='blocks');
SELECT 'needs-human label with no ask behind it:   ' || COUNT(*)
FROM issues i WHERE i.$OPEN
  AND EXISTS (SELECT 1 FROM json_each(json_extract(i.raw,'\$.labels.nodes')) WHERE json_extract(value,'\$.name')='needs-human');"
