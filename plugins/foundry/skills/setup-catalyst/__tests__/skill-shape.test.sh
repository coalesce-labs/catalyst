#!/usr/bin/env bash
# Smoke test: the setup-catalyst skill (SKILL.md + references/) mentions the
# config-drift merge (CTL-489), the execution-core state-contract step (CTL-564),
# non-interactive/headless mode (CTL-842), and the CTL-2230 cloud-detection +
# non-cloud-fallback pattern. CTL-2230 split the old monolithic SKILL.md into a
# ≤80-line main file plus references/*.md (progressive disclosure, CTL-1993) — so
# this suite greps the WHOLE skill dir (SKILL.md + references/*.md concatenated),
# not SKILL.md alone. Only the setup-catalyst.sh wiring-shape assertions stay
# pinned to the single backing script (out of this skill's editorial scope).
# Run: bash plugins/foundry/skills/setup-catalyst/__tests__/skill-shape.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${SCRIPT_DIR}/.."
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
SETUP_CATALYST="${REPO_ROOT}/setup-catalyst.sh"

# All prose the skill ships, concatenated, so an assertion can match content that
# lives in SKILL.md OR any references/*.md — the split is an editorial choice
# (CTL-2230), not a change in what the skill documents.
SKILL_ALL="$(cat "${SKILL_DIR}/SKILL.md" "${SKILL_DIR}"/references/*.md 2>/dev/null)"

FAILURES=0
PASSES=0

assert_contains() {
  if grep -qF -- "$2" <<<"$SKILL_ALL"; then
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

assert_contains "Fix table mentions drift" "Drift detected"
assert_contains "Fix table references check-config-drift.sh" "check-config-drift.sh"
assert_contains "Fix table mentions unified diff" "diff -u"
assert_contains "Fix table mentions user confirmation" "confirmation"
assert_contains "Phase 3 re-runs check after merge" "Re-run"

# CTL-564 — the execution-core state-contract step.
assert_contains "Skill documents the execution-core step" "execution-core"
assert_contains "Skill references setup-execution-core-states.sh" "setup-execution-core-states.sh"

# CTL-564 — setup-catalyst.sh wiring shape.
assert_grep "setup-catalyst.sh defines setup_execution_core_states" \
  "$SETUP_CATALYST" "^setup_execution_core_states\(\)"
assert_grep "setup_execution_core_states branches on dispatchMode" \
  "$SETUP_CATALYST" "dispatchMode"
assert_grep "setup_execution_core_states branches on execution-core" \
  "$SETUP_CATALYST" "execution-core"
assert_grep "main() calls setup_execution_core_states" \
  "$SETUP_CATALYST" "^[[:space:]]+setup_execution_core_states"

# CTL-842 — non-interactive / headless mode.
assert_contains "Skill documents non-interactive mode" "Non-interactive / headless mode"
assert_contains "Skill mentions --non-interactive flag" "--non-interactive"
assert_contains "Skill mentions CATALYST_AUTONOMOUS" "CATALYST_AUTONOMOUS"
assert_contains "Skill mentions can_open_tty" "can_open_tty"
assert_contains "Skill mentions source guard" "return 0 2>/dev/null"

# CTL-2230 — cloud-mirror detection + loud non-cloud fallback (Ryan direction
# 2026-08-25). The replica must never be treated as authoritative silently.
assert_contains "Skill reuses the linearis freshness-gate helper" "linear-read-replica.sh"
assert_contains "Skill checks the .catalyst project-config marker" "linearReplica.mode"
assert_contains "Skill states the fallback is loud, not silent" "Falling back for this setup session"
assert_contains "Skill states the fallback is the non-fleet path" "non-fleet"
assert_contains "Skill warns the fallback burns the shared quota" "2500/hr"

assert_grep "setup-catalyst.sh defines can_open_tty" \
  "$SETUP_CATALYST" "^can_open_tty\(\)"
assert_grep "setup-catalyst.sh defines parse_args" \
  "$SETUP_CATALYST" "^parse_args\(\)"
assert_grep "setup-catalyst.sh defines prompt_value" \
  "$SETUP_CATALYST" "^prompt_value\(\)"
assert_grep "setup-catalyst.sh has NON_INTERACTIVE global" \
  "$SETUP_CATALYST" "^NON_INTERACTIVE="
assert_grep "setup-catalyst.sh uses return-probe source guard" \
  "$SETUP_CATALYST" "return 0 2>/dev/null"
assert_grep "setup-catalyst.sh npm offer declines in NI" \
  "$SETUP_CATALYST" 'ask_yes_no.*npm.*"?y"?.*"?n"?'
assert_grep "setup-catalyst.sh jq offer declines in NI" \
  "$SETUP_CATALYST" 'ask_yes_no.*jq.*"?y"?.*"?n"?'

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
