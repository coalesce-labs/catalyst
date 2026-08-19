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
#                        research, planning, inProgress, verifying, reviewing,
#                        inReview, done, canceled, duplicate). Required unless
#                        --state given.
#   --state <literal>    Literal state name (takes precedence over --transition)
#   --config <path>      Path to .catalyst/config.json. Default: auto-discover
#                        by walking up from CWD.
#   --force              Skip idempotency check (always call update even if
#                        ticket is already in target state)
#   --dry-run            Print what would happen without calling linearis
#   --resolve-only       CTL-1889. Resolve the target state and STOP — emit
#                        {targetState, targetStateId, currentState, action} and exit 0,
#                        writing nothing. Unlike --dry-run it does NOT require the
#                        linearis binary, because its caller is the cloud write proxy,
#                        which reaches Linear under the cloud's grant rather than this
#                        host's. That distinction is the point: the end state of
#                        CTL-1889 is a host with NO Linear credential and no reason to
#                        have linearis installed, and the state-resolution chain below
#                        (per-project stateMap > global stateMap > registry triageStatus
#                        > built-in default) must keep working there. Duplicating that
#                        chain in JS would make this script one of two sources of truth.
#   --json               Emit a JSON result to stdout (default: human-readable)
#
# Exit codes:
#   0  success (transitioned, idempotent skip, dry-run, or linearis missing)
#   1  usage error (missing required args)
#   2  linearis update call failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CTL-1397: direct-SQLite Linear reads (replica-first, loud linearis fallback).
source "${SCRIPT_DIR}/lib/linear-read-replica.sh"

# ─── Default state fallbacks (when config doesn't specify them) ────────────
# These match the defaults documented in oneshot/orchestrate skills.
default_state_for() {
  case "$1" in
    backlog)     echo "Backlog" ;;
    todo)        echo "Todo" ;;
    triage)      echo "Triage" ;;  # requires the team's native Linear Triage mode enabled (triageEnabled), else no such state exists to resolve
    research)    echo "In Progress" ;;
    planning)    echo "In Progress" ;;
    inProgress)  echo "In Progress" ;;
    verifying)   echo "In Progress" ;;
    reviewing)   echo "In Progress" ;;
    remediating) echo "In Progress" ;;  # CTL-653: fallback when no stateMap "remediating" key
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
RESOLVE_ONLY=0

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
    --resolve-only) RESOLVE_ONLY=1; shift ;;
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
# Precedence: explicit --state
#           > per-project catalyst.projects[<ticket-prefix>].stateMap[transition]  (CTL-1153)
#           > global catalyst.linear.stateMap[transition]
#           > built-in default.
TARGET_STATE=""
# Derive team prefix from ticket (e.g. "CTL-123" → "CTL"). Use tr for bash-3.2-safe
# uppercasing (${x^^} fails as "bad substitution" on macOS /bin/bash 3.2).
PROJECT_KEY="$(printf '%s' "${TICKET%%-*}" | tr '[:lower:]' '[:upper:]')"
if [ -n "$STATE" ]; then
  TARGET_STATE="$STATE"
elif [ -n "$CONFIG_PATH" ] && [ -f "$CONFIG_PATH" ] && command -v jq >/dev/null 2>&1; then
  TARGET_STATE=$(jq -r --arg p "$PROJECT_KEY" --arg k "$TRANSITION" \
    '(.catalyst.projects[]? | select(.key == $p) | .stateMap[$k]) // .catalyst.linear.stateMap[$k] // empty' \
    "$CONFIG_PATH" 2>/dev/null)
fi
# A "triage" transition's true target is whatever the project's registered
# eligibleQuery.triageStatus says (resolveEligibleQuery in registry.mjs, same
# default "Triage"), NOT necessarily the literal string "Triage" — a project
# customized to e.g. "Intake" has no reason to also duplicate that into
# stateMap.triage. Check the execution-core registry BEFORE falling through to
# default_state_for's hardcoded "Triage", so this stays in sync with what
# applyTriageStatus() actually verifies against.
if [ -z "$TARGET_STATE" ] && [ "$TRANSITION" = "triage" ] && command -v jq >/dev/null 2>&1; then
  EXEC_REGISTRY_PATH="${CATALYST_DIR:-$HOME/catalyst}/execution-core/registry.json"
  if [ -f "$EXEC_REGISTRY_PATH" ]; then
    TARGET_STATE=$(jq -r --arg t "$PROJECT_KEY" \
      '(.projects[]? | select(.team == $t) | .eligibleQuery.triageStatus) // empty' \
      "$EXEC_REGISTRY_PATH" 2>/dev/null)
  fi
fi
if [ -z "$TARGET_STATE" ]; then
  TARGET_STATE="$(default_state_for "$TRANSITION")"
fi
if [ -z "$TARGET_STATE" ]; then
  echo "ERROR: could not resolve target state (transition='${TRANSITION}')" >&2
  exit 1
fi

# ─── Look up the cached UUID from the machine-level registry (CTL-577) ─────
# stateIds is a derived cache keyed by teamKey at
# ~/.config/catalyst/linear-state-ids.json — never committed, never stale in
# git. On a cache miss we resolve once (resolve-linear-ids.sh fetches the whole
# team set in one call), then re-read. If the resolve cannot run, STATUS_ARG
# falls back to the state name, which linearis resolves correctly anyway.
REGISTRY_PATH="${HOME}/.config/catalyst/linear-state-ids.json"
TEAM_KEY=""
if [ -n "$CONFIG_PATH" ] && [ -f "$CONFIG_PATH" ] && command -v jq >/dev/null 2>&1; then
  TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_PATH" 2>/dev/null)
fi

lookup_state_id() {
  [ -n "$TEAM_KEY" ] && [ -f "$REGISTRY_PATH" ] && command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg t "$TEAM_KEY" --arg s "$TARGET_STATE" \
    '.[$t].stateIds[$s] // empty' "$REGISTRY_PATH" 2>/dev/null
}

TARGET_STATE_ID="$(lookup_state_id)"

# Cache miss → resolve once, then re-read. Skipped under --dry-run (no side
# effects) and when there is no teamKey (the resolver requires one).
if [ -z "$TARGET_STATE_ID" ] && [ -n "$TEAM_KEY" ] && [ "$DRY_RUN" -ne 1 ] && [ "$RESOLVE_ONLY" -ne 1 ]; then
  RESOLVER="${SCRIPT_DIR}/resolve-linear-ids.sh"
  if [ -x "$RESOLVER" ] && [ -n "$CONFIG_PATH" ]; then
    bash "$RESOLVER" --config "$CONFIG_PATH" --force >/dev/null 2>&1 || true
    TARGET_STATE_ID="$(lookup_state_id)"
  fi
fi
STATUS_ARG="${TARGET_STATE_ID:-$TARGET_STATE}"

# CTL-1889 Codex P2 (round 1, #3724): jq is not a required dependency, so a
# jq-less host (linearis installed, jq absent) must still be able to emit
# valid JSON — linear-write.mjs parses `action` from stdout to decide
# `applied`. Before this, a jq-less emit() call under --json silently
# produced no stdout (command-not-found), so a REAL successful transition
# was reported as `not-applied-unknown` and retried forever by the
# reconciliation timer. Escaping is minimal (backslash, double-quote,
# newline) because every field here is a ticket id, a Linear state name, or
# a static message string — never arbitrary user input.
_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' '
}

# ─── Emit a JSON or human-readable result ──────────────────────────────────
emit() {
  local action="$1" current="$2" message="$3"
  if [ "$JSON_OUT" -eq 1 ]; then
    if command -v jq >/dev/null 2>&1; then
      jq -nc \
        --arg ticket "$TICKET" \
        --arg targetState "$TARGET_STATE" \
        --arg currentState "$current" \
        --arg transition "$TRANSITION" \
        --arg action "$action" \
        --arg message "$message" \
        --arg targetStateId "$TARGET_STATE_ID" \
        '{ticket:$ticket, targetState:$targetState, currentState:$currentState,
          transition:$transition, action:$action, message:$message,
          targetStateId:$targetStateId}'
    else
      printf '{"ticket":"%s","targetState":"%s","currentState":"%s","transition":"%s","action":"%s","message":"%s","targetStateId":"%s"}\n' \
        "$(_json_escape "$TICKET")" "$(_json_escape "$TARGET_STATE")" "$(_json_escape "$current")" \
        "$(_json_escape "$TRANSITION")" "$(_json_escape "$action")" "$(_json_escape "$message")" \
        "$(_json_escape "$TARGET_STATE_ID")"
    fi
  else
    printf '%s — %s (target=%s)' "$TICKET" "$action" "$TARGET_STATE"
    [ -n "$current" ] && printf ' (current=%s)' "$current"
    [ -n "$message" ] && printf ': %s' "$message"
    printf '\n'
  fi
}

# ─── --resolve-only short-circuit (CTL-1889) ───────────────────────────────
# Deliberately ABOVE the linearis gate: the cloud write proxy is the caller, and the
# end state of CTL-1889 is a host with neither linearis nor a Linear credential. The
# idempotency read below is replica-first (linear_read_ticket) and best-effort, so the
# proxy caller inherits the SAME "already in target state" answer the writing path
# would have produced, rather than re-deriving it and risking a different one.
if [ "$RESOLVE_ONLY" -eq 1 ]; then
  RO_CURRENT=""
  if command -v jq >/dev/null 2>&1; then
    RO_JSON=$(linear_read_ticket "$TICKET" 2>/dev/null || echo "")
    if [ -n "$RO_JSON" ]; then
      RO_CURRENT=$(echo "$RO_JSON" | jq -r '.state.name // empty' 2>/dev/null || echo "")
    fi
  fi
  if [ -n "$RO_CURRENT" ] && [ "$RO_CURRENT" = "$TARGET_STATE" ] && [ "$FORCE" -ne 1 ]; then
    emit "skipped" "$RO_CURRENT" "already in target state"
  else
    emit "resolve-only" "$RO_CURRENT" "resolved target state; no write performed"
  fi
  exit 0
fi

# ─── Check linearis availability ───────────────────────────────────────────
if ! command -v linearis >/dev/null 2>&1; then
  emit "skipped-no-linearis" "" "linearis CLI not installed; cannot transition ticket"
  exit 0
fi

# ─── Idempotency check (read current state first) ──────────────────────────
CURRENT_STATE=""
if [ "$FORCE" -ne 1 ] && command -v jq >/dev/null 2>&1; then
  # CTL-1397: read current state via direct SQL against the replica
  # (`linear_read_ticket`), never bare `linearis` — keeps this per-transition
  # idempotency read off the shared Linear quota. The helper is replica-first and
  # falls back loudly to linearis when the replica is stale/absent. If the read
  # returns empty the check is skipped and the transition proceeds (a same-state
  # write is a Linear no-op), so it degrades safely.
  READ_JSON=$(linear_read_ticket "$TICKET" 2>/dev/null || echo "")
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
