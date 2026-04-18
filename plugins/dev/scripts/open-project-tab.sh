#!/usr/bin/env bash
# open-project-tab.sh — Standard init for a "project 📦" Warp tab.
#
# Runs the shared 5-step startup used by every ~/.warp/tab_configs/*.toml that
# opens a project's main checkout (no worktree, no claude launch).
#
# Steps:
#   1. direnv allow + export
#   2. humanlayer thoughts init + sync (if humanlayer installed)
#   3. optional project-specific setup (first arg — e.g. "bun install && scripts/setup-env.sh")
#   4. trust-workspace.sh so Claude Code skips the trust dialog
#   5. git fetch + git status
#
# Usage (from a tab_configs commands array):
#   "<catalyst-root>/plugins/dev/scripts/open-project-tab.sh"
#   "<catalyst-root>/plugins/dev/scripts/open-project-tab.sh 'bun install && scripts/setup-env.sh'"
#
# Assumes cwd is the project root (Warp tab sets `directory`). No `set -e`: if any
# step soft-fails, we still want the tab to drop the user into a usable shell.

SETUP_CMD="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. direnv
if command -v direnv >/dev/null 2>&1; then
  direnv allow . && eval "$(direnv export zsh)"
fi

# 2. humanlayer thoughts — mirrors the pattern used across all project tabs.
#    $HUMANLAYER_PROFILE / $HUMANLAYER_DIRECTORY come from the shell env.
if command -v humanlayer >/dev/null 2>&1; then
  yes | humanlayer thoughts init --profile "$HUMANLAYER_PROFILE" --directory "$HUMANLAYER_DIRECTORY" 2>/dev/null
  humanlayer thoughts sync
fi

# 3. Project-specific setup
if [[ -n "$SETUP_CMD" ]]; then
  eval "$SETUP_CMD"
fi

# 4. Trust workspace for Claude Code
if [[ -x "$SCRIPT_DIR/trust-workspace.sh" ]]; then
  "$SCRIPT_DIR/trust-workspace.sh" "$(pwd)"
fi

# 5. Git state
git fetch && git status
