#!/usr/bin/env bash
# Tests for CTL-1654: _vn_run_monitor graded verify-node profile
# — real checks (broker up, monitor up, exec-core DOWN, event-mirror up [required],
# would-not-own-work). Phase 4 removed the CATALYST_MONITOR_EVENT_MIRROR advisory gate.
# Run: bash plugins/dev/scripts/__tests__/verify-node-monitor-profile.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

check() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $name"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

check_not() {
  local name="$1"; shift
  if ! "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $name (expected failure but succeeded)"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

# Run cmd_verify_node --json with daemon probes stubbed.
# Args: broker=up|down monitor=up|down exec_core=up|down event_mirror=up|down
# Optionally: in_roster=yes|no multi_host=yes|no roster_src=<val>
# Also optionally: event_mirror_enabled=1 (sets CATALYST_MONITOR_EVENT_MIRROR=enabled)
run_verify_monitor() {
  local broker_st="up" monitor_st="up" exec_core_st="down" event_mirror_st="up"
  local in_roster="no" multi_host="no" roster_src="cluster.json"
  local event_mirror_env=""
  for arg in "$@"; do
    case "$arg" in
      broker=*)       broker_st="${arg#broker=}" ;;
      monitor=*)      monitor_st="${arg#monitor=}" ;;
      exec_core=*)    exec_core_st="${arg#exec_core=}" ;;
      event_mirror=*) event_mirror_st="${arg#event_mirror=}" ;;
      in_roster=*)    in_roster="${arg#in_roster=}" ;;
      multi_host=*)   multi_host="${arg#multi_host=}" ;;
      roster_src=*)   roster_src="${arg#roster_src=}" ;;
      event_mirror_enabled=1) event_mirror_env="CATALYST_MONITOR_EVENT_MIRROR=enabled" ;;
    esac
  done
  bash --noprofile --norc <<EOF
set -uo pipefail
source "${STACK}" 2>/dev/null || true

# Override daemon probes to return deterministic up/down.
_vn_broker_running()      { printf '%s' "$([ "$broker_st" = "up" ] && echo yes || echo no)"; }
_vn_exec_core_running()   { printf '%s' "$([ "$exec_core_st" = "up" ] && echo yes || echo no)"; }
_vn_monitor_running()     { printf '%s' "$([ "$monitor_st" = "up" ] && echo yes || echo no)"; }
_vn_event_mirror_running(){ printf '%s' "$([ "$event_mirror_st" = "up" ] && echo yes || echo no)"; }
_vn_drained()             { printf '%s' "no"; }

# Override roster/class resolution.
_vn_resolve() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "monitor" "layer2" "false" "true" "monitor" \
    "${in_roster}" "${multi_host}" "${roster_src}" "laptop"
}

${event_mirror_env} cmd_verify_node --json
EOF
}

# Helper: assert a JSON check field has given status.
assert_check_status() {
  local json="$1" check_name="$2" expected_status="$3"
  local actual
  actual="$(printf '%s' "$json" | jq -r --arg n "$check_name" '.checks[] | select(.name == $n) | .status' 2>/dev/null)"
  [[ "$actual" == "$expected_status" ]]
}

assert_verdict() {
  local json="$1" expected="$2"
  local actual
  actual="$(printf '%s' "$json" | jq -r '.verdict' 2>/dev/null)"
  [[ "$actual" == "$expected" ]]
}

echo ""
echo "=== Phase 2: _vn_run_monitor graded profile (CTL-1654) ==="
echo ""

# --- healthy monitor: all observation services up, exec-core down ---
echo "  # healthy monitor: broker up, monitor up, exec-core down, out-of-roster → PASS"
OUT="$(run_verify_monitor broker=up monitor=up exec_core=down event_mirror=up \
       in_roster=no multi_host=no roster_src=cluster.json 2>/dev/null)"

check "healthy: verdict = pass"          assert_verdict "$OUT" "pass"
check "healthy: node-class PASS"         assert_check_status "$OUT" "node-class" "PASS"
check "healthy: broker-running PASS"     assert_check_status "$OUT" "broker-running" "PASS"
check "healthy: monitor-running PASS"    assert_check_status "$OUT" "monitor-running" "PASS"
check "healthy: exec-core-stopped PASS"  assert_check_status "$OUT" "exec-core-stopped" "PASS"
check "healthy: would-not-own-work PASS" assert_check_status "$OUT" "would-not-own-work" "PASS"
check_not "healthy: no profile-stub check in output" bash -c "printf '%s' '${OUT}' | jq -e '.checks[] | select(.name == \"profile-stub\")' >/dev/null 2>&1"

echo ""

# --- mis-running monitor: exec-core is UP → FAIL ---
echo "  # mis-running monitor: exec-core UP → exec-core-stopped FAIL, verdict = fail"
OUT="$(run_verify_monitor broker=up monitor=up exec_core=up event_mirror=up \
       in_roster=no multi_host=no roster_src=cluster.json 2>/dev/null)"

check "mis-exec-core: verdict = fail"            assert_verdict "$OUT" "fail"
check "mis-exec-core: exec-core-stopped FAIL"    assert_check_status "$OUT" "exec-core-stopped" "FAIL"

echo ""

# --- broker down → FAIL ---
echo "  # broker down → broker-running FAIL, verdict = fail"
OUT="$(run_verify_monitor broker=down monitor=up exec_core=down event_mirror=up \
       in_roster=no multi_host=no roster_src=cluster.json 2>/dev/null)"

check "broker-down: verdict = fail"          assert_verdict "$OUT" "fail"
check "broker-down: broker-running FAIL"     assert_check_status "$OUT" "broker-running" "FAIL"

echo ""

# --- monitor service down → FAIL ---
echo "  # monitor down → monitor-running FAIL, verdict = fail"
OUT="$(run_verify_monitor broker=up monitor=down exec_core=down event_mirror=up \
       in_roster=no multi_host=no roster_src=cluster.json 2>/dev/null)"

check "monitor-down: verdict = fail"         assert_verdict "$OUT" "fail"
check "monitor-down: monitor-running FAIL"   assert_check_status "$OUT" "monitor-running" "FAIL"

echo ""

# --- event-mirror down: hard T1 required check (Phase 4 removed the advisory gate) ---
echo "  # event-mirror down → event-mirror-running FAIL, verdict = fail"
OUT="$(run_verify_monitor broker=up monitor=up exec_core=down event_mirror=down \
       in_roster=no multi_host=no roster_src=cluster.json 2>/dev/null)"

check "event-mirror-stopped: verdict = fail"             assert_verdict "$OUT" "fail"
check "event-mirror-stopped: event-mirror-running FAIL"  assert_check_status "$OUT" "event-mirror-running" "FAIL"

echo ""

# --- event-mirror up: explicitly verify the check appears as required PASS ---
echo "  # event-mirror up → event-mirror-running PASS (required T1 check)"
OUT="$(run_verify_monitor broker=up monitor=up exec_core=down event_mirror=up \
       in_roster=no multi_host=no roster_src=cluster.json 2>/dev/null)"

check "event-mirror-up: event-mirror-running PASS" assert_check_status "$OUT" "event-mirror-running" "PASS"
check "event-mirror-up: verdict = pass"            assert_verdict "$OUT" "pass"

echo ""

# --- in roster, multi-host, not drained → FAIL on would-not-own-work ---
echo "  # in multi-host roster, not drained → would-not-own-work FAIL"
OUT="$(run_verify_monitor broker=up monitor=up exec_core=down event_mirror=up \
       in_roster=yes multi_host=yes roster_src=cluster.json 2>/dev/null)"

check "in-roster: would-not-own-work FAIL" \
      assert_check_status "$OUT" "would-not-own-work" "FAIL"

echo ""
echo "=== Results: ${PASSES} pass, ${FAILURES} fail ==="
[[ $FAILURES -eq 0 ]]
