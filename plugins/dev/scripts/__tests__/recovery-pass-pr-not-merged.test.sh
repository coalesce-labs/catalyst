#!/usr/bin/env bash
# recovery-pass-pr-not-merged.test.sh — doc-drift guards for the PR-not-merged
# remediation playbook added to recovery-pass/SKILL.md in CTL-1496.
# Run: bash plugins/dev/scripts/__tests__/recovery-pass-pr-not-merged.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/recovery-pass/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; return 0; }

# 1. SKILL.md has a PR-not-merged remediation section
if grep -q "PR-not-merged\|pr-not-merged\|PR not merged\|pr_not_merged" "$SKILL_MD" 2>/dev/null; then
  pass "recovery-pass/SKILL.md has a PR-not-merged remediation section"
else
  fail "recovery-pass/SKILL.md has a PR-not-merged remediation section" \
    "no PR-not-merged section found in ${SKILL_MD}"
fi

# 2. References reading the recovery-pass.json brief and/or probing live PR state
if grep -q "recovery-pass.json\|probe\|gh pr view" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md references reading brief / probing live PR state"
else
  fail "SKILL.md references reading brief / probing live PR state" \
    "no reference to recovery-pass.json, probe, or gh pr view"
fi

# 3. CI branch mentions gh run view --log-failed
if grep -q "gh run view.*--log-failed\|--log-failed" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md CI branch mentions gh run view --log-failed"
else
  fail "SKILL.md CI branch mentions gh run view --log-failed" \
    "no --log-failed reference found"
fi

# 4. Review branch mentions resolving thread and posting @codex review
if grep -q "@codex review\|codex review" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md review branch mentions posting @codex review"
else
  fail "SKILL.md review branch mentions posting @codex review" \
    "no @codex review mention in ${SKILL_MD}"
fi

# 5. SKILL.md forbids --admin / force-merge
if grep -q "\-\-admin\|force.merge\|force-merge" "$SKILL_MD" 2>/dev/null; then
  pass "SKILL.md explicitly forbids --admin / force-merge past failing checks"
else
  fail "SKILL.md explicitly forbids --admin / force-merge past failing checks" \
    "no --admin / force-merge prohibition found"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
