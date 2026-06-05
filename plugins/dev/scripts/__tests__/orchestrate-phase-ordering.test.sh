#!/usr/bin/env bash
# Structural regression test for orchestrate/SKILL.md document order (CTL-491).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-phase-ordering.test.sh
#
# Asserts that the orchestrate-register-interests.sh invocation textually
# precedes the orchestrate-dispatch-next invocation in orchestrate/SKILL.md.
# A future edit that re-orders them re-introduces the CTL-491 race window —
# this test fails before reaching dogfood.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_MD="${REPO_ROOT}/plugins/legacy/skills/orchestrate/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

[ -f "$SKILL_MD" ] || { echo "MISSING: $SKILL_MD"; exit 2; }

# Line number of the first occurrence of each invocation.
REG_LINE=$(grep -n 'orchestrate-register-interests.sh' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
DISP_LINE=$(grep -n 'orchestrate-dispatch-next' "$SKILL_MD" | head -1 | cut -d: -f1 || true)

echo "test 9: orchestrate-register-interests.sh appears BEFORE orchestrate-dispatch-next"
[ -n "$REG_LINE" ] && pass "register-interests reference present" || fail "register-interests reference present" "no match in $SKILL_MD"
[ -n "$DISP_LINE" ] && pass "dispatch-next reference present" || fail "dispatch-next reference present"
if [ -n "$REG_LINE" ] && [ -n "$DISP_LINE" ]; then
  if [ "$REG_LINE" -lt "$DISP_LINE" ]; then
    pass "register-interests (line $REG_LINE) precedes dispatch-next (line $DISP_LINE)"
  else
    fail "register-interests precedes dispatch-next" "register=$REG_LINE dispatch=$DISP_LINE — CTL-491 race re-introduced"
  fi
fi

echo "test 10: exactly ONE pre-dispatch register-interests invocation between Phase 2 and Phase 3"
# Phase 2/3 markers in SKILL.md
PHASE2_LINE=$(grep -nE '^### Phase 2:' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
PHASE3_LINE=$(grep -nE '^### Phase 3:' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
[ -n "$PHASE2_LINE" ] && [ -n "$PHASE3_LINE" ] && pass "Phase 2/3 headers located" \
  || fail "Phase 2/3 headers located" "p2=$PHASE2_LINE p3=$PHASE3_LINE"
if [ -n "$PHASE2_LINE" ] && [ -n "$PHASE3_LINE" ]; then
  # Count register-interests.sh invocations strictly between Phase 2 header
  # and the orchestrate-dispatch-next invocation. The helper is allowed to
  # appear elsewhere (Phase 4 refresh) so we don't count the whole file.
  COUNT_BETWEEN=$(awk -v p2="$PHASE2_LINE" -v dn="$DISP_LINE" 'NR > p2 && NR < dn' "$SKILL_MD" \
    | grep -c 'orchestrate-register-interests.sh' || true)
  [ "$COUNT_BETWEEN" -ge 1 ] && pass "at least one register-interests invocation before dispatch-next (got $COUNT_BETWEEN)" \
    || fail "at least one register-interests invocation before dispatch-next" "found 0 between lines $PHASE2_LINE..$DISP_LINE"
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
