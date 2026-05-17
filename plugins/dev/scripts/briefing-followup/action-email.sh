#!/usr/bin/env bash
# action-email.sh — Create a Gmail draft message.
#
# Usage:
#   action-email.sh --to ADDR --subject S [--body B] [--from FROM] [--cc ADDR] [--bcc ADDR]
#
# Output (stdout, JSON one-liner):
#   {"draft_id":"...","status":"drafted"}
# or on soft-skip:
#   {"status":"skipped","reason":"..."}
#
# Soft-skip when GMAIL_OAUTH_ACCESS_TOKEN is unset (Gmail scope is distinct
# from Calendar/Drive — see cma/mcp/gmail.md) or curl is missing.

set -uo pipefail

TO=""
SUBJECT=""
BODY=""
FROM=""
CC=""
BCC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)       TO="$2"; shift 2 ;;
    --subject)  SUBJECT="$2"; shift 2 ;;
    --body)     BODY="$2"; shift 2 ;;
    --from)     FROM="$2"; shift 2 ;;
    --cc)       CC="$2"; shift 2 ;;
    --bcc)      BCC="$2"; shift 2 ;;
    -h|--help)  sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "action-email.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TO" || -z "$SUBJECT" ]]; then
  echo "action-email.sh: --to and --subject are required" >&2
  exit 2
fi

if [[ -z "${GMAIL_OAUTH_ACCESS_TOKEN:-}" ]]; then
  jq -nc --arg reason "GMAIL_OAUTH_ACCESS_TOKEN not set (see cma/mcp/gmail.md)" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  jq -nc --arg reason "curl not on PATH" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi

# Build RFC 2822 message and base64url-encode it.
build_message() {
  printf 'To: %s\r\n' "$TO"
  [[ -n "$FROM" ]] && printf 'From: %s\r\n' "$FROM"
  [[ -n "$CC"   ]] && printf 'Cc: %s\r\n' "$CC"
  [[ -n "$BCC"  ]] && printf 'Bcc: %s\r\n' "$BCC"
  printf 'Subject: %s\r\n' "$SUBJECT"
  printf 'Content-Type: text/plain; charset=UTF-8\r\n'
  printf '\r\n'
  printf '%s' "$BODY"
}

RAW=$(build_message | python3 -c '
import sys, base64
data = sys.stdin.buffer.read()
sys.stdout.write(base64.urlsafe_b64encode(data).decode("ascii").rstrip("="))
' 2>/dev/null || echo "")

if [[ -z "$RAW" ]]; then
  jq -nc --arg reason "failed to encode message body" \
    '{status: "failed", reason: $reason}'
  exit 1
fi

BODY_JSON=$(jq -nc --arg raw "$RAW" '{message: {raw: $raw}}')

STDERR_FILE=$(mktemp -t action-email-stderr.XXXXXX)
RESP=$(printf '%s' "$BODY_JSON" | curl -fsSL --max-time 15 \
  -H "Authorization: Bearer ${GMAIL_OAUTH_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST \
  --data-binary @- \
  "https://gmail.googleapis.com/gmail/v1/users/me/drafts" \
  2>"$STDERR_FILE")
CURL_EXIT=$?
STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
rm -f "$STDERR_FILE"

DRAFT_ID=$(echo "$RESP" | jq -r '.id // empty' 2>/dev/null || echo "")

if [[ -z "$DRAFT_ID" ]]; then
  REASON="Gmail drafts API returned no id (curl exit=$CURL_EXIT)"
  [[ -n "$STDERR_TAIL" ]] && REASON="${REASON}: ${STDERR_TAIL}"
  jq -nc --arg reason "$REASON" '{status: "failed", reason: $reason}'
  exit 1
fi

jq -nc --arg id "$DRAFT_ID" '{draft_id: $id, status: "drafted"}'
