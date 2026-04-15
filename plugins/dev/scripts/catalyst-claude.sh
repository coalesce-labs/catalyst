#!/usr/bin/env bash
# catalyst-claude — wrapper that registers a catalyst session around claude.
#
# Usage:
#   catalyst-claude [wrapper-flags] [claude-args...]
#
# Wrapper flags (must come before claude args):
#   --ticket KEY    Override auto-detected ticket
#   --label TEXT    Override auto-derived label
#   --skill NAME    Override skill name (default: "interactive")
#
# Everything after wrapper flags is passed through to claude verbatim.
# If catalyst-session.sh is unavailable, falls through to plain claude.
#
# The wrapper:
#   1. Detects ticket from --ticket flag, .catalyst/workflow-context, or branch
#   2. Starts a catalyst session (records PID, working dir, branch)
#   3. Exports CATALYST_SESSION_ID so skills inside claude inherit it
#   4. Runs a background heartbeat every 60s to keep updated_at fresh
#   5. On exit, calls catalyst-session end with done/failed status

set -uo pipefail

# ─── Locate catalyst-session.sh ──────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_SCRIPT="${SCRIPT_DIR}/catalyst-session.sh"

if [[ ! -x "$SESSION_SCRIPT" ]]; then
  exec claude "$@"
fi

# ─── Parse wrapper flags ─────────────────────────────────────────────────────

USER_TICKET=""
USER_LABEL=""
USER_SKILL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket) USER_TICKET="$2"; shift 2 ;;
    --label)  USER_LABEL="$2"; shift 2 ;;
    --skill)  USER_SKILL="$2"; shift 2 ;;
    *)        break ;;
  esac
done

# ─── Detect metadata ─────────────────────────────────────────────────────────

TICKET="$USER_TICKET"
SKILL="${USER_SKILL:-interactive}"
BRANCH=""
WORKTREE_PATH="$(pwd)"

BRANCH=$(git branch --show-current 2>/dev/null || echo "")

# Auto-detect ticket from workflow context
if [[ -z "$TICKET" && -f ".catalyst/.workflow-context.json" ]]; then
  TICKET=$(jq -r '.currentTicket // empty' .catalyst/.workflow-context.json 2>/dev/null || echo "")
fi

# Auto-detect ticket from git branch name
if [[ -z "$TICKET" && -n "$BRANCH" ]]; then
  if [[ "$BRANCH" =~ ([A-Z]+-[0-9]+) ]]; then
    TICKET="${BASH_REMATCH[1]}"
  fi
fi

# Check if first claude arg is a skill invocation
if [[ -z "$USER_SKILL" && "${1:-}" =~ ^/ ]]; then
  SKILL="${1#/}"
fi

# Derive label
if [[ -n "$USER_LABEL" ]]; then
  LABEL="$USER_LABEL"
elif [[ -n "$TICKET" ]]; then
  LABEL="${TICKET}${BRANCH:+ ($BRANCH)}"
elif [[ -n "$BRANCH" ]]; then
  LABEL="$BRANCH"
else
  LABEL="$(basename "$WORKTREE_PATH")"
fi

# ─── Start session ────────────────────────────────────────────────────────────

SESSION_ARGS=(--skill "$SKILL" --cwd "$WORKTREE_PATH")
[[ -n "$TICKET" ]] && SESSION_ARGS+=(--ticket "$TICKET")
[[ -n "$LABEL" ]] && SESSION_ARGS+=(--label "$LABEL")
[[ -n "$BRANCH" ]] && SESSION_ARGS+=(--branch "$BRANCH")
[[ -n "${CATALYST_SESSION_ID:-}" ]] && SESSION_ARGS+=(--workflow "$CATALYST_SESSION_ID")

CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start "${SESSION_ARGS[@]}" 2>/dev/null)
if [[ -z "$CATALYST_SESSION_ID" ]]; then
  exec claude "$@"
fi
export CATALYST_SESSION_ID

# Write session ID to a discoverable location
mkdir -p .catalyst 2>/dev/null || true
echo "$CATALYST_SESSION_ID" > .catalyst/.session-id 2>/dev/null || true

# ─── Background heartbeat ────────────────────────────────────────────────────

HEARTBEAT_PID=""

start_heartbeat() {
  (
    while true; do
      sleep 60
      "$SESSION_SCRIPT" heartbeat "$CATALYST_SESSION_ID" 2>/dev/null || true
    done
  ) &
  HEARTBEAT_PID=$!
}

stop_heartbeat() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
}

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  local exit_code="${1:-$?}"

  stop_heartbeat
  rm -f .catalyst/.session-id 2>/dev/null || true

  if [[ $exit_code -eq 0 ]]; then
    "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done 2>/dev/null || true
  else
    "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed 2>/dev/null || true
  fi
}

trap 'cleanup $?' EXIT
trap 'cleanup 130; exit 130' INT
trap 'cleanup 143; exit 143' TERM

# ─── Run claude ───────────────────────────────────────────────────────────────

start_heartbeat

claude "$@"
