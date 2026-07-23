#!/usr/bin/env bash
# Divergence test for CTL-1490 Feature D: implement-plan/SKILL.md must invoke
# the implement-plan-draft-pr-early fenced block AFTER the TDD Green step
# (not only at the full-phase boundary), so a mid-phase kill loses at most one
# Red→Green cycle.
#
# Run: bash plugins/dev/scripts/__tests__/implement-plan-draft-pr-timing.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/implement-plan/SKILL.md"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# ──────────────────────────────────────────────────────────────────────────────
# T1: the implement-plan-draft-pr-early fence appears BEFORE "**Refactor**"
#     in SKILL.md (i.e., it is placed in the TDD Green step, not only at the
#     full-phase boundary).
# ──────────────────────────────────────────────────────────────────────────────
echo "T1: implement-plan-draft-pr-early fence is before **Refactor** in SKILL.md"
FENCE_LINE="$(grep -n 'implement-plan-draft-pr-early' "$SKILL_MD" | head -1 | cut -d: -f1)"
REFACTOR_LINE="$(grep -n '^\*\*Refactor\*\*\|^3\. \*\*Refactor\*\*' "$SKILL_MD" | head -1 | cut -d: -f1)"

if [[ -z "$FENCE_LINE" ]]; then
  fail "T1: 'implement-plan-draft-pr-early' not found in SKILL.md at all"
elif [[ -z "$REFACTOR_LINE" ]]; then
  fail "T1: '**Refactor**' step not found in SKILL.md"
elif [[ "$FENCE_LINE" -lt "$REFACTOR_LINE" ]]; then
  pass "T1: fence at line ${FENCE_LINE} is before Refactor step at line ${REFACTOR_LINE}"
else
  fail "T1: fence at line ${FENCE_LINE} is NOT before Refactor step at line ${REFACTOR_LINE} — block was not moved to post-Green location"
fi

# ──────────────────────────────────────────────────────────────────────────────
# T2: the fence at the post-Green location still carries the CATALYST_PHASE guard.
# ──────────────────────────────────────────────────────────────────────────────
echo "T2: post-Green fence block still guarded by [[ -n \"\${CATALYST_PHASE:-}\" ]]"
# Extract lines between the first fence occurrence and the closing ``` that follows it.
AWK_OUT="$(awk '
  /implement-plan-draft-pr-early/ && !found { found=1; next }
  found && /^```$/ { exit }
  found { print }
' "$SKILL_MD")"

if echo "$AWK_OUT" | grep -qF 'CATALYST_PHASE'; then
  pass "T2: CATALYST_PHASE guard is present in the post-Green fence block"
else
  fail "T2: CATALYST_PHASE guard is MISSING from the post-Green fence block"
fi

# ──────────────────────────────────────────────────────────────────────────────
# T3: draft_pr_push appears in the post-Green fence block (core push line preserved).
# ──────────────────────────────────────────────────────────────────────────────
echo "T3: draft_pr_push call is present in the post-Green fence block"
if echo "$AWK_OUT" | grep -qF 'draft_pr_push'; then
  pass "T3: draft_pr_push is in the post-Green fence block"
else
  fail "T3: draft_pr_push is MISSING from the post-Green fence block"
fi

# ──────────────────────────────────────────────────────────────────────────────
# T4: draft_pr_ensure appears in the post-Green fence block (idempotent PR open).
# ──────────────────────────────────────────────────────────────────────────────
echo "T4: draft_pr_ensure call is present in the post-Green fence block"
if echo "$AWK_OUT" | grep -qF 'draft_pr_ensure'; then
  pass "T4: draft_pr_ensure is in the post-Green fence block"
else
  fail "T4: draft_pr_ensure is MISSING from the post-Green fence block"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "implement-plan-draft-pr-timing: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
