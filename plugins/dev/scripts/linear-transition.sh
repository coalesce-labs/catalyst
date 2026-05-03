#!/usr/bin/env bash
# linear-transition - Single source of truth for transitioning Linear ticket
# state. Reads stateMap from `.catalyst/config.json`, is idempotent, and emits
# JSON when requested. Used by the orchestrator's PR-merge safety net, by
# workers at end of `/oneshot`, and by the bulk-close helper. CTL-69.
#
# Usage:
#   linear-transition.sh --ticket <ID> --transition <name> [--state <literal>]
#                        [--config <path>] [--force] [--dry-run] [--json]
#
#   --ticket <ID>        Linear ticket identifier (required)
#   --transition <name>  State map key to look up (one of: backlog, todo,
#                        research, planning, inProgress, inReview, done,
#                        canceled, duplicate). Required unless --state given.
#   --state <literal>    Literal state name (takes precedence over --transition)
#   --config <path>      Path to .catalyst/config.json. Default: auto-discover
#                        by walking up from CWD.
#   --force              Skip idempotency check (always call update even if
#                        ticket is already in target state)
#   --dry-run            Print what would happen without calling linearis
#   --json               Emit a JSON result to stdout (default: human-readable)
#
# Exit codes:
#   0  success (transitioned, idempotent skip, dry-run, or linearis missing)
#   1  usage error (missing required args)
#   2  linearis update call failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Default state fallbacks (when config doesn't specify them) ────────────
# These match the defaults documented in oneshot/orchestrate skills.
default_state_for() {
  case "$1" in
    backlog)     echo "Backlog" ;;
    todo)        echo "Todo" ;;
    research)    echo "In Progress" ;;
    planning)    echo "In Progress" ;;
    inProgress)  echo "In Progress" ;;
    inReview)    echo "In Review" ;;
    done)        echo "Done" ;;
    canceled)    echo "Canceled" ;;
    duplicate)   echo "Duplicate" ;;
    *)           echo "" ;;
  esac
}

TICKET=""
TRANSITION=""
STATE=""
CONFIG=""
FORCE=0
DRY_RUN=0
JSON_OUT=0

usage() {
  sed -n '2,24p' "$0" >&2
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket)      TICKET="$2"; shift 2 ;;
    --transition)  TRANSITION="$2"; shift 2 ;;
    --state)       STATE="$2"; shift 2 ;;
    --config)      CONFIG="$2"; shift 2 ;;
    --force)       FORCE=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --json)        JSON_OUT=1; shift ;;
    -h|--help)     usage 0 ;;
    *)             echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -z "$TICKET" ] && { echo "ERROR: --ticket required" >&2; exit 1; }
if [ -z "$TRANSITION" ] && [ -z "$STATE" ]; then
  echo "ERROR: --transition or --state required" >&2; exit 1
fi

# ─── Resolve config path ───────────────────────────────────────────────────
resolve_config() {
  if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    echo "$CONFIG"; return 0
  fi
  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "${dir}/.catalyst/config.json" ]; then
      echo "${dir}/.catalyst/config.json"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

CONFIG_PATH="$(resolve_config)"

# ─── Resolve target state ──────────────────────────────────────────────────
# Precedence: explicit --state > config stateMap[transition] > default.
TARGET_STATE=""
if [ -n "$STATE" ]; then
  TARGET_STATE="$STATE"
elif [ -n "$CONFIG_PATH" ] && [ -f "$CONFIG_PATH" ] && command -v jq >/dev/null 2>&1; then
  TARGET_STATE=$(jq -r --arg k "$TRANSITION" \
    '.catalyst.linear.stateMap[$k] // empty' "$CONFIG_PATH" 2>/dev/null)
fi
if [ -z "$TARGET_STATE" ]; then
  TARGET_STATE="$(default_state_for "$TRANSITION")"
fi
if [ -z "$TARGET_STATE" ]; then
  echo "ERROR: could not resolve target state (transition='${TRANSITION}')" >&2
  exit 1
fi

# ─── Look up cached UUID for the target state (CTL-207) ───────────────────
TARGET_STATE_ID=""
if [ -n "$CONFIG_PATH" ] && [ -f "$CONFIG_PATH" ] && command -v jq >/dev/null 2>&1; then
  TARGET_STATE_ID=$(jq -r --arg s "$TARGET_STATE" \
    '.catalyst.linear.stateIds[$s] // empty' "$CONFIG_PATH" 2>/dev/null)
fi
STATUS_ARG="${TARGET_STATE_ID:-$TARGET_STATE}"

# ─── Emit a JSON or human-readable result ──────────────────────────────────
emit() {
  local action="$1" current="$2" message="$3"
  if [ "$JSON_OUT" -eq 1 ]; then
    jq -nc \
      --arg ticket "$TICKET" \
      --arg targetState "$TARGET_STATE" \
      --arg currentState "$current" \
      --arg transition "$TRANSITION" \
      --arg action "$action" \
      --arg message "$message" \
      '{ticket:$ticket, targetState:$targetState, currentState:$currentState,
        transition:$transition, action:$action, message:$message}'
  else
    printf '%s — %s (target=%s)' "$TICKET" "$action" "$TARGET_STATE"
    [ -n "$current" ] && printf ' (current=%s)' "$current"
    [ -n "$message" ] && printf ': %s' "$message"
    printf '\n'
  fi
}

# ─── Check linearis availability ───────────────────────────────────────────
if ! command -v linearis >/dev/null 2>&1; then
  emit "skipped-no-linearis" "" "linearis CLI not installed; cannot transition ticket"
  exit 0
fi

# ─── Idempotency check (read current state first) ──────────────────────────
CURRENT_STATE=""
if [ "$FORCE" -ne 1 ] && command -v jq >/dev/null 2>&1; then
  READ_JSON=$(linearis issues read "$TICKET" 2>/dev/null || echo "")
  if [ -n "$READ_JSON" ]; then
    CURRENT_STATE=$(echo "$READ_JSON" | jq -r '.state.name // empty' 2>/dev/null || echo "")
  fi
  if [ -n "$CURRENT_STATE" ] && [ "$CURRENT_STATE" = "$TARGET_STATE" ]; then
    emit "skipped" "$CURRENT_STATE" "already in target state"
    exit 0
  fi
fi

# ─── Dry-run short-circuit ─────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  emit "dry-run" "$CURRENT_STATE" "would transition to ${TARGET_STATE}"
  exit 0
fi

# ─── Perform the transition ────────────────────────────────────────────────
# Note: `linearis issues update --status "<name>"` expects the state name
# exactly as it appears in Linear. Multi-word names like "In Review" are
# passed as a single argument — the shell quotes handle spaces.
if linearis issues update "$TICKET" --status "$STATUS_ARG" >/dev/null 2>&1; then
  emit "transitioned" "$CURRENT_STATE" ""
  exit 0
else
  emit "update-failed" "$CURRENT_STATE" "linearis update call returned non-zero"
  exit 2
fi
