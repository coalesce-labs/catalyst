#!/usr/bin/env bash
# recovery-pass-rubric-four.test.sh — doc-drift guards for CAT-11's
# orphaned-committed-work recovery rubric.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/recovery-pass/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; return 0; }

for rubric in ONE TWO THREE FOUR; do
  if grep -q "RUBRIC ${rubric}" "$SKILL_MD"; then
    pass "RUBRIC ${rubric} is present"
  else
    fail "RUBRIC ${rubric} is present"
  fi
done

for token in unownedInFlightDetail create-worktree.sh draft_pr_ensure; do
  if grep -q "$token" "$SKILL_MD"; then
    pass "${token} is referenced"
  else
    fail "${token} is referenced"
  fi
done

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
