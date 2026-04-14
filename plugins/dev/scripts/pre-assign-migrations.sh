#!/usr/bin/env bash
# pre-assign-migrations.sh - Pre-assign Supabase migration numbers to tickets in an upcoming wave
#                            so parallel workers don't collide on the same NNN_ filename.
#
# Usage:
#   pre-assign-migrations.sh --tickets "CTL-1 CTL-2" [--migrations-dir <dir>]
#   pre-assign-migrations.sh --tickets-json '<json>' [--migrations-dir <dir>]
#
# Flags:
#   --tickets <ids>          Space-separated ticket IDs. Uses `linearis issues read` to fetch
#                            title/description/labels per ticket.
#   --tickets-json <json>    Array of {id,title,description,labels[]} objects. Bypasses linearis
#                            (used by tests and when ticket metadata is already in hand).
#   --migrations-dir <dir>   Migrations directory to scan. Default: supabase/migrations in cwd.
#
# Output:
#   - If the migrations directory does not exist: exit 0 silently (repo-agnostic).
#   - If no tickets in the wave are migration-likely: exit 0 silently.
#   - Otherwise: a Markdown "## Migration Number Assignments" section on stdout, suitable for
#     appending to a wave briefing. Each migration-likely ticket gets the next sequential
#     NNN number starting from max(existing NNN_*.sql prefixes) + 1.
#
# Detection heuristic for migration-likely tickets (any of the following):
#   * Labels include (case-insensitive) one of: database, migration, schema
#   * Title or description contains (case-insensitive) one of:
#     `supabase/migrations`, `migration`, `schema`, `ALTER TABLE`, `CREATE TABLE`
#
# This matches the heuristic documented in orchestrate SKILL.md.

set -euo pipefail

TICKETS=""
TICKETS_JSON=""
MIG_DIR="supabase/migrations"

while [ $# -gt 0 ]; do
  case "$1" in
    --tickets)           TICKETS="$2"; shift 2 ;;
    --tickets-json)      TICKETS_JSON="$2"; shift 2 ;;
    --migrations-dir)    MIG_DIR="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "error: unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TICKETS" ] && [ -z "$TICKETS_JSON" ]; then
  echo "error: --tickets or --tickets-json required" >&2
  exit 1
fi

# Gate 1: migrations dir must exist on disk (worker/orchestrator runs this in a worktree
# that already has the base branch checked out, so the filesystem is authoritative).
if [ ! -d "$MIG_DIR" ]; then
  exit 0
fi

# Build ticket JSON if not supplied.
if [ -z "$TICKETS_JSON" ]; then
  if ! command -v linearis >/dev/null 2>&1; then
    echo "error: --tickets requires linearis CLI; pass --tickets-json instead" >&2
    exit 1
  fi
  TICKETS_JSON="["
  FIRST=1
  for T in $TICKETS; do
    RAW=$(linearis issues read "$T" 2>/dev/null || echo '{}')
    OBJ=$(echo "$RAW" | jq -c --arg id "$T" '{
      id: $id,
      title: (.title // ""),
      description: (.description // ""),
      labels: [(.labels.nodes // [])[].name]
    }')
    if [ "$FIRST" = "1" ]; then TICKETS_JSON="${TICKETS_JSON}${OBJ}"; FIRST=0
    else                        TICKETS_JSON="${TICKETS_JSON},${OBJ}"
    fi
  done
  TICKETS_JSON="${TICKETS_JSON}]"
fi

# Detect migration-likely tickets (IDs in input order).
MIG_TICKETS=$(echo "$TICKETS_JSON" | jq -r '
  [ .[]
    | select(
        ((.labels // []) | map(ascii_downcase) | any(. == "database" or . == "migration" or . == "schema"))
        or ((.title + " " + .description) | ascii_downcase |
            test("supabase/migrations|\\bmigration\\b|\\bschema\\b|alter table|create table"))
      )
    | .id
  ] | .[]
')

if [ -z "$MIG_TICKETS" ]; then
  exit 0
fi

# Scan the migrations directory for the highest existing NNN_ prefix.
HIGHEST=0
for F in "$MIG_DIR"/[0-9][0-9][0-9]_*.sql; do
  [ -e "$F" ] || continue
  NAME=$(basename "$F")
  N=${NAME:0:3}
  N=$((10#$N))  # force base-10 (avoids octal parsing of 007, 008, etc.)
  if [ "$N" -gt "$HIGHEST" ]; then HIGHEST="$N"; fi
done

# Emit the briefing section.
printf '## Migration Number Assignments\n\n'
printf 'The following tickets in this wave are likely to add a Supabase migration.\n'
printf 'Use the assigned number as the filename prefix to prevent collisions:\n\n'

NEXT=$((HIGHEST + 1))
while IFS= read -r TID; do
  [ -n "$TID" ] || continue
  PADDED=$(printf '%03d' "$NEXT")
  printf -- '- **%s**: `%s_<description>.sql`\n' "$TID" "$PADDED"
  NEXT=$((NEXT + 1))
done <<< "$MIG_TICKETS"

printf '\n'
printf '_These are reservations — if your ticket does not actually add a migration, ignore._\n'
