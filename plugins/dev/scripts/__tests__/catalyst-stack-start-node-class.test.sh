#!/usr/bin/env bash
# Tests for CTL-1654: catalyst-stack cmd_start honors catalyst.node.class
# — only a WORKER node starts execution-core + the log-shipper; monitor/developer
# nodes start observation services only (monitor, broker, forward) and add
# the event-mirror.
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-start-node-class.test.sh

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
    echo "    output:"
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
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

STUBDIR="${SCRATCH}/stubs"
mkdir -p "$STUBDIR"
INVOCATIONS="${SCRATCH}/invocations"

# Stub every service command to record which ones were called.
make_stubs() {
  rm -f "$INVOCATIONS"
  for svc in start_monitor start_broker start_daemon start_forward start_shipper start_event_mirror; do
    echo "recorded: ${svc}" >> "${SCRATCH}/stub_src_${svc}"
  done
}

# Run cmd_start with stubbed internal functions and a given CATALYST_NODE_CLASS.
# Records which start_* functions were called in $INVOCATIONS.
run_cmd_start() {
  local node_class="${1:-worker}"
  rm -f "$INVOCATIONS"

  # Source the stack and override the start_* functions + _resolve_node_class,
  # then call cmd_start. Suppress prompts with ASSUME_YES=yes.
  INVOCATIONS_FILE="$INVOCATIONS" \
  bash --noprofile --norc <<EOF
set -uo pipefail
export INVOCATIONS_FILE="${INVOCATIONS}"
# Source the stack (defines all functions) then override what we need.
# Redirect sourcing stderr to suppress chatter.
source "${STACK}" 2>/dev/null || true

_resolve_node_class() { printf '%s' "${node_class}"; }

start_monitor()       { echo start_monitor >> "\${INVOCATIONS_FILE}"; }
start_broker()        { echo start_broker >> "\${INVOCATIONS_FILE}"; }
start_daemon()        { echo start_daemon >> "\${INVOCATIONS_FILE}"; }
start_forward()       { echo start_forward >> "\${INVOCATIONS_FILE}"; }
start_shipper()       { echo start_shipper >> "\${INVOCATIONS_FILE}"; return 0; }
start_event_mirror()  { echo start_event_mirror >> "\${INVOCATIONS_FILE}"; return 0; }
# Suppress the trailing cmd_status call.
cmd_status()          { :; }
_cloud_token_env_run() { :; }
log()                 { :; }
warn()                { :; }

ASSUME_YES=yes cmd_start
EOF
}

assert_called() {
  local fn="$1"
  grep -q "^${fn}$" "$INVOCATIONS" 2>/dev/null
}

assert_not_called() {
  local fn="$1"
  ! grep -q "^${fn}$" "$INVOCATIONS" 2>/dev/null
}

echo ""
echo "=== Phase 1: Node-class-gated cmd_start (CTL-1654) ==="
echo ""

# --- monitor class ---
echo "  # monitor class: observation-only, no execution-core, no shipper, has event-mirror"
run_cmd_start "monitor"

check "monitor: start_monitor called" assert_called start_monitor
check "monitor: start_broker called" assert_called start_broker
check "monitor: start_forward called" assert_called start_forward
check "monitor: start_daemon NOT called" assert_not_called start_daemon
check "monitor: start_shipper NOT called" assert_not_called start_shipper
check "monitor: start_event_mirror called" assert_called start_event_mirror

echo ""

# --- worker class ---
echo "  # worker class: full stack (unchanged — execution-core + shipper, no event-mirror)"
run_cmd_start "worker"

check "worker: start_monitor called" assert_called start_monitor
check "worker: start_broker called" assert_called start_broker
check "worker: start_forward called" assert_called start_forward
check "worker: start_daemon called" assert_called start_daemon
check "worker: start_shipper called" assert_called start_shipper
check "worker: start_event_mirror NOT called" assert_not_called start_event_mirror

echo ""

# --- developer class ---
echo "  # developer class: observation-only (same skip as monitor — regression guard)"
run_cmd_start "developer"

check "developer: start_monitor called" assert_called start_monitor
check "developer: start_broker called" assert_called start_broker
check "developer: start_forward called" assert_called start_forward
check "developer: start_daemon NOT called" assert_not_called start_daemon
check "developer: start_shipper NOT called" assert_not_called start_shipper
check "developer: start_event_mirror called" assert_called start_event_mirror

echo ""
echo "=== Results: ${PASSES} pass, ${FAILURES} fail ==="
[[ $FAILURES -eq 0 ]]
