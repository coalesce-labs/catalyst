#!/usr/bin/env bash
# orchestrate-roll-usage.sh — Roll a worker's final usage/cost into orch state.
#
# Reads the worker's stream-json output, extracts the final `result` event's
# usage/cost fields, and writes them to:
#   1. the worker's signal file              (.cost = USAGE)
#   2. state.json's per-worker entry         (.workers[ticket].usage = USAGE)
#   3. state.json's orchestrator-level total (.usage += USAGE)
#
# Idempotent: signal.cost being non-null is the marker that this worker has
# already been rolled. Safe to invoke from every monitor poll cycle for every
# worker — does work exactly once per worker, when its stream first contains
# a result event.
#
# No-op (exits 0) when:
#   - signal file missing
#   - stream file missing
#   - stream has no `result` event yet (worker still running, or died early)
#   - signal.cost already populated (already rolled)
#
# Exits non-zero only on truly broken input (missing required args).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_SCRIPT="${SCRIPT_DIR}/catalyst-state.sh"

usage() {
  cat >&2 <<'EOF'
usage: orchestrate-roll-usage.sh --orch <id> --ticket <id> [--orch-dir <dir>]

required:
  --orch <id>        orchestrator id (e.g. orch-ctl-115-116)
  --ticket <id>      worker ticket id (e.g. CTL-115)

optional:
  --orch-dir <dir>   override default ~/catalyst/runs/<orch>/

Reads ${ORCH_DIR}/workers/output/${TICKET}-stream.jsonl and
${ORCH_DIR}/workers/${TICKET}.json; writes signal.cost,
state.workers[ticket].usage, and rolls into state.usage.

Idempotent: no-op when signal.cost is already populated.
EOF
  exit 2
}

ORCH_ID="" TICKET_ID="" ORCH_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --orch)     ORCH_ID="$2"; shift 2 ;;
    --ticket)   TICKET_ID="$2"; shift 2 ;;
    --orch-dir) ORCH_DIR="$2"; shift 2 ;;
    -h|--help)  usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$ORCH_ID" ]   || usage
[ -n "$TICKET_ID" ] || usage
[ -n "$ORCH_DIR" ]  || ORCH_DIR="${HOME}/catalyst/runs/${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET_ID}.json"
STREAM_FILE="${ORCH_DIR}/workers/output/${TICKET_ID}-stream.jsonl"

# No-op gates — silent so the monitor loop doesn't spew per-pass.
[ -f "$SIGNAL_FILE" ] || exit 0
[ -f "$STREAM_FILE" ] || exit 0

# Idempotency: if signal already has .cost (non-null), nothing to do.
EXISTING=$(jq -r '.cost // "null"' "$SIGNAL_FILE")
[ "$EXISTING" = "null" ] || exit 0

# Extract final result event from the stream
RESULT_LINE=$(grep '"type":"result"' "$STREAM_FILE" | tail -1 || true)
[ -n "$RESULT_LINE" ] || exit 0

USAGE=$(echo "$RESULT_LINE" | jq -c '{
  inputTokens:         (.usage.input_tokens // 0),
  outputTokens:        (.usage.output_tokens // 0),
  cacheReadTokens:     (.usage.cache_read_input_tokens // 0),
  cacheCreationTokens: (.usage.cache_creation_input_tokens // 0),
  costUSD:             (.total_cost_usd // 0),
  numTurns:            (.num_turns // 0),
  durationMs:          (.duration_ms // 0),
  durationApiMs:       (.duration_api_ms // 0),
  model:               (.modelUsage | keys[0] // null)
}' 2>/dev/null || echo 'null')

[ "$USAGE" != "null" ] || exit 0

# 1. Mirror to signal file (atomic tmp+rename). Dashboard reads signal files,
#    not state.json, for per-worker cost columns.
jq --argjson cost "$USAGE" '.cost = $cost' "$SIGNAL_FILE" \
  > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"

# 2. Per-worker entry in global state. The state script handles its own lock.
"$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
  '.usage = $u' --argjson u "$USAGE" >/dev/null

# 3. Orchestrator-level aggregate.
"$STATE_SCRIPT" update "$ORCH_ID" \
  '.usage.inputTokens         += $u.inputTokens
   | .usage.outputTokens        += $u.outputTokens
   | .usage.cacheReadTokens     += $u.cacheReadTokens
   | .usage.cacheCreationTokens += $u.cacheCreationTokens
   | .usage.costUSD             += $u.costUSD
   | .usage.numTurns            += $u.numTurns
   | .usage.durationMs          += $u.durationMs
   | .usage.durationApiMs       += $u.durationApiMs' \
  --argjson u "$USAGE" >/dev/null
