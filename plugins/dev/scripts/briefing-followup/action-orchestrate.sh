#!/usr/bin/env bash
# action-orchestrate.sh — Dispatch a /catalyst-dev:orchestrate run for a ticket.
#
# Usage:
#   action-orchestrate.sh --ticket TICKET-ID [--bg] [--worker-args ARGS]
#
# Modes:
#   default — synchronous: invoke `claude -p /catalyst-dev:orchestrate TICKET`,
#             parse stdout for an orch_<...> identifier.
#   --bg    — background: nohup ... & with stdout redirected to a log file
#             we tail briefly for the orch_id.
#
# Output (stdout, JSON one-liner):
#   {"orchestrator_id":"orch_abc123","status":"dispatched"}
# or on soft-skip:
#   {"status":"skipped","reason":"..."}
#
# Soft-skip when the claude CLI (or CATALYST_DISPATCH_CLAUDE_BIN override) is
# not on PATH.

set -uo pipefail

TICKET=""
BG=0
WORKER_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket)       TICKET="$2"; shift 2 ;;
    --bg)           BG=1; shift ;;
    --worker-args)  WORKER_ARGS="$2"; shift 2 ;;
    -h|--help)      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "action-orchestrate.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TICKET" ]]; then
  echo "action-orchestrate.sh: --ticket is required" >&2
  exit 2
fi

CLAUDE_BIN="${CATALYST_DISPATCH_CLAUDE_BIN:-claude}"
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  jq -nc --arg reason "$CLAUDE_BIN not on PATH" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi

# CTL-495: tag OTEL stream as briefing-followup so Grafana cost can be sliced.
# shellcheck source=../lib/task-type.sh
. "$(dirname "$0")/../lib/task-type.sh"
__catalyst_append_task_type "briefing-followup"

COMMAND="/catalyst-dev:orchestrate $TICKET"
[[ -n "$WORKER_ARGS" ]] && COMMAND="$COMMAND $WORKER_ARGS"

extract_orch_id() {
  # Match orch_<id> in input; the dispatch helpers print this on success.
  grep -oE 'orch_[a-zA-Z0-9_]+' "$@" 2>/dev/null | head -n1
}

if [[ "$BG" -eq 1 ]]; then
  LOG_DIR="${TMPDIR:-/tmp}/catalyst-briefing-followup"
  mkdir -p "$LOG_DIR"
  LOG_FILE="$LOG_DIR/orchestrate-$TICKET-$(date -u +%Y%m%dT%H%M%SZ).log"
  nohup "$CLAUDE_BIN" -p "$COMMAND" --dangerously-skip-permissions \
    > "$LOG_FILE" 2>&1 </dev/null &
  BG_PID=$!
  # Briefly poll for the orch id — orchestrator dispatch typically prints it
  # within the first second or two.
  ORCH_ID=""
  for _ in 1 2 3 4 5; do
    sleep 1
    ORCH_ID=$(extract_orch_id "$LOG_FILE")
    [[ -n "$ORCH_ID" ]] && break
  done
  if [[ -z "$ORCH_ID" ]]; then
    jq -nc --arg pid "$BG_PID" --arg log "$LOG_FILE" \
      '{status: "dispatched-async", pid: $pid, log: $log}'
    exit 0
  fi
  jq -nc --arg id "$ORCH_ID" --arg pid "$BG_PID" --arg log "$LOG_FILE" \
    '{orchestrator_id: $id, pid: $pid, log: $log, status: "dispatched"}'
  exit 0
fi

# Synchronous dispatch — capture stdout AND stderr so failure reasons surface.
STDERR_FILE=$(mktemp -t action-orchestrate-stderr.XXXXXX)
OUT=$("$CLAUDE_BIN" -p "$COMMAND" --dangerously-skip-permissions 2>"$STDERR_FILE")
EXIT_CODE=$?
STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
rm -f "$STDERR_FILE"

ORCH_ID=$(printf '%s' "$OUT" | grep -oE 'orch_[a-zA-Z0-9_]+' | head -n1)

if [[ -z "$ORCH_ID" ]]; then
  REASON="no orch_id found in claude output (exit=$EXIT_CODE)"
  [[ -n "$STDERR_TAIL" ]] && REASON="${REASON}: ${STDERR_TAIL}"
  jq -nc --arg reason "$REASON" '{status: "failed", reason: $reason}'
  exit 1
fi

jq -nc --arg id "$ORCH_ID" '{orchestrator_id: $id, status: "dispatched"}'
