#!/usr/bin/env bash
# add-finding - Record an improvement finding to a per-run JSONL queue that the
# end-of-run hook (CTL-183) drains via file-feedback.sh. Called by orchestrate,
# oneshot, implement-plan, and worker dispatch templates the moment a finding is
# observed — context compaction loses observations that are postponed. CTL-176.
#
# Usage:
#   add-finding.sh --title <T> --body <B>
#                  [--skill <S>]      # default: $CATALYST_SKILL or "unknown"
#                  [--severity <L>]   # low | med | high (default low)
#                  [--tags <csv>]     # comma-separated, informational only
#                  [--file <path>]    # override log path resolution
#                  [--dry-run]        # print path + JSON, don't write
#
# Path resolution (first match wins):
#   1. --file <path>
#   2. $CATALYST_FINDINGS_FILE
#   3. .catalyst/findings/${CATALYST_SESSION_ID}.jsonl
#   4. .catalyst/findings/current.jsonl
#
# Output:
#   stdout: the appended JSON line
#   stderr: the resolved log path (visibility)
#
# Exit codes:
#   0   success (line appended, or --dry-run printed)
#   1   filesystem / jq error during append
#   64  usage error (missing --title or --body)

set -uo pipefail

TITLE=""
BODY=""
SKILL="${CATALYST_SKILL:-unknown}"
SEVERITY="low"
TAGS=""
FILE_OVERRIDE=""
DRY_RUN=0

usage() {
  sed -n '2,28p' "$0" >&2
  exit "${1:-64}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)    TITLE="$2"; shift 2 ;;
    --body)     BODY="$2"; shift 2 ;;
    --skill)    SKILL="$2"; shift 2 ;;
    --severity) SEVERITY="$2"; shift 2 ;;
    --tags)     TAGS="$2"; shift 2 ;;
    --file)     FILE_OVERRIDE="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -z "$TITLE" ] && { echo "ERROR: --title is required" >&2; usage; }
[ -z "$BODY" ]  && { echo "ERROR: --body is required" >&2; usage; }

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for add-finding" >&2
  exit 1
fi

resolve_path() {
  if [ -n "$FILE_OVERRIDE" ]; then
    echo "$FILE_OVERRIDE"; return
  fi
  if [ -n "${CATALYST_FINDINGS_FILE:-}" ]; then
    echo "$CATALYST_FINDINGS_FILE"; return
  fi
  if [ -n "${CATALYST_SESSION_ID:-}" ]; then
    echo ".catalyst/findings/${CATALYST_SESSION_ID}.jsonl"; return
  fi
  echo ".catalyst/findings/current.jsonl"
}

LOG_PATH="$(resolve_path)"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build the JSON line. jq handles escaping of newlines, quotes, and unicode.
TAGS_JSON="[]"
if [ -n "$TAGS" ]; then
  TAGS_JSON=$(echo "$TAGS" | jq -R 'split(",") | map(select(length > 0))')
fi

if ! LINE=$(jq -nc \
    --arg ts "$TS" \
    --arg skill "$SKILL" \
    --arg title "$TITLE" \
    --arg body "$BODY" \
    --arg severity "$SEVERITY" \
    --argjson tags "$TAGS_JSON" \
    '{ts: $ts, skill: $skill, title: $title, body: $body, severity: $severity, tags: $tags}'); then
  echo "ERROR: failed to build JSON line" >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "$LOG_PATH" >&2
  echo "$LINE"
  exit 0
fi

mkdir -p "$(dirname "$LOG_PATH")" || { echo "ERROR: cannot create $(dirname "$LOG_PATH")" >&2; exit 1; }

# Append; bash `>>` is atomic for lines below PIPE_BUF (~4 KB) on POSIX.
if ! printf '%s\n' "$LINE" >> "$LOG_PATH"; then
  echo "ERROR: failed to append to $LOG_PATH" >&2
  exit 1
fi

echo "$LOG_PATH" >&2
echo "$LINE"
