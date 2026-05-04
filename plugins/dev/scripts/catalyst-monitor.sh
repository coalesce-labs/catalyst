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
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
SERVER_SCRIPT="${MONITOR_SERVER_SCRIPT:-$SCRIPT_DIR/orch-monitor/server.ts}"
MONITOR_DIR="$(cd "$(dirname "$SERVER_SCRIPT")" && pwd)"

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

cmd_status() {
  local json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      *) echo "error: unknown flag for status: $1" >&2; return 1 ;;
    esac
  done

  local pid
  if pid=$(read_pid); then
    if [[ $json -eq 1 ]]; then
      printf '{"running":true,"pid":%d,"port":%d,"url":"http://localhost:%d"}\n' \
        "$pid" "$PORT" "$PORT"
    else
      echo "Monitor running (pid $pid) at http://localhost:$PORT"
    fi
    return 0
  else
    if [[ $json -eq 1 ]]; then
      printf '{"running":false,"pid":null,"port":%d,"url":"http://localhost:%d"}\n' \
        "$PORT" "$PORT"
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
  echo "  status [--json]    Check if monitor is running"
  echo "  open               Start if needed, open browser to dashboard"
  echo "  url                Print the monitor URL"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  start)     cmd_start "$@" ;;
  stop)      cmd_stop ;;
  status)    cmd_status "$@" ;;
  open)      cmd_open "$@" ;;
  url)       cmd_url ;;
  help|--help|-h) usage ;;
  *) echo "error: unknown command: $cmd" >&2; exit 1 ;;
esac
