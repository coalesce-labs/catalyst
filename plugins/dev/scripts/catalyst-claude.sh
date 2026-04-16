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
#   4. Spawns a background watcher for heartbeat + cleanup
#   5. exec's claude so the process image becomes "claude" (enables Warp
#      terminal integration: rich sidebar, notifications, process detection)
#   6. Background watcher detects PID exit and records session end

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

# ─── Background watcher (heartbeat + cleanup) ───────────────────────────────
# We need to exec claude so that the process image becomes "claude" — this lets
# terminal emulators like Warp detect the process by name for rich integration
# (sidebar, notifications). But exec replaces our process, so traps never fire.
#
# Solution: spawn a background watcher that polls our PID. It handles heartbeat
# while claude runs and performs session cleanup once the PID exits.

WRAPPER_PID=$$
SESSION_ID_FILE="${WORKTREE_PATH}/.catalyst/.session-id"

(
  # Detach from parent's signal handling
  trap '' INT TERM

  SECONDS_SINCE_HEARTBEAT=0

  while kill -0 "$WRAPPER_PID" 2>/dev/null; do
    sleep 5
    SECONDS_SINCE_HEARTBEAT=$((SECONDS_SINCE_HEARTBEAT + 5))

    if [[ $SECONDS_SINCE_HEARTBEAT -ge 60 ]]; then
      "$SESSION_SCRIPT" heartbeat "$CATALYST_SESSION_ID" 2>/dev/null || true
      SECONDS_SINCE_HEARTBEAT=0
    fi
  done

  # claude (exec'd into our PID) has exited — clean up
  rm -f "$SESSION_ID_FILE" 2>/dev/null || true
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done 2>/dev/null || true
) &
disown

# ─── Replace process with claude ─────────────────────────────────────────────
# After exec, this PID becomes claude. Warp sees "claude" in the process table.
# The background watcher monitors this PID and cleans up when it exits.

exec claude "$@"
