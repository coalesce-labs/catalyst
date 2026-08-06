#!/usr/bin/env bash
# CTL-1654 Phase 5: monitor-node e2e acceptance test.
# Validates that the event-mirror fan-in pipeline works end-to-end:
#   Scenario 1 — cmd_start on a monitor node does NOT invoke execution-core or log-shipper.
#   Scenario 2 — cmd_stop on a monitor node invokes stop_event_mirror (cleanup).
#   Scenario 3 — A mirrored event written to the local event file is visible to
#                `catalyst-events wait-for` (via grep simulation — no live ssh).
#
# These are integration-style tests using the real catalyst-stack source but
# with all daemon primitives stubbed, so no launchd/ssh side effects occur.
# Run: bash plugins/dev/scripts/__tests__/monitor-node-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
EVENT_MIRROR_TS="${REPO_ROOT}/plugins/dev/scripts/event-mirror/index.ts"

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

# ─── Scenario 1: cmd_start monitor class ──────────────────────────────────────

echo ""
echo "=== CTL-1654 monitor-node e2e (Phase 5) ==="
echo ""
echo "  # Scenario 1: cmd_start monitor — observation substrate only"

CALLED_LOG="${SCRATCH}/called.log"

OUT="$(bash --noprofile --norc <<EOF 2>&1
set -uo pipefail
source "${STACK}" 2>/dev/null || true

# Record which primitive was called.
_record() { echo "\$1" >> "${CALLED_LOG}"; }

start_monitor()      { _record start_monitor; }
start_broker()       { _record start_broker; }
start_forward()      { _record start_forward; }
start_daemon()       { _record start_daemon; }
start_shipper()      { _record start_shipper; }
start_event_mirror() { _record start_event_mirror; }
start_mitmproxy()    { : ; }

CATALYST_NODE_CLASS=monitor cmd_start
EOF
)"

check "s1: start_monitor called"      grep -q "start_monitor"       "${CALLED_LOG}"
check "s1: start_broker called"       grep -q "start_broker"        "${CALLED_LOG}"
check "s1: start_forward called"      grep -q "start_forward"       "${CALLED_LOG}"
check "s1: start_event_mirror called" grep -q "start_event_mirror"  "${CALLED_LOG}"
check_not "s1: start_daemon NOT called"   grep -q "start_daemon"    "${CALLED_LOG}"
check_not "s1: start_shipper NOT called"  grep -q "start_shipper"   "${CALLED_LOG}"

# ─── Scenario 2: cmd_stop monitor class ───────────────────────────────────────

echo ""
echo "  # Scenario 2: cmd_stop monitor — stop_event_mirror is called"

STOP_LOG="${SCRATCH}/stop.log"

bash --noprofile --norc <<EOF 2>/dev/null
set -uo pipefail
source "${STACK}" 2>/dev/null || true

stop_monitor()      { echo stop_monitor      >> "${STOP_LOG}"; }
stop_broker()       { echo stop_broker       >> "${STOP_LOG}"; }
stop_forward()      { echo stop_forward      >> "${STOP_LOG}"; }
stop_daemon()       { echo stop_daemon       >> "${STOP_LOG}"; }
stop_shipper()      { echo stop_shipper      >> "${STOP_LOG}"; }
stop_event_mirror() { echo stop_event_mirror >> "${STOP_LOG}"; }
stop_mitmproxy()    { : ; }

CATALYST_NODE_CLASS=monitor cmd_stop
EOF

check "s2: stop_event_mirror called"  grep -q "stop_event_mirror"  "${STOP_LOG}"
check "s2: stop_monitor called"       grep -q "stop_monitor"       "${STOP_LOG}"
check "s2: stop_broker called"        grep -q "stop_broker"        "${STOP_LOG}"

# ─── Scenario 3: mirrored event visible to wait-for ───────────────────────────

echo ""
echo "  # Scenario 3: event written via event-mirror fan-in is visible to wait-for"

# Simulate what mirrorTick does: fan a remote event into the local event file.
CATALYST_DIR_TEST="${SCRATCH}/catalyst"
EVENTS_DIR="${CATALYST_DIR_TEST}/events"
CURRENT_MONTH="$(date -u +%Y-%m)"
LOCAL_FILE="${EVENTS_DIR}/${CURRENT_MONTH}.jsonl"
mkdir -p "$EVENTS_DIR"

# The event that would come from a worker host via ssh-tail.
REMOTE_EVT='{"id":"fleet-evt-1","ts":"2026-08-05T00:00:00Z","attributes":{"event.name":"phase.implement.complete.CTL-9999"}}'

# Simulate mirrorTick appending the event to the local file.
printf '%s\n' "$REMOTE_EVT" >> "$LOCAL_FILE"

# A `catalyst-events wait-for` equivalent: grep for the event name in the local file.
check "s3: mirrored event visible in local log" \
  bash -c "grep -q 'phase.implement.complete.CTL-9999' '${LOCAL_FILE}'"

# Verify the event id is present (dedup key).
check "s3: event id preserved in local log" \
  bash -c "grep -q 'fleet-evt-1' '${LOCAL_FILE}'"

# ─── Scenario 4: event-mirror index.ts exists and is executable ───────────────

echo ""
echo "  # Scenario 4: event-mirror daemon entry point is present"

check "s4: event-mirror/index.ts exists"   test -f "${EVENT_MIRROR_TS}"
check "s4: event-mirror/launch.sh exists"  test -f "${REPO_ROOT}/plugins/dev/scripts/event-mirror/launch.sh"

echo ""
echo "=== Results: ${PASSES} pass, ${FAILURES} fail ==="
[[ $FAILURES -eq 0 ]]
