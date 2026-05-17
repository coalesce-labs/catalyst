#!/usr/bin/env bash
# Smoke test: setup-catalyst SKILL.md mentions the config-drift merge (CTL-489).
# Run: bash plugins/dev/skills/setup-catalyst/__tests__/skill-shape.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/../SKILL.md"

FAILURES=0
PASSES=0

assert_contains() {
  if grep -qF -- "$2" "$SKILL"; then
    PASSES=$((PASSES+1)); echo "  PASS: $1"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: $1 (missing: $2)"
  fi
}

assert_contains "Phase 2 table mentions drift" "Drift detected"
assert_contains "Phase 2 references check-config-drift.sh" "check-config-drift.sh"
assert_contains "Phase 2 mentions unified diff" "diff -u"
assert_contains "Phase 2 mentions user confirmation" "confirmation"
assert_contains "Phase 3 re-runs check after merge" "Re-run"
assert_contains "Output Format shows Config Drift section" "Config Drift"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
