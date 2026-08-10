#!/usr/bin/env bash
# Shell tests for the cloud-sync status line in `catalyst-stack status` (CTL-1736).
#
# Overrides _cloud_sync_state() inside isolating command-substitution subshells to
# assert cmd_status output contains the correct line per state. NO real adoption /
# daemon / network / mutation — catalyst-stack is SOURCED (its dispatch is guarded by
# BASH_SOURCE[0]==$0, so sourcing runs no command).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-status-cloud-sync.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="${SCRIPT_DIR}/../catalyst-stack"

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES + 1))
  echo "  PASS: $name"
}

fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $name"
  echo "    $detail"
}

# Source the script (guarded dispatch → no side effects) to reach the helpers.
# shellcheck disable=SC1090
source "$STACK"

# assert_status_line <name> <expected-substring> <state>
# Overrides _cloud_sync_state inside a subshell, runs cmd_status (stderr suppressed
# since broker/monitor/exec-core status CLIs are not available in the test env),
# and checks that the output contains the expected substring.
assert_status_line() {
  local name="$1" expected="$2" state="$3"
  local out
  out="$( _cloud_sync_state() { echo "$state"; }; cmd_status 2>/dev/null )"
  case "$out" in
    *"$expected"*) ok "$name" ;;
    *) fail "$name" "missing '$expected' in: $(printf '%s' "$out" | grep cloud-sync || echo '<no cloud-sync line>')" ;;
  esac
}

assert_status_line "status: fresh line"    "cloud-sync       running  (replica fresh)"            fresh
assert_status_line "status: stale line"    "cloud-sync       stale"                                stale
assert_status_line "status: unseeded line" "cloud-sync       installed, not seeded"                unseeded
assert_status_line "status: idle line"     "cloud-sync       not installed"                        idle

# The stale line must include the kickstart hint.
STALE_OUT="$( _cloud_sync_state() { echo stale; }; cmd_status 2>/dev/null )"
case "$STALE_OUT" in
  *"launchctl kickstart -k"*) ok "status: stale line has kickstart hint" ;;
  *) fail "status: stale line has kickstart hint" "missing 'launchctl kickstart -k'" ;;
esac
case "$STALE_OUT" in
  *"${CLOUD_SYNC_AGENT_LABEL}"*) ok "status: stale line names the agent label" ;;
  *) fail "status: stale line names the agent label" "missing '${CLOUD_SYNC_AGENT_LABEL}'" ;;
esac

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
