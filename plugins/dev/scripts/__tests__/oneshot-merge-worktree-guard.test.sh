#!/usr/bin/env bash
# Static guard: oneshot/SKILL.md uses worktree-safe merge (CTL-56).
# Mirrors phase-monitor-merge-guard.test.sh CTL-56 block against the legacy oneshot skill.
# Run: bash plugins/dev/scripts/__tests__/oneshot-merge-worktree-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/legacy/skills/oneshot/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" == *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' not found"; fi
}

assert_not_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" != *"$substr"* ]]; then pass "$label"
  else fail "$label — forbidden '$substr' present"; fi
}

echo "CTL-56: oneshot worktree-safe merge (drop --delete-branch, checkout-free remote-ref delete)"

if [[ -f "$SKILL" ]]; then
  BODY="$(cat "$SKILL")"
  assert_not_contains "$BODY" "--delete-branch" \
    "CTL-56: oneshot merge call drops --delete-branch (worktree-safe)"
  assert_contains "$BODY" "git/refs/heads/" \
    "CTL-56: oneshot deletes remote head ref checkout-free"
  assert_contains "$BODY" "--method DELETE" \
    "CTL-56: oneshot remote-ref delete uses gh api --method DELETE"
else
  fail "SKILL.md missing: $SKILL"
fi

echo ""
echo "CTL-56: oneshot retains gh pr merge --squash (REST path) and REST confirm"

if [[ -f "$SKILL" ]]; then
  if grep -q 'gh pr merge .*--squash' "$SKILL"; then
    pass "oneshot merge path uses gh pr merge --squash (REST API)"
  else
    fail "oneshot merge path should use 'gh pr merge --squash' (REST API)"
  fi
  assert_contains "$BODY" ".merged" \
    "oneshot has REST .merged confirm after merge"
else
  fail "SKILL.md missing for REST-path check: $SKILL"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "oneshot-merge-worktree-guard: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
