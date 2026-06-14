#!/usr/bin/env bash
# Static guard: phase-monitor-merge/SKILL.md has the pre-merge stale-ref check (CTL-1051).
# Run: bash plugins/dev/scripts/__tests__/phase-monitor-merge-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-monitor-merge/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" == *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' not found"; fi
}

echo "CTL-1051: phase-monitor-merge pre-merge stale-ref guard"

if [[ -f "$SKILL" ]]; then
  BODY="$(cat "$SKILL")"
  assert_contains "$BODY" "draft_pr_push_verify" \
    "monitor-merge push-verifies on headRefOid mismatch"
  assert_contains "$BODY" "head.sha" \
    "monitor-merge reads PR head SHA pre-merge"
else
  fail "SKILL.md missing: $SKILL"
fi

echo ""
echo "CTL-1119: merge path uses gh pr merge (REST), not git push"

if [[ -f "$SKILL" ]]; then
  if grep -q 'gh pr merge .*--squash' "$SKILL"; then
    pass "merge path uses gh pr merge (REST) — 'workflow' OAuth scope not required for merge"
  else
    fail "merge path should use 'gh pr merge --squash' (REST API, no workflow scope needed)"
  fi
else
  fail "SKILL.md missing for REST-path check: $SKILL"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-monitor-merge-guard: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
