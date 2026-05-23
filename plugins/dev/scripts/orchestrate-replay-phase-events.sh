#!/usr/bin/env bash
# orchestrate-replay-phase-events.sh (CTL-491) — one-shot replay of any
# phase.*.{complete,failed,turn-cap-exhausted,skipped}.<TICKET> events that
# landed in the catalyst event log between the orchestrator's startup line
# cursor and the current end-of-file. Routes each event through
# orchestrate-phase-advance (complete | skipped) or orchestrate-revive
# (failed | turn-cap-exhausted).
#
# CTL-512: skipped is the monitor-deploy terminal-no-deploy status. Routed
# the same as complete because phase-advance is a no-op for monitor-deploy
# (terminal phase) — the advance call's side effect is purely the broker
# wake that frees the wave slot via the scheduler's in-flight predicate.
#
# Defends against any future re-introduction of the CTL-491 race window. With
# the Phase 1 fix in place, this script's output should be empty in steady
# state — but its idempotent behavior means running it on every Phase 4 entry
# is safe and cheap.
#
# Usage:
#   orchestrate-replay-phase-events.sh --orch-dir <path> --orch-id <id>
#
# Reads from:
#   ${ORCH_DIR}/state.json    .race.startLineCursor (number), .race.startEventsFile (path)
#   ${ORCH_DIR}/workers/*.json    active ticket set (cross-orch filter)
#   ${CATALYST_EVENTS_DIR}/$(date +%Y-%m).jsonl    current month's event log
#
# Exit codes:
#   0  success (including empty window)
#   1  baseline missing from state.json (refuses to silently scan entire log)
#   2  bad args
#
# Environment overrides (for tests):
#   CATALYST_PHASE_ADVANCE_BIN  path to orchestrate-phase-advance (default: sibling)
#   CATALYST_REVIVE_BIN         path to orchestrate-revive (default: sibling)
#   CATALYST_EVENTS_DIR         events directory (default: $HOME/catalyst/events)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADVANCE_BIN="${CATALYST_PHASE_ADVANCE_BIN:-${SCRIPT_DIR}/orchestrate-phase-advance}"
REVIVE_BIN="${CATALYST_REVIVE_BIN:-${SCRIPT_DIR}/orchestrate-revive}"
# CATALYST_EVENTS_DIR overrides the directory the helper scans for the current
# month's event log. When unset, the directory is derived from the baseline
# file path captured in state.json.race.startEventsFile — this is the common
# case in production. The env var is honored for tests that mock the events
# directory and for callers who keep the events dir somewhere non-default.

ORCH_DIR=""
ORCH_ID=""

usage() {
  sed -n '2,28p' "$0"
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --orch-dir) ORCH_DIR="$2"; shift 2 ;;
    --orch-id)  ORCH_ID="$2";  shift 2 ;;
    -h|--help)  usage 0 ;;
    *)          echo "ERROR: unknown arg: $1" >&2; usage 2 ;;
  esac
done

[ -z "$ORCH_DIR" ] && { echo "ERROR: --orch-dir required" >&2; exit 2; }
[ -z "$ORCH_ID" ]  && { echo "ERROR: --orch-id required" >&2; exit 2; }
[ ! -d "$ORCH_DIR" ] && { echo "ERROR: orch-dir does not exist: $ORCH_DIR" >&2; exit 2; }

STATE_FILE="${ORCH_DIR}/state.json"
[ -f "$STATE_FILE" ] || { echo "ERROR: state.json missing at $STATE_FILE — baseline-missing" >&2; exit 1; }

# Read baseline cursor + file from state.json. Both must be present or we
# refuse to scan the whole log silently.
START_CURSOR=$(jq -r '.race.startLineCursor // empty' "$STATE_FILE" 2>/dev/null || echo "")
START_FILE=$(jq -r '.race.startEventsFile // empty' "$STATE_FILE" 2>/dev/null || echo "")
if [ -z "$START_CURSOR" ] || [ -z "$START_FILE" ]; then
  echo "ERROR: state.json.race.{startLineCursor,startEventsFile} missing — baseline-missing" >&2
  exit 1
fi

# Active ticket set from workers/*.json.
shopt -s nullglob
WORKER_FILES=( "${ORCH_DIR}/workers/"*.json )
shopt -u nullglob
if [ ${#WORKER_FILES[@]} -eq 0 ]; then
  # No active workers — nothing to route to. Exit 0 (empty window).
  exit 0
fi
ACTIVE_TICKETS_JSON=$(jq -rs '[.[].ticket // empty] | unique' "${WORKER_FILES[@]}" 2>/dev/null || echo '[]')

# Current month's events file. Derived from the SAME directory as the
# baseline file (so callers don't need to keep $CATALYST_EVENTS_DIR in sync
# with whatever path was captured at startup). If the baseline file is the
# same as the current file, scan it from $START_CURSOR forward. Otherwise
# (month rollover) scan the tail of the baseline file from $START_CURSOR to
# its EOF, then scan the current file from line 1.
CURRENT_MONTH=$(date -u +%Y-%m)
# Prefer CATALYST_EVENTS_DIR when set (tests + non-default deployments);
# otherwise derive from the baseline file's directory.
CURRENT_DIR="${CATALYST_EVENTS_DIR:-$(dirname "$START_FILE")}"
CURRENT_FILE="${CURRENT_DIR}/${CURRENT_MONTH}.jsonl"

# Stream the matching event lines to stdout for processing.
stream_events() {
  if [ "$START_FILE" = "$CURRENT_FILE" ]; then
    if [ -f "$START_FILE" ]; then
      tail -n +$((START_CURSOR + 1)) "$START_FILE"
    fi
  else
    # Month rollover: tail the baseline file from cursor+1, then the current
    # file from the beginning.
    [ -f "$START_FILE" ]   && tail -n +$((START_CURSOR + 1)) "$START_FILE"
    [ -f "$CURRENT_FILE" ] && cat "$CURRENT_FILE"
  fi
}

# Match the canonical event-name regex from broker/index.mjs:1302.
# phase.<phase>.<status>.<ticket>
PHASE_REGEX='^phase\.([^.]+)\.(complete|failed|turn-cap-exhausted|skipped)\.([A-Za-z][A-Za-z0-9_]*-[0-9]+)$'

REVIVE_TRIGGERED=0  # we only need to invoke revive ONCE per replay regardless
                    # of how many failed/turn-cap events we see — revive scans
                    # all workers itself.

while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue

  # Extract event name. Tolerate malformed JSON lines by skipping with stderr.
  NAME=$(echo "$LINE" | jq -r '.attributes."event.name" // .name // ""' 2>/dev/null)
  if [ -z "$NAME" ]; then
    # Could be malformed JSON or non-OTel envelope. Warn and continue.
    if ! echo "$LINE" | jq -e . >/dev/null 2>&1; then
      echo "WARN: skipping malformed event-log line" >&2
    fi
    continue
  fi

  # Quick prefix check before the regex.
  case "$NAME" in
    phase.*) ;;
    *) continue ;;
  esac

  if [[ "$NAME" =~ $PHASE_REGEX ]]; then
    PHASE_NAME="${BASH_REMATCH[1]}"
    STATUS="${BASH_REMATCH[2]}"
    TICKET="${BASH_REMATCH[3]}"
  else
    continue
  fi

  # Filter out cross-orchestrator tickets.
  IN_ORCH=$(echo "$ACTIVE_TICKETS_JSON" | jq --arg t "$TICKET" 'index($t) != null' 2>/dev/null)
  [ "$IN_ORCH" = "true" ] || continue

  case "$STATUS" in
    complete|skipped)
      # CTL-512: skipped is terminal-equivalent for routing — phase-advance
      # no-ops on monitor-deploy. Coalescing under one arm avoids divergent
      # dispatch paths for two statuses that share a handler.
      if [ -x "$ADVANCE_BIN" ]; then
        "$ADVANCE_BIN" --orch-dir "$ORCH_DIR" --orch-id "$ORCH_ID" \
          --ticket "$TICKET" --completed-phase "$PHASE_NAME" >/dev/null 2>&1 || true
      fi
      ;;
    failed|turn-cap-exhausted)
      # orchestrate-revive scans all workers itself; we only need to invoke
      # it once. Coalescing multiple failed/turn-cap events into a single
      # invocation matches the live broker wake-handler behavior in
      # orchestrate/SKILL.md (one revive call per wake regardless of how
      # many failed workers).
      if [ "$REVIVE_TRIGGERED" -eq 0 ] && [ -x "$REVIVE_BIN" ]; then
        "$REVIVE_BIN" --orch-dir "$ORCH_DIR" --orch-id "$ORCH_ID" \
          >/dev/null 2>&1 || true
        REVIVE_TRIGGERED=1
      fi
      ;;
  esac
done < <(stream_events)

exit 0
