#!/usr/bin/env bash
# catalyst-session.sh — Lifecycle CLI for Catalyst agent sessions.
#
# Universal write interface that any skill (bash or otherwise) can call to
# report lifecycle events. Persists to the SQLite store via direct sqlite3
# calls (minimizes per-call overhead for the <50ms requirement) and dual-
# writes a JSONL event line to ~/catalyst/events/YYYY-MM.jsonl for tools
# that still consume the legacy event stream.
#
# Commands:
#   start --skill NAME [--ticket K] [--label L] [--workflow W] [--status S]
#       Create a new session and print the generated session id to stdout.
#   phase <session-id> <status> [--phase N]
#       Record a status/phase transition. Emits a `phase-changed` event.
#   metric <session-id> [--cost USD] [--input N] [--output N]
#                       [--cache-read N] [--cache-creation N] [--duration-ms N]
#       Update cost/token counters (upserts session_metrics row).
#   tool <session-id> <tool-name> [--duration MS]
#       Increment the tool usage histogram (defaults to 0ms).
#   iteration <session-id> --kind plan|fix [--by N]
#       Increment the plan-replan or implement-fix iteration counter.
#       Emits a `phase-iteration` event. Flushed to OTLP at session end.
#   pr <session-id> --number N --url URL [--ci STATUS]
#       Record PR creation. Emits a `pr-opened` event.
#   end <session-id> [--status done|failed] [--reason TEXT]
#       Mark the session complete. Emits a `session-ended` event AND a
#       `claude_code.session.outcome` OTLP log (CTL-157) carrying outcome,
#       session_id, linear.key, and optional reason for Loki/PromQL queries.
#   heartbeat <session-id>
#       Bump updated_at (and emit a `heartbeat` event to the JSONL log).
#   list [--active] [--skill NAME] [--ticket KEY] [--limit N]
#       List sessions as JSON. --active filters to status not in (done,failed).
#   read <session-id>
#       Print full session state (session + metrics + tools + events + prs).
#   history [--skill NAME] [--ticket KEY] [--since DATE] [--limit N]
#       List past sessions with optional filters. Defaults to limit 20.
#   stats [--skill NAME] [--since DATE]
#       Aggregate statistics: avg cost, duration, success rate, skill breakdown.
#   compare <session-id-1> <session-id-2>
#       Side-by-side comparison of two sessions.
#   status [--json]
#       Unified view of all active sessions with PID liveness checks.
#   restart [--exec] [--all | <session-id>...]
#       Find crashed sessions and offer resume commands. --exec runs them.
#
# Exit codes: 0 on success, 1 on argument or execution error. Reads print
# `null` + exit 1 when the session does not exist.

set -uo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"
EVENTS_DIR="${CATALYST_DIR}/events"
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

# Canonical OTel-shaped event helpers (CTL-300).
# shellcheck source=lib/canonical-event.sh
source "${SCRIPT_DIR}/lib/canonical-event.sh"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ─── SQL helpers (kept in sync with catalyst-db.sh) ─────────────────────────

sql_quote() {
  local s="${1:-}"
  printf "'%s'" "${s//\'/\'\'}"
}

sql_value_or_null() {
  if [[ -z "${1:-}" ]]; then printf 'NULL'; else sql_quote "$1"; fi
}

# Enable foreign keys on every connection (per-connection pragma).
db_exec()      { sqlite3 "$DB_FILE" -cmd "PRAGMA foreign_keys = ON;" "$@"; }
db_exec_json() { sqlite3 -json "$DB_FILE" -cmd "PRAGMA foreign_keys = ON;" "$@"; }

# Escape a string for embedding inside a JSON string literal. We use this
# for the JSONL event log to avoid a jq fork per write (saves ~15ms per call,
# which matters because the <50ms budget covers the whole hot path).
#
# Covers the common escapes inline; only forks `tr` when the input actually
# contains a C0 control char beyond \n\r\t\b\f (rare in lifecycle payloads).
json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  # Strip remaining C0 controls only when present — RFC 8259 forbids them raw
  # inside strings, so dropping is safer than emitting an invalid JSONL line.
  if [[ "$s" =~ [[:cntrl:]] ]]; then
    s=$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\016-\037')
  fi
  printf '%s' "$s"
}

# Lookup helper: read (workflow_id, ticket_key) for a session_id, used to
# derive trace/span IDs for canonical event emission. Returns "workflow|ticket"
# or "|" when the session row isn't yet visible.
__session_workflow_ticket() {
  local sid="$1"
  db_exec "SELECT COALESCE(workflow_id,'') || '|' || COALESCE(ticket_key,'')
           FROM sessions WHERE session_id = $(sql_quote "$sid") LIMIT 1;" 2>/dev/null \
    || printf '|'
}

# Map a legacy session event_type to canonical (event_name, entity, action,
# severity). Echoes "name entity action severity" — caller splits on space.
__session_canonical_for() {
  case "$1" in
    session-started) echo "session.started session started INFO" ;;
    phase-changed)   echo "session.phase session phase INFO" ;;
    phase-iteration) echo "session.iteration session iteration INFO" ;;
    pr-opened)       echo "session.pr_opened pr opened INFO" ;;
    session-ended)   echo "session.ended session ended INFO" ;;  # ERROR override applied at call site
    heartbeat)       echo "session.heartbeat session heartbeat DEBUG" ;;
    *)               echo "session.$1 session $1 INFO" ;;
  esac
}

# Write a canonical JSONL event line for a session event. Looks up the
# session row to derive trace/span IDs and additional attributes (vcs.pr.number
# from session_prs, catalyst.phase from the payload).
__session_emit_canonical() {
  local sid="$1" legacy_type="$2" payload="${3:-null}" ts="$4"
  local severity_override="${5:-}"

  command -v jq >/dev/null 2>&1 || return 0

  local mapping name entity action severity
  mapping="$(__session_canonical_for "$legacy_type")"
  read -r name entity action severity <<<"$mapping"
  [[ -n "$severity_override" ]] && severity="$severity_override"

  local row workflow ticket
  row="$(__session_workflow_ticket "$sid")"
  workflow="${row%%|*}"
  ticket="${row##*|}"

  local trace_id span_id
  trace_id="$(derive_trace_id "$workflow" "$sid")"
  span_id="$(derive_span_id "$ticket" "$sid")"

  # Pull catalyst.phase out of the payload if present (phase-changed event).
  local phase=""
  if [[ "$legacy_type" == "phase-changed" && "$payload" != "null" ]]; then
    phase="$(printf '%s' "$payload" | jq -r '.phase // ""' 2>/dev/null || true)"
  fi

  # Pull vcs.pr.number out for pr-opened.
  local vcs_pr=""
  local label="$sid"
  if [[ "$legacy_type" == "pr-opened" && "$payload" != "null" ]]; then
    vcs_pr="$(printf '%s' "$payload" | jq -r '.pr // ""' 2>/dev/null || true)"
    [[ -n "$vcs_pr" ]] && label="PR #${vcs_pr}"
  fi

  local extra_args=()
  [[ -n "$workflow" ]] && extra_args+=(--orch "$workflow")
  [[ -n "$ticket" ]] && extra_args+=(--worker "$ticket")
  [[ -n "$phase" ]] && extra_args+=(--phase "$phase")
  [[ -n "$vcs_pr" ]] && extra_args+=(--vcs-pr "$vcs_pr")

  local line
  line="$(build_canonical_line \
    --ts "$ts" \
    --severity "$severity" \
    --service catalyst.session \
    --event-name "$name" \
    --entity "$entity" \
    --action "$action" \
    --label "$label" \
    --trace-id "$trace_id" \
    --span-id "$span_id" \
    --session "$sid" \
    "${extra_args[@]}" \
    --payload-json "$payload" 2>/dev/null)" || return 0
  canonical_jsonl_append "$EVENTS_DIR" "$line"
}

# Insert an event row into session_events and append a canonical JSONL line.
emit_event() {
  local sid="$1" type="$2" payload="${3:-}"
  local ts; ts="$(now_iso)"

  db_exec "INSERT INTO session_events (session_id, event_type, payload, ts)
           VALUES ($(sql_quote "$sid"),
                   $(sql_quote "$type"),
                   $(sql_value_or_null "$payload"),
                   $(sql_quote "$ts"));"

  __session_emit_canonical "$sid" "$type" "${payload:-null}" "$ts"
}

# ─── Commands ───────────────────────────────────────────────────────────────

cmd_start() {
  local skill="" ticket="" label="" workflow="" status="running" explicit_pid="" cwd="" git_branch=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skill)    skill="$2"; shift 2 ;;
      --ticket)   ticket="$2"; shift 2 ;;
      --label)    label="$2"; shift 2 ;;
      --workflow) workflow="$2"; shift 2 ;;
      --status)   status="$2"; shift 2 ;;
      --pid)      explicit_pid="$2"; shift 2 ;;
      --cwd)      cwd="$2"; shift 2 ;;
      --branch)   git_branch="$2"; shift 2 ;;
      *) echo "error: unknown flag for start: $1" >&2; return 1 ;;
    esac
  done
  [[ -n "$skill" ]] || { echo "error: start requires --skill NAME" >&2; return 1; }

  # Generate a sortable, reasonably-unique session id without forking uuidgen
  # (uuidgen fork ~10ms, which we want to keep for the callers, not ourselves).
  local stamp rand sid
  stamp="$(date -u +%Y%m%dT%H%M%S)"
  rand=$(printf "%04x%04x" "$RANDOM" "$RANDOM")
  sid="sess_${stamp}_${rand}"

  local ts; ts="$(now_iso)"
  local pid="${explicit_pid:-$$}"

  db_exec "INSERT INTO sessions
             (session_id, workflow_id, ticket_key, label, skill_name, status, phase, pid, started_at, updated_at, cwd, git_branch)
           VALUES
             ($(sql_quote "$sid"),
              $(sql_value_or_null "$workflow"),
              $(sql_value_or_null "$ticket"),
              $(sql_value_or_null "$label"),
              $(sql_quote "$skill"),
              $(sql_quote "$status"),
              0,
              $pid,
              $(sql_quote "$ts"),
              $(sql_quote "$ts"),
              $(sql_value_or_null "$cwd"),
              $(sql_value_or_null "$git_branch"));"

  # start is not on the hot path (one-shot per session), so jq is fine here.
  local payload
  payload=$(jq -nc --arg skill "$skill" --arg ticket "$ticket" --arg label "$label" \
    --arg workflow "$workflow" --arg status "$status" \
    '{skill:$skill,
      ticket:(if $ticket == "" then null else $ticket end),
      label:(if $label == "" then null else $label end),
      workflow:(if $workflow == "" then null else $workflow end),
      status:$status}')
  emit_event "$sid" "session-started" "$payload"

  echo "$sid"
}

cmd_phase() {
  local sid="${1:-}" status="${2:-}"
  [[ -n "$sid" && -n "$status" ]] || { echo "error: phase requires <session-id> <status>" >&2; return 1; }
  shift 2 || true

  local phase=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --phase) phase="$2"; shift 2 ;;
      *) echo "error: unknown flag for phase: $1" >&2; return 1 ;;
    esac
  done

  # Guard phase to a non-negative integer if provided.
  if [[ -n "$phase" ]] && ! [[ "$phase" =~ ^[0-9]+$ ]]; then
    echo "error: --phase must be a non-negative integer" >&2; return 1
  fi

  local ts; ts="$(now_iso)"
  local set_clause="status = $(sql_quote "$status"), updated_at = $(sql_quote "$ts")"
  [[ -n "$phase" ]] && set_clause+=", phase = $phase"

  local payload
  if [[ -n "$phase" ]]; then
    payload="{\"to\":\"$(json_escape "$status")\",\"phase\":$phase}"
  else
    payload="{\"to\":\"$(json_escape "$status")\",\"phase\":null}"
  fi

  # Batch UPDATE + INSERT into a single sqlite3 call to halve connection overhead.
  db_exec "UPDATE sessions SET $set_clause WHERE session_id = $(sql_quote "$sid");
           INSERT INTO session_events (session_id, event_type, payload, ts)
           VALUES ($(sql_quote "$sid"), 'phase-changed',
                   $(sql_quote "$payload"), $(sql_quote "$ts"));"

  __session_emit_canonical "$sid" "phase-changed" "$payload" "$ts"
}

# Metric keys expose a stable CLI surface; internal column names live in METRIC_MAP.
# declare -A is bash 4+; macOS still ships bash 3.2, so use parallel arrays instead.
METRIC_FLAGS=(--cost --input --output --cache-read --cache-creation --duration-ms)
METRIC_COLS=(cost_usd input_tokens output_tokens cache_read_tokens cache_creation_tokens duration_ms)

metric_col_for_flag() {
  local flag="$1" i
  for i in "${!METRIC_FLAGS[@]}"; do
    if [[ "${METRIC_FLAGS[$i]}" == "$flag" ]]; then
      printf '%s' "${METRIC_COLS[$i]}"
      return 0
    fi
  done
  return 1
}

cmd_metric() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { echo "error: metric requires <session-id>" >&2; return 1; }
  shift

  local -a set_pairs=()
  while [[ $# -gt 0 ]]; do
    local col
    if col=$(metric_col_for_flag "$1"); then
      local val="$2"
      # Cost is REAL, others INTEGER — both accept the number literal unquoted.
      if ! [[ "$val" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
        echo "error: $1 requires a numeric argument" >&2; return 1
      fi
      set_pairs+=("${col} = ${val}")
      shift 2
    else
      echo "error: unknown flag for metric: $1" >&2; return 1
    fi
  done
  [[ ${#set_pairs[@]} -gt 0 ]] || { echo "error: metric requires at least one value flag" >&2; return 1; }

  local ts; ts="$(now_iso)"
  db_exec "INSERT OR IGNORE INTO session_metrics (session_id, updated_at)
           VALUES ($(sql_quote "$sid"), $(sql_quote "$ts"));"

  local set_clause="${set_pairs[0]}"
  local i
  for ((i=1; i<${#set_pairs[@]}; i++)); do set_clause+=", ${set_pairs[$i]}"; done
  set_clause+=", updated_at = $(sql_quote "$ts")"

  db_exec "UPDATE session_metrics SET $set_clause WHERE session_id = $(sql_quote "$sid");"
}

cmd_tool() {
  local sid="${1:-}" name="${2:-}"
  [[ -n "$sid" && -n "$name" ]] || { echo "error: tool requires <session-id> <tool-name>" >&2; return 1; }
  shift 2

  local duration=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --duration) duration="$2"; shift 2 ;;
      *) echo "error: unknown flag for tool: $1" >&2; return 1 ;;
    esac
  done
  [[ "$duration" =~ ^[0-9]+$ ]] || { echo "error: --duration must be a non-negative integer" >&2; return 1; }

  local ts; ts="$(now_iso)"
  db_exec "INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
           VALUES ($(sql_quote "$sid"), $(sql_quote "$name"), 1, $duration, $(sql_quote "$ts"))
           ON CONFLICT(session_id, tool_name) DO UPDATE SET
             call_count = call_count + 1,
             total_duration_ms = total_duration_ms + $duration,
             updated_at = $(sql_quote "$ts");"
}

cmd_iteration() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { echo "error: iteration requires <session-id>" >&2; return 1; }
  shift

  local kind="" by="1"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kind) kind="$2"; shift 2 ;;
      --by)   by="$2";   shift 2 ;;
      *) echo "error: unknown flag for iteration: $1" >&2; return 1 ;;
    esac
  done
  case "$kind" in
    plan|fix) ;;
    *) echo "error: iteration requires --kind plan|fix" >&2; return 1 ;;
  esac
  [[ "$by" =~ ^[0-9]+$ ]] || { echo "error: --by must be a non-negative integer" >&2; return 1; }

  local col="${kind}_iterations"
  local ts; ts="$(now_iso)"

  # Lazy-create the metrics row, then increment the chosen counter.
  db_exec "INSERT OR IGNORE INTO session_metrics (session_id, updated_at)
             VALUES ($(sql_quote "$sid"), $(sql_quote "$ts"));
           UPDATE session_metrics
             SET $col = $col + $by, updated_at = $(sql_quote "$ts")
             WHERE session_id = $(sql_quote "$sid");"

  # Read the fresh value so downstream tailers (orch-monitor) get the new count.
  local new_count
  new_count=$(db_exec "SELECT $col FROM session_metrics WHERE session_id = $(sql_quote "$sid");")

  local payload
  payload=$(jq -nc --arg k "$kind" \
    --argjson n "${new_count:-0}" --argjson by "$by" \
    '{kind:$k, count:$n, by:$by}')
  emit_event "$sid" "phase-iteration" "$payload"
}

cmd_pr() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { echo "error: pr requires <session-id>" >&2; return 1; }
  shift

  local number="" url="" ci=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --number) number="$2"; shift 2 ;;
      --url)    url="$2"; shift 2 ;;
      --ci)     ci="$2"; shift 2 ;;
      *) echo "error: unknown flag for pr: $1" >&2; return 1 ;;
    esac
  done
  [[ "$number" =~ ^[0-9]+$ ]] || { echo "error: --number must be an integer" >&2; return 1; }

  local ts; ts="$(now_iso)"

  local -a sets=()
  [[ -n "$url" ]] && sets+=("pr_url = $(sql_quote "$url")")
  [[ -n "$ci" ]]  && sets+=("ci_status = $(sql_quote "$ci")")
  sets+=("updated_at = $(sql_quote "$ts")")

  local set_clause="${sets[0]}"
  local i
  for ((i=1; i<${#sets[@]}; i++)); do set_clause+=", ${sets[$i]}"; done

  db_exec "INSERT INTO session_prs (session_id, pr_number, pr_url, ci_status, opened_at, updated_at)
           VALUES ($(sql_quote "$sid"), $number,
                   $(sql_value_or_null "$url"),
                   $(sql_value_or_null "$ci"),
                   $(sql_quote "$ts"),
                   $(sql_quote "$ts"))
           ON CONFLICT(session_id, pr_number) DO UPDATE SET $set_clause;"

  local payload
  payload=$(jq -nc --argjson n "$number" --arg url "$url" --arg ci "$ci" \
    '{pr:$n,
      url:(if $url == "" then null else $url end),
      ci:(if $ci == "" then null else $ci end)}')
  emit_event "$sid" "pr-opened" "$payload"
}

cmd_end() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { echo "error: end requires <session-id>" >&2; return 1; }
  shift

  local status="done" reason=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) status="$2"; shift 2 ;;
      --reason) reason="$2"; shift 2 ;;
      *) echo "error: unknown flag for end: $1" >&2; return 1 ;;
    esac
  done
  case "$status" in
    done|failed) ;;
    *) echo "error: --status must be 'done' or 'failed'" >&2; return 1 ;;
  esac

  local ts; ts="$(now_iso)"
  db_exec "UPDATE sessions
           SET status = $(sql_quote "$status"),
               completed_at = $(sql_quote "$ts"),
               updated_at = $(sql_quote "$ts")
           WHERE session_id = $(sql_quote "$sid");"

  local payload
  if [[ -n "$reason" ]]; then
    payload=$(jq -nc --arg s "$status" --arg r "$reason" '{status:$s,reason:$r}')
  else
    payload=$(jq -nc --arg s "$status" '{status:$s}')
  fi

  # CTL-300: session-ended uses ERROR severity for failed status; emit_event
  # writes INFO by default, so we override directly here.
  local end_ts; end_ts="$(now_iso)"
  db_exec "INSERT INTO session_events (session_id, event_type, payload, ts)
           VALUES ($(sql_quote "$sid"), 'session-ended',
                   $(sql_value_or_null "$payload"), $(sql_quote "$end_ts"));"
  local sev="INFO"
  [[ "$status" == "failed" ]] && sev="ERROR"
  __session_emit_canonical "$sid" "session-ended" "$payload" "$end_ts" "$sev"

  # CTL-157: emit claude_code.session.outcome to OTLP.
  local emit_bin="${CATALYST_EMIT_OTEL_BIN:-$SCRIPT_DIR/emit-otel-event.sh}"
  if [[ -x "$emit_bin" ]]; then
    local outcome
    case "$status" in
      done)   outcome="success" ;;
      failed) outcome="fail" ;;
    esac
    local args=(
      --event "claude_code.session.outcome"
      --outcome "$outcome"
      --session-id "$sid"
    )
    [[ -n "$reason" ]] && args+=(--reason "$reason")
    "$emit_bin" "${args[@]}" >/dev/null 2>&1 || true
  fi

  # CTL-158: flush iteration counters to OTLP.
  emit_iteration_metric "$sid"
}

emit_iteration_metric() {
  local sid="$1"
  local emit="${CATALYST_EMIT_METRIC:-$SCRIPT_DIR/emit-otel-metric.sh}"
  [[ -x "$emit" ]] || return 0

  local plan_count fix_count ticket started_at
  plan_count=$(db_exec "SELECT COALESCE(plan_iterations,0) FROM session_metrics WHERE session_id = $(sql_quote "$sid");")
  fix_count=$( db_exec "SELECT COALESCE(fix_iterations,0)  FROM session_metrics WHERE session_id = $(sql_quote "$sid");")
  ticket=$(    db_exec "SELECT COALESCE(ticket_key,'')     FROM sessions        WHERE session_id = $(sql_quote "$sid");")
  started_at=$(db_exec "SELECT started_at                  FROM sessions        WHERE session_id = $(sql_quote "$sid");")

  plan_count="${plan_count:-0}"
  fix_count="${fix_count:-0}"

  local start_s=""
  if [[ -n "$started_at" ]]; then
    start_s=$(date -ju -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" '+%s' 2>/dev/null \
           || date -u -d "$started_at" '+%s' 2>/dev/null \
           || echo "")
  fi
  local start_ns=""
  [[ -n "$start_s" ]] && start_ns="${start_s}000000000"

  "$emit" iteration_count --kind plan --count "$plan_count" --linear-key "$ticket" ${start_ns:+--start-ns "$start_ns"} 2>/dev/null || true
  "$emit" iteration_count --kind fix  --count "$fix_count"  --linear-key "$ticket" ${start_ns:+--start-ns "$start_ns"} 2>/dev/null || true
}

cmd_heartbeat() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { echo "error: heartbeat requires <session-id>" >&2; return 1; }

  local ts; ts="$(now_iso)"
  db_exec "UPDATE sessions SET updated_at = $(sql_quote "$ts")
           WHERE session_id = $(sql_quote "$sid");"

  # JSONL-only event; no need to bloat session_events with per-minute pings.
  __session_emit_canonical "$sid" "heartbeat" "null" "$ts" "DEBUG"
}

cmd_list() {
  local active=0 skill="" ticket="" limit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --active) active=1; shift ;;
      --skill)  skill="$2"; shift 2 ;;
      --ticket) ticket="$2"; shift 2 ;;
      --limit)  limit="$2"; shift 2 ;;
      *) echo "error: unknown flag for list: $1" >&2; return 1 ;;
    esac
  done

  local -a conds=()
  [[ $active -eq 1 ]] && conds+=("status NOT IN ('done','failed')")
  [[ -n "$skill" ]]  && conds+=("skill_name = $(sql_quote "$skill")")
  [[ -n "$ticket" ]] && conds+=("ticket_key = $(sql_quote "$ticket")")

  local where=""
  if [[ ${#conds[@]} -gt 0 ]]; then
    where="WHERE ${conds[0]}"
    local i
    for ((i=1; i<${#conds[@]}; i++)); do where+=" AND ${conds[$i]}"; done
  fi

  local lim=""
  if [[ -n "$limit" ]]; then
    [[ "$limit" =~ ^[0-9]+$ ]] || { echo "error: --limit must be an integer" >&2; return 1; }
    lim="LIMIT $limit"
  fi

  local out
  out=$(db_exec_json "SELECT * FROM sessions $where ORDER BY started_at DESC $lim;")
  [[ -z "$out" ]] && { echo '[]'; return 0; }
  echo "$out"
}

cmd_read() {
  local sid="${1:-}"
  [[ -n "$sid" ]] || { echo "error: read requires <session-id>" >&2; return 1; }

  local session metrics events tools prs
  session=$(db_exec_json "SELECT * FROM sessions WHERE session_id = $(sql_quote "$sid");")
  if [[ -z "$session" ]]; then
    # Missing session: print a structured null so callers can still parse.
    echo 'null'
    return 1
  fi
  session=$(echo "$session" | jq '.[0]')

  metrics=$(db_exec_json "SELECT * FROM session_metrics WHERE session_id = $(sql_quote "$sid");")
  metrics="${metrics:-[]}"
  metrics=$(echo "$metrics" | jq 'if length == 0 then null else .[0] end')

  events=$(db_exec_json "SELECT * FROM session_events WHERE session_id = $(sql_quote "$sid") ORDER BY event_id ASC;")
  events="${events:-[]}"

  tools=$(db_exec_json "SELECT * FROM session_tools WHERE session_id = $(sql_quote "$sid") ORDER BY tool_name ASC;")
  tools="${tools:-[]}"

  prs=$(db_exec_json "SELECT * FROM session_prs WHERE session_id = $(sql_quote "$sid") ORDER BY pr_number ASC;")
  prs="${prs:-[]}"

  jq -n \
    --argjson session "$session" \
    --argjson metrics "$metrics" \
    --argjson events "$events" \
    --argjson tools "$tools" \
    --argjson prs "$prs" \
    '{session:$session, metrics:$metrics, events:$events, tools:$tools, prs:$prs}'
}

cmd_history() {
  local skill="" ticket="" since="" limit="20"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skill)  skill="$2"; shift 2 ;;
      --ticket) ticket="$2"; shift 2 ;;
      --since)  since="$2"; shift 2 ;;
      --limit)  limit="$2"; shift 2 ;;
      *) echo "error: unknown flag for history: $1" >&2; return 1 ;;
    esac
  done
  [[ "$limit" =~ ^[0-9]+$ ]] || { echo "error: --limit must be an integer" >&2; return 1; }

  local -a conds=()
  [[ -n "$skill" ]]  && conds+=("skill_name = $(sql_quote "$skill")")
  [[ -n "$ticket" ]] && conds+=("ticket_key = $(sql_quote "$ticket")")
  [[ -n "$since" ]]  && conds+=("started_at >= $(sql_quote "$since")")

  local where=""
  if [[ ${#conds[@]} -gt 0 ]]; then
    where="WHERE ${conds[0]}"
    local i
    for ((i=1; i<${#conds[@]}; i++)); do where+=" AND ${conds[$i]}"; done
  fi

  local sql
  sql="SELECT s.session_id, s.skill_name, s.ticket_key, s.label, s.status, s.started_at, s.completed_at,
              COALESCE(m.cost_usd, 0) as cost_usd, COALESCE(m.duration_ms, 0) as duration_ms
       FROM sessions s
       LEFT JOIN session_metrics m ON m.session_id = s.session_id
       $where
       ORDER BY s.started_at DESC
       LIMIT $limit;"

  local out
  out=$(db_exec_json "$sql")
  [[ -z "$out" ]] && { echo '[]'; return 0; }
  echo "$out"
}

cmd_stats() {
  local skill="" since=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skill) skill="$2"; shift 2 ;;
      --since) since="$2"; shift 2 ;;
      *) echo "error: unknown flag for stats: $1" >&2; return 1 ;;
    esac
  done

  local -a conds=()
  [[ -n "$skill" ]] && conds+=("s.skill_name = $(sql_quote "$skill")")
  [[ -n "$since" ]] && conds+=("s.started_at >= $(sql_quote "$since")")

  local where=""
  if [[ ${#conds[@]} -gt 0 ]]; then
    where="WHERE ${conds[0]}"
    local i
    for ((i=1; i<${#conds[@]}; i++)); do where+=" AND ${conds[$i]}"; done
  fi

  local agg skill_breakdown daily_costs top_tools
  agg=$(db_exec_json "SELECT COUNT(*) as total_sessions,
                        SUM(COALESCE(m.cost_usd,0)) as total_cost,
                        AVG(COALESCE(m.cost_usd,0)) as avg_cost,
                        AVG(COALESCE(m.duration_ms,0)) as avg_duration,
                        SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END) as done_count,
                        SUM(CASE WHEN s.status='failed' THEN 1 ELSE 0 END) as failed_count
                      FROM sessions s LEFT JOIN session_metrics m ON m.session_id=s.session_id $where;")
  [[ -z "$agg" ]] && agg='[{"total_sessions":0}]'

  skill_breakdown=$(db_exec_json "SELECT COALESCE(s.skill_name,'unknown') as skill,
                                    COUNT(*) as count,
                                    SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END) as done_count,
                                    SUM(CASE WHEN s.status='failed' THEN 1 ELSE 0 END) as failed_count,
                                    SUM(COALESCE(m.cost_usd,0)) as total_cost,
                                    AVG(COALESCE(m.cost_usd,0)) as avg_cost,
                                    AVG(COALESCE(m.duration_ms,0)) as avg_duration
                                  FROM sessions s LEFT JOIN session_metrics m ON m.session_id=s.session_id
                                  $where GROUP BY COALESCE(s.skill_name,'unknown') ORDER BY total_cost DESC;")
  [[ -z "$skill_breakdown" ]] && skill_breakdown='[]'

  daily_costs=$(db_exec_json "SELECT DATE(s.started_at) as day,
                                SUM(COALESCE(m.cost_usd,0)) as cost,
                                COUNT(*) as session_count
                              FROM sessions s LEFT JOIN session_metrics m ON m.session_id=s.session_id
                              $where GROUP BY DATE(s.started_at) ORDER BY day ASC;")
  [[ -z "$daily_costs" ]] && daily_costs='[]'

  local tool_where=""
  if [[ ${#conds[@]} -gt 0 ]]; then
    tool_where="WHERE t.session_id IN (SELECT s.session_id FROM sessions s $where)"
  fi
  top_tools=$(db_exec_json "SELECT t.tool_name, SUM(t.call_count) as total_calls,
                              SUM(t.total_duration_ms) as total_duration_ms
                            FROM session_tools t
                            $tool_where
                            GROUP BY t.tool_name ORDER BY total_calls DESC LIMIT 20;")
  [[ -z "$top_tools" ]] && top_tools='[]'

  jq -n \
    --argjson agg "$agg" \
    --argjson skills "$skill_breakdown" \
    --argjson daily "$daily_costs" \
    --argjson tools "$top_tools" \
    '{aggregate: $agg[0], skillBreakdown: $skills, dailyCosts: $daily, topTools: $tools}'
}

cmd_compare() {
  local id1="${1:-}" id2="${2:-}"
  [[ -n "$id1" && -n "$id2" ]] || { echo "error: compare requires <session-id-1> <session-id-2>" >&2; return 1; }

  local s1 s2 t1 t2
  s1=$(db_exec_json "SELECT s.session_id, s.skill_name, s.ticket_key, s.status, s.started_at, s.completed_at,
                       COALESCE(m.cost_usd,0) as cost_usd, COALESCE(m.duration_ms,0) as duration_ms,
                       COALESCE(m.input_tokens,0) as input_tokens, COALESCE(m.output_tokens,0) as output_tokens,
                       COALESCE(m.cache_read_tokens,0) as cache_read_tokens
                     FROM sessions s LEFT JOIN session_metrics m ON m.session_id=s.session_id
                     WHERE s.session_id=$(sql_quote "$id1");")
  [[ -z "$s1" || "$s1" == "[]" ]] && { echo "error: session $id1 not found" >&2; return 1; }

  s2=$(db_exec_json "SELECT s.session_id, s.skill_name, s.ticket_key, s.status, s.started_at, s.completed_at,
                       COALESCE(m.cost_usd,0) as cost_usd, COALESCE(m.duration_ms,0) as duration_ms,
                       COALESCE(m.input_tokens,0) as input_tokens, COALESCE(m.output_tokens,0) as output_tokens,
                       COALESCE(m.cache_read_tokens,0) as cache_read_tokens
                     FROM sessions s LEFT JOIN session_metrics m ON m.session_id=s.session_id
                     WHERE s.session_id=$(sql_quote "$id2");")
  [[ -z "$s2" || "$s2" == "[]" ]] && { echo "error: session $id2 not found" >&2; return 1; }

  t1=$(db_exec_json "SELECT tool_name, call_count as total_calls, total_duration_ms
                     FROM session_tools WHERE session_id=$(sql_quote "$id1") ORDER BY call_count DESC;")
  [[ -z "$t1" ]] && t1='[]'

  t2=$(db_exec_json "SELECT tool_name, call_count as total_calls, total_duration_ms
                     FROM session_tools WHERE session_id=$(sql_quote "$id2") ORDER BY call_count DESC;")
  [[ -z "$t2" ]] && t2='[]'

  jq -n \
    --argjson s1 "$s1" --argjson s2 "$s2" \
    --argjson t1 "$t1" --argjson t2 "$t2" \
    '{left: ($s1[0] + {tools: $t1}), right: ($s2[0] + {tools: $t2})}'
}

time_ago() {
  local started="$1" now_epoch elapsed h m
  now_epoch=$(date -u +%s)
  if [[ "$OSTYPE" == darwin* ]]; then
    local started_epoch
    started_epoch=$(date -u -jf "%Y-%m-%dT%H:%M:%SZ" "$started" +%s 2>/dev/null || date -u +%s)
    elapsed=$(( now_epoch - started_epoch ))
  else
    local started_epoch
    started_epoch=$(date -u -d "$started" +%s 2>/dev/null || date -u +%s)
    elapsed=$(( now_epoch - started_epoch ))
  fi
  if (( elapsed < 60 )); then
    printf '%ds ago' "$elapsed"
  elif (( elapsed < 3600 )); then
    printf '%dm ago' $(( elapsed / 60 ))
  elif (( elapsed < 86400 )); then
    h=$(( elapsed / 3600 ))
    m=$(( (elapsed % 3600) / 60 ))
    if (( m > 0 )); then printf '%dh%dm ago' "$h" "$m"; else printf '%dh ago' "$h"; fi
  else
    printf '%dd ago' $(( elapsed / 86400 ))
  fi
}

truncate_str() {
  local s="$1" max="$2"
  if [[ ${#s} -gt $max ]]; then
    printf '%s…' "${s:0:$(( max - 1 ))}"
  else
    printf '%s' "$s"
  fi
}

cmd_status() {
  local json_mode=0 since="" show_all=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)  json_mode=1; shift ;;
      --since) since="$2"; shift 2 ;;
      --all)   show_all=1; shift ;;
      *) echo "error: unknown flag for status: $1" >&2; return 1 ;;
    esac
  done

  local since_clause=""
  if [[ $show_all -eq 0 && -z "$since" ]]; then
    since_clause="AND started_at >= datetime('now', '-24 hours')"
  elif [[ -n "$since" ]]; then
    since_clause="AND started_at >= $(sql_quote "$since")"
  fi

  local rows
  rows=$(db_exec_json "SELECT session_id, skill_name, ticket_key, label, status, phase,
                              pid, cwd, git_branch, started_at, updated_at
                       FROM sessions
                       WHERE status NOT IN ('done','failed') ${since_clause}
                       ORDER BY started_at DESC;")
  [[ -z "$rows" || "$rows" == "[]" ]] && rows='[]'

  local total alive crashed
  total=0; alive=0; crashed=0

  local enriched='[]'
  local count
  count=$(echo "$rows" | jq 'length')

  local i
  for (( i=0; i<count; i++ )); do
    local row pid is_alive
    row=$(echo "$rows" | jq ".[$i]")
    pid=$(echo "$row" | jq -r '.pid // ""')

    is_alive="false"
    if [[ -n "$pid" && "$pid" != "null" ]] && kill -0 "$pid" 2>/dev/null; then
      is_alive="true"
      alive=$(( alive + 1 ))
    else
      crashed=$(( crashed + 1 ))
    fi
    total=$(( total + 1 ))

    enriched=$(echo "$enriched" | jq --argjson row "$row" --argjson alive "$is_alive" \
      '. + [$row + {alive: $alive}]')
  done

  if [[ $json_mode -eq 1 ]]; then
    jq -n --argjson sessions "$enriched" \
           --argjson total "$total" --argjson alive "$alive" --argjson crashed "$crashed" \
      '{sessions: $sessions, summary: {total: $total, alive: $alive, crashed: $crashed}}'
    return 0
  fi

  if (( total == 0 )); then
    if [[ $show_all -eq 0 ]]; then
      echo "No active sessions in the last 24h. Use --all to see older sessions."
    else
      echo "No active sessions."
    fi
    return 0
  fi

  printf '%-12s %-24s %-14s %-5s %-42s %s\n' "TYPE" "LABEL" "STATUS" "PID" "CWD" "SINCE"
  printf '%-12s %-24s %-14s %-5s %-42s %s\n' "────────────" "────────────────────────" "──────────────" "─────" "──────────────────────────────────────────" "─────────"

  for (( i=0; i<count; i++ )); do
    local skill label status alive_val cwd started display_cwd since_str alive_mark
    skill=$(echo "$enriched" | jq -r ".[$i].skill_name // \"unknown\"")
    # Strip plugin prefix for display
    skill="${skill#catalyst-dev:}"
    skill="${skill#catalyst-pm:}"
    skill=$(truncate_str "$skill" 12)

    label=$(echo "$enriched" | jq -r ".[$i].label // .[$i].ticket_key // .[$i].session_id" | head -1)
    label=$(truncate_str "$label" 24)

    status=$(echo "$enriched" | jq -r ".[$i].status")
    status=$(truncate_str "$status" 14)

    alive_val=$(echo "$enriched" | jq -r ".[$i].alive")
    cwd=$(echo "$enriched" | jq -r ".[$i].cwd // \"\"")
    started=$(echo "$enriched" | jq -r ".[$i].started_at // \"\"")

    display_cwd="${cwd/#$HOME/\~}"
    display_cwd=$(truncate_str "$display_cwd" 42)

    since_str=""
    [[ -n "$started" && "$started" != "null" ]] && since_str=$(time_ago "$started")

    if [[ "$alive_val" == "true" ]]; then alive_mark="  ✓"; else alive_mark="  ✗"; fi

    printf '%-12s %-24s %-14s %-5s %-42s %s\n' \
      "$skill" "$label" "$status" "$alive_mark" "$display_cwd" "$since_str"
  done

  echo ""
  echo "${total} session(s): ${alive} alive, ${crashed} crashed"
  [[ $show_all -eq 0 ]] && echo "(last 24h — use --all for full history)"
}

cmd_restart() {
  local exec_mode=0 all_mode=0 target_ids=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --exec) exec_mode=1; shift ;;
      --all)  all_mode=1; shift ;;
      *)      target_ids+=("$1"); shift ;;
    esac
  done

  local rows
  rows=$(db_exec_json "SELECT session_id, skill_name, ticket_key, label, status, pid, cwd, started_at
                       FROM sessions
                       WHERE status NOT IN ('done','failed')
                       ORDER BY started_at DESC;")
  [[ -z "$rows" || "$rows" == "[]" ]] && { echo "No active sessions found."; return 0; }

  local crashed=()
  local count
  count=$(echo "$rows" | jq 'length')

  local i
  for (( i=0; i<count; i++ )); do
    local pid sid
    pid=$(echo "$rows" | jq -r ".[$i].pid // \"\"")
    sid=$(echo "$rows" | jq -r ".[$i].session_id")

    if [[ -n "$pid" && "$pid" != "null" ]] && kill -0 "$pid" 2>/dev/null; then
      continue
    fi

    if [[ $all_mode -eq 0 && ${#target_ids[@]} -gt 0 ]]; then
      local found=0
      for tid in "${target_ids[@]}"; do
        [[ "$sid" == "$tid" ]] && { found=1; break; }
      done
      [[ $found -eq 0 ]] && continue
    fi

    crashed+=("$i")
  done

  if [[ ${#crashed[@]} -eq 0 ]]; then
    echo "No crashed sessions found."
    return 0
  fi

  echo "Crashed sessions:"
  echo ""

  local resume_cmds=()
  local n=1
  for idx in "${crashed[@]}"; do
    local sid skill label cwd started claude_sid
    sid=$(echo "$rows" | jq -r ".[$idx].session_id")
    skill=$(echo "$rows" | jq -r ".[$idx].skill_name // \"unknown\"")
    label=$(echo "$rows" | jq -r ".[$idx].label // .[$idx].ticket_key // .[$idx].session_id" | head -1)
    cwd=$(echo "$rows" | jq -r ".[$idx].cwd // \"\"")
    started=$(echo "$rows" | jq -r ".[$idx].started_at // \"\"")

    local since_str=""
    [[ -n "$started" && "$started" != "null" ]] && since_str=" ($(time_ago "$started"))"

    claude_sid=""
    if [[ -n "$cwd" && "$cwd" != "null" && -f "${cwd}/.catalyst/.session-id" ]]; then
      claude_sid=$(cat "${cwd}/.catalyst/.session-id" 2>/dev/null || true)
    fi

    local display_cwd="${cwd/#$HOME/\~}"

    printf '  %d. %s %s%s\n' "$n" "$skill" "$label" "$since_str"
    printf '     cwd: %s\n' "$display_cwd"

    if [[ -n "$claude_sid" ]]; then
      local cmd="cd ${display_cwd} && claude --resume ${claude_sid}"
      printf '     resume: %s\n' "$cmd"
      resume_cmds+=("cd ${cwd} && claude --resume ${claude_sid}")
    else
      printf '     resume: no Claude session ID found — mark as failed\n'
      resume_cmds+=("")
    fi
    echo ""
    n=$(( n + 1 ))
  done

  if [[ $exec_mode -eq 1 ]]; then
    local executed=0
    for ((j=0; j<${#crashed[@]}; j++)); do
      local cmd="${resume_cmds[$j]}"
      local idx="${crashed[$j]}"
      local sid
      sid=$(echo "$rows" | jq -r ".[$idx].session_id")

      if [[ -z "$cmd" ]]; then
        db_exec "UPDATE sessions SET status='failed', completed_at=$(sql_quote "$(now_iso)")
                 WHERE session_id=$(sql_quote "$sid");"
        echo "  Marked ${sid} as failed (no resumable session)"
      else
        echo "  Resuming: ${cmd}"
        eval "$cmd" &
        disown
        executed=$(( executed + 1 ))
      fi
    done
    echo ""
    echo "Executed ${executed} resume(s). Use 'catalyst-session.sh status' to check."
  else
    echo "To restart, run:  catalyst-session.sh restart --exec --all"
    echo "Or resume individually with the commands above."
  fi
}

usage() {
  sed -n '/^# Commands:/,/^# Exit codes:/p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#$//'
}

# ─── Dispatch ───────────────────────────────────────────────────────────────

cmd="${1:-help}"
shift || true

case "$cmd" in
  start)     cmd_start "$@" ;;
  phase)     cmd_phase "$@" ;;
  metric)    cmd_metric "$@" ;;
  tool)      cmd_tool "$@" ;;
  iteration) cmd_iteration "$@" ;;
  pr)        cmd_pr "$@" ;;
  end)       cmd_end "$@" ;;
  heartbeat) cmd_heartbeat "$@" ;;
  list)      cmd_list "$@" ;;
  read)      cmd_read "$@" ;;
  history)   cmd_history "$@" ;;
  stats)     cmd_stats "$@" ;;
  compare)   cmd_compare "$@" ;;
  status)    cmd_status "$@" ;;
  restart)   cmd_restart "$@" ;;
  help|--help|-h) usage ;;
  *) echo "error: unknown command: $cmd" >&2; echo "run '$0 help' for usage" >&2; exit 1 ;;
esac
