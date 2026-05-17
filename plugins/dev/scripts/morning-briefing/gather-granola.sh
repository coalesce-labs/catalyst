#!/usr/bin/env bash
# gather-granola.sh — Pull yesterday's Granola meeting notes via REST.
#
# Usage:
#   gather-granola.sh [--date YYYY-MM-DD] [--limit N]
#
# Requires GRANOLA_API_KEY in env. Prints {"granola": [...]} or {} when key is
# absent / network fails. Never blocks the briefing.

set -uo pipefail

DATE=""
LIMIT=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "gather-granola.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${GRANOLA_API_KEY:-}" ]]; then
  echo '{}'
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

if [[ -z "$DATE" ]]; then
  DATE="$(date -u +%Y-%m-%d)"
fi

YESTERDAY=$(date -u -d "${DATE} -1 day" +%Y-%m-%d 2>/dev/null \
  || date -u -j -v-1d -f "%Y-%m-%d" "$DATE" +%Y-%m-%d 2>/dev/null \
  || echo "")
if [[ -z "$YESTERDAY" ]]; then
  echo '{}'
  exit 0
fi

CREATED_AFTER="${YESTERDAY}T00:00:00Z"
CREATED_BEFORE="${DATE}T00:00:00Z"

# Page size 1-30; default to 10 like the API. Network failures (timeout, 4xx, 5xx)
# all degrade silently to {} so the briefing always renders.
RESP=$(curl -fsSL --max-time 10 \
  -H "Authorization: Bearer ${GRANOLA_API_KEY}" \
  "https://public-api.granola.ai/v1/notes?page_size=${LIMIT}&created_after=${CREATED_AFTER}&created_before=${CREATED_BEFORE}" \
  2>/dev/null || echo "")

if [[ -z "$RESP" ]]; then
  echo '{}'
  exit 0
fi

echo "$RESP" | jq -c '
  {granola: (
    (.notes // [])
    | map({
        id: (.id // ""),
        title: (.title // ""),
        created_at: (.created_at // "")
      })
    | map(select(.id != ""))
  )}
' 2>/dev/null || echo '{}'
