#!/usr/bin/env bash
# Asserts the aggregate test runner wires the execution-core bun surface so
# the CTL-535 monitor suite runs as part of `make test` (CTL-535 Phase 5).
# Run: bash plugins/dev/scripts/__tests__/execution-core-runner-wired.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RUNNER="${REPO_ROOT}/plugins/dev/scripts/run-tests.sh"

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

echo "execution-core runner wiring tests"

check "run-tests.sh exists" test -f "$RUNNER"
check "run-tests.sh references the execution-core surface" grep -q 'execution-core' "$RUNNER"
check "run-tests.sh defines EXECUTION_CORE_DIR" grep -q 'EXECUTION_CORE_DIR' "$RUNNER"
check "run-tests.sh installs execution-core deps before the suite" \
  grep -q 'ensure_execution_core_deps' "$RUNNER"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
