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

assert_not_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" != *"$substr"* ]]; then pass "$label"
  else fail "$label — forbidden '$substr' present"; fi
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
echo "CTL-1680 Phase 2: merge SHA is confirmed before done"

if [[ -f "$SKILL" ]]; then
  assert_contains "$BODY" "PHASE_MERGE_SHA_RETRIES" \
    "merge SHA retry uses PHASE_MERGE_SHA_RETRIES variable"
  assert_contains "$BODY" "# CTL-1680: retry empty merge_commit_sha" \
    "merge SHA retry has CTL-1680 comment marker"
  assert_contains "$BODY" "sleep 2" \
    "merge SHA retry loop sleeps (not a spin loop)"
  assert_contains "$BODY" "merge_commit_sha still empty after" \
    "merge SHA retry emits observable warning on exhaustion"
else
  fail "SKILL.md missing for Phase 2 checks: $SKILL"
fi

echo ""
echo "CTL-1680 Phase 3: automated-reviewer arrival window"

if [[ -f "$SKILL" ]]; then
  assert_contains "$BODY" "PHASE_REVIEWER_ARRIVAL_WAIT_SEC" \
    "reviewer-arrival gate uses PHASE_REVIEWER_ARRIVAL_WAIT_SEC variable"
  assert_contains "$BODY" "# CTL-1680: reviewer-arrival window" \
    "reviewer-arrival gate has CTL-1680 comment marker"
  assert_contains "$BODY" "reviewer-arrival window elapsed; proceeding to merge" \
    "reviewer-arrival gate is fail-open (elapsed path proceeds to merge)"
  assert_contains "$BODY" "REVIEWED_HEAD" \
    "reviewer-arrival gate keys on current HEAD SHA (not just PR-open time)"
  assert_contains "$BODY" "Reviewed commit" \
    "reviewer-arrival gate detects clean-pass comment (Reviewed commit shape)"
else
  fail "SKILL.md missing for Phase 3 checks: $SKILL"
fi

echo ""
echo "CTL-1680 remediation (Codex #3079): head-scoped, portable, bounded"

if [[ -f "$SKILL" ]]; then
  # P1: HEAD age must be parsed portably (jq), NOT with BSD/macOS-only `date -j`.
  assert_contains "$BODY" "fromdateiso8601" \
    "reviewer-arrival HEAD age uses portable jq fromdateiso8601"
  assert_not_contains "$BODY" 'date -u -j -f' \
    "reviewer-arrival gate does NOT use BSD-only date -j (Linux fail-open bug)"
  # P1: the reviews verdict check is scoped to the current head via commit_id.
  assert_contains "$BODY" 'commit_id == $h' \
    "reviews verdict is scoped to REVIEWED_HEAD commit_id (no stale-head pass)"
  # P2: the re-wait is bounded by the remaining reviewer window.
  assert_contains "$BODY" "MERGE_WAKE_TIMEOUT_SEC" \
    "reviewer-arrival re-wait is bounded by the remaining window"
else
  fail "SKILL.md missing for remediation checks: $SKILL"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-monitor-merge-guard: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
