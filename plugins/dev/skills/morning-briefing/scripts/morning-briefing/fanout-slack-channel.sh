#!/usr/bin/env bash
# fanout-slack-channel.sh — Post the SANITIZED briefing to a Slack channel
# using chat.postMessage. Uses the `channel` sanitization profile (decision
# internals stripped, customer names + PR URLs redacted).
#
# Usage:
#   fanout-slack-channel.sh --in <briefing.md> --date YYYY-MM-DD
#                           [--channel <slack-channel-id>] [--dry-run] [--config <path>]
#
# Credentials: SLACK_BOT_TOKEN env var.
# Destination: --channel flag wins; otherwise .catalyst.briefing.slackChannelId from --config.
# Prints final {"status":"posted|skipped|failed", "destination":"slack_channel", ...}.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IN=""
DATE=""
CHANNEL=""
DRY_RUN=0
CONFIG=".catalyst/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in)      IN="$2"; shift 2 ;;
    --date)    DATE="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --config)  CONFIG="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "fanout-slack-channel.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

emit_status() {
  local status="$1" reason="${2:-}" details="${3:-{\}}"
  if [[ -n "$reason" ]]; then
    jq -nc --arg s "$status" --arg r "$reason" --argjson d "$details" \
      '{status:$s, destination:"slack_channel", reason:$r, details:$d}'
  else
    jq -nc --arg s "$status" --argjson d "$details" \
      '{status:$s, destination:"slack_channel", details:$d}'
  fi
}

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  emit_status skipped no_credentials
  exit 0
fi

if [[ -z "$CHANNEL" ]] && [[ -f "$CONFIG" ]]; then
  CHANNEL=$(jq -r '.catalyst.briefing.slackChannelId // empty' "$CONFIG" 2>/dev/null || echo "")
fi
if [[ -z "$CHANNEL" ]]; then
  emit_status skipped no_destination
  exit 0
fi

if [[ -z "$IN" ]] || [[ ! -f "$IN" ]]; then
  emit_status failed input_not_found
  exit 0
fi

# Channel profile = sanitized. Strip YAML frontmatter — Slack channels don't
# want raw frontmatter in a message body.
SANITIZED=$(bash "$SCRIPT_DIR/sanitize.sh" --profile channel --in "$IN" --config "$CONFIG")

BODY=$(printf '%s' "$SANITIZED" | python3 -c '
import re, sys
text = sys.stdin.read()
text = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL)
limit = 2900
if len(text) > limit:
    text = text[:limit] + "\n…(truncated)"
print(text, end="")
')

PAYLOAD=$(jq -nc \
  --arg channel "$CHANNEL" \
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
  emit_status posted "" "$(jq -nc --arg c "$CHANNEL" '{dryRun:true, channel:$c}')"
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
  emit_status posted "" "$(jq -nc --arg c "$CHANNEL" --arg ts "$TS" '{channel:$c, ts:$ts}')"
else
  ERR=$(printf '%s' "$RESPONSE" | jq -r '.error // "api_error"' 2>/dev/null)
  emit_status failed "$ERR" "$(jq -nc --arg r "$RESPONSE" '{response:$r}')"
fi
