#!/usr/bin/env bash
# catalyst-state.sh — Manage global orchestrator state at ~/catalyst/state.json
#
# Provides flock-protected read-modify-write for concurrent orchestrators and workers.
# Also manages the append-only event log at ~/catalyst/events/YYYY-MM.jsonl
# and history archival at ~/catalyst/history/.
#
# Usage:
#   catalyst-state.sh init                                    Initialize state file if missing
#   catalyst-state.sh register <orch-id> <json>               Register a new orchestrator
#   catalyst-state.sh update <orch-id> <jq-filter>            Update orchestrator fields
#   catalyst-state.sh worker <orch-id> <ticket-id> <jq-filter> Update a worker entry
#   catalyst-state.sh heartbeat <orch-id>                     Update lastHeartbeat timestamp
#   catalyst-state.sh attention <orch-id> <type> <ticket> <msg> Add attention item
#   catalyst-state.sh resolve-attention <orch-id> <ticket>    Remove attention for a ticket
#   catalyst-state.sh event <json>                            Append event to the log
#   catalyst-state.sh archive <orch-id>                       Move orchestrator to history
#   catalyst-state.sh gc [--stale-after <minutes>] [--events-older-than <months>]  Garbage collect
#   catalyst-state.sh status [--project <key>]                Print summary of active orchestrators
#   catalyst-state.sh query <jq-filter>                       Run a jq query against state.json
#   catalyst-state.sh events [--last <n>] [--ticket <id>] [--type <event-type>]  Query events

set -euo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
STATE_FILE="${CATALYST_STATE_FILE:-$CATALYST_DIR/state.json}"
LOCK_FILE="${STATE_FILE}.lock"
EVENTS_DIR="${CATALYST_DIR}/events"
HISTORY_DIR="${CATALYST_DIR}/history"
RUNS_DIR="${CATALYST_DIR}/runs"
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

# ─── Helpers ──────────────────────────────────────────────────────────────────

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

ensure_dirs() {
  mkdir -p "$CATALYST_DIR" "$EVENTS_DIR" "$HISTORY_DIR" "$RUNS_DIR"
}

# Print the resolved per-orchestrator runs directory for a given orch-id.
# Does not create anything on disk — callers that need the directory should use
# `cmd_ensure_run_dir`.
cmd_run_dir() {
  local orch_id="${1:-}"
  if [[ -z "$orch_id" ]]; then
    echo "error: run-dir requires an orch-id argument" >&2
    return 1
  fi
  echo "${RUNS_DIR}/${orch_id}"
}

# Idempotently create the per-orchestrator runs layout:
#   ~/catalyst/runs/<orch-id>/workers/output/
cmd_ensure_run_dir() {
  local orch_id="${1:-}"
  if [[ -z "$orch_id" ]]; then
    echo "error: ensure-run-dir requires an orch-id argument" >&2
    return 1
  fi
  ensure_dirs
  mkdir -p "${RUNS_DIR}/${orch_id}/workers/output"
  echo "${RUNS_DIR}/${orch_id}"
}

ensure_state_file() {
  ensure_dirs
  if [[ ! -f "$STATE_FILE" ]]; then
    cat > "$STATE_FILE" <<'INIT'
{
  "version": "1.0.0",
  "lastUpdated": "",
  "orchestrators": {}
}
INIT
    jq --arg now "$(now_iso)" '.lastUpdated = $now' "$STATE_FILE" > "${STATE_FILE}.tmp" \
      && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
}

# Portable lock acquire/release using mkdir (atomic on all POSIX systems).
# Falls back to flock on Linux where available.
lock_acquire() {
  local max_wait=10
  local waited=0
  while ! mkdir "$LOCK_FILE" 2>/dev/null; do
    if [[ $waited -ge $max_wait ]]; then
      echo "error: failed to acquire state lock after ${max_wait}s" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  trap 'rmdir "$LOCK_FILE" 2>/dev/null' EXIT
}

lock_release() {
  rmdir "$LOCK_FILE" 2>/dev/null || true
  trap - EXIT
}

# Lock-protected read-modify-write on state.json
# $1: jq filter (receives $now as a bound variable)
state_write() {
  local jq_filter="$1"
  shift
  ensure_state_file
  lock_acquire
  jq --arg now "$(now_iso)" "$@" \
     "${jq_filter} | .lastUpdated = \$now" \
     "$STATE_FILE" > "${STATE_FILE}.tmp" \
  && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  lock_release
}

# Append a single JSON line to the current month's event log.
# No locking needed — POSIX atomic append for small writes.
event_append() {
  local event_json="$1"
  ensure_dirs
  local month_file="${EVENTS_DIR}/$(date -u +%Y-%m).jsonl"
  echo "$event_json" >> "$month_file"
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_init() {
  ensure_state_file
  echo "Initialized $STATE_FILE"
}

cmd_register() {
  local orch_id="$1"
  local orch_json="$2"

  # Merge the provided JSON into the orchestrators map
  state_write \
    '.orchestrators[$id] = ($orch | fromjson) | .orchestrators[$id].updatedAt = $now | .orchestrators[$id].lastHeartbeat = $now' \
    --arg id "$orch_id" \
    --arg orch "$orch_json"

  # Emit event
  local tickets
  tickets=$(echo "$orch_json" | jq -c '[.workers // {} | keys[]]')
  event_append "$(jq -nc \
    --arg ts "$(now_iso)" \
    --arg orch "$orch_id" \
    --argjson tickets "$tickets" \
    '{ts: $ts, orchestrator: $orch, worker: null, event: "orchestrator-started", detail: {tickets: $tickets}}')"
}

cmd_update() {
  local orch_id="$1"
  local jq_filter="$2"
  shift 2

  state_write \
    ".orchestrators[\$id] |= (${jq_filter} | .updatedAt = \$now)" \
    --arg id "$orch_id" \
    "$@"
}

cmd_worker() {
  local orch_id="$1"
  local ticket_id="$2"
  local jq_filter="$3"
  shift 3

  state_write \
    ".orchestrators[\$oid].workers[\$tid] |= (${jq_filter} | .updatedAt = \$now) | .orchestrators[\$oid].updatedAt = \$now" \
    --arg oid "$orch_id" \
    --arg tid "$ticket_id" \
    "$@"
}

cmd_heartbeat() {
  local orch_id="$1"

  state_write \
    '.orchestrators[$id].lastHeartbeat = $now | .orchestrators[$id].updatedAt = $now' \
    --arg id "$orch_id"
}

cmd_attention() {
  local orch_id="$1"
  local attn_type="$2"
  local ticket_id="$3"
  local message="$4"

  # Add attention item to the orchestrator and mark the worker
  state_write \
    '.orchestrators[$oid].attention = ([{type: $atype, ticketId: $tid, message: $msg, since: $now}] + .orchestrators[$oid].attention)
     | .orchestrators[$oid].workers[$tid].needsAttention = true
     | .orchestrators[$oid].workers[$tid].attentionReason = $msg
     | .orchestrators[$oid].updatedAt = $now' \
    --arg oid "$orch_id" \
    --arg atype "$attn_type" \
    --arg tid "$ticket_id" \
    --arg msg "$message"

  # Emit event
  event_append "$(jq -nc \
    --arg ts "$(now_iso)" \
    --arg orch "$orch_id" \
    --arg worker "$ticket_id" \
    --arg atype "$attn_type" \
    --arg msg "$message" \
    '{ts: $ts, orchestrator: $orch, worker: $worker, event: "attention-raised", detail: {attentionType: $atype, reason: $msg}}')"
}

cmd_resolve_attention() {
  local orch_id="$1"
  local ticket_id="$2"

  state_write \
    '.orchestrators[$oid].attention = [.orchestrators[$oid].attention[] | select(.ticketId != $tid)]
     | .orchestrators[$oid].workers[$tid].needsAttention = false
     | .orchestrators[$oid].workers[$tid].attentionReason = null
     | .orchestrators[$oid].updatedAt = $now' \
    --arg oid "$orch_id" \
    --arg tid "$ticket_id"

  # Emit event
  event_append "$(jq -nc \
    --arg ts "$(now_iso)" \
    --arg orch "$orch_id" \
    --arg worker "$ticket_id" \
    '{ts: $ts, orchestrator: $orch, worker: $worker, event: "attention-resolved", detail: null}')"
}

cmd_event() {
  local event_json="$1"
  event_append "$event_json"
}

cmd_archive() {
  local orch_id="$1"

  ensure_dirs
  lock_acquire

  # Extract the orchestrator entry
  local started_at
  started_at=$(jq -r ".orchestrators[\"$orch_id\"].startedAt // empty" "$STATE_FILE")
  if [[ -z "$started_at" ]]; then
    lock_release
    echo "error: orchestrator '$orch_id' not found in state" >&2
    return 1
  fi

  # Sanitize timestamp for filename (replace colons)
  local ts_safe="${started_at//:/-}"

  # Write to history
  jq ".orchestrators[\"$orch_id\"]" "$STATE_FILE" > "${HISTORY_DIR}/${orch_id}--${ts_safe}.json"

  # Remove from active state
  jq --arg now "$(now_iso)" --arg id "$orch_id" \
     'del(.orchestrators[$id]) | .lastUpdated = $now' \
     "$STATE_FILE" > "${STATE_FILE}.tmp" \
  && mv "${STATE_FILE}.tmp" "$STATE_FILE"

  lock_release

  # Emit event
  event_append "$(jq -nc \
    --arg ts "$(now_iso)" \
    --arg orch "$orch_id" \
    '{ts: $ts, orchestrator: $orch, worker: null, event: "archive", detail: null}')"

  echo "Archived $orch_id to ${HISTORY_DIR}/"
}

cmd_gc() {
  local stale_minutes=10
  local events_months=6

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stale-after) stale_minutes="$2"; shift 2 ;;
      --events-older-than) events_months="${2%m}"; shift 2 ;;  # strip trailing 'm' if present
      *) echo "Unknown gc flag: $1" >&2; return 1 ;;
    esac
  done

  ensure_state_file

  # Find and archive stale orchestrators (heartbeat older than threshold)
  local cutoff_ts
  cutoff_ts=$(date -u -v-${stale_minutes}M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "${stale_minutes} minutes ago" +%Y-%m-%dT%H:%M:%SZ)

  local stale_ids
  stale_ids=$(jq -r --arg cutoff "$cutoff_ts" \
    '.orchestrators | to_entries[]
     | select(.value.status == "active" and .value.lastHeartbeat < $cutoff)
     | .key' "$STATE_FILE")

  for id in $stale_ids; do
    echo "Marking stale orchestrator: $id"
    cmd_update "$id" '.status = "abandoned"'

    event_append "$(jq -nc \
      --arg ts "$(now_iso)" \
      --arg orch "$id" \
      '{ts: $ts, orchestrator: $orch, worker: null, event: "orchestrator-failed", detail: {reason: "heartbeat expired — presumed dead"}}')"

    # CTL-157: emit claude_code.session.outcome for the abandoned orchestrator.
    # Best-effort — the emitter silently no-ops if OTEL is unconfigured and
    # we swallow any failure so gc always completes archival.
    local emit_bin="${CATALYST_EMIT_OTEL_BIN:-$SCRIPT_DIR/emit-otel-event.sh}"
    if [[ -x "$emit_bin" ]]; then
      "$emit_bin" \
        --event "claude_code.session.outcome" \
        --outcome abandoned \
        --session-id "$id" \
        --reason "heartbeat expired — presumed dead" \
        >/dev/null 2>&1 || true
    fi

    cmd_archive "$id"
  done

  # Prune old event files
  local cutoff_month
  cutoff_month=$(date -u -v-${events_months}m +%Y-%m 2>/dev/null \
    || date -u -d "${events_months} months ago" +%Y-%m)

  for f in "$EVENTS_DIR"/*.jsonl; do
    [[ ! -f "$f" ]] && continue
    local basename
    basename=$(basename "$f" .jsonl)
    if [[ "$basename" < "$cutoff_month" ]]; then
      echo "Removing old event log: $f"
      rm "$f"
    fi
  done
}

cmd_status() {
  local project_filter=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) project_filter="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  ensure_state_file

  if [[ -n "$project_filter" ]]; then
    jq --arg proj "$project_filter" '
      .orchestrators | to_entries
      | map(select(.value.projectKey == $proj))
      | from_entries
      | to_entries[]
      | {
          id: .key,
          status: .value.status,
          progress: "\(.value.progress.completedTickets)/\(.value.progress.totalTickets) done",
          wave: "\(.value.progress.currentWave)/\(.value.progress.totalWaves)",
          attention: (.value.attention | length),
          lastHeartbeat: .value.lastHeartbeat
        }
    ' "$STATE_FILE"
  else
    jq '
      .orchestrators | to_entries[]
      | {
          id: .key,
          project: .value.projectKey,
          status: .value.status,
          progress: "\(.value.progress.completedTickets)/\(.value.progress.totalTickets) done",
          wave: "\(.value.progress.currentWave)/\(.value.progress.totalWaves)",
          attention: (.value.attention | length),
          lastHeartbeat: .value.lastHeartbeat
        }
    ' "$STATE_FILE"
  fi
}

cmd_query() {
  local jq_filter="$1"
  ensure_state_file
  jq "$jq_filter" "$STATE_FILE"
}

cmd_events() {
  local last_n=""
  local ticket_filter=""
  local type_filter=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --last) last_n="$2"; shift 2 ;;
      --ticket) ticket_filter="$2"; shift 2 ;;
      --type) type_filter="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  ensure_dirs

  # Concatenate all event files in chronological order
  local all_events
  all_events=$(cat "$EVENTS_DIR"/*.jsonl 2>/dev/null || true)

  if [[ -z "$all_events" ]]; then
    echo "No events found."
    return 0
  fi

  # Build jq filter
  local filter="."
  if [[ -n "$ticket_filter" ]]; then
    filter="${filter} | select(.worker == \"$ticket_filter\" or (.detail.tickets // [] | index(\"$ticket_filter\")))"
  fi
  if [[ -n "$type_filter" ]]; then
    filter="${filter} | select(.event == \"$type_filter\")"
  fi

  if [[ -n "$last_n" ]]; then
    echo "$all_events" | jq -s "[.[] | ${filter}] | .[-${last_n}:][]"
  else
    echo "$all_events" | jq "$filter"
  fi
}

# ─── Dispatch ─────────────────────────────────────────────────────────────────

cmd="${1:-help}"
shift || true

case "$cmd" in
  init)               cmd_init ;;
  register)           cmd_register "$@" ;;
  update)             cmd_update "$@" ;;
  worker)             cmd_worker "$@" ;;
  heartbeat)          cmd_heartbeat "$@" ;;
  attention)          cmd_attention "$@" ;;
  resolve-attention)  cmd_resolve_attention "$@" ;;
  event)              cmd_event "$@" ;;
  archive)            cmd_archive "$@" ;;
  gc)                 cmd_gc "$@" ;;
  status)             cmd_status "$@" ;;
  query)              cmd_query "$@" ;;
  events)             cmd_events "$@" ;;
  run-dir)            cmd_run_dir "$@" ;;
  ensure-run-dir)     cmd_ensure_run_dir "$@" ;;
  help|--help|-h)
    echo "Usage: catalyst-state.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  init                                    Initialize ~/catalyst/state.json"
    echo "  register <orch-id> <json>               Register a new orchestrator"
    echo "  update <orch-id> <jq-filter>            Update orchestrator fields"
    echo "  worker <orch-id> <ticket> <jq-filter>   Update a worker entry"
    echo "  heartbeat <orch-id>                     Update heartbeat timestamp"
    echo "  attention <orch-id> <type> <ticket> <msg>  Flag item for human attention"
    echo "  resolve-attention <orch-id> <ticket>    Clear attention for a ticket"
    echo "  event <json>                            Append event to the log"
    echo "  archive <orch-id>                       Move orchestrator to history"
    echo "  gc [--stale-after <min>] [--events-older-than <months>]  Clean up"
    echo "  status [--project <key>]                Print active orchestrator summary"
    echo "  query <jq-filter>                       Run jq query against state.json"
    echo "  events [--last <n>] [--ticket <id>] [--type <event-type>]  Query events"
    echo "  run-dir <orch-id>                       Print ~/catalyst/runs/<id>/ path"
    echo "  ensure-run-dir <orch-id>                Create ~/catalyst/runs/<id>/workers/output/"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Run 'catalyst-state.sh help' for usage." >&2
    exit 1
    ;;
esac
