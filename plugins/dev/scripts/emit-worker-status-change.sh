#!/usr/bin/env bash
# emit-worker-status-change.sh — central producer for worker phase / terminal events (CTL-229).
#
# Replaces the inline `jq -nc … event: "worker-status-change"` block in
# oneshot/SKILL.md's phase_transition helper. Adds three things on top of the
# old single-event-per-transition shape:
#
#   1. Severity tier (topic split):
#        worker-phase-advanced  — info-tier, coalescable, routine in-flight phases
#        worker-status-terminal — actionable, emitted immediately, with PR enrichment
#
#   2. Coalesce window (info-tier only): routine events arriving within
#      windowSec for the same orchestrator merge into a single emitted event
#      with .detail.changes: [{ts, worker, from, to}, …]. Default 30 s.
#
#   3. PR enrichment: when --to is in the PR-bearing terminal set
#      (pr-created, merging, merged, done, deploy-failed), the emitter reads
#      .pr.{number,url} from --signal-file and adds .detail.pr to the event.
#
# Subcommands:
#
#   emit-worker-status-change.sh emit \
#     --orch <id> --ticket <id> --from <s> --to <s> \
#     [--signal-file <path>] [--coalesce-window <sec>]
#
#   emit-worker-status-change.sh flush --orch <id>
#       Flush any pending coalesce queue for the given orchestrator. No-op if
#       the queue is empty. Used by orchestrator periodic sweeps and
#       end-of-orchestration cleanup so the last event in a sequence does not
#       linger past windowSec.
#
#   emit-worker-status-change.sh classify <to-status>
#       Print "terminal" or "info" for the given destination status. Helper
#       for tests and skill prose.
#
# Stragglers (the last event in a sequence) flush via the next emit OR an
# explicit flush call. We do NOT spawn a background flusher — the
# orchestrator's existing 10-min idle scan in orchestrate/SKILL.md Phase 4 is
# the documented contract for periodic flushing.
#
# All events are appended via catalyst-state.sh event <json>, the same path
# that previously emitted worker-status-change.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve symlinks (CTL-239 pattern) so installs that symlink the script work.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *)  SOURCE="$(cd "$(dirname "$SOURCE")" && pwd)/$TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
STATE_SCRIPT="${SCRIPT_DIR}/catalyst-state.sh"

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
COALESCE_DIR="${CATALYST_DIR}/coalesce"

# Default coalesce window. CLI --coalesce-window flag overrides; env var
# CATALYST_COALESCE_WINDOW_SEC overrides the built-in default but is itself
# overridden by the flag.
DEFAULT_WINDOW_SEC="${CATALYST_COALESCE_WINDOW_SEC:-30}"

# Terminal destination set — these states fire immediately and may carry
# PR enrichment. Anything else is info-tier and goes through the coalesce
# queue.
is_terminal() {
  case "$1" in
    pr-created|merging|merged|done|failed|stalled|deploy-failed|deploying)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# PR-bearing subset of terminal states — for these the emitter looks up
# .pr.{number,url} on the worker signal file and adds .detail.pr to the
# event. Other terminals (failed, stalled, deploying) never carry .detail.pr.
is_pr_bearing() {
  case "$1" in
    pr-created|merging|merged|done|deploy-failed) return 0 ;;
    *) return 1 ;;
  esac
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Convert ISO 8601 UTC timestamp to epoch seconds. Portable across macOS
# (BSD date) and Linux (GNU date) by stripping the trailing Z and using a
# format string both accept.
iso_to_epoch() {
  local iso="$1"
  # Strip trailing Z
  local naive="${iso%Z}"
  if date -j -u -f "%Y-%m-%dT%H:%M:%S" "$naive" +%s 2>/dev/null; then
    return
  fi
  # GNU date fallback
  date -u -d "${naive}Z" +%s
}

ensure_coalesce_dir() {
  mkdir -p "$COALESCE_DIR"
}

# mkdir-based atomic lock (same pattern as catalyst-state.sh). Spins for up
# to ~10 s waiting for the lock holder to release.
lock_acquire() {
  local lock_dir="$1"
  local i=0
  until mkdir "$lock_dir" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
      echo "emit-worker-status-change: timed out waiting for lock $lock_dir" >&2
      return 1
    fi
    sleep 0.1
  done
}

lock_release() {
  rmdir "$1" 2>/dev/null || true
}

# Append a JSON event to the event log via catalyst-state.sh. We pipe the
# JSON in to avoid bash quoting fragility.
append_event() {
  local event_json="$1"
  if [ -x "$STATE_SCRIPT" ]; then
    "$STATE_SCRIPT" event "$event_json"
  else
    # Fallback: write directly to the events file. Same path catalyst-state.sh
    # uses (CATALYST_EVENTS_DIR / YYYY-MM.jsonl, or CATALYST_EVENTS_FILE if
    # explicitly set, used by tests).
    local events_file
    if [ -n "${CATALYST_EVENTS_FILE:-}" ]; then
      events_file="$CATALYST_EVENTS_FILE"
    else
      events_file="${CATALYST_EVENTS_DIR:-$CATALYST_DIR/events}/$(date -u +%Y-%m).jsonl"
      mkdir -p "$(dirname "$events_file")"
    fi
    printf '%s\n' "$event_json" >> "$events_file"
  fi
}

# Flush the queue for an orchestrator if non-empty. Caller must hold the lock.
# Emits a worker-phase-advanced event with the accumulated changes and clears
# the queue file.
flush_queue_locked() {
  local orch="$1"
  local queue_file="${COALESCE_DIR}/${orch}.json"
  [ -f "$queue_file" ] || return 0

  local change_count
  change_count=$(jq '.changes | length' "$queue_file" 2>/dev/null || echo 0)
  if [ "$change_count" = "0" ] || [ -z "$change_count" ]; then
    rm -f "$queue_file"
    return 0
  fi

  local event_json
  event_json=$(jq -nc \
    --slurpfile q "$queue_file" \
    --arg ts "$(now_iso)" \
    '{
      ts: $ts,
      orchestrator: $q[0].orchestrator,
      worker: null,
      event: "worker-phase-advanced",
      detail: {
        windowSec: $q[0].windowSec,
        changes: $q[0].changes
      }
    }')
  append_event "$event_json"
  rm -f "$queue_file"
}

# ─── Subcommands ──────────────────────────────────────────────────────────

cmd_classify() {
  local to="${1:-}"
  if [ -z "$to" ]; then
    echo "usage: emit-worker-status-change.sh classify <to-status>" >&2
    return 2
  fi
  if is_terminal "$to"; then
    echo "terminal"
  else
    echo "info"
  fi
}

cmd_flush() {
  local orch=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --orch) orch="$2"; shift 2 ;;
      *) echo "flush: unknown arg: $1" >&2; return 2 ;;
    esac
  done
  if [ -z "$orch" ]; then
    echo "flush: --orch is required" >&2
    return 2
  fi
  ensure_coalesce_dir
  local lock_dir="${COALESCE_DIR}/${orch}.lock"
  lock_acquire "$lock_dir" || return 1
  flush_queue_locked "$orch"
  lock_release "$lock_dir"
}

cmd_emit() {
  local orch="" ticket="" from="" to="" signal_file=""
  local window_sec="$DEFAULT_WINDOW_SEC"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --orch)             orch="$2";        shift 2 ;;
      --ticket)           ticket="$2";      shift 2 ;;
      --from)             from="$2";        shift 2 ;;
      --to)               to="$2";          shift 2 ;;
      --signal-file)      signal_file="$2"; shift 2 ;;
      --coalesce-window)  window_sec="$2";  shift 2 ;;
      *) echo "emit: unknown arg: $1" >&2; return 2 ;;
    esac
  done

  if [ -z "$orch" ] || [ -z "$ticket" ] || [ -z "$from" ] || [ -z "$to" ]; then
    echo "emit: --orch, --ticket, --from, --to are required" >&2
    return 2
  fi

  ensure_coalesce_dir
  local lock_dir="${COALESCE_DIR}/${orch}.lock"
  lock_acquire "$lock_dir" || return 1

  local queue_file="${COALESCE_DIR}/${orch}.json"
  local now ts
  now=$(date -u +%s)
  ts=$(now_iso)

  # Step 1: if existing queue is stale, flush it before doing anything else.
  if [ -f "$queue_file" ]; then
    local q_start q_window q_start_epoch
    q_start=$(jq -r '.windowStartTs // empty' "$queue_file" 2>/dev/null || echo "")
    q_window=$(jq -r '.windowSec // 30' "$queue_file" 2>/dev/null || echo 30)
    if [ -n "$q_start" ]; then
      q_start_epoch=$(iso_to_epoch "$q_start" 2>/dev/null || echo 0)
      if [ -n "$q_start_epoch" ] && [ "$q_start_epoch" != "0" ]; then
        if [ "$((q_start_epoch + q_window))" -lt "$now" ]; then
          flush_queue_locked "$orch"
        fi
      fi
    fi
  fi

  if is_terminal "$to"; then
    # Flush any pending (non-stale) info-tier queue first so the order in the
    # log is "all preceding routine progress, then this terminal event".
    flush_queue_locked "$orch"

    # Build the terminal event payload.
    local detail_json="{\"from\": \"$from\", \"to\": \"$to\"}"
    if is_pr_bearing "$to" && [ -n "$signal_file" ] && [ -f "$signal_file" ]; then
      local pr_number pr_url
      pr_number=$(jq -r '.pr.number // empty' "$signal_file" 2>/dev/null || echo "")
      pr_url=$(jq -r '.pr.url // empty' "$signal_file" 2>/dev/null || echo "")
      if [ -n "$pr_number" ] && [ -n "$pr_url" ]; then
        detail_json=$(jq -nc \
          --arg from "$from" \
          --arg to "$to" \
          --argjson n "$pr_number" \
          --arg url "$pr_url" \
          '{from: $from, to: $to, pr: {number: $n, url: $url}}')
      fi
    fi

    local event_json
    event_json=$(jq -nc \
      --arg ts "$ts" \
      --arg orch "$orch" \
      --arg ticket "$ticket" \
      --argjson detail "$detail_json" \
      '{
        ts: $ts,
        orchestrator: $orch,
        worker: $ticket,
        event: "worker-status-terminal",
        detail: $detail
      }')
    append_event "$event_json"
  else
    # Info-tier: append change to coalesce queue. Start a new window if queue
    # is empty/missing.
    if [ ! -f "$queue_file" ]; then
      jq -nc \
        --arg orch "$orch" \
        --arg ts "$ts" \
        --argjson w "$window_sec" \
        --arg worker "$ticket" \
        --arg from "$from" \
        --arg to "$to" \
        '{
          schemaVersion: 1,
          orchestrator: $orch,
          windowStartTs: $ts,
          windowSec: $w,
          changes: [{ts: $ts, worker: $worker, from: $from, to: $to}]
        }' > "$queue_file"
    else
      # Append to existing queue. Preserve windowStartTs and windowSec.
      jq --arg ts "$ts" \
         --arg worker "$ticket" \
         --arg from "$from" \
         --arg to "$to" \
         '.changes += [{ts: $ts, worker: $worker, from: $from, to: $to}]' \
         "$queue_file" > "${queue_file}.tmp" && mv "${queue_file}.tmp" "$queue_file"
    fi
  fi

  lock_release "$lock_dir"
}

# ─── Dispatch ─────────────────────────────────────────────────────────────

main() {
  local cmd="${1:-}"
  if [ -z "$cmd" ]; then
    cat >&2 <<EOF
usage: emit-worker-status-change.sh <subcommand> [...]

subcommands:
  emit      --orch <id> --ticket <id> --from <s> --to <s>
            [--signal-file <path>] [--coalesce-window <sec>]
  flush     --orch <id>
  classify  <to-status>
EOF
    return 2
  fi
  shift
  case "$cmd" in
    emit)     cmd_emit "$@" ;;
    flush)    cmd_flush "$@" ;;
    classify) cmd_classify "$@" ;;
    -h|--help|help)
      cat <<EOF
emit-worker-status-change.sh — emit worker-phase-advanced / worker-status-terminal events.

  emit      Emit (or buffer) a phase transition.
  flush     Flush a pending coalesce queue.
  classify  Print "terminal" or "info" for a destination status.

Env:
  CATALYST_DIR                       base catalyst dir (default: \$HOME/catalyst)
  CATALYST_COALESCE_WINDOW_SEC       default coalesce window in seconds (default: 30)
  CATALYST_EVENTS_FILE               override events file path (used by tests)
EOF
      return 0 ;;
    *)
      echo "unknown subcommand: $cmd" >&2
      return 2 ;;
  esac
}

main "$@"
