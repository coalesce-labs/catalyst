#!/usr/bin/env bash
# recovery-pass-pr-not-merged.test.sh — doc-drift guards for the PR-not-merged
# remediation playbook added to recovery-pass/SKILL.md in CTL-1496.
# Run: bash plugins/dev/scripts/__tests__/recovery-pass-pr-not-merged.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
# Search the composed skill: SKILL.md + references/*.md (progressive-disclosure shape).
SKILL_DIR="${REPO_ROOT}/plugins/dev/skills/recovery-pass"
SKILL_MD="${SKILL_DIR}/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; return 0; }

# 1. Skill has a PR-not-merged remediation section (SKILL.md or references/)
if grep -rq "PR-not-merged\|pr-not-merged\|PR not merged\|pr_not_merged" "$SKILL_DIR" 2>/dev/null; then
  pass "recovery-pass skill has a PR-not-merged remediation section"
else
  fail "recovery-pass skill has a PR-not-merged remediation section" \
    "no PR-not-merged section found in ${SKILL_DIR}"
fi

# 2. References reading the recovery-pass.json brief and/or probing live PR state
if grep -rq "recovery-pass.json\|probe\|gh pr view" "$SKILL_DIR" 2>/dev/null; then
  pass "skill references reading brief / probing live PR state"
else
  fail "skill references reading brief / probing live PR state" \
    "no reference to recovery-pass.json, probe, or gh pr view"
fi

# 3. CI branch mentions gh run view --log-failed
if grep -rq "gh run view.*--log-failed\|--log-failed" "$SKILL_DIR" 2>/dev/null; then
  pass "skill CI branch mentions gh run view --log-failed"
else
  fail "skill CI branch mentions gh run view --log-failed" \
    "no --log-failed reference found"
fi

# 4. Review branch mentions resolving thread and posting @codex review
if grep -rq "@codex review\|codex review" "$SKILL_DIR" 2>/dev/null; then
  pass "skill review branch mentions posting @codex review"
else
  fail "skill review branch mentions posting @codex review" \
    "no @codex review mention in ${SKILL_DIR}"
fi

# 5. Skill forbids --admin / force-merge
if grep -rq "\-\-admin\|force.merge\|force-merge" "$SKILL_DIR" 2>/dev/null; then
  pass "skill explicitly forbids --admin / force-merge past failing checks"
else
  fail "skill explicitly forbids --admin / force-merge past failing checks" \
    "no --admin / force-merge prohibition found"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
