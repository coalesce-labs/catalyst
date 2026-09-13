#!/bin/bash
# human-blocked.sh — what is actually blocked on a human decision, and what only claims to be.
#
# Ryan's model (2026-08-21): a human block is an ASK TICKET that BLOCKS the work ticket.
# Anything else — a stale label, a machine verdict, a capacity failure — is not a human block.
#
# Reads the local replica ONLY (never the Linear API — shared fleet quota).
# Usage: bash ~/catalyst/comms/coord/human-blocked.sh [--all]
set -uo pipefail

# ── Replica access goes through the canonical helper (CTL-2151 review round 1) ──
# Same three defects round-1 review found in ask-triage.sh applied verbatim here:
# GNU/BSD `stat` probed in the order that breaks on Linux, WAL mtime used as a freshness
# signal it cannot be, and an undocumented $CATALYST_REPLICA that ignores the supported
# CATALYST_REPLICA_DB / CATALYST_DIR ladder. lib/linear-read-replica.sh owns all three.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/lib/linear-read-replica.sh"
DB="$CATALYST_REPLICA_DB"

# ⛔ This report's whole purpose is to separate "genuinely blocked" from "only claims to
# be". A stale or partial replica cannot make that distinction, and a confident-looking
# empty cohort is exactly the false clean result this repo keeps paying for. Inconclusive
# is a RESULT — emit it and stop, never a degraded report.
if ! replica_fresh "$DB"; then
  echo "⚠️  INCONCLUSIVE — replica is absent, stale, or mid-reseed: $DB" >&2
  echo "    Cohorts below would be unreliable, so none are printed. Check the writer, re-run." >&2
  exit 1
fi

# NOTE: fully qualified on purpose — section 1 joins `issues` twice, and an
# unqualified removed_at is ambiguous there (silently fatal, not silently wrong).
OPEN="state NOT IN ('Done','Canceled','Duplicate') AND i.removed_at IS NULL"
# Canonical ask labels matched EXACTLY, via the normalized tables. The raw-JSON
# `$.labels.nodes` + LIKE '%ask%' predicate this replaces was wrong twice over: raw.labels
# is an ARRAY in the replica (so .nodes matched nothing for those rows) and '%ask%' also
# swallows `task` and `ask/readiness`. Measured 2026-08-21: 5 asks found vs 11 real.
ASK_LABEL="EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
                   WHERE il.issue_id = i.id AND l.name IN ('catalyst-ask','ask/decision'))"
# An ask only counts as live work-blocking if its target is itself still open. The
# terminal states are spelled once here and reused by every section and the summary, so
# the detail queries and the counts cannot drift apart (round-1 finding: they had).
WORK_OPEN="w.identifier IS NOT NULL AND w.removed_at IS NULL AND w.state NOT IN ('Done','Canceled','Duplicate')"

echo "════ 1. GENUINELY BLOCKED ON A HUMAN ════"
echo "   (an open ask ticket that BLOCKS a work ticket — the real signal)"
sqlite3 -column -header "$DB" "
SELECT i.identifier AS ask, i.state AS ask_state,
       r.related_identifier AS blocks_work, w.state AS work_state,
       CAST((strftime('%s','now') - i.updated_at/1000)/3600 AS INT) || 'h' AS waiting,
       substr(i.title,1,58) AS ask_title
FROM issues i
JOIN relations r ON r.issue_identifier = i.identifier AND r.type = 'blocks'
JOIN issues w ON w.identifier = r.related_identifier
WHERE i.$OPEN AND $ASK_LABEL AND $WORK_OPEN
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
  AND EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
              WHERE il.issue_id = i.id AND l.name = 'needs-human')
  AND NOT EXISTS (
    SELECT 1 FROM relations r JOIN issues a ON a.identifier = r.issue_identifier
    WHERE r.related_identifier = i.identifier AND r.type='blocks'
      AND a.removed_at IS NULL AND a.state NOT IN ('Done','Canceled','Duplicate')
      AND EXISTS (SELECT 1 FROM issue_labels il2 JOIN labels l2 ON l2.id = il2.label_id
                  WHERE il2.issue_id = a.id AND l2.name IN ('catalyst-ask','ask/decision'))
  )
ORDER BY i.updated_at ASC;"

echo
echo "════ SUMMARY ════"
sqlite3 "$DB" "
SELECT 'genuinely human-blocked (ask blocks work): ' || COUNT(DISTINCT i.identifier)
FROM issues i JOIN relations r ON r.issue_identifier=i.identifier AND r.type='blocks'
JOIN issues w ON w.identifier = r.related_identifier
WHERE i.$OPEN AND $ASK_LABEL AND $WORK_OPEN;
SELECT 'asks missing a blocking link:              ' || COUNT(*)
FROM issues i WHERE i.$OPEN AND $ASK_LABEL
  AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.issue_identifier=i.identifier AND r.type='blocks');
SELECT 'needs-human label with no ask behind it:   ' || COUNT(*)
FROM issues i WHERE i.$OPEN
  AND EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
              WHERE il.issue_id = i.id AND l.name = 'needs-human')
  AND NOT EXISTS (
    SELECT 1 FROM relations r JOIN issues a ON a.identifier = r.issue_identifier
    WHERE r.related_identifier = i.identifier AND r.type='blocks'
      AND a.removed_at IS NULL AND a.state NOT IN ('Done','Canceled','Duplicate')
      AND EXISTS (SELECT 1 FROM issue_labels il2 JOIN labels l2 ON l2.id = il2.label_id
                  WHERE il2.issue_id = a.id AND l2.name IN ('catalyst-ask','ask/decision'))
  );"
