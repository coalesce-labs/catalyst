#!/usr/bin/env bash
# catalyst-db.sh — SQLite-backed session store for Catalyst agent activity.
#
# Durable source of truth for agent runs (solo and orchestrated). During the
# migration period, catalyst-state.sh continues to dual-write JSON/JSONL for
# backward compatibility.
#
# Storage:
#   $CATALYST_DIR/catalyst.db   (default CATALYST_DIR=$HOME/catalyst)
#
# SQL migrations live in ./db-migrations/NNN_*.sql and are applied in order
# by the `init` / `migrate` commands. Applied versions are tracked in the
# schema_migrations table.
#
# Usage (run with --help for full syntax):
#   catalyst-db.sh init
#   catalyst-db.sh migrate
#   catalyst-db.sh session create <id> [--ticket K] [--workflow W] [--label L] [--skill S] [--pid P]
#   catalyst-db.sh session update <id> key=value [...]
#   catalyst-db.sh session get <id>
#   catalyst-db.sh session list [--ticket K] [--status S] [--workflow W] [--limit N]
#   catalyst-db.sh event append <session-id> <event-type> <payload-json>
#   catalyst-db.sh events list [--session ID] [--type T] [--last N]
#   catalyst-db.sh metrics update <session-id> key=value [...]
#   catalyst-db.sh metrics get <session-id>
#   catalyst-db.sh tool record <session-id> <tool-name> [--duration MS]
#   catalyst-db.sh pr upsert <session-id> <pr-number> [--url U] [--ci S] [--opened TS] [--merged TS]
#   catalyst-db.sh pr get <session-id> <pr-number>
#   catalyst-db.sh exec <sql>

set -euo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${CATALYST_MIGRATIONS_DIR:-$SCRIPT_DIR/db-migrations}"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

ensure_dir() { mkdir -p "$(dirname "$DB_FILE")"; }

# Fields recognized by whitelists to prevent SQL injection via key=value input.
SESSION_FIELDS=(workflow_id ticket_key label skill_name status phase pid started_at updated_at completed_at)
METRIC_FIELDS=(cost_usd input_tokens output_tokens cache_read_tokens cache_creation_tokens duration_ms)

# ─── SQL helpers ────────────────────────────────────────────────────────────

# Escape a literal for SQL: wrap in single quotes, doubling any embedded '.
sql_quote() {
  local s="${1:-}"
  printf "'%s'" "${s//\'/\'\'}"
}

# Return 'NULL' for empty string, otherwise a quoted literal.
sql_value_or_null() {
  if [[ -z "${1:-}" ]]; then printf 'NULL'; else sql_quote "$1"; fi
}

# Assert that a name is in a whitelist. $1 = name, $2+ = allowed names.
assert_field() {
  local name="$1"; shift
  local f
  for f in "$@"; do [[ "$f" == "$name" ]] && return 0; done
  echo "error: unknown field '$name'" >&2
  return 1
}

# foreign_keys is a per-connection pragma, so enable it on every invocation.
db_exec() { sqlite3 "$DB_FILE" -cmd "PRAGMA foreign_keys = ON;" "$@"; }

db_exec_json() { sqlite3 -json "$DB_FILE" -cmd "PRAGMA foreign_keys = ON;" "$@"; }

# ─── Migrations ─────────────────────────────────────────────────────────────

apply_migrations() {
  ensure_dir

  # Configure durable, concurrency-friendly settings. `journal_mode = WAL`
  # persists across connections once set.
  db_exec "PRAGMA journal_mode = WAL;" >/dev/null
  db_exec "PRAGMA foreign_keys = ON;" >/dev/null

  db_exec "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    TEXT PRIMARY KEY,
             applied_at TEXT NOT NULL
           );"

  if [[ ! -d "$MIGRATIONS_DIR" ]]; then
    echo "error: migrations directory not found: $MIGRATIONS_DIR" >&2
    return 1
  fi

  local file version applied
  shopt -s nullglob
  for file in "$MIGRATIONS_DIR"/*.sql; do
    version="$(basename "$file" .sql)"
    applied=$(db_exec "SELECT 1 FROM schema_migrations WHERE version=$(sql_quote "$version");")
    if [[ -n "$applied" ]]; then continue; fi

    # Apply migration + record version atomically.
    {
      echo "PRAGMA foreign_keys = ON;"
      echo "BEGIN;"
      cat "$file"
      printf "INSERT INTO schema_migrations(version, applied_at) VALUES (%s, %s);\n" \
        "$(sql_quote "$version")" "$(sql_quote "$(now_iso)")"
      echo "COMMIT;"
    } | sqlite3 "$DB_FILE"
    echo "Applied migration: $version"
  done
  shopt -u nullglob
}

# ─── Session commands ──────────────────────────────────────────────────────

session_create() {
  local id="${1:?session id required}"; shift || true
  local ticket="" workflow="" label="" skill="" pid="" status="dispatched"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ticket)   ticket="$2"; shift 2 ;;
      --workflow) workflow="$2"; shift 2 ;;
      --label)    label="$2"; shift 2 ;;
      --skill)    skill="$2"; shift 2 ;;
      --pid)      pid="$2"; shift 2 ;;
      --status)   status="$2"; shift 2 ;;
      *) echo "unknown flag for session create: $1" >&2; return 1 ;;
    esac
  done

  local ts; ts="$(now_iso)"
  local pid_sql="NULL"
  [[ -n "$pid" ]] && pid_sql="$pid"

  db_exec "INSERT INTO sessions
             (session_id, workflow_id, ticket_key, label, skill_name, status, phase, pid, started_at, updated_at)
           VALUES
             ($(sql_quote "$id"),
              $(sql_value_or_null "$workflow"),
              $(sql_value_or_null "$ticket"),
              $(sql_value_or_null "$label"),
              $(sql_value_or_null "$skill"),
              $(sql_quote "$status"),
              0,
              $pid_sql,
              $(sql_quote "$ts"),
              $(sql_quote "$ts"));"
}

# Build a SET clause from key=value args, validating against a field whitelist.
# Writes SQL fragment to stdout; numeric fields are emitted unquoted when
# the value looks numeric, otherwise quoted.
build_set_clause() {
  local whitelist_name="$1"; shift
  local -n whitelist="$whitelist_name"
  local first=1
  while [[ $# -gt 0 ]]; do
    local kv="$1"; shift
    local key="${kv%%=*}"
    local val="${kv#*=}"
    assert_field "$key" "${whitelist[@]}" || return 1
    if [[ $first -eq 0 ]]; then printf ', '; fi
    first=0
    if [[ "$val" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
      printf '%s = %s' "$key" "$val"
    else
      printf '%s = %s' "$key" "$(sql_quote "$val")"
    fi
  done
}

session_update() {
  local id="${1:?session id required}"; shift
  [[ $# -eq 0 ]] && { echo "error: no fields to update" >&2; return 1; }

  local set_clause
  set_clause="$(build_set_clause SESSION_FIELDS "$@")"

  local ts; ts="$(now_iso)"
  db_exec "UPDATE sessions
           SET $set_clause, updated_at = $(sql_quote "$ts")
           WHERE session_id = $(sql_quote "$id");"
}

session_get() {
  local id="${1:?session id required}"
  local out
  out=$(db_exec_json "SELECT * FROM sessions WHERE session_id = $(sql_quote "$id");")
  [[ -z "$out" ]] && { echo 'null'; return 0; }
  echo "$out" | jq '.[0]'
}

session_list() {
  local where="" limit="" ticket="" status="" workflow=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ticket)   ticket="$2"; shift 2 ;;
      --status)   status="$2"; shift 2 ;;
      --workflow) workflow="$2"; shift 2 ;;
      --limit)    limit="$2"; shift 2 ;;
      *) echo "unknown flag for session list: $1" >&2; return 1 ;;
    esac
  done

  local conds=()
  [[ -n "$ticket" ]]   && conds+=("ticket_key = $(sql_quote "$ticket")")
  [[ -n "$status" ]]   && conds+=("status = $(sql_quote "$status")")
  [[ -n "$workflow" ]] && conds+=("workflow_id = $(sql_quote "$workflow")")

  if [[ ${#conds[@]} -gt 0 ]]; then
    where="WHERE $(IFS=' AND '; printf '%s' "${conds[*]}")"
    # bash IFS trick is fragile for multi-char separators — build manually
    where="WHERE ${conds[0]}"
    local i
    for ((i=1; i<${#conds[@]}; i++)); do where+=" AND ${conds[$i]}"; done
  fi

  local lim=""
  [[ -n "$limit" ]] && lim="LIMIT $limit"

  local out
  out=$(db_exec_json "SELECT * FROM sessions $where ORDER BY started_at DESC $lim;")
  [[ -z "$out" ]] && { echo '[]'; return 0; }
  echo "$out"
}

# ─── Event commands ─────────────────────────────────────────────────────────

event_append() {
  local id="${1:?session id required}"
  local type="${2:?event type required}"
  local payload="${3:-}"

  # Validate JSON if provided; reject malformed input so queries stay clean.
  if [[ -n "$payload" ]]; then
    if ! echo "$payload" | jq empty 2>/dev/null; then
      echo "error: payload is not valid JSON" >&2
      return 1
    fi
  fi

  local ts; ts="$(now_iso)"
  db_exec "INSERT INTO session_events (session_id, event_type, payload, ts)
           VALUES ($(sql_quote "$id"),
                   $(sql_quote "$type"),
                   $(sql_value_or_null "$payload"),
                   $(sql_quote "$ts"));"
}

events_list() {
  local session="" type="" last=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session) session="$2"; shift 2 ;;
      --type)    type="$2"; shift 2 ;;
      --last)    last="$2"; shift 2 ;;
      *) echo "unknown flag for events list: $1" >&2; return 1 ;;
    esac
  done

  local conds=()
  [[ -n "$session" ]] && conds+=("session_id = $(sql_quote "$session")")
  [[ -n "$type" ]]    && conds+=("event_type = $(sql_quote "$type")")

  local where=""
  if [[ ${#conds[@]} -gt 0 ]]; then
    where="WHERE ${conds[0]}"
    local i
    for ((i=1; i<${#conds[@]}; i++)); do where+=" AND ${conds[$i]}"; done
  fi

  # For --last N, order DESC then reverse so callers get chronological order.
  local out
  if [[ -n "$last" ]]; then
    out=$(db_exec_json "SELECT * FROM session_events $where ORDER BY event_id DESC LIMIT $last;")
    [[ -z "$out" ]] && { echo '[]'; return 0; }
    echo "$out" | jq 'reverse'
  else
    out=$(db_exec_json "SELECT * FROM session_events $where ORDER BY event_id ASC;")
    [[ -z "$out" ]] && { echo '[]'; return 0; }
    echo "$out"
  fi
}

# ─── Metrics commands ───────────────────────────────────────────────────────

metrics_update() {
  local id="${1:?session id required}"; shift
  [[ $# -eq 0 ]] && { echo "error: no metric fields to update" >&2; return 1; }

  # Validate each key against the whitelist before writing.
  local kv key
  for kv in "$@"; do
    key="${kv%%=*}"
    assert_field "$key" "${METRIC_FIELDS[@]}"
  done

  local ts; ts="$(now_iso)"

  # Ensure a row exists, then update. INSERT OR IGNORE is safe & idempotent.
  db_exec "INSERT OR IGNORE INTO session_metrics (session_id, updated_at)
           VALUES ($(sql_quote "$id"), $(sql_quote "$ts"));"

  local set_clause
  set_clause="$(build_set_clause METRIC_FIELDS "$@")"
  db_exec "UPDATE session_metrics
           SET $set_clause, updated_at = $(sql_quote "$ts")
           WHERE session_id = $(sql_quote "$id");"
}

metrics_get() {
  local id="${1:?session id required}"
  local out
  out=$(db_exec_json "SELECT * FROM session_metrics WHERE session_id = $(sql_quote "$id");")
  [[ -z "$out" ]] && { echo 'null'; return 0; }
  echo "$out" | jq '.[0]'
}

# ─── Tool usage ─────────────────────────────────────────────────────────────

tool_record() {
  local id="${1:?session id required}"
  local name="${2:?tool name required}"
  shift 2 || true
  local duration=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --duration) duration="$2"; shift 2 ;;
      *) echo "unknown flag for tool record: $1" >&2; return 1 ;;
    esac
  done
  [[ "$duration" =~ ^[0-9]+$ ]] || { echo "error: --duration must be a non-negative integer" >&2; return 1; }

  local ts; ts="$(now_iso)"
  db_exec "INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
           VALUES ($(sql_quote "$id"), $(sql_quote "$name"), 1, $duration, $(sql_quote "$ts"))
           ON CONFLICT(session_id, tool_name) DO UPDATE SET
             call_count = call_count + 1,
             total_duration_ms = total_duration_ms + $duration,
             updated_at = $(sql_quote "$ts");"
}

# ─── PR commands ────────────────────────────────────────────────────────────

pr_upsert() {
  local id="${1:?session id required}"
  local num="${2:?pr number required}"
  shift 2 || true
  [[ "$num" =~ ^[0-9]+$ ]] || { echo "error: pr-number must be an integer" >&2; return 1; }

  local url="" ci="" opened="" merged=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --url)    url="$2"; shift 2 ;;
      --ci)     ci="$2"; shift 2 ;;
      --opened) opened="$2"; shift 2 ;;
      --merged) merged="$2"; shift 2 ;;
      *) echo "unknown flag for pr upsert: $1" >&2; return 1 ;;
    esac
  done

  local ts; ts="$(now_iso)"

  # Build SET fragments only for flags the caller actually supplied, so that
  # subsequent upserts don't accidentally clobber previously-set columns
  # (e.g. keeping pr_url when only --ci is updated).
  local sets=()
  [[ -n "$url" ]]    && sets+=("pr_url = $(sql_quote "$url")")
  [[ -n "$ci" ]]     && sets+=("ci_status = $(sql_quote "$ci")")
  [[ -n "$opened" ]] && sets+=("opened_at = $(sql_quote "$opened")")
  [[ -n "$merged" ]] && sets+=("merged_at = $(sql_quote "$merged")")
  sets+=("updated_at = $(sql_quote "$ts")")

  local set_clause="${sets[0]}"
  local i
  for ((i=1; i<${#sets[@]}; i++)); do set_clause+=", ${sets[$i]}"; done

  db_exec "INSERT INTO session_prs (session_id, pr_number, pr_url, ci_status, opened_at, merged_at, updated_at)
           VALUES ($(sql_quote "$id"), $num,
                   $(sql_value_or_null "$url"),
                   $(sql_value_or_null "$ci"),
                   $(sql_value_or_null "$opened"),
                   $(sql_value_or_null "$merged"),
                   $(sql_quote "$ts"))
           ON CONFLICT(session_id, pr_number) DO UPDATE SET $set_clause;"
}

pr_get() {
  local id="${1:?session id required}"
  local num="${2:?pr number required}"
  local out
  out=$(db_exec_json "SELECT * FROM session_prs WHERE session_id = $(sql_quote "$id") AND pr_number = $num;")
  [[ -z "$out" ]] && { echo 'null'; return 0; }
  echo "$out" | jq '.[0]'
}

# ─── Dispatch ───────────────────────────────────────────────────────────────

usage() {
  sed -n '/^# Usage/,/^set -/p' "${BASH_SOURCE[0]}" | sed 's/^# //; s/^#$//' | head -n -1
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  init|migrate) apply_migrations ;;
  session)
    sub="${1:?session subcommand required}"; shift
    case "$sub" in
      create) session_create "$@" ;;
      update) session_update "$@" ;;
      get)    session_get "$@" ;;
      list)   session_list "$@" ;;
      *) echo "unknown session subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  event)
    sub="${1:?event subcommand required}"; shift
    case "$sub" in
      append) event_append "$@" ;;
      *) echo "unknown event subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  events)
    sub="${1:?events subcommand required}"; shift
    case "$sub" in
      list) events_list "$@" ;;
      *) echo "unknown events subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  metrics)
    sub="${1:?metrics subcommand required}"; shift
    case "$sub" in
      update) metrics_update "$@" ;;
      get)    metrics_get "$@" ;;
      *) echo "unknown metrics subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  tool)
    sub="${1:?tool subcommand required}"; shift
    case "$sub" in
      record) tool_record "$@" ;;
      *) echo "unknown tool subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  pr)
    sub="${1:?pr subcommand required}"; shift
    case "$sub" in
      upsert) pr_upsert "$@" ;;
      get)    pr_get "$@" ;;
      *) echo "unknown pr subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  exec)
    [[ $# -ge 1 ]] || { echo "error: exec requires a SQL string" >&2; exit 1; }
    db_exec "$1"
    ;;
  help|--help|-h) usage ;;
  *) echo "unknown command: $cmd" >&2; echo "run '$0 help' for usage" >&2; exit 1 ;;
esac
