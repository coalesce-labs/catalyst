#!/usr/bin/env bash
# Usage: append-contradictions.sh [--date YYYY-MM-DD] <output-file>
#
# Reads contradiction JSONL on stdin (from contradict.sh). Appends one
# markdown block per record to <output-file>. If <output-file> doesn't
# exist, prepends a one-time header on the first write.
#
# Format per block:
#   ## YYYY-MM-DD — <cluster.topic>
#
#   - [[slug-A]] ↔ [[slug-B]]: <explanation>
#   - [[slug-C]] ↔ [[slug-D]]: <explanation>
#
# Append-only contract: opens <output-file> in `>>` mode; never overwrites.
# Empty stdin is a no-op (file unchanged byte-for-byte).
#
# --date defaults to today (UTC); tests pin it for determinism.

set -uo pipefail

DATE="$(date -u +%Y-%m-%d)"
DEST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    --) shift; DEST="${1:-}"; shift ;;
    -*) echo "append-contradictions.sh: unknown flag: $1" >&2; exit 2 ;;
    *) DEST="$1"; shift ;;
  esac
done

if [[ -z "$DEST" ]]; then
  echo "append-contradictions.sh: missing <output-file>" >&2
  exit 2
fi

# Buffer stdin so we can detect the empty-input case before touching the file.
INPUT="$(cat)"
if [[ -z "${INPUT//[[:space:]]/}" ]]; then
  # No contradictions → no-op
  exit 0
fi

# Count actual JSON records
RECORDS=$(printf '%s\n' "$INPUT" | grep -c '^{' || true)
if [[ "$RECORDS" -eq 0 ]]; then
  exit 0
fi

# Render one block per record
render_block() {
  local rec="$1"
  local topic
  topic=$(jq -r '.topic // .cluster_id' <<<"$rec")
  printf '## %s — %s\n\n' "$DATE" "$topic"
  jq -r '.contradictions[] | "- [[\(.between[0])]] ↔ [[\(.between[1])]]: \(.explanation)"' <<<"$rec"
  printf '\n'
}

# If file doesn't exist, write a one-time header before any blocks.
{
  if [[ ! -f "$DEST" ]]; then
    printf '# Contradictions — research corpus\n\n'
    printf 'Append-only. Each `##` block is one weekly curation run.\n\n'
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "${line:0:1}" != "{" ]] && continue
    render_block "$line"
  done <<<"$INPUT"
} >> "$DEST"
