#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SCRIPT="$ROOT/plugins/dev/scripts/catalyst-monitor.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/state"

pass=0 fail=0
run_case() { local class="$1" reap="${2:-1}"; CATALYST_DIR="$TMP/state" MONITOR_SKIP_BOOTSTRAP=1 CATALYST_MONITOR_PORT_REAP="$reap" CLASS="$class" INVOCATIONS="$TMP/calls" bash --noprofile --norc -c '
 source "'$SCRIPT'" url >/dev/null
 read_pid(){ return 1; }; classify_port_holder(){ echo "$CLASS"; }; _monitor_port_holder_pids(){ echo 222; }
 _monitor_reap_pid(){ echo reap >> "$INVOCATIONS"; }; print_version_warning(){ :; }; bootstrap(){ :; }
 _monitor_launch(){ echo launch >> "$INVOCATIONS"; }
 cmd_start
 ' >/dev/null 2>"$TMP/err"; }
check_case() { local name="$1" class="$2" want_rc="$3" want="$4" reap="${5:-1}"; : > "$TMP/calls"; run_case "$class" "$reap"; rc=$?; calls="$(tr '\n' ' ' < "$TMP/calls" | sed 's/ $//')"; if [[ "$rc" == "$want_rc" && "$calls" == "$want" ]]; then pass=$((pass+1)); else echo "FAIL $name rc=$rc calls='$calls'"; fail=$((fail+1)); fi; }
check_case free free 0 launch
check_case ours ours 0 ''
check_case orphan orphan 0 'reap launch'
check_case foreign foreign 1 ''
check_case unknown unknown 1 ''
check_case disabled orphan 1 '' 0

# Source-level structural guarantees for the real wrappers.
body="$(MONITOR_SKIP_BOOTSTRAP=1 bash -c 'source "'$SCRIPT'" url >/dev/null; declare -f cmd_restart; declare -f _monitor_reap_pid')"
[[ "$body" == *'acquire_monitor_lock'* && "$body" == *'_monitor_stop_impl'* && "$body" == *'_monitor_start_impl'* ]] && pass=$((pass+1)) || { echo 'FAIL restart lock transaction'; fail=$((fail+1)); }
[[ "$body" == *'kill -9'* && "$body" == *'_monitor_pid_is_ours'* ]] && pass=$((pass+1)) || { echo 'FAIL bounded identity-aware reap'; fail=$((fail+1)); }
printf 'catalyst-monitor-port-reap: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
