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

# CTL-1496: PR_NUMBER is interpolated into a REST path below — reject anything
# non-numeric so a bad arg can't build a malformed/traversable endpoint.
if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "gh-pr-comment: PR number must be a positive integer (got '${PR_NUMBER}')" >&2
  exit 2
fi

GH="${CATALYST_GH_PR_COMMENT_GH_BIN:-gh}"

# Resolve repo (needed for the REST comments endpoint in idempotent mode).
REPO="$("$GH" repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)" || {
  echo "gh-pr-comment: could not resolve repo" >&2
  exit 1
}

if [[ "$IDEMPOTENT" == "true" ]]; then
  # Fetch the last 20 issue comments and check for an exact body match.
  # CTL-1496: distinguish a genuine "no matching comment" from a transient
  # fetch failure. The old `... 2>/dev/null | jq ... || true` swallowed a gh
  # api error and treated the empty result as "not present", then posted — so
  # a transient hiccup could double-post `@codex review`, the exact spam this
  # guard exists to prevent. On a non-zero gh api exit we now fail-closed (skip
  # the post) and exit non-zero so the caller can retry next cycle.
  if ! RAW_COMMENTS="$("$GH" api "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=20" 2>/dev/null)"; then
    echo "gh-pr-comment: existing-comment fetch failed — skipping post to avoid a double-comment (idempotent, CTL-1496)" >&2
    exit 3
  fi
  EXISTING="$(printf '%s' "$RAW_COMMENTS" | jq -r '.[].body' 2>/dev/null)" || EXISTING=""
  while IFS= read -r existing_body; do
    if [[ "$existing_body" == "$BODY" ]]; then
      echo "gh-pr-comment: body already present — skipping (idempotent)" >&2
      exit 0
    fi
  done <<< "$EXISTING"
fi

"$GH" pr comment "$PR_NUMBER" -R "$REPO" --body "$BODY"
