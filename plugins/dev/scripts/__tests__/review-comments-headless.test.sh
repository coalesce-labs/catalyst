#!/usr/bin/env bash
# review-comments-headless.test.sh — doc-drift guards for the headless mode
# added to review-comments/SKILL.md in CTL-1496.
# Run: bash plugins/dev/scripts/__tests__/review-comments-headless.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/review-comments/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; return 0; }

# 1. SKILL.md must have a headless / non-interactive section gated on CATALYST_PHASE or --headless
if grep -q "Non-interactive\|headless\|CATALYST_PHASE" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md contains a Non-interactive/headless section keyed on CATALYST_PHASE or --headless"
else
  fail "SKILL.md contains a Non-interactive/headless section keyed on CATALYST_PHASE or --headless" \
    "grep: no match for Non-interactive/headless/CATALYST_PHASE in ${SKILL_MD}"
fi

# 2. SKILL.md must state the y/N prompt is skipped in headless mode
if grep -qi "y/N.*skip\|skip.*y/N\|not.*prompt\|never.*prompt\|prompt.*skipped\|skipped.*prompt" \
     "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md states y/N prompt is SKIPPED in headless mode"
else
  fail "SKILL.md states y/N prompt is SKIPPED in headless mode" \
    "no sentence about skipping the y/N prompt in headless mode"
fi

# 3. SKILL.md must state judgment-call findings go to a structured escalation list
if grep -q "escalation\|review-escalations\|escalation list\|escalate" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md states judgment-call findings are recorded to an escalation list"
else
  fail "SKILL.md states judgment-call findings are recorded to an escalation list" \
    "no reference to escalation list for judgment-call findings"
fi

# 4. The interactive y/N wording must still exist for the non-headless path
if grep -q "y/N\|Y/n\|\[y/N\]\|\[Y/n\]" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md still contains the interactive y/N wording (not deleted)"
else
  fail "SKILL.md still contains the interactive y/N wording (not deleted)" \
    "interactive y/N prompt wording not found — may have been removed by headless additions"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
