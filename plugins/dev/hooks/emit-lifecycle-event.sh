#!/usr/bin/env bash
# emit-lifecycle-event.sh — Claude Code SubagentStop/Stop lifecycle hook (CTL-404).
#
# Fallback agent.checkout emitter for when the model exits without calling
# catalyst-session.sh end. The Claude Code harness fires this on Stop (main
# agent finishes a turn) and SubagentStop (subagent finishes), regardless of
# model behavior — providing a deterministic last-resort signal to the broker.
#
# Guards:
#   1. Exits silently when CATALYST_SESSION_ID is unset (non-Catalyst subagents:
#      planner, researcher, code-reviewer, etc. that have no broker context)
#   2. Exits silently when sessions.completed_at is already set (model called
#      catalyst-session.sh end normally — no double-emit)
#
# Install: must be added to global ~/.claude/settings.json (cannot be scoped
# to a plugin via hooks.toml). See check-setup.sh "Global Lifecycle Hooks" for
# the exact snippet and /update-config for automated installation.

set -uo pipefail

# Guard 1: only fire for Catalyst sessions.
CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}"
[[ -n "$CATALYST_SESSION_ID" ]] || exit 0

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"
EVENTS_DIR="${CATALYST_DIR}/events"

# Resolve canonical-event.sh relative to this script.
# Works for both source-clone (plugins/dev/hooks/) and version-aware wrappers
# installed by install-cli.sh (${_LATEST}/hooks/), because the sibling scripts/
# directory is always at ../scripts/ relative to hooks/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_CANONICAL="${SCRIPT_DIR}/../scripts/lib/canonical-event.sh"
[[ -r "$LIB_CANONICAL" ]] || exit 0
# shellcheck source=../scripts/lib/canonical-event.sh
source "$LIB_CANONICAL"

# Guard 2: skip if the session already completed normally.
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$DB_FILE" ]]; then
  completed=$(sqlite3 "$DB_FILE" \
    "SELECT COALESCE(completed_at,'') FROM sessions
     WHERE session_id = '${CATALYST_SESSION_ID}' LIMIT 1;" \
    2>/dev/null || echo "")
  [[ -z "$completed" ]] || exit 0
fi

# Emit flat agent.checkout — same shape as catalyst-session.sh cmd_end().
# status=failed because an unclean exit is always a failure from the broker's
# perspective; reason field distinguishes this path from a normal end call.
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
canonical_jsonl_append "$EVENTS_DIR" \
  "$(jq -nc \
    --arg ts "$ts" \
    --arg sid "$CATALYST_SESSION_ID" \
    '{ts:$ts,event:"agent.checkout",detail:{session_id:$sid,status:"failed",reason:"lifecycle-hook-stop"}}' \
    2>/dev/null)" 2>/dev/null || true
