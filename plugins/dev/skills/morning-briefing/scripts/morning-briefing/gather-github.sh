#!/usr/bin/env bash
# gather-github.sh — Pull merged PRs from the configured repo for the prior day.
#
# Usage:
#   gather-github.sh [--date YYYY-MM-DD] [--repo OWNER/NAME] [--limit N]
#
# Prints {"github": [{"number":...,"title":...,"url":...,"author":...}, ...]}.
# If `gh` is not on PATH or repo cannot be resolved, prints {} and exits 0.

set -uo pipefail

DATE=""
REPO=""
LIMIT=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "gather-github.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
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

# Resolve repo from gh context (we're inside the worktree).
if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
fi
if [[ -z "$REPO" ]]; then
  echo '{}'
  exit 0
fi

GH_OUT=$(gh search prs \
  --repo "$REPO" \
  --merged-at "${YESTERDAY}..${DATE}" \
  --limit "$LIMIT" \
  --json number,title,url,author \
  2>/dev/null || echo "[]")

echo "$GH_OUT" | jq -c '
  {github: (
    . // []
    | map({
        number: (.number // 0),
        title: (.title // ""),
        url: (.url // ""),
        author: (.author.login // "")
      })
    | map(select(.number != 0))
  )}
' 2>/dev/null || echo '{}'
