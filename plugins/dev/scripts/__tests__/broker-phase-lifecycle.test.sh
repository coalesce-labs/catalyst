#!/usr/bin/env bash
# Shell test for broker phase_lifecycle interest type (CTL-447).
# Run: bash plugins/dev/scripts/__tests__/broker-phase-lifecycle.test.sh
#
# Delegates to the bun test runner so the assertions live in idiomatic JS
# alongside the broker source. The acceptance criterion in the plan
# (§Initiative 1 Phase 1) is "6 tests pass" — the matching describe block
# in phase-lifecycle.test.mjs contains exactly 6 test() calls.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TEST_FILE="${REPO_ROOT}/plugins/dev/scripts/broker/phase-lifecycle.test.mjs"

if ! command -v bun >/dev/null 2>&1; then
  echo "SKIP: bun not on PATH — phase_lifecycle tests require bun" >&2
  exit 0
fi

if [[ ! -f "$TEST_FILE" ]]; then
  echo "FAIL: test file not found: $TEST_FILE" >&2
  exit 1
fi

echo "broker phase_lifecycle tests"

OUT_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE"' EXIT

# Run only the core phase_lifecycle describe block so the count assertion below
# matches the acceptance criterion of "6 tests pass" exactly.
( cd "$REPO_ROOT" && bun test "$TEST_FILE" --test-name-pattern "phase_lifecycle interest type" ) \
  > "$OUT_FILE" 2>&1
RC=$?

cat "$OUT_FILE"

if [ "$RC" -ne 0 ]; then
  echo
  echo "FAIL: bun test exited with rc=$RC"
  exit 1
fi

PASS_COUNT=$(grep -cE '^[[:space:]]*[0-9]+ pass' "$OUT_FILE" | head -1)
PASS_NUM=$(grep -oE '[0-9]+ pass' "$OUT_FILE" | head -1 | awk '{print $1}')

if [ -z "$PASS_NUM" ] || [ "$PASS_NUM" -lt 6 ]; then
  echo
  echo "FAIL: expected 6 tests to pass, got ${PASS_NUM:-0}"
  exit 1
fi

echo
echo "Results: $PASS_NUM passed"
exit 0
