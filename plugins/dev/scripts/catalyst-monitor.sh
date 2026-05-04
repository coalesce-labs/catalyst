#!/usr/bin/env bash
# catalyst-monitor.sh — On-demand monitor server management.
#
# Commands:
#   start [--port N]     Start monitor server in background (idempotent)
#   stop                 Stop monitor server
#   status [--json]      Check if monitor is running
#   open                 Start monitor if needed, open browser to dashboard
#   url                  Print the monitor URL

set -uo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DEFAULT_PORT=7400
PORT="${MONITOR_PORT:-$DEFAULT_PORT}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "error: MONITOR_PORT must be a numeric port, got: $PORT" >&2
  exit 1
fi
PID_FILE="${MONITOR_PID_FILE:-$CATALYST_DIR/monitor.pid}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SCRIPT="${MONITOR_SERVER_SCRIPT:-$SCRIPT_DIR/orch-monitor/server.ts}"
MONITOR_DIR="$(cd "$(dirname "$SERVER_SCRIPT")" && pwd)"

# ─── Version drift self-check ───────────────────────────────────────────────
PLUGIN_CACHE_ROOT="${CATALYST_PLUGIN_CACHE_ROOT:-$HOME/.claude/plugins/cache/catalyst/catalyst-dev}"

# Reads the running version from the version.txt adjacent to the script.
# In both the plugin cache layout (cache/.../<X.Y.Z>/version.txt) and the source
# tree (plugins/dev/version.txt), the file lives at SCRIPT_DIR/../version.txt.
read_running_version() {
  local version_file="${CATALYST_VERSION_FILE:-$SCRIPT_DIR/../version.txt}"
  if [[ -f "$version_file" ]]; then
    tr -d '[:space:]' < "$version_file"
    return 0
  fi
  return 1
}

# Highest semver subdirectory under the plugin cache root.
read_latest_available_version() {
  [[ -d "$PLUGIN_CACHE_ROOT" ]] || return 1
  local latest
  latest=$(ls -1 "$PLUGIN_CACHE_ROOT" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | tail -n1)
  [[ -n "$latest" ]] || return 1
  printf '%s' "$latest"
}

# Returns 0 if v1 < v2, else nonzero. Empty inputs treated as not-less-than.
version_lt() {
  local v1="$1" v2="$2"
  [[ -n "$v1" && -n "$v2" ]] || return 1
  [[ "$v1" == "$v2" ]] && return 1
  local lower
  lower=$(printf '%s\n%s\n' "$v1" "$v2" \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | head -n1)
  [[ "$lower" == "$v1" ]]
}

RUNNING_VERSION="$(read_running_version || true)"
LATEST_AVAILABLE_VERSION="$(read_latest_available_version || true)"
IS_STALE="false"
if version_lt "$RUNNING_VERSION" "$LATEST_AVAILABLE_VERSION"; then
  IS_STALE="true"
fi

read_suppress_warning() {
  local config_path=""
  if [[ -f ".catalyst/config.json" ]]; then
    config_path=".catalyst/config.json"
  elif [[ -f ".claude/config.json" ]]; then
    config_path=".claude/config.json"
  fi
  [[ -n "$config_path" ]] || { echo "false"; return; }
  command -v jq &>/dev/null || { echo "false"; return; }
  local v
  v=$(jq -r '.catalyst.monitor.suppressVersionWarning // false' "$config_path" 2>/dev/null)
  echo "${v:-false}"
}

print_version_warning() {
  [[ "$IS_STALE" == "true" ]] || return 0
  [[ "$(read_suppress_warning)" != "true" ]] || return 0
  echo "warning: catalyst-monitor running v${RUNNING_VERSION}; v${LATEST_AVAILABLE_VERSION} is available locally" >&2
  echo "  remediation: bash \"\$CLAUDE_PLUGIN_ROOT/scripts/install-cli.sh\" install   # or 'git pull' if running from a clone" >&2
  echo "  suppress: add '\"catalyst\":{\"monitor\":{\"suppressVersionWarning\":true}}' to .catalyst/config.json" >&2
}

# JSON-safe string-or-null helper for status output.
json_quote_or_null() {
  if [[ -n "$1" ]]; then
    printf '"%s"' "$1"
  else
    printf 'null'
  fi
}

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && is_alive "$pid"; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE" 2>/dev/null
  fi
  return 1
}

bootstrap() {
  if [[ "${MONITOR_SKIP_BOOTSTRAP:-}" == "1" ]]; then
    return 0
  fi

  local errors=()

  if ! command -v bun &>/dev/null; then
    errors+=("bun is required but not found. Install: curl -fsSL https://bun.sh/install | bash")
  fi

  if [[ ! -f "$SERVER_SCRIPT" ]]; then
    errors+=("server.ts not found at $SERVER_SCRIPT")
  fi

  if ! command -v sqlite3 &>/dev/null; then
    errors+=("sqlite3 is required for session history")
  fi

  if [[ ! -d "$CATALYST_DIR" ]]; then
    errors+=("Catalyst directory missing: $CATALYST_DIR — run /catalyst-dev:setup-catalyst first")
  fi

  if [[ ! -d "$CATALYST_DIR/wt" ]]; then
    errors+=("Worktree directory missing: $CATALYST_DIR/wt/ — run /catalyst-dev:setup-catalyst first")
  fi

  if [[ ${#errors[@]} -gt 0 ]]; then
    echo "Cannot start monitor:" >&2
    for err in "${errors[@]}"; do
      echo "  • $err" >&2
    done
    return 1
  fi

  local db_file="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"
  if [[ ! -f "$db_file" ]]; then
    echo "Warning: Session database not found ($db_file) — session history will be empty"
    echo "  Run /catalyst-dev:setup-catalyst to initialize"
  fi

  if [[ -d "$MONITOR_DIR" ]]; then
    if [[ ! -d "$MONITOR_DIR/node_modules" ]]; then
      echo "Installing orch-monitor dependencies..."
      (cd "$MONITOR_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    fi

    if [[ -d "$MONITOR_DIR/ui" && ! -d "$MONITOR_DIR/ui/node_modules" ]]; then
      echo "Installing orch-monitor UI dependencies..."
      (cd "$MONITOR_DIR/ui" && bun install --frozen-lockfile 2>/dev/null || bun install)
    fi

    if [[ -d "$MONITOR_DIR/ui" && ! -d "$MONITOR_DIR/ui/dist" ]]; then
      echo "Building orch-monitor frontend..."
      (cd "$MONITOR_DIR/ui" && bunx vite build)
    fi
  fi
}

cmd_start() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      *) echo "error: unknown flag for start: $1" >&2; return 1 ;;
    esac
  done

  local existing_pid
  if existing_pid=$(read_pid); then
    echo "Monitor already running (pid $existing_pid)"
    return 0
  fi

  print_version_warning

  bootstrap || return 1

  mkdir -p "$(dirname "$PID_FILE")" 2>/dev/null || true
  mkdir -p "$CATALYST_DIR/wt" 2>/dev/null || true

  MONITOR_PORT="$PORT" nohup bun run "$SERVER_SCRIPT" --pid-file "$PID_FILE" \
    > "$CATALYST_DIR/monitor.log" 2>&1 &
  local server_pid=$!
  disown "$server_pid" 2>/dev/null || true

  local waited=0
  while [[ $waited -lt 20 ]]; do
    if [[ -f "$PID_FILE" ]]; then
      echo "Monitor started (pid $(cat "$PID_FILE")) at http://localhost:$PORT"
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  if is_alive "$server_pid"; then
    echo "$server_pid" > "$PID_FILE"
    echo "Monitor started (pid $server_pid) at http://localhost:$PORT"
    return 0
  fi

  echo "error: failed to start monitor server" >&2
  return 1
}

cmd_stop() {
  local pid
  if ! pid=$(read_pid); then
    echo "Monitor not running"
    return 0
  fi

  kill "$pid" 2>/dev/null || true

  local waited=0
  while [[ $waited -lt 30 ]] && is_alive "$pid"; do
    sleep 0.1
    waited=$((waited + 1))
  done

  if is_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE" 2>/dev/null || true
  echo "Monitor stopped"
}

cmd_restart() {
  if read_pid >/dev/null; then
    cmd_stop
  fi
  cmd_start "$@"
}

cmd_status() {
  local json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      *) echo "error: unknown flag for status: $1" >&2; return 1 ;;
    esac
  done

  local rv lv
  rv=$(json_quote_or_null "$RUNNING_VERSION")
  lv=$(json_quote_or_null "$LATEST_AVAILABLE_VERSION")

  local pid
  if pid=$(read_pid); then
    if [[ $json -eq 1 ]]; then
      printf '{"running":true,"pid":%d,"port":%d,"url":"http://localhost:%d","runningVersion":%s,"latestAvailableVersion":%s,"isStale":%s}\n' \
        "$pid" "$PORT" "$PORT" "$rv" "$lv" "$IS_STALE"
    else
      echo "Monitor running (pid $pid) at http://localhost:$PORT"
    fi
    return 0
  else
    if [[ $json -eq 1 ]]; then
      printf '{"running":false,"pid":null,"port":%d,"url":"http://localhost:%d","runningVersion":%s,"latestAvailableVersion":%s,"isStale":%s}\n' \
        "$PORT" "$PORT" "$rv" "$lv" "$IS_STALE"
    else
      echo "Monitor stopped"
    fi
    return 1
  fi
}

cmd_open() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      *) echo "error: unknown flag for open: $1" >&2; return 1 ;;
    esac
  done

  local pid
  if ! pid=$(read_pid); then
    cmd_start --port "$PORT"
  fi

  local url="http://localhost:$PORT"
  if command -v open &>/dev/null; then
    open "$url"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$url"
  else
    echo "Open $url in your browser"
  fi
}

cmd_url() {
  echo "http://localhost:$PORT"
}

usage() {
  echo "Usage: catalyst-monitor.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  start [--port N]   Start monitor server in background"
  echo "  stop               Stop monitor server"
  echo "  restart [--port N] Stop and re-start monitor server"
  echo "  status [--json]    Check if monitor is running"
  echo "  open               Start if needed, open browser to dashboard"
  echo "  url                Print the monitor URL"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  start)     cmd_start "$@" ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart "$@" ;;
  status)    cmd_status "$@" ;;
  open)      cmd_open "$@" ;;
  url)       cmd_url ;;
  help|--help|-h) usage ;;
  *) echo "error: unknown command: $cmd" >&2; exit 1 ;;
esac
