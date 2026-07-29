#!/usr/bin/env bash
# gh-pr-comment.sh — Post a GitHub PR comment (CTL-1496).
#
# Usage: gh-pr-comment.sh <PR_NUMBER> <BODY> [--idempotent]
#
# With --idempotent: checks issue comments posted within a RECENT time window
# (CATALYST_GH_COMMENT_DEDUP_WINDOW_SEC, default 600s) for an exact body match
# and skips posting if already present — this prevents @codex spam within a
# single recovery cycle WITHOUT suppressing a fresh re-review request forever
# (CTL-1496: an unbounded "last 20 comments" match let the very first
# `@codex review` block every later cycle's re-review; the fetch also returned
# the OLDEST comments, not the newest). The window is fetched correctly via the
# API `since` parameter.
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
  # Only dedup against comments from a RECENT window, fetched correctly via the
  # `since` parameter (the plain `?per_page=20` returns the OLDEST comments in
  # ascending order, so on a busy PR a fresh duplicate wouldn't even be in the
  # set — and an old identical comment would suppress every future post). A
  # match only counts as a duplicate when it was posted inside the window, so an
  # earlier cycle's `@codex review` no longer blocks a re-review after a new fix.
  WINDOW_SEC="${CATALYST_GH_COMMENT_DEDUP_WINDOW_SEC:-600}"
  NOW_EPOCH="$(date -u +%s)"
  SINCE_EPOCH=$(( NOW_EPOCH - WINDOW_SEC ))
  # BSD (`-r`) and GNU (`-d @`) date both covered.
  SINCE_ISO="$(date -u -r "$SINCE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@${SINCE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"
  COMMENTS_PATH="repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100"
  [[ -n "$SINCE_ISO" ]] && COMMENTS_PATH="${COMMENTS_PATH}&since=${SINCE_ISO}"
  # CTL-1496: distinguish a genuine "no matching comment" from a transient
  # fetch failure. A swallowed gh api error treated as "not present" would
  # double-post `@codex review`, the exact spam this guard exists to prevent.
  # On a non-zero gh api exit we fail-closed (skip the post) and exit non-zero
  # so the caller can retry next cycle.
  if ! RAW_COMMENTS="$("$GH" api "$COMMENTS_PATH" 2>/dev/null)"; then
    echo "gh-pr-comment: existing-comment fetch failed — skipping post to avoid a double-comment (idempotent, CTL-1496)" >&2
    exit 3
  fi
  # Count exact-body matches within the fetched (recent) window.
  MATCH_COUNT="$(printf '%s' "$RAW_COMMENTS" \
    | jq -r --arg body "$BODY" '[ .[] | select(.body == $body) ] | length' 2>/dev/null)" || MATCH_COUNT=""
  if [[ "$MATCH_COUNT" =~ ^[0-9]+$ && "$MATCH_COUNT" -gt 0 ]]; then
    echo "gh-pr-comment: identical comment already posted within ${WINDOW_SEC}s — skipping (idempotent)" >&2
    exit 0
  fi
fi

"$GH" pr comment "$PR_NUMBER" -R "$REPO" --body "$BODY"
