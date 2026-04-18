#!/usr/bin/env bash
# launch-orchestrator-tab.sh — Tab-config launcher for catalyst orchestrators
#
# Called as a one-liner from Warp tab configs (~/.warp/tab_configs/*_orchestrator.toml).
# Accepts a single "+"-delimited args string (Warp params can't carry literal spaces
# reliably through the command array), parses it into one of four orchestration modes,
# then bootstraps the worktree and execs claude.
#
# Usage:
#   launch-orchestrator-tab.sh "ADV-230+ADV-231"                    # positional tickets
#   launch-orchestrator-tab.sh "--project+Architecture+Decision+Records"
#   launch-orchestrator-tab.sh "--cycle+current"
#   launch-orchestrator-tab.sh "--auto+5"
#
# Must be invoked from the repo root (Warp tab sets `directory`). Assumes direnv
# and catalyst scripts are available in a sibling directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="${SCRIPT_DIR}/setup-orchestrator.sh"
CLAUDE_LAUNCHER="${SCRIPT_DIR}/catalyst-claude.sh"

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: launch-orchestrator-tab.sh <args-string>" >&2
  echo "  args-string uses '+' as word separator (e.g. ADV-230+ADV-231, --cycle+current,"
  echo "  --project+My+Project, --auto+5)" >&2
  exit 1
fi

# Replace '+' with spaces to recover the real argument string
ARGS="${1//+/ }"

# Case-dispatch into one of the four orchestration modes
case "$ARGS" in
  --project\ *)
    SETUP_FLAG="--project"
    SETUP_VAL="${ARGS#--project }"
    CLAUDE_INVOCATION="/catalyst-dev:orchestrate --project \"$SETUP_VAL\""
    ;;
  --cycle\ *)
    SETUP_FLAG="--cycle"
    SETUP_VAL="${ARGS#--cycle }"
    CLAUDE_INVOCATION="/catalyst-dev:orchestrate --cycle $SETUP_VAL"
    ;;
  --auto\ *)
    SETUP_FLAG="--auto"
    SETUP_VAL="${ARGS#--auto }"
    CLAUDE_INVOCATION="/catalyst-dev:orchestrate --auto $SETUP_VAL"
    ;;
  *)
    SETUP_FLAG="--tickets"
    SETUP_VAL="$ARGS"
    CLAUDE_INVOCATION="/catalyst-dev:orchestrate $ARGS"
    ;;
esac

# Activate direnv in the repo (OTEL context, PATH additions, etc.)
if command -v direnv >/dev/null 2>&1; then
  direnv allow . >/dev/null 2>&1 || true
  eval "$(direnv export zsh 2>/dev/null || true)"
fi

# Bootstrap the orchestrator worktree. --quiet gives us machine-readable
# WORKTREE_PATH=... / RUN_DIR=... / ORCH_ID=... lines.
SETUP_OUT="$("$SETUP" --quiet "$SETUP_FLAG" "$SETUP_VAL")"
eval "$SETUP_OUT"

if [[ -z "${WORKTREE_PATH:-}" ]]; then
  echo "❌ setup-orchestrator.sh did not return a WORKTREE_PATH" >&2
  exit 1
fi

cd "$WORKTREE_PATH"

# Re-activate direnv inside the worktree (per-worktree .envrc)
if command -v direnv >/dev/null 2>&1; then
  direnv allow . >/dev/null 2>&1 || true
  eval "$(direnv export zsh 2>/dev/null || true)"
fi

exec "$CLAUDE_LAUNCHER" "$CLAUDE_INVOCATION"
