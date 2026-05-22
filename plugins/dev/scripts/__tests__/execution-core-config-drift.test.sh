#!/usr/bin/env bash
# Tests config.template.json's orchestration config surface so check-config-drift.sh
# has a structural baseline. CTL-582 (D4) removed the per-repo executionCore
# block — enrolled projects are the central registry.json — so the template
# carries only dispatchMode under orchestration.
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

check "template carries orchestration.dispatchMode" \
  jq -e '.catalyst.orchestration.dispatchMode' "$TEMPLATE"

# CTL-582 (D4): the per-repo executionCore block is retired — the daemon reads
# the central ~/catalyst/execution-core/registry.json. The template must NOT
# carry the executionCore key back in.
check "template no longer carries the per-repo executionCore block" \
  jq -e '.catalyst.orchestration | has("executionCore") | not' "$TEMPLATE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
