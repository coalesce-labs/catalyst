#!/usr/bin/env bash
# orchestrate-status.sh — emit orchestrator.status self-status events (CTL-405)
#
# Usage:
#   orchestrate-status.sh emit \
#     --orch <orch-id> \
#     --phase <dispatching|monitoring|reviewing|paused> \
#     [--wave <n>] \
#     [--active <n>] \
#     [--total <n>] \
#     [--summary <text>] \
#     [--session <session-id>]
#
# Emits an orchestrator.status event to the event log via catalyst-state.sh.
# Best-effort: exits cleanly on missing dependencies.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_SCRIPT="${SCRIPT_DIR}/catalyst-state.sh"

if [[ ! -x "$STATE_SCRIPT" ]]; then
  echo "warn: catalyst-state.sh not found at ${STATE_SCRIPT} — status event skipped" >&2
  exit 0
fi

cmd_emit() {
  local orch="" phase="" wave="" active="" total="" summary="" session_id=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --orch)    orch="$2";       shift 2 ;;
      --phase)   phase="$2";     shift 2 ;;
      --wave)    wave="$2";      shift 2 ;;
      --active)  active="$2";    shift 2 ;;
      --total)   total="$2";     shift 2 ;;
      --summary) summary="$2";   shift 2 ;;
      --session) session_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Fall back to env vars for common fields
  orch="${orch:-${CATALYST_ORCHESTRATOR_ID:-}}"
  session_id="${session_id:-${CATALYST_SESSION_ID:-}}"

  if [[ -z "$orch" ]]; then
    echo "warn: --orch required for orchestrate-status emit — skipped" >&2
    exit 0
  fi
  if [[ -z "$phase" ]]; then
    echo "warn: --phase required for orchestrate-status emit — skipped" >&2
    exit 0
  fi

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local payload
  payload="$(jq -nc \
    --arg orch "$orch" \
    --arg phase "$phase" \
    --argjson wave "${wave:-null}" \
    --argjson active "${active:-null}" \
    --argjson total "${total:-null}" \
    --arg summary "$summary" \
    --arg session_id "$session_id" \
    '{
      orchestrator: $orch,
      phase: $phase,
      wave: $wave,
      active_workers: $active,
      total_workers: $total,
      summary: $summary,
      session_id: (if $session_id == "" then null else $session_id end)
    }')"

  "$STATE_SCRIPT" event "$(jq -nc \
    --arg ts "$ts" \
    --arg orch "$orch" \
    --argjson detail "$payload" \
    '{ts: $ts, orchestrator: $orch, worker: null, event: "orchestrator-status", detail: $detail}')" \
    2>/dev/null || true
}

CMD="${1:-}"
shift || true

case "$CMD" in
  emit) cmd_emit "$@" ;;
  *)
    echo "Usage: orchestrate-status.sh emit --orch <id> --phase <phase> [--wave <n>] [--active <n>] [--total <n>] [--summary <text>] [--session <id>]" >&2
    exit 1
    ;;
esac
