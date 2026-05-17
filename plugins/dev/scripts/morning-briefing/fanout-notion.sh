#!/usr/bin/env bash
# fanout-notion.sh — Append the SANITIZED briefing to a designated Notion page.
# Idempotency: each update inserts a marker paragraph "### Morning Briefing — <date>"
# at the top of the appended block list. Operators can prune old marker blocks
# manually (Phase 6 acceptance verifies one-page-no-duplicate behavior).
#
# Usage:
#   fanout-notion.sh --in <briefing.md> --date YYYY-MM-DD
#                    [--page <notion-page-id>] [--dry-run] [--config <path>]
#
# Credentials: NOTION_TOKEN env var.
# Destination: --page flag wins; otherwise .catalyst.briefing.notionPageId from --config.
# Prints final {"status":"posted|skipped|failed", "destination":"notion", ...}.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IN=""
DATE=""
PAGE=""
DRY_RUN=0
CONFIG=".catalyst/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in)      IN="$2"; shift 2 ;;
    --date)    DATE="$2"; shift 2 ;;
    --page)    PAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --config)  CONFIG="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "fanout-notion.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

emit_status() {
  local status="$1" reason="${2:-}" details="${3:-{\}}"
  if [[ -n "$reason" ]]; then
    jq -nc --arg s "$status" --arg r "$reason" --argjson d "$details" \
      '{status:$s, destination:"notion", reason:$r, details:$d}'
  else
    jq -nc --arg s "$status" --argjson d "$details" \
      '{status:$s, destination:"notion", details:$d}'
  fi
}

if [[ -z "${NOTION_TOKEN:-}" ]]; then
  emit_status skipped no_credentials
  exit 0
fi

if [[ -z "$PAGE" ]] && [[ -f "$CONFIG" ]]; then
  PAGE=$(jq -r '.catalyst.briefing.notionPageId // empty' "$CONFIG" 2>/dev/null || echo "")
fi
if [[ -z "$PAGE" ]]; then
  emit_status skipped no_destination
  exit 0
fi

if [[ -z "$IN" ]] || [[ ! -f "$IN" ]]; then
  emit_status failed input_not_found
  exit 0
fi

SANITIZED_FILE="$(mktemp)"
trap 'rm -f "$SANITIZED_FILE"' EXIT
bash "$SCRIPT_DIR/sanitize.sh" --profile notion --in "$IN" --config "$CONFIG" > "$SANITIZED_FILE"

# Build the Notion children payload:
#   - First block: heading_3 with text "Morning Briefing — <date>" (marker).
#   - Subsequent blocks: one paragraph per non-empty body line (rich_text plain text).
#   Notion's API caps blocks at 100 per request; truncate beyond that.
# Pass sanitized content via file path (NOT stdin) — the heredoc occupies stdin.
PAYLOAD=$(python3 - "$DATE" "$SANITIZED_FILE" <<'PY'
import json
import re
import sys

date = sys.argv[1] if len(sys.argv) > 1 else ""
sanitized_path = sys.argv[2]
with open(sanitized_path, "r", encoding="utf-8") as fh:
    text = fh.read()

# Drop the YAML frontmatter — Notion only wants the body.
m = re.match(r"^---\s*\n.*?\n---\s*\n(.*)$", text, re.DOTALL)
body = m.group(1) if m else text

def block_paragraph(line):
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [
                {"type": "text", "text": {"content": line[:2000]}}
            ]
        },
    }

marker = {
    "object": "block",
    "type": "heading_3",
    "heading_3": {
        "rich_text": [
            {"type": "text", "text": {"content": f"Morning Briefing — {date}"}}
        ]
    },
}

children = [marker]
for line in body.splitlines():
    if not line.strip():
        continue
    children.append(block_paragraph(line))
    if len(children) >= 100:
        break

print(json.dumps({"children": children}))
PY
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%s\n' "$PAYLOAD"
  emit_status posted "" "$(jq -nc --arg p "$PAGE" --argjson b "$(jq '.children | length' <<<"$PAYLOAD")" \
    '{dryRun:true, pageId:$p, blockCount:$b}')"
  exit 0
fi

RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sS -X PATCH \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "https://api.notion.com/v1/blocks/${PAGE}/children" 2>/dev/null)

OBJ=$(printf '%s' "$RESPONSE" | jq -r '.object // ""' 2>/dev/null)
if [[ "$OBJ" == "list" ]]; then
  emit_status posted "" "$(jq -nc --arg p "$PAGE" '{pageId:$p}')"
else
  ERR=$(printf '%s' "$RESPONSE" | jq -r '.message // "api_error"' 2>/dev/null)
  emit_status failed "$ERR" "$(jq -nc --arg r "$RESPONSE" '{response:$r}')"
fi
