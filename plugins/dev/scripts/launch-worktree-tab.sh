#!/usr/bin/env bash
# launch-worktree-tab.sh — Tab-config launcher for long-lived catalyst worktrees
#
# Called as a one-liner from Warp tab configs. Creates the worktree if it doesn't
# exist (reusing it if it does), then execs claude inside it. Used for both the
# permanent "pm" worktree and on-demand ticket worktrees.
#
# Usage:
#   launch-worktree-tab.sh <worktree-name> [base-branch]
#
# Examples:
#   launch-worktree-tab.sh pm main          # open/create the PM worktree
#   launch-worktree-tab.sh ADV-230 main     # open/create a ticket worktree
#
# Must be invoked from the repo root (Warp tab sets `directory`). Expects
# create-worktree.sh and catalyst-claude.sh in a sibling directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE="${SCRIPT_DIR}/create-worktree.sh"
CLAUDE_LAUNCHER="${SCRIPT_DIR}/catalyst-claude.sh"

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: launch-worktree-tab.sh <worktree-name> [base-branch]" >&2
  exit 1
fi

WORKTREE_NAME="$1"
BASE_BRANCH="${2:-main}"

if command -v direnv >/dev/null 2>&1; then
  direnv allow . >/dev/null 2>&1 || true
  eval "$(direnv export zsh 2>/dev/null || true)"
fi

# --reuse-existing makes the script idempotent: new worktree gets full setup,
# existing one is just surfaced via WORKTREE_PATH=... output.
OUT="$("$CREATE" --reuse-existing "$WORKTREE_NAME" "$BASE_BRANCH" | grep '^WORKTREE_PATH=')"
eval "$OUT"

if [[ -z "${WORKTREE_PATH:-}" ]]; then
  echo "❌ create-worktree.sh did not return a WORKTREE_PATH" >&2
  exit 1
fi

cd "$WORKTREE_PATH"

if command -v direnv >/dev/null 2>&1; then
  direnv allow . >/dev/null 2>&1 || true
  eval "$(direnv export zsh 2>/dev/null || true)"
fi

exec "$CLAUDE_LAUNCHER"
