#!/usr/bin/env bash
# record-resolution.sh — Append a resolution record to the day's
# briefing-followup resolutions JSON. Phase 4 (CTL-465) reads this file to
# write the resolutions: block back to the briefing markdown frontmatter.
#
# Usage:
#   record-resolution.sh --log-dir DIR --date YYYY-MM-DD \
#     --id DECISION_ID --action ACTION_NAME --result JSON
#
# Resolution shape (one element per call):
#   {
#     "decision_id": "dec-1",
#     "action": "schedule_calendar",
#     "timestamp": "2026-05-17T20:30:00Z",
#     "result": { ... }
#   }
#
# Writes (creates if missing) a JSON array at:
#   $LOG_DIR/briefing-followup-$DATE-resolutions.json

set -uo pipefail

LOG_DIR=""
DATE=""
DEC_ID=""
ACTION=""
RESULT_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-dir)   LOG_DIR="$2"; shift 2 ;;
    --date)      DATE="$2"; shift 2 ;;
    --id)        DEC_ID="$2"; shift 2 ;;
    --action)    ACTION="$2"; shift 2 ;;
    --result)    RESULT_JSON="$2"; shift 2 ;;
    -h|--help)   sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "record-resolution.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

for required in LOG_DIR DATE DEC_ID ACTION RESULT_JSON; do
  if [[ -z "${!required}" ]]; then
    echo "record-resolution.sh: --${required,,} is required" >&2
    exit 2
  fi
done

# Validate that RESULT_JSON is valid JSON. Empty objects are allowed.
if ! echo "$RESULT_JSON" | jq empty >/dev/null 2>&1; then
  echo "record-resolution.sh: --result is not valid JSON" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"
FILE="$LOG_DIR/briefing-followup-$DATE-resolutions.json"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

NEW_ENTRY=$(jq -nc \
  --arg id "$DEC_ID" \
  --arg action "$ACTION" \
  --arg ts "$TIMESTAMP" \
  --argjson result "$RESULT_JSON" \
  '{decision_id: $id, action: $action, timestamp: $ts, result: $result}')

if [[ -f "$FILE" ]]; then
  # Append to existing array. If the file is malformed, fail loudly rather than
  # overwriting prior records silently.
  if ! UPDATED=$(jq --argjson entry "$NEW_ENTRY" '. + [$entry]' "$FILE" 2>/dev/null); then
    echo "record-resolution.sh: existing resolutions file is malformed: $FILE" >&2
    exit 2
  fi
  printf '%s\n' "$UPDATED" > "$FILE"
else
  printf '%s\n' "[$NEW_ENTRY]" | jq '.' > "$FILE"
fi
