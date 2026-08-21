#!/usr/bin/env bash
# claude-selfupdate.sh (CTL-2085) — keep the system `claude` CLI current on persistent
# hosts. Installed as a StartInterval LaunchAgent by `catalyst-stack install-services`
# on all node classes (worker, monitor, developer).
#
# Fail-open: a no-op update, a failing update, or an absent binary NEVER exits
# non-zero (a StartInterval launchd job that exits non-zero wedges the interval for
# that launch on some macOS versions). Throttled by a durable marker to keep network
# and install overhead off the hot path.
#
# Config:
#   CATALYST_CLAUDE_UPDATE_MIN_INTERVAL_MS  — minimum ms between update runs (default 6h = 21600000)
#   CATALYST_EVENTS_DIR                     — override the unified event log directory
#   CATALYST_DIR                            — override the catalyst home (default: ~/catalyst)
set -uo pipefail

# --- resolve script directory following symlinks (portable) ---
__CSU_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
while [[ -L "$__CSU_SELF" ]]; do __CSU_SELF="$(readlink "$__CSU_SELF")"; done
__CSU_SCRIPT_DIR="$(cd "$(dirname "$__CSU_SELF")" && pwd)"
unset __CSU_SELF

CATALYST_HOME="${CATALYST_DIR:-${HOME}/catalyst}"
MIN_INTERVAL_MS="${CATALYST_CLAUDE_UPDATE_MIN_INTERVAL_MS:-21600000}"   # 6h default
MARKER="${CATALYST_HOME}/.claude-selfupdate.last"
EVENTS_DIR="${CATALYST_EVENTS_DIR:-${CATALYST_HOME}/events}"

now_ms() { echo $(( $(date +%s) * 1000 )); }

# Throttle: skip if we ran inside the min interval (marker holds last-run epoch-ms).
if [[ -f "$MARKER" ]]; then
  last="$(cat "$MARKER" 2>/dev/null || echo 0)"
  if [[ "$last" =~ ^[0-9]+$ ]] && (( $(now_ms) - last < MIN_INTERVAL_MS )); then
    exit 0
  fi
fi

# Fail-open: if `claude` is not on PATH, nothing to do.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  exit 0
fi

before="$("$CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}' || true)"
update_output=""
update_status=0
update_output="$("$CLAUDE_BIN" update 2>&1)" || update_status=$?

after="$("$CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}' || true)"

if [[ "$update_status" -ne 0 ]]; then
  event_suffix="failed"
elif [[ -n "$after" && "$after" != "$before" ]]; then
  event_suffix="updated"
else
  event_suffix="checked"
fi

# Write throttle marker (best-effort).
mkdir -p "$CATALYST_HOME" 2>/dev/null || true
now_ms > "$MARKER" 2>/dev/null || true

# Emit a canonical v2 event to the unified log (CTL-2085). Best-effort: NEVER
# let a log failure change the exit code. Uses build_canonical_line +
# canonical_jsonl_append for CTL-1809 atomicity.
_emit_update_event() {
  local suffix="$1" before_ver="$2" after_ver="$3"
  local lib="${__CSU_SCRIPT_DIR}/lib/canonical-event.sh"
  [[ -r "$lib" ]] || return 0
  # shellcheck disable=SC1090
  . "$lib" 2>/dev/null || return 0

  local ts severity
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  case "$suffix" in
    failed) severity="WARN" ;;
    *)      severity="INFO" ;;
  esac

  local payload
  payload="$(jq -nc \
    --arg before "$before_ver" \
    --arg after "$after_ver" \
    '{before_version: $before, after_version: $after}' 2>/dev/null || true)"
  [[ -n "$payload" ]] || payload='{"before_version":"","after_version":""}'

  local line
  line="$(build_canonical_line \
    --ts "$ts" \
    --severity "$severity" \
    --service "catalyst.stack" \
    --event-name "node.claude.update.${suffix}" \
    --message "claude CLI update: ${suffix} (${before_ver} → ${after_ver})" \
    --payload-json "$payload")" 2>/dev/null || return 0

  canonical_jsonl_append "$EVENTS_DIR" "$line" 2>/dev/null || true
}

_emit_update_event "$event_suffix" "${before:-}" "${after:-}" || true

exit 0
