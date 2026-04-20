#!/usr/bin/env bash
# launch-worktree-tab.sh — Tab-config launcher for long-lived catalyst worktrees
#
# Called as a one-liner from Warp tab configs. Creates the worktree if it doesn't
# exist (reusing it if it does), then execs claude inside it. Used for both the
# permanent "pm" worktree and on-demand ticket worktrees.
#
# Usage:
#   launch-worktree-tab.sh [--project NAME] [--prompt-file PATH] <worktree-name> [base-branch] [description]
#
# Examples:
#   launch-worktree-tab.sh --project catalyst pm main
#   launch-worktree-tab.sh --project catalyst --prompt-file /path/to/pm-kickoff.md pm main
#   launch-worktree-tab.sh --project catalyst CTL-64 main fix-auth
#   launch-worktree-tab.sh ADV-230 main                  # --project omitted
#
# Session naming convention (for Claude's --name + remote-control prefix):
#   <project>_<worktree>[_<description>]
# e.g., catalyst_pm, catalyst_CTL-64, catalyst_CTL-64_fix-auth
#
# --prompt-file: Path to a file whose contents are passed to claude as the
# initial positional prompt (interactive mode). Missing file is a non-fatal
# warning; the tab still opens normally.
#
# Must be invoked from the repo root (Warp tab sets `directory`). Expects
# create-worktree.sh and catalyst-claude.sh in a sibling directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE="${SCRIPT_DIR}/create-worktree.sh"
CLAUDE_LAUNCHER="${SCRIPT_DIR}/catalyst-claude.sh"

PROJECT=""
PROMPT_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --) shift; break ;;
    --*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: launch-worktree-tab.sh [--project NAME] <worktree-name> [base-branch] [description]" >&2
  exit 1
fi

WORKTREE_NAME="$1"
BASE_BRANCH="${2:-main}"
DESCRIPTION="${3:-}"

# Build session name. Description is sanitized: non-alnum/dash → dash, squeeze dashes, trim.
SESSION_NAME="${PROJECT:+${PROJECT}_}${WORKTREE_NAME}"
if [[ -n "$DESCRIPTION" ]]; then
  CLEAN_DESC="$(printf '%s' "$DESCRIPTION" | LC_ALL=C tr -c '[:alnum:]-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
  [[ -n "$CLEAN_DESC" ]] && SESSION_NAME="${SESSION_NAME}_${CLEAN_DESC}"
fi

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

# Forward session name to claude via catalyst-claude.sh (reads CATALYST_WARP_*)
export CATALYST_WARP_NAME="$SESSION_NAME"
export CATALYST_WARP_REMOTE="$SESSION_NAME"

if [[ -n "$PROMPT_FILE" ]]; then
  if [[ -f "$PROMPT_FILE" ]]; then
    INITIAL_PROMPT="$(<"$PROMPT_FILE")"
    exec "$CLAUDE_LAUNCHER" "$INITIAL_PROMPT"
  else
    echo "⚠️  --prompt-file not found: $PROMPT_FILE — launching without initial prompt" >&2
  fi
fi

exec "$CLAUDE_LAUNCHER"
