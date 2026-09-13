#!/usr/bin/env bash
# fanout-slack-dm.sh — Post the briefing markdown to the operator's Slack DM
# using the chat.postMessage Web API. DM profile = no sanitization (full content).
#
# Usage:
#   fanout-slack-dm.sh --in <briefing.md> --date YYYY-MM-DD
#                      [--user <slack-user-id>] [--dry-run] [--config <path>]
#
# Credentials: SLACK_BOT_TOKEN env var.
# Destination: --user flag wins; otherwise .catalyst.briefing.slackDmUserId from --config.
# Prints final {"status":"posted|skipped|failed", "destination":"slack_dm", ...}.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IN=""
DATE=""
USER_ID=""
DRY_RUN=0
CONFIG=".catalyst/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in)      IN="$2"; shift 2 ;;
    --date)    DATE="$2"; shift 2 ;;
    --user)    USER_ID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --config)  CONFIG="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "fanout-slack-dm.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

emit_status() {
  # $1 = status, $2 = optional reason, $3 = optional details JSON
  local status="$1" reason="${2:-}" details="${3:-{\}}"
  if [[ -n "$reason" ]]; then
    jq -nc --arg s "$status" --arg r "$reason" --argjson d "$details" \
      '{status:$s, destination:"slack_dm", reason:$r, details:$d}'
  else
    jq -nc --arg s "$status" --argjson d "$details" \
      '{status:$s, destination:"slack_dm", details:$d}'
  fi
}

# Credential check
if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  emit_status skipped no_credentials
  exit 0
fi

# Destination resolution
if [[ -z "$USER_ID" ]] && [[ -f "$CONFIG" ]]; then
  USER_ID=$(jq -r '.catalyst.briefing.slackDmUserId // empty' "$CONFIG" 2>/dev/null || echo "")
fi
if [[ -z "$USER_ID" ]]; then
  emit_status skipped no_destination
  exit 0
fi

if [[ -z "$IN" ]] || [[ ! -f "$IN" ]]; then
  emit_status failed input_not_found
  exit 0
fi

# DM profile = full content. Strip YAML frontmatter before sending — Slack
# users don't want raw frontmatter in a message.
SANITIZED=$(bash "$SCRIPT_DIR/sanitize.sh" --profile dm --in "$IN")

# Slack section blocks cap at 3000 chars; truncate with a footer pointer.
BODY=$(printf '%s' "$SANITIZED" | python3 -c '
import re, sys
text = sys.stdin.read()
text = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL)
limit = 2900
if len(text) > limit:
    text = text[:limit] + "\n…(truncated, see briefing file)"
print(text, end="")
')

PAYLOAD=$(jq -nc \
  --arg channel "$USER_ID" \
  --arg text "Morning briefing — $DATE" \
  --arg body "$BODY" \
  '{
    channel: $channel,
    text: $text,
    unfurl_links: false,
    blocks: [
      {"type":"section","text":{"type":"mrkdwn","text":$body}}
    ]
  }')

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%s\n' "$PAYLOAD"
  emit_status posted "" "$(jq -nc --arg u "$USER_ID" '{dryRun:true, channel:$u}')"
  exit 0
fi

RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sS -X POST \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-type: application/json; charset=utf-8" \
  --data-binary @- \
  https://slack.com/api/chat.postMessage 2>/dev/null)

OK=$(printf '%s' "$RESPONSE" | jq -r '.ok // false' 2>/dev/null || echo "false")
if [[ "$OK" == "true" ]]; then
  TS=$(printf '%s' "$RESPONSE" | jq -r '.ts // ""' 2>/dev/null)
  emit_status posted "" "$(jq -nc --arg u "$USER_ID" --arg ts "$TS" '{channel:$u, ts:$ts}')"
else
  ERR=$(printf '%s' "$RESPONSE" | jq -r '.error // "api_error"' 2>/dev/null)
  emit_status failed "$ERR" "$(jq -nc --arg r "$RESPONSE" '{response:$r}')"
fi
