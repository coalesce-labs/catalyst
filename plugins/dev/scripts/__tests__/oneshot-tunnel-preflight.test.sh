#!/usr/bin/env bash
# CTL-572: the oneshot Phase 5 listen-loop pre-flight must probe the webhook
# tunnel field that actually exists. `catalyst-monitor status --json` exposes
# `.webhookTunnel.connected` (boolean) and `.webhookTunnel.lastEventAt` — there
# is NO `.webhookTunnel.state` field, so the old `.webhookTunnel.state` probe
# always resolved to "unknown" and forced REST polling on every run.
#
# This test guards three skills:
#   - oneshot           — must use .connected + a lastEventAt staleness check
#   - wait-for-github   — already correct; guard against regressing to .state
#   - monitor-events    — already correct; guard against regressing to .state
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ONESHOT="${REPO_ROOT}/plugins/dev/skills/oneshot/SKILL.md"
WAIT_FOR_GITHUB="${REPO_ROOT}/plugins/dev/skills/wait-for-github/SKILL.md"
MONITOR_EVENTS="${REPO_ROOT}/plugins/dev/skills/monitor-events/SKILL.md"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_grep() {
  local file="$1" pattern="$2" label="$3"
  if grep -qF "$pattern" "$file"; then
    pass "$label"
  else
    fail "$label — expected '$pattern' in $(basename "$(dirname "$file")")/$(basename "$file")"
  fi
}

assert_not_grep() {
  local file="$1" pattern="$2" label="$3"
  if grep -qF "$pattern" "$file"; then
    fail "$label — forbidden '$pattern' found in $(basename "$(dirname "$file")")/$(basename "$file")"
  else
    pass "$label"
  fi
}

for f in "$ONESHOT" "$WAIT_FOR_GITHUB" "$MONITOR_EVENTS"; do
  if [[ ! -f "$f" ]]; then
    echo "FATAL: skill file missing: $f" >&2
    exit 1
  fi
done

echo "Test: oneshot SKILL probes the webhook-tunnel field that exists"
assert_not_grep "$ONESHOT" 'webhookTunnel.state' \
  "oneshot SKILL does not probe the non-existent .webhookTunnel.state field"
assert_grep "$ONESHOT" 'webhookTunnel.connected' \
  "oneshot SKILL probes .webhookTunnel.connected"
assert_grep "$ONESHOT" 'lastEventAt' \
  "oneshot SKILL includes a lastEventAt staleness check"

echo ""
echo "Test: already-correct skills do not regress to .webhookTunnel.state"
assert_not_grep "$WAIT_FOR_GITHUB" 'webhookTunnel.state' \
  "wait-for-github SKILL does not probe .webhookTunnel.state"
assert_not_grep "$MONITOR_EVENTS" 'webhookTunnel.state' \
  "monitor-events SKILL does not probe .webhookTunnel.state"

echo ""
echo "─────────────────────────────────────────────"
echo "oneshot-tunnel-preflight: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
