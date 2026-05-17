#!/usr/bin/env bash
# phase-emit-complete.sh — emit a `phase.<name>.<status>.<ticket>` canonical
# OTel event so the broker's phase_lifecycle router (CTL-447) wakes
# whichever orchestrator interest subscribed to this phase boundary.
#
# Sourceable helper used by greenfield phase-agent skills shipped in CTL-451
# (phase-triage, phase-monitor-deploy). It is intentionally the minimum
# correct surface — Phase 6 / CTL-448 will absorb a richer
# `phase-agent-emit-complete` script that also dispatches the next phase
# and updates signal files. Keeping this helper small means that future
# absorption is mechanical.
#
# Usage (after sourcing):
#   emit_phase_complete --phase <name> --ticket <id> \
#                       --status {complete|failed|skipped} \
#                       [--reason <text>] [--payload-json <json>]
#
# Required env (read; never required):
#   CATALYST_SESSION_ID        used for span_id derivation
#   CATALYST_ORCHESTRATOR_ID   used for trace_id derivation
#   CATALYST_EVENTS_FILE       test override; takes precedence over CATALYST_EVENTS_DIR
#   CATALYST_EVENTS_DIR        directory to append YYYY-MM.jsonl into
#                              (default: $CATALYST_DIR/events, default: $HOME/catalyst/events)

if [[ -n "${__CATALYST_PHASE_EMIT_SOURCED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__CATALYST_PHASE_EMIT_SOURCED=1

__PEC_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# canonical-event.sh provides build_canonical_line / canonical_jsonl_append /
# derive_trace_id / derive_span_id / plugin_version.
# shellcheck disable=SC1091
. "${__PEC_LIB_DIR}/canonical-event.sh"

emit_phase_complete() {
  local phase="" ticket="" status="" reason="" payload="null"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --phase)        phase="$2"; shift 2 ;;
      --ticket)       ticket="$2"; shift 2 ;;
      --status)       status="$2"; shift 2 ;;
      --reason)       reason="$2"; shift 2 ;;
      --payload-json) payload="${2:-null}"; shift 2 ;;
      *) echo "emit_phase_complete: unknown flag: $1" >&2; return 1 ;;
    esac
  done

  [[ -n "$phase"  ]] || { echo "emit_phase_complete: --phase required"  >&2; return 1; }
  [[ -n "$ticket" ]] || { echo "emit_phase_complete: --ticket required" >&2; return 1; }
  [[ -n "$status" ]] || { echo "emit_phase_complete: --status required" >&2; return 1; }

  case "$status" in
    complete|failed|skipped|turn-cap-exhausted) ;;
    *) echo "emit_phase_complete: --status must be complete|failed|skipped|turn-cap-exhausted" >&2; return 1 ;;
  esac

  local severity="INFO" event_name
  case "$status" in
    failed|turn-cap-exhausted) severity="WARN" ;;
  esac
  event_name="phase.${phase}.${status}.${ticket}"

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

  local trace_id span_id
  trace_id="$(derive_trace_id "${CATALYST_ORCHESTRATOR_ID:-}" "${CATALYST_SESSION_ID:-}")"
  span_id="$(derive_span_id "${ticket}" "${CATALYST_SESSION_ID:-}")"

  local message="$reason"
  if [[ -z "$message" ]]; then
    case "$status" in
      complete)           message="Phase ${phase} complete on ${ticket}" ;;
      failed)             message="Phase ${phase} failed on ${ticket}" ;;
      skipped)            message="Phase ${phase} skipped on ${ticket}" ;;
      turn-cap-exhausted) message="Phase ${phase} turn-cap-exhausted on ${ticket}" ;;
    esac
  fi

  # Merge {phase_name: <name>} into the payload so downstream consumers can
  # filter by phase without re-parsing event.name. The phase NAME is distinct
  # from catalyst.phase (the numeric phase index used by oneshot), so we don't
  # pass --phase to build_canonical_line.
  local enriched_payload
  if [[ "$payload" == "null" || -z "$payload" ]]; then
    enriched_payload="$(jq -nc --arg p "$phase" '{phase_name: $p}')"
  else
    enriched_payload="$(printf '%s' "$payload" | jq -c --arg p "$phase" '. + {phase_name: $p}')" || enriched_payload="$payload"
  fi

  local line
  line="$(build_canonical_line \
    --ts "$ts" \
    --severity "$severity" \
    --service "catalyst.phase-agent" \
    --event-name "$event_name" \
    --trace-id "$trace_id" \
    --span-id "$span_id" \
    --entity "phase" \
    --action "$status" \
    --linear-ticket "$ticket" \
    --orch "${CATALYST_ORCHESTRATOR_ID:-}" \
    --session "${CATALYST_SESSION_ID:-}" \
    --message "$message" \
    --payload-json "$enriched_payload")" || return 1

  # Test override: write the single line directly to the file.
  if [[ -n "${CATALYST_EVENTS_FILE:-}" ]]; then
    mkdir -p "$(dirname "$CATALYST_EVENTS_FILE")" 2>/dev/null || true
    printf '%s\n' "$line" >> "$CATALYST_EVENTS_FILE" || return 1
    return 0
  fi

  # Production: append into the configured events directory's month file.
  local events_dir
  events_dir="${CATALYST_EVENTS_DIR:-${CATALYST_DIR:-$HOME/catalyst}/events}"
  canonical_jsonl_append "$events_dir" "$line"
}

# When run as a script (not sourced), expose the function via CLI shimming so
# downstream callers without bash-source semantics can still invoke it.
# Detect script-mode by checking BASH_SOURCE[0] vs $0.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  emit_phase_complete "$@"
fi
