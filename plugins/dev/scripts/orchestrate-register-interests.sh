#!/usr/bin/env bash
# orchestrate-register-interests.sh (CTL-491) — emit the four broker
# filter.register events (pr_lifecycle, ticket_lifecycle, comms_lifecycle,
# phase_lifecycle). Idempotent at the broker (upserts by interest_id).
#
# Hoisted out of plugins/dev/skills/orchestrate/SKILL.md Phase 4 so it can run
# BEFORE Phase 3 dispatches workers — the original ordering opened a race
# window where phase-agent completions landed in the event log with zero
# matching interests and were dropped by broker/index.mjs:1782.
#
# Usage:
#   orchestrate-register-interests.sh --orch-dir <path> --orch-id <id>
#                                     [--config <path>] [--refresh]
#
# Both modes emit all interests and stamp ${ORCH_DIR}/.last-registration.json
# with the current ticket set + ts. Phase 3 (CTL-491) extends --refresh with
# diff semantics; for now --refresh is equivalent to the unconditional path.
#
# Exit codes: 0 (success or broker-down no-op), 2 (bad args).
#
# Environment overrides (for tests):
#   CATALYST_STATE_SCRIPT  path to catalyst-state.sh (default: sibling)
#   PATH                   any fake catalyst-broker / catalyst-filter / gh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_SCRIPT="${CATALYST_STATE_SCRIPT:-${SCRIPT_DIR}/catalyst-state.sh}"

ORCH_DIR=""
ORCH_ID=""
CONFIG_PATH=""
REFRESH=0

usage() {
  sed -n '2,25p' "$0"
  exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --orch-dir) ORCH_DIR="$2"; shift 2 ;;
    --orch-id)  ORCH_ID="$2";  shift 2 ;;
    --config)   CONFIG_PATH="$2"; shift 2 ;;
    --refresh)  REFRESH=1; shift ;;
    -h|--help)  usage 0 ;;
    *)          echo "ERROR: unknown arg: $1" >&2; usage 2 ;;
  esac
done

[ -z "$ORCH_DIR" ] && { echo "ERROR: --orch-dir required" >&2; exit 2; }
[ -z "$ORCH_ID" ]  && { echo "ERROR: --orch-id required" >&2; exit 2; }
[ ! -d "$ORCH_DIR" ] && { echo "ERROR: orch-dir does not exist: $ORCH_DIR" >&2; exit 2; }

# Broker gate — same as the inline block in orchestrate/SKILL.md. If neither
# the broker nor the filter daemon is running, registration is a no-op
# (consumers fall back to direct catalyst-events wait-for).
if ! command -v catalyst-broker >/dev/null 2>&1 \
   && ! command -v catalyst-filter >/dev/null 2>&1; then
  exit 0
fi
if ! catalyst-broker status >/dev/null 2>&1 \
   && ! catalyst-filter status >/dev/null 2>&1; then
  exit 0
fi

# Read dispatchMode from config (default: oneshot-legacy — matches the
# original SKILL.md gate; phase_lifecycle interests only emit in phase-agents).
DISPATCH_MODE="oneshot-legacy"
if [ -n "$CONFIG_PATH" ] && [ -f "$CONFIG_PATH" ]; then
  DISPATCH_MODE=$(jq -r '.catalyst.orchestration.dispatchMode // "oneshot-legacy"' \
    "$CONFIG_PATH" 2>/dev/null || echo "oneshot-legacy")
fi

# Compute the active ticket / PR set from worker signal files.
shopt -s nullglob
WORKER_FILES=( "${ORCH_DIR}/workers/"*.json )
shopt -u nullglob

if [ ${#WORKER_FILES[@]} -gt 0 ]; then
  ACTIVE_PRS=$(jq -rs '[.[].pr.number // empty] | unique' "${WORKER_FILES[@]}" 2>/dev/null || echo '[]')
  ACTIVE_TICKETS=$(jq -rs '[.[].ticket // empty]' "${WORKER_FILES[@]}" 2>/dev/null || echo '[]')
  ACTIVE_BASES=$(jq -rs '[
    .[] | select(.pr.number != null and .pr.baseRefName != null)
        | {pr: .pr.number, base: .pr.baseRefName}
  ]' "${WORKER_FILES[@]}" 2>/dev/null || echo '[]')
else
  ACTIVE_PRS='[]'
  ACTIVE_TICKETS='[]'
  ACTIVE_BASES='[]'
fi

REPO_FULL_NAME=""
if command -v gh >/dev/null 2>&1; then
  REPO_FULL_NAME=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
fi

# ─── Refresh-mode diff (CTL-491 Phase 3) ────────────────────────────────────
# When --refresh is set AND a previous registration exists at
# .last-registration.json, diff the current active set against the prior set.
# If nothing changed, exit 0 without emitting events. Otherwise emit the 3
# deterministic interests AND a phase_lifecycle ONLY for newly-added tickets.
# If no baseline exists, --refresh behaves like the initial registration
# (emits everything) so a mid-run upgrade still produces durable interests.

LAST_FILE="${ORCH_DIR}/.last-registration.json"
EMIT_DETERMINISTIC=1
# Default phase_lifecycle emission set = all active tickets (initial mode).
PHASE_TICKETS_JSON="$ACTIVE_TICKETS"

if [ "$REFRESH" = "1" ] && [ -f "$LAST_FILE" ]; then
  LAST_PRS=$(jq -c '.prs // []' "$LAST_FILE" 2>/dev/null || echo '[]')
  LAST_TICKETS=$(jq -c '.tickets // []' "$LAST_FILE" 2>/dev/null || echo '[]')

  CUR_PRS_N=$(jq -cS '.' <<< "$ACTIVE_PRS" 2>/dev/null || echo "$ACTIVE_PRS")
  CUR_TKT_N=$(jq -cS '.' <<< "$ACTIVE_TICKETS" 2>/dev/null || echo "$ACTIVE_TICKETS")
  LAST_PRS_N=$(jq -cS '.' <<< "$LAST_PRS" 2>/dev/null || echo "$LAST_PRS")
  LAST_TKT_N=$(jq -cS '.' <<< "$LAST_TICKETS" 2>/dev/null || echo "$LAST_TICKETS")

  if [ "$CUR_PRS_N" = "$LAST_PRS_N" ] && [ "$CUR_TKT_N" = "$LAST_TKT_N" ]; then
    # Nothing changed — emit nothing, leave .last-registration.json alone.
    exit 0
  fi

  # Phase_lifecycle is emitted only for NEW tickets (the broker already has
  # interests for existing tickets via the initial pre-dispatch registration).
  PHASE_TICKETS_JSON=$(jq -c --argjson old "$LAST_TICKETS" '. - $old' \
    <<< "$ACTIVE_TICKETS" 2>/dev/null || echo "$ACTIVE_TICKETS")
fi

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

emit_event() {
  if [ -x "$STATE_SCRIPT" ]; then
    "$STATE_SCRIPT" event "$1" >/dev/null 2>&1 || true
  fi
}

# ─── Emit deterministic interests (pr / ticket / comms) ─────────────────────

emit_event "$(jq -nc \
  --arg orch "$ORCH_ID" \
  --arg id   "${ORCH_ID}-pr-lifecycle" \
  --arg notify "filter.wake.${ORCH_ID}" \
  --arg ts "$(now_iso)" \
  --arg repo "$REPO_FULL_NAME" \
  --argjson prs "$ACTIVE_PRS" \
  --argjson bases "$ACTIVE_BASES" \
  '{
    ts: $ts,
    event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $id,
      interest_type: "pr_lifecycle",
      notify_event: $notify,
      persistent: true,
      pr_numbers: $prs,
      repo: $repo,
      base_branches: $bases
    }
  }')"

emit_event "$(jq -nc \
  --arg orch "$ORCH_ID" \
  --arg id   "${ORCH_ID}-ticket-lifecycle" \
  --arg notify "filter.wake.${ORCH_ID}" \
  --arg ts "$(now_iso)" \
  --argjson tickets "$ACTIVE_TICKETS" \
  '{
    ts: $ts,
    event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $id,
      interest_type: "ticket_lifecycle",
      notify_event: $notify,
      persistent: true,
      tickets: $tickets,
      wake_on: ["status_done", "status_in_review", "status_changed"]
    }
  }')"

emit_event "$(jq -nc \
  --arg orch "$ORCH_ID" \
  --arg id   "${ORCH_ID}-comms-lifecycle" \
  --arg notify "filter.wake.${ORCH_ID}" \
  --arg ts "$(now_iso)" \
  --arg channel "$ORCH_ID" \
  --argjson workers "$ACTIVE_TICKETS" \
  '{
    ts: $ts,
    event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $id,
      interest_type: "comms_lifecycle",
      notify_event: $notify,
      persistent: true,
      channel: $channel,
      subscriber_kind: "orchestrator",
      owned_workers: $workers,
      types_of_interest: ["attention", "done"]
    }
  }')"

# ─── Emit phase_lifecycle interests (one per ticket, gated by mode) ─────────
# In --refresh mode, PHASE_TICKETS_JSON contains only newly-added tickets;
# in initial mode, it equals ACTIVE_TICKETS.

if [ "$DISPATCH_MODE" = "phase-agents" ]; then
  COUNT=$(jq 'length' <<< "$PHASE_TICKETS_JSON" 2>/dev/null || echo 0)
  if [ "$COUNT" -gt 0 ]; then
    while IFS= read -r T; do
      [ -z "$T" ] && continue
      emit_event "$(jq -nc \
        --arg orch "$ORCH_ID" \
        --arg id   "${ORCH_ID}-phase-lifecycle-${T}" \
        --arg notify "filter.wake.${ORCH_ID}" \
        --arg ts "$(now_iso)" \
        --arg ticket "$T" \
        --argjson phases '["triage","research","plan","implement","verify","review","pr","monitor-merge","monitor-deploy"]' \
        '{
          ts: $ts,
          event: "filter.register",
          orchestrator: $orch,
          worker: null,
          detail: {
            interest_id: $id,
            interest_type: "phase_lifecycle",
            notify_event: $notify,
            persistent: true,
            ticket: $ticket,
            phase_names: $phases
          }
        }')"
    done < <(jq -r '.[]' <<< "$PHASE_TICKETS_JSON")
  fi
fi

# ─── Write/update .last-registration.json ───────────────────────────────────
# Always rewrite on success so the Phase 4 refresh can diff against current.
TMP="${LAST_FILE}.tmp.$$"
jq -nc \
  --argjson prs "$ACTIVE_PRS" \
  --argjson tickets "$ACTIVE_TICKETS" \
  --arg ts "$(now_iso)" \
  '{prs: $prs, tickets: ($tickets | unique), registeredAt: $ts}' \
  > "$TMP" 2>/dev/null && mv "$TMP" "$LAST_FILE" || rm -f "$TMP"

exit 0
