#!/usr/bin/env bash
# gh-pr-comment.sh — Post a GitHub PR comment (CTL-1496).
#
# Usage: gh-pr-comment.sh <PR_NUMBER> <BODY> [--idempotent]
#
# With --idempotent: checks the last ~20 issue comments for an exact body
# match and skips posting if already present (prevents @codex spam on
# repeated recovery cycles).
#
# The gh binary can be overridden via CATALYST_GH_PR_COMMENT_GH_BIN (for
# tests), matching the convention in orchestrate-resolve-fixed-threads.
set -euo pipefail

PR_NUMBER="${1:?PR number required (e.g. 42)}"
BODY="${2:?comment body required}"
IDEMPOTENT=false
if [[ "${3:-}" == "--idempotent" ]]; then
  IDEMPOTENT=true
fi

GH="${CATALYST_GH_PR_COMMENT_GH_BIN:-gh}"

# Resolve repo (needed for the REST comments endpoint in idempotent mode).
REPO="$("$GH" repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)" || {
  echo "gh-pr-comment: could not resolve repo" >&2
  exit 1
}

if [[ "$IDEMPOTENT" == "true" ]]; then
  # Fetch the last 20 issue comments and check for an exact body match.
  EXISTING="$("$GH" api "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=20" 2>/dev/null \
    | jq -r '.[].body' 2>/dev/null)" || true
  while IFS= read -r existing_body; do
    if [[ "$existing_body" == "$BODY" ]]; then
      echo "gh-pr-comment: body already present — skipping (idempotent)" >&2
      exit 0
    fi
  done <<< "$EXISTING"
fi

"$GH" pr comment "$PR_NUMBER" -R "$REPO" --body "$BODY"
