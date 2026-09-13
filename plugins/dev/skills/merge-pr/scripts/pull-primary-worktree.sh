#!/bin/bash
# pull-primary-worktree.sh - Pull latest changes in the primary (original clone) worktree
# Usage: ./pull-primary-worktree.sh [--branch <name>]
#
# Options:
#   --branch <name>   Branch to pull (default: auto-detect from origin HEAD)
#
# The primary worktree is always the first entry in `git worktree list` —
# the original clone directory. This works from any worktree context.
#
# Non-fatal: warns to stderr on failure, always exits 0.

set -euo pipefail

BRANCH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "warn: pull-primary-worktree.sh: unknown arg: $1" >&2; shift ;;
  esac
done

if [ -z "$BRANCH" ]; then
  BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || true
  [ -z "$BRANCH" ] && BRANCH="main"
fi

PRIMARY_WORKTREE=$(git worktree list 2>/dev/null | head -1 | awk '{print $1}')

if [ -z "$PRIMARY_WORKTREE" ]; then
  echo "warn: pull-primary-worktree.sh: could not resolve primary worktree" >&2
  exit 0
fi

CURRENT_DIR=$(pwd -P)
PRIMARY_RESOLVED=$(cd "$PRIMARY_WORKTREE" 2>/dev/null && pwd -P) || PRIMARY_RESOLVED=""

if [ "$PRIMARY_RESOLVED" = "$CURRENT_DIR" ]; then
  exit 0
fi

if git -C "$PRIMARY_WORKTREE" pull origin "$BRANCH" 2>/dev/null; then
  echo "Updated primary worktree ($PRIMARY_WORKTREE) to latest $BRANCH"
else
  echo "warn: pull-primary-worktree.sh: failed to pull $BRANCH in $PRIMARY_WORKTREE" >&2
fi

exit 0
