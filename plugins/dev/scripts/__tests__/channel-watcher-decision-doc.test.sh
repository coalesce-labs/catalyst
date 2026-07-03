#!/usr/bin/env bash
# Tests for the channel-watcher decision record — CTL-1423.
# Asserts the doc exists and that the LogQL/label section names the exact
# constants from the schema module (guards doc↔code drift).
#
# Run: bash plugins/dev/scripts/__tests__/channel-watcher-decision-doc.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }

DOC="${REPO_ROOT}/thoughts/shared/decisions/2026-07-03-CTL-1423-channel-watcher-supervision.md"

echo "channel-watcher decision-doc contract tests"

# 1. Doc exists
if [[ -f "$DOC" ]]; then
  pass "decision doc exists"
else
  fail "decision doc missing: $DOC"
fi

# 2. Event name is documented
if grep -q "channel.watcher.heartbeat" "$DOC" 2>/dev/null; then
  pass "event name channel.watcher.heartbeat documented"
else
  fail "event name channel.watcher.heartbeat not found in doc"
fi

# 3. service_name is documented
if grep -q "catalyst.channel-watcher" "$DOC" 2>/dev/null; then
  pass "service_name catalyst.channel-watcher documented"
else
  fail "service_name catalyst.channel-watcher not found in doc"
fi

# 4. Dead-man's-switch contract documented (event_label=`system_down`)
if grep -qE 'event_label=.?system_down.?' "$DOC" 2>/dev/null; then
  pass "dead-man's-switch contract (event_label=system_down) documented"
else
  fail "dead-man's-switch contract (event_label=system_down) not found in doc"
fi

# 5. Phenomena distinction documented
if grep -qE 'Phenomenon.*(i|1)|by-design single-shot' "$DOC" 2>/dev/null; then
  pass "phenomenon (i) by-design exit distinguished from silent teardown"
else
  fail "phenomena distinction (Phenomenon i / by-design single-shot) not found in doc"
fi

echo
echo "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
