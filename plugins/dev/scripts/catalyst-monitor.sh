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

# CTL-390: --version handling (early, before any arg parsing or stdin reads).
case "${1:-}" in
  --version|-V)
    _CV_SRC="${BASH_SOURCE[0]}"
    while [[ -L "$_CV_SRC" ]]; do
      _CV_D="$(cd -P "$(dirname "$_CV_SRC")" && pwd)" && _CV_SRC="$(readlink "$_CV_SRC")"
      [[ "$_CV_SRC" != /* ]] && _CV_SRC="$_CV_D/$_CV_SRC"
    done
    _CV_DIR="$(cd -P "$(dirname "$_CV_SRC")" && pwd)"
    [[ -f "${_CV_DIR}/lib/catalyst-version.sh" ]] && . "${_CV_DIR}/lib/catalyst-version.sh" \
      && catalyst_print_version "catalyst-monitor" "${BASH_SOURCE[0]}" && exit 0
    echo "error: catalyst-version helper missing at ${_CV_DIR}/lib/catalyst-version.sh" >&2
    exit 1
    ;;
esac

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
# CTL-1088: default out-of-repo dist dir for the vite build (single definition
# used by both bootstrap and cmd_start).
MONITOR_UI_DIST_DIR="${MONITOR_UI_DIST_DIR:-$CATALYST_DIR/monitor-ui-dist}"

# CTL-1223: structured-event emission for silent vite-build failures. Best-effort.
EVENTS_DIR="${CATALYST_EVENTS_DIR:-$CATALYST_DIR/events}"
# shellcheck source=lib/canonical-event.sh
[[ -f "$SCRIPT_DIR/lib/canonical-event.sh" ]] && source "$SCRIPT_DIR/lib/canonical-event.sh" || true
FORWARD_PID_FILE="${CATALYST_DIR}/otel-forward.pid"
FORWARD_LOG="${CATALYST_DIR}/otel-forward.log"
FORWARD_SCRIPT="${SCRIPT_DIR}/otel-forward/index.ts"

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
    errors+=("Catalyst directory missing: $CATALYST_DIR — run /catalyst-foundry:setup-catalyst first")
  fi

  # CTL-841: a missing wt/ dir is a fresh-host normal, not a fatal error. A daemon
  # start script should mkdir -p its own runtime dirs and start, rather than dead-end
  # a headless-host operator at an interactive Claude skill. Self-heal instead of
  # hard-failing. (cmd_start also runs `mkdir -p "$CATALYST_DIR/wt"`, but bootstrap's
  # `return 1` made that line unreachable — proving the auto-create was always intended.)
  if [[ ! -d "$CATALYST_DIR/wt" ]] && [[ -d "$CATALYST_DIR" ]]; then
    mkdir -p "$CATALYST_DIR/wt" 2>/dev/null || true
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
    echo "  Run /catalyst-foundry:setup-catalyst to initialize"
  fi

  if [[ -d "$MONITOR_DIR" ]]; then
    if [[ ! -d "$MONITOR_DIR/node_modules" ]] || [[ "$MONITOR_DIR/bun.lock" -nt "$MONITOR_DIR/node_modules" ]]; then
      echo "Installing orch-monitor dependencies..."
      (cd "$MONITOR_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    fi

    if [[ -d "$MONITOR_DIR/ui" ]] && { [[ ! -d "$MONITOR_DIR/ui/node_modules" ]] || [[ "$MONITOR_DIR/ui/bun.lock" -nt "$MONITOR_DIR/ui/node_modules" ]]; }; then
      echo "Installing orch-monitor UI dependencies..."
      (cd "$MONITOR_DIR/ui" && bun install --frozen-lockfile 2>/dev/null || bun install)
    fi

    if [[ -d "$MONITOR_DIR/ui" ]]; then
      mkdir -p "$MONITOR_UI_DIST_DIR"
      export MONITOR_UI_DIST_DIR

      # CTL-1088: dist lives out-of-repo; first build happens when index.html is absent.
      # CTL-1118: also rebuild when the UI source has advanced past the last-built
      # commit. We record the SHA of the last commit touching ui/ next to the dist and
      # rebuild on mismatch — this covers EVERY restart path (broker hot-reload and
      # manual restart) with no broker-side plumbing. Escape hatch: MONITOR_FORCE_BUILD=1.
      ui_source_sha="$(git -C "$MONITOR_DIR" log -1 --format='%H' -- ui/ 2>/dev/null || true)"
      built_sha_file="$MONITOR_UI_DIST_DIR/.source-sha"
      built_sha=""
      [[ -f "$built_sha_file" ]] && built_sha="$(cat "$built_sha_file" 2>/dev/null || true)"

      rebuild_reason=""
      if [[ "${MONITOR_FORCE_BUILD:-}" == "1" ]]; then
        rebuild_reason="MONITOR_FORCE_BUILD=1"
      elif [[ ! -f "$MONITOR_UI_DIST_DIR/index.html" ]]; then
        rebuild_reason="no built index.html"
      elif [[ -n "$ui_source_sha" && "$ui_source_sha" != "$built_sha" ]]; then
        rebuild_reason="ui source changed (${built_sha:-none} → $ui_source_sha)"
      fi

      if [[ -n "$rebuild_reason" ]]; then
        echo "Building orch-monitor frontend → $MONITOR_UI_DIST_DIR ($rebuild_reason) ..."
        if (cd "$MONITOR_DIR/ui" && bunx vite build); then
          # Record the built source SHA ONLY on success so a failed build retries next start.
          [[ -n "$ui_source_sha" ]] && printf '%s\n' "$ui_source_sha" > "$built_sha_file"
        else
          echo "warning: orch-monitor vite build failed — serving previous dist (will retry next restart)" >&2
          if declare -f build_canonical_line >/dev/null 2>&1; then
            _bf_line="$(build_canonical_line \
              --ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
              --severity WARN \
              --service catalyst.monitor \
              --event-name "monitor.ui.build_failed" \
              --entity monitor --action ui_build_failed \
              --label "${rebuild_reason:-build_failed}" \
              --payload-json "$(jq -cn --arg dir "$MONITOR_DIR" --arg sha "${ui_source_sha:-}" \
                --arg built "${built_sha:-}" --arg reason "${rebuild_reason:-}" \
                '{monitor_dir:$dir,ui_source_sha:$sha,built_sha:$built,rebuild_reason:$reason}' \
                2>/dev/null || echo '{}')" \
              2>/dev/null)" || _bf_line=""
            [[ -n "$_bf_line" ]] && canonical_jsonl_append "$EVENTS_DIR" "$_bf_line" || true
          fi
        fi
      fi

      # Complete the dist: copy non-vite static assets so the out-of-repo dir is a
      # full served root (server uses one publicDir for everything). Idempotent.
      # CTL-1133: manifest, service worker, and PWA icons join the served root.
      for _asset in history.html favicon.ico favicon.svg \
        manifest.webmanifest service-worker.js \
        icon-192.png icon-512.png apple-touch-icon.png; do
        [[ -f "$MONITOR_DIR/public/$_asset" ]] && cp -f "$MONITOR_DIR/public/$_asset" "$MONITOR_UI_DIST_DIR/" 2>/dev/null || true
      done
      for _dir in vendor mockups; do
        [[ -d "$MONITOR_DIR/public/$_dir" ]] && cp -R "$MONITOR_DIR/public/$_dir" "$MONITOR_UI_DIST_DIR/" 2>/dev/null || true
      done
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

  CATALYST_CONFIG_PATH="${CATALYST_CONFIG_PATH:-}" \
  MONITOR_PORT="$PORT" \
  MONITOR_PUBLIC_DIR="${MONITOR_UI_DIST_DIR}" \
  nohup bun run "$SERVER_SCRIPT" --pid-file "$PID_FILE" \
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

  # CTL-343: surface broker key-health alongside monitor status so a single
  # `catalyst-monitor status --json` call answers "is everything healthy?".
  local brokerKeyHealth='null'
  local brokerStateFile="${BROKER_STATE_FILE:-${CATALYST_DIR:-$HOME/catalyst}/broker.state.json}"
  if [[ -f "$brokerStateFile" ]]; then
    brokerKeyHealth=$(jq -c '.keyHealth // null' "$brokerStateFile" 2>/dev/null || echo 'null')
    [[ -z "$brokerKeyHealth" ]] && brokerKeyHealth='null'
  fi

  local pid
  if pid=$(read_pid); then
    if [[ $json -eq 1 ]]; then
      # Fetch webhook tunnel state from the running daemon (2s timeout, silent on error).
      local tunnel
      tunnel=$(curl -s --max-time 2 "http://localhost:${PORT}/api/status/webhook-tunnel" 2>/dev/null || true)
      # If tunnel response is empty or invalid JSON, omit the field (null).
      if ! echo "$tunnel" | jq -e . >/dev/null 2>&1; then
        tunnel='null'
      fi
      jq -n \
        --argjson pid "$pid" \
        --argjson port "$PORT" \
        --argjson rv "$rv" \
        --argjson lv "$lv" \
        --argjson stale "$([ "$IS_STALE" = "true" ] && echo true || echo false)" \
        --argjson tunnel "$tunnel" \
        --argjson brokerKeyHealth "$brokerKeyHealth" \
        '{running:true,pid:$pid,port:$port,url:("http://localhost:"+($port|tostring)),runningVersion:$rv,latestAvailableVersion:$lv,isStale:$stale,webhookTunnel:$tunnel,brokerKeyHealth:$brokerKeyHealth}'
    else
      echo "Monitor running (pid $pid) at http://localhost:$PORT"
    fi
    return 0
  else
    if [[ $json -eq 1 ]]; then
      jq -n \
        --argjson port "$PORT" \
        --argjson rv "$rv" \
        --argjson lv "$lv" \
        --argjson stale "$([ "$IS_STALE" = "true" ] && echo true || echo false)" \
        --argjson brokerKeyHealth "$brokerKeyHealth" \
        '{running:false,pid:null,port:$port,url:("http://localhost:"+($port|tostring)),runningVersion:$rv,latestAvailableVersion:$lv,isStale:$stale,brokerKeyHealth:$brokerKeyHealth}'
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

read_forward_pid() {
  if [[ -f "$FORWARD_PID_FILE" ]]; then
    local pid
    pid="$(cat "$FORWARD_PID_FILE" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"; return 0
    fi
    rm -f "$FORWARD_PID_FILE" 2>/dev/null || true
  fi
  return 1
}

cmd_forward_start() {
  if read_forward_pid >/dev/null; then
    echo "Forwarder already running (pid $(cat "$FORWARD_PID_FILE"))"
    return 0
  fi
  nohup bun run "$FORWARD_SCRIPT" > "$FORWARD_LOG" 2>&1 &
  local fwd_pid=$!
  disown "$fwd_pid" 2>/dev/null || true
  echo "$fwd_pid" > "$FORWARD_PID_FILE"
  echo "Forwarder started (pid $fwd_pid)"
}

cmd_forward_stop() {
  local pid
  if ! pid=$(read_forward_pid); then
    echo "Forwarder not running"; return 0
  fi
  kill "$pid" 2>/dev/null || true
  local waited=0
  while [[ $waited -lt 30 ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1; waited=$((waited + 1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$FORWARD_PID_FILE" 2>/dev/null || true
  echo "Forwarder stopped"
}

cmd_forward_status() {
  local pid
  if pid=$(read_forward_pid); then
    echo "Forwarder running (pid $pid)"
  else
    echo "Forwarder not running"
  fi
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
  echo "  forward-start      Start otel-forward daemon in background"
  echo "  forward-stop       Stop otel-forward daemon"
  echo "  forward-status     Check if otel-forward daemon is running"
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
  forward-start)  cmd_forward_start ;;
  forward-stop)   cmd_forward_stop ;;
  forward-status) cmd_forward_status ;;
  help|--help|-h) usage ;;
  *) echo "error: unknown command: $cmd" >&2; exit 1 ;;
esac
