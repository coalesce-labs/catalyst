#!/usr/bin/env bash
# Tests for CTL-1654: catalyst-stack cmd_start honors catalyst.node.class,
# matching the verify-node profiles:
#   worker    — full stack: monitor + broker + execution-core + shipper (no event-mirror)
#   monitor   — observation host: monitor + broker + forward + event-mirror (no exec-core/shipper)
#   developer — daemonless client: ONLY the event-mirror (no broker/monitor/forward/exec-core)
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
echo "  # developer class: daemonless client — ONLY event-mirror (Codex P2: no broker)"
run_cmd_start "developer"

check "developer: start_monitor NOT called" assert_not_called start_monitor
check "developer: start_broker NOT called" assert_not_called start_broker
check "developer: start_forward NOT called" assert_not_called start_forward
check "developer: start_daemon NOT called" assert_not_called start_daemon
check "developer: start_shipper NOT called" assert_not_called start_shipper
check "developer: start_event_mirror called" assert_called start_event_mirror

echo ""
echo "=== Phase 2: _resolve_node_class fail-closed on invalid config (Codex P2 F5) ==="
echo ""

# Resolve the REAL _resolve_node_class (not the stub) against a given env + Layer-2
# config file. Prints the resolved class to stdout.
resolve_class() {
  local env_class="${1:-}" cfg_json="${2:-}"
  local cfg="${SCRATCH}/layer2-config.json"
  if [[ -n "$cfg_json" ]]; then printf '%s' "$cfg_json" > "$cfg"; else rm -f "$cfg"; fi
  CATALYST_NODE_CLASS="$env_class" \
  CATALYST_LAYER2_CONFIG_FILE="$cfg" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    [[ -n "${CATALYST_NODE_CLASS}" ]] || unset CATALYST_NODE_CLASS
    _resolve_node_class
  '
}

assert_class() {
  local name="$1" expected="$2" got="$3"
  if [[ "$got" == "$expected" ]]; then
    PASSES=$((PASSES + 1)); echo "  PASS: $name (got '$got')"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $name (expected '$expected', got '$got')"
  fi
}

assert_class "absent config ⇒ worker default" \
  "worker" "$(resolve_class "" '{"catalyst":{}}')"
assert_class "recognized 'developer' honored" \
  "developer" "$(resolve_class "" '{"catalyst":{"node":{"class":"developer"}}}')"
assert_class "recognized 'monitor' honored" \
  "monitor" "$(resolve_class "" '{"catalyst":{"node":{"class":"monitor"}}}')"
# The fail-closed cases the old code got wrong: a non-string / typo must NOT become worker.
assert_class "non-string class ⇒ monitor (fail-closed, was worker)" \
  "monitor" "$(resolve_class "" '{"catalyst":{"node":{"class":false}}}')"
assert_class "typo class ⇒ monitor (fail-closed)" \
  "monitor" "$(resolve_class "" '{"catalyst":{"node":{"class":"developr"}}}')"
assert_class "env override 'worker' wins" \
  "worker" "$(resolve_class "worker" '{"catalyst":{"node":{"class":"monitor"}}}')"

echo ""
echo "=== Phase 3: event-mirror plist carries roster overrides (Codex P2 F6) ==="
echo ""

# Render the event-mirror plist with a given environment; prints the XML.
render_mirror_plist() {
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    render_event_mirror_plist /tmp/launch.sh
  '
}

PLIST_WITH_HOSTS="$(CATALYST_EVENT_MIRROR_HOSTS='mini,mini-2' render_mirror_plist)"
if grep -q '<key>CATALYST_EVENT_MIRROR_HOSTS</key>' <<<"$PLIST_WITH_HOSTS" \
   && grep -q '<string>mini,mini-2</string>' <<<"$PLIST_WITH_HOSTS"; then
  PASSES=$((PASSES + 1)); echo "  PASS: plist carries CATALYST_EVENT_MIRROR_HOSTS when set"
else
  FAILURES=$((FAILURES + 1)); echo "  FAIL: plist missing CATALYST_EVENT_MIRROR_HOSTS override"
fi

PLIST_WITH_CLUSTER="$(CATALYST_CLUSTER_DIR='/opt/catalyst-cluster' render_mirror_plist)"
if grep -q '<key>CATALYST_CLUSTER_DIR</key>' <<<"$PLIST_WITH_CLUSTER" \
   && grep -q '<string>/opt/catalyst-cluster</string>' <<<"$PLIST_WITH_CLUSTER"; then
  PASSES=$((PASSES + 1)); echo "  PASS: plist carries CATALYST_CLUSTER_DIR when set"
else
  FAILURES=$((FAILURES + 1)); echo "  FAIL: plist missing CATALYST_CLUSTER_DIR override"
fi

PLIST_BARE="$(unset CATALYST_EVENT_MIRROR_HOSTS CATALYST_CLUSTER_DIR CATALYST_CLUSTER_JSON; render_mirror_plist)"
if grep -q 'CATALYST_EVENT_MIRROR_HOSTS' <<<"$PLIST_BARE"; then
  FAILURES=$((FAILURES + 1)); echo "  FAIL: plist injected CATALYST_EVENT_MIRROR_HOSTS when unset"
else
  PASSES=$((PASSES + 1)); echo "  PASS: plist omits override keys when unset"
fi

echo ""
echo "=== Phase 4: event-mirror plist survives reboot (CTL-1662) ==="
echo ""

# RunAtLoad must be true: a developer/monitor node typically never installs the
# STACK_AGENT (install-services), only adopt-updater — so the dedicated event-mirror
# agent must self-start at login like the updater/cloud-sync/log-shipper agents do,
# not rely solely on start_event_mirror's one-time kickstart.
if grep -A1 '<key>RunAtLoad</key>' <<<"$PLIST_BARE" | grep -q '<true/>'; then
  PASSES=$((PASSES + 1)); echo "  PASS: event-mirror plist has RunAtLoad=true (survives reboot/login)"
else
  FAILURES=$((FAILURES + 1)); echo "  FAIL: event-mirror plist RunAtLoad is not true — will not self-start after reboot"
fi

echo ""
echo "=== Results: ${PASSES} pass, ${FAILURES} fail ==="
[[ $FAILURES -eq 0 ]]
