#!/usr/bin/env bash
# gather-linear.sh — Pull yesterday's Linear state changes for the configured team.
#
# Usage:
#   gather-linear.sh [--date YYYY-MM-DD] [--team TEAMKEY] [--limit N]
#
# Prints a JSON object: {"linear": [{"id":...,"title":...,"state":...,"url":...}, ...]}.
# If `linearis` is not on PATH, or if no team is resolvable, prints {} and exits 0.
# This script never blocks the briefing — credential/setup gaps degrade to no-data.

set -uo pipefail

DATE=""
TEAM=""
LIMIT=50

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --team) TEAM="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "gather-linear.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! command -v linearis >/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

if [[ -z "$DATE" ]]; then
  DATE="$(date -u +%Y-%m-%d)"
fi

# Compute "yesterday" cutoff (24h before target date midnight UTC).
# Portable approach — try GNU date first, fall back to BSD date.
YESTERDAY=$(date -u -d "${DATE} -1 day" +%Y-%m-%d 2>/dev/null \
  || date -u -j -v-1d -f "%Y-%m-%d" "$DATE" +%Y-%m-%d 2>/dev/null \
  || echo "")
if [[ -z "$YESTERDAY" ]]; then
  echo '{}'
  exit 0
fi

# Resolve team key from .catalyst/config.json if not provided.
if [[ -z "$TEAM" ]] && [[ -f .catalyst/config.json ]]; then
  TEAM=$(jq -r '.catalyst.linear.teamKey // empty' .catalyst/config.json 2>/dev/null || echo "")
fi
if [[ -z "$TEAM" ]]; then
  echo '{}'
  exit 0
fi

# Query Linear — updated since yesterday, limit results to keep briefing small.
LIN_OUT=$(linearis issues list \
  --team "$TEAM" \
  --updated-after "$YESTERDAY" \
  --limit "$LIMIT" 2>/dev/null || echo "")

if [[ -z "$LIN_OUT" ]]; then
  echo '{}'
  exit 0
fi

# Normalize. linearis outputs either an array or {"nodes": [...]} depending on subcommand.
echo "$LIN_OUT" | jq -c '
  ({linear:
    ((. | type) as $t
     | if $t == "array" then .
       elif .nodes then .nodes
       elif .issues then .issues
       else [] end
     | map({
         id: (.identifier // .id // ""),
         title: (.title // ""),
         state: (.state.name // .status // ""),
         url: (.url // "")
       })
     | map(select(.id != ""))
    )
  })
' 2>/dev/null || echo '{}'
