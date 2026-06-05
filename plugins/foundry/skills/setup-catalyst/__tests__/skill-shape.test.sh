#!/usr/bin/env bash
# Smoke test: setup-catalyst SKILL.md mentions the config-drift merge (CTL-489)
# and the execution-core state-contract step (CTL-564).
# Run: bash plugins/foundry/skills/setup-catalyst/__tests__/skill-shape.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/../SKILL.md"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
SETUP_CATALYST="${REPO_ROOT}/setup-catalyst.sh"

FAILURES=0
PASSES=0

assert_contains() {
  if grep -qF -- "$2" "$SKILL"; then
    PASSES=$((PASSES+1)); echo "  PASS: $1"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: $1 (missing: $2)"
  fi
}

# assert_grep <name> <file> <pattern> — extended-regex grep against any file.
assert_grep() {
  if grep -qE -- "$3" "$2"; then
    PASSES=$((PASSES+1)); echo "  PASS: $1"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: $1 (no match: $3)"
  fi
}

assert_contains "Phase 2 table mentions drift" "Drift detected"
assert_contains "Phase 2 references check-config-drift.sh" "check-config-drift.sh"
assert_contains "Phase 2 mentions unified diff" "diff -u"
assert_contains "Phase 2 mentions user confirmation" "confirmation"
assert_contains "Phase 3 re-runs check after merge" "Re-run"
assert_contains "Output Format shows Config Drift section" "Config Drift"

# CTL-564 — the execution-core state-contract step.
assert_contains "SKILL.md documents the execution-core step" "execution-core"
assert_contains "SKILL.md references setup-execution-core-states.sh" "setup-execution-core-states.sh"

# CTL-564 — setup-catalyst.sh wiring shape.
assert_grep "setup-catalyst.sh defines setup_execution_core_states" \
  "$SETUP_CATALYST" "^setup_execution_core_states\(\)"
assert_grep "setup_execution_core_states branches on dispatchMode" \
  "$SETUP_CATALYST" "dispatchMode"
assert_grep "setup_execution_core_states branches on execution-core" \
  "$SETUP_CATALYST" "execution-core"
assert_grep "main() calls setup_execution_core_states" \
  "$SETUP_CATALYST" "^[[:space:]]+setup_execution_core_states"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
