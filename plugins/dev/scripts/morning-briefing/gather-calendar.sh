#!/usr/bin/env bash
# gather-calendar.sh — Pull Google Calendar events for a target day.
#
# Usage:
#   gather-calendar.sh [--date YYYY-MM-DD] [--calendar-id ID]
#
# Requires GOOGLE_OAUTH_ACCESS_TOKEN. Optional GOOGLE_CALENDAR_ID (defaults to
# 'primary'). Degrades silently to {} when creds are missing or network fails.

set -uo pipefail

DATE=""
CAL_ID="${GOOGLE_CALENDAR_ID:-primary}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --calendar-id) CAL_ID="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "gather-calendar.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]]; then
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

# Day window: 00:00:00Z of $DATE through 23:59:59Z of $DATE.
TIME_MIN="${DATE}T00:00:00Z"
TIME_MAX="${DATE}T23:59:59Z"

ENCODED_CAL=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$CAL_ID" 2>/dev/null || echo "primary")

RESP=$(curl -fsSL --max-time 10 \
  -H "Authorization: Bearer ${GOOGLE_OAUTH_ACCESS_TOKEN}" \
  "https://www.googleapis.com/calendar/v3/calendars/${ENCODED_CAL}/events?timeMin=${TIME_MIN}&timeMax=${TIME_MAX}&singleEvents=true&orderBy=startTime" \
  2>/dev/null || echo "")

if [[ -z "$RESP" ]]; then
  echo '{}'
  exit 0
fi

echo "$RESP" | jq -c '
  {calendar: (
    (.items // [])
    | map({
        id: (.id // ""),
        title: (.summary // "(no title)"),
        start: (.start.dateTime // .start.date // ""),
        end: (.end.dateTime // .end.date // "")
      })
    | map(select(.id != ""))
  )}
' 2>/dev/null || echo '{}'
