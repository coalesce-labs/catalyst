#!/usr/bin/env bash
# action-schedule.sh — Schedule a Google Calendar event.
#
# Usage:
#   action-schedule.sh --title T --start ISO8601 --end ISO8601 \
#     [--description D] [--calendar-id ID] [--location L]
#
# Output (stdout, JSON one-liner):
#   {"event_id":"...","html_link":"...","status":"scheduled"}
# or on soft-skip:
#   {"status":"skipped","reason":"..."}
#
# Soft-skip when GOOGLE_OAUTH_ACCESS_TOKEN is unset or curl is missing.
# See cma/mcp/google-calendar.md for OAuth setup.

set -uo pipefail

TITLE=""
START=""
END=""
DESCRIPTION=""
CAL_ID="${GOOGLE_CALENDAR_ID:-primary}"
LOCATION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        TITLE="$2"; shift 2 ;;
    --start)        START="$2"; shift 2 ;;
    --end)          END="$2"; shift 2 ;;
    --description)  DESCRIPTION="$2"; shift 2 ;;
    --calendar-id)  CAL_ID="$2"; shift 2 ;;
    --location)     LOCATION="$2"; shift 2 ;;
    -h|--help)      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "action-schedule.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TITLE" || -z "$START" || -z "$END" ]]; then
  echo "action-schedule.sh: --title, --start, and --end are required" >&2
  exit 2
fi

if [[ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]]; then
  jq -nc --arg reason "GOOGLE_OAUTH_ACCESS_TOKEN not set (see cma/mcp/google-calendar.md)" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  jq -nc --arg reason "curl not on PATH" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi

ENCODED_CAL=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' \
  "$CAL_ID" 2>/dev/null || echo "primary")

# Build event body. `--argjson` would require pre-quoted values; --arg + jq
# string interpolation is safer for free-form titles/descriptions.
BODY=$(jq -nc \
  --arg summary "$TITLE" \
  --arg description "$DESCRIPTION" \
  --arg start "$START" \
  --arg end "$END" \
  --arg location "$LOCATION" \
  '{summary: $summary,
    start: {dateTime: $start},
    end: {dateTime: $end}}
   | (if $description != "" then .description = $description else . end)
   | (if $location != "" then .location = $location else . end)')

STDERR_FILE=$(mktemp -t action-schedule-stderr.XXXXXX)
RESP=$(printf '%s' "$BODY" | curl -fsSL --max-time 15 \
  -H "Authorization: Bearer ${GOOGLE_OAUTH_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST \
  --data-binary @- \
  "https://www.googleapis.com/calendar/v3/calendars/${ENCODED_CAL}/events" \
  2>"$STDERR_FILE")
CURL_EXIT=$?
STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
rm -f "$STDERR_FILE"

EVENT_ID=$(echo "$RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
HTML_LINK=$(echo "$RESP" | jq -r '.htmlLink // empty' 2>/dev/null || echo "")

if [[ -z "$EVENT_ID" ]]; then
  REASON="Calendar create-event returned no id (curl exit=$CURL_EXIT)"
  [[ -n "$STDERR_TAIL" ]] && REASON="${REASON}: ${STDERR_TAIL}"
  jq -nc --arg reason "$REASON" '{status: "failed", reason: $reason}'
  exit 1
fi

jq -nc --arg id "$EVENT_ID" --arg link "$HTML_LINK" \
  '{event_id: $id, html_link: $link, status: "scheduled"}'
