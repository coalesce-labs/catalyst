#!/usr/bin/env bash
# emit-worker-state-changed.sh — emit a canonical `worker.state_changed` event
# carrying the full new contents of a worker signal file (CTL-483 Phase 1
# dual-write).
#
# Sourceable helper. Best-effort: emission failures NEVER fail the caller —
# the direct write to workers/<TICKET>.json remains authoritative during
# Phase 1. The broker's projectWorkerState handler materializes the event
# to a SHADOW path (workers/<TICKET>.json.projected) so the verification
# cycle can confirm byte-for-byte agreement with the direct write before
# Phase 2 cuts the broker over to sole-writer at the canonical path.
#
# Usage (after sourcing):
#   emit_worker_state_changed <signal-path> <writer-name>
#
# Required env (read; never required):
#   CATALYST_SESSION_ID        used for span_id derivation
#   CATALYST_ORCHESTRATOR_ID   used for trace_id derivation (also overrides
#                              the signal-file orchestrator field if set)
#   CATALYST_EVENTS_FILE       test override; takes precedence over CATALYST_EVENTS_DIR
#   CATALYST_EVENTS_DIR        directory to append YYYY-MM.jsonl into
#                              (default: $CATALYST_DIR/events, default: $HOME/catalyst/events)

if [[ -n "${__CATALYST_EMIT_WSC_SOURCED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__CATALYST_EMIT_WSC_SOURCED=1

__EWSC_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# canonical-event.sh provides build_canonical_line / canonical_jsonl_append /
# derive_trace_id / derive_span_id.
# shellcheck disable=SC1091
. "${__EWSC_LIB_DIR}/canonical-event.sh"

emit_worker_state_changed() {
  local signal="${1:-}"
  local writer="${2:-unknown}"

  [[ -n "$signal" ]] || return 0
  [[ -r "$signal" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local ticket orchestrator state_json
  ticket="$(jq -r '.ticket // empty' "$signal" 2>/dev/null)" || return 0
  [[ -n "$ticket" ]] || return 0

  orchestrator="${CATALYST_ORCHESTRATOR_ID:-}"
  if [[ -z "$orchestrator" ]]; then
    orchestrator="$(jq -r '.orchestrator // empty' "$signal" 2>/dev/null)"
  fi
  [[ -n "$orchestrator" ]] || return 0

  state_json="$(cat "$signal" 2>/dev/null)" || return 0

  local payload
  payload="$(jq -nc \
    --arg ticket "$ticket" \
    --arg orchestrator "$orchestrator" \
    --arg writer "$writer" \
    --argjson state "$state_json" \
    '{ticket: $ticket, orchestrator: $orchestrator, writer: $writer, state: $state}')" || return 0

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

  local trace_id span_id
  trace_id="$(derive_trace_id "$orchestrator" "${CATALYST_SESSION_ID:-}")"
  span_id="$(derive_span_id "$ticket" "${CATALYST_SESSION_ID:-}")"

  local line
  line="$(build_canonical_line \
    --ts "$ts" \
    --severity "INFO" \
    --service "catalyst.orchestrator" \
    --event-name "worker.state_changed" \
    --trace-id "$trace_id" \
    --span-id "$span_id" \
    --entity "worker" \
    --action "state_changed" \
    --label "worker $ticket state changed by $writer" \
    --orch "$orchestrator" \
    --worker "$ticket" \
    --session "${CATALYST_SESSION_ID:-}" \
    --message "worker $ticket state changed by $writer" \
    --payload-json "$payload")" || return 0

  if [[ -n "${CATALYST_EVENTS_FILE:-}" ]]; then
    mkdir -p "$(dirname "$CATALYST_EVENTS_FILE")" 2>/dev/null || true
    printf '%s\n' "$line" >> "$CATALYST_EVENTS_FILE" 2>/dev/null || return 0
    return 0
  fi

  local events_dir
  events_dir="${CATALYST_EVENTS_DIR:-${CATALYST_DIR:-$HOME/catalyst}/events}"
  canonical_jsonl_append "$events_dir" "$line" 2>/dev/null || return 0
}

# When run as a script (not sourced), expose the function via CLI shimming.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  emit_worker_state_changed "$@"
fi
