#!/usr/bin/env bash
# Tests that config.template.json carries the executionCore.eligibleQuery key
# so check-config-drift.sh has a structural baseline for the new M4 scheduler
# config surface (CTL-535 Phase 1, research §4).
# Run: bash plugins/dev/scripts/__tests__/execution-core-config-drift.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TEMPLATE="${REPO_ROOT}/plugins/dev/templates/config.template.json"

FAILURES=0
PASSES=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
  fi
}

echo "execution-core config drift tests"

check "config.template.json exists" test -f "$TEMPLATE"

check "template carries executionCore.eligibleQuery" \
  jq -e '.catalyst.orchestration.executionCore.eligibleQuery' "$TEMPLATE"

check "eligibleQuery.status is a string" \
  jq -e '.catalyst.orchestration.executionCore.eligibleQuery.status | type == "string"' "$TEMPLATE"

check "eligibleQuery carries team/project/label/priority keys" \
  jq -e '.catalyst.orchestration.executionCore.eligibleQuery
         | has("team") and has("project") and has("label") and has("priority")' \
  "$TEMPLATE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
