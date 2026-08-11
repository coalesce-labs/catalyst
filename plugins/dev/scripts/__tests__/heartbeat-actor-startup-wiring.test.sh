#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
EXEC="$ROOT/plugins/dev/scripts/catalyst-execution-core"
MONITOR="$ROOT/plugins/dev/scripts/catalyst-monitor.sh"
failures=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; failures=$((failures + 1)); }

exec_block="$(sed -n '/source "\$SCRIPT_DIR\/lib\/linear-app-actor.sh"/,/CATALYST_CONFIG_FILE pins/p' "$EXEC")"
heartbeat_line="$(printf '%s\n' "$exec_block" | grep -n 'linear_app_actor_auth "catalyst-execution-core" CATALYST_HEARTBEAT_APP_ACTOR_TOKEN' | cut -d: -f1)"
shared_line="$(printf '%s\n' "$exec_block" | grep -n 'linear_app_actor_auth "catalyst-execution-core"$' | cut -d: -f1)"
if [[ -n "$heartbeat_line" && -n "$shared_line" && "$heartbeat_line" -lt "$shared_line" ]]; then
  pass "execution-core mints the scoped heartbeat actor before the shared orchestrator actor"
else
  fail "execution-core heartbeat/shared mint order is missing or reversed"
fi
printf '%s\n' "$exec_block" | grep -q 'linear-heartbeat-actor "Catalyst Heartbeat app-actor"' \
  && pass "execution-core passes the dedicated actor id and display name" \
  || fail "execution-core dedicated actor arguments are missing"

monitor_branch="$(sed -n '/if \[\[ "\$_liveness_source" == "loki"/,/^  fi$/p' "$MONITOR")"
else_line="$(printf '%s\n' "$monitor_branch" | grep -n '^  else$' | cut -d: -f1)"
monitor_line="$(printf '%s\n' "$monitor_branch" | grep -n 'linear_app_actor_auth "catalyst-monitor" CATALYST_MONITOR_APP_ACTOR_TOKEN' | cut -d: -f1)"
monitor_heartbeat_line="$(printf '%s\n' "$monitor_branch" | grep -n 'linear_app_actor_auth "catalyst-monitor" CATALYST_HEARTBEAT_APP_ACTOR_TOKEN' | cut -d: -f1)"
if [[ -n "$else_line" && -n "$monitor_line" && "$monitor_line" -gt "$else_line" ]]; then
  pass "monitor actor mint is confined to the anchor else branch"
else
  fail "monitor actor mint is missing or reachable from a skip branch"
fi
if [[ -n "$else_line" && -n "$monitor_heartbeat_line" && "$monitor_heartbeat_line" -gt "$else_line" ]] \
  && printf '%s\n' "$monitor_branch" | grep -q 'linear-heartbeat-actor "Catalyst Heartbeat app-actor"'; then
  pass "monitor heartbeat mint is confined to the anchor else branch"
else
  fail "monitor heartbeat mint is missing, mis-parameterized, or reachable from a skip branch"
fi

[[ "$failures" -eq 0 ]]
