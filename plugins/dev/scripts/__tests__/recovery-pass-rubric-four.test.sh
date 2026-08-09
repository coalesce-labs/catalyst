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

# ── CAT-11 (Codex P1 round 1) — the three RUBRIC FOUR steps that were unreachable
# or unsafe as written. Each guard pins the CORRECTION, so a future edit that
# reverts to the broken instruction fails here instead of silently shipping.

# (1) Rebuild must use the branch the probe FOUND. create-worktree.sh seeds only
# from origin/<worktree_name>, so passing the bare ticket key loses the work when
# the orphan lives on Linear's branch-name slug.
if grep -q 'create-worktree.sh "\$(jq -r ' "$SKILL_MD" \
  && grep -qi 'NOT the bare ticket key' "$SKILL_MD"; then
  pass "rebuild passes the probe-confirmed branchName, not the bare ticket key"
else
  fail "rebuild passes the probe-confirmed branchName, not the bare ticket key"
fi

# (2) draft_pr_ensure silently retries WITHOUT --draft on failure, so the skill has
# to verify .isDraft and undo, never trust the helper's success.
if grep -q 'gh pr ready --undo' "$SKILL_MD" && grep -q 'isDraft' "$SKILL_MD"; then
  pass "draft-only requirement is ENFORCED (isDraft read back + --undo path)"
else
  fail "draft-only requirement is ENFORCED (isDraft read back + --undo path)"
fi

# (3) This cohort has no worker dir, so a rescued PR needs a real downstream phase
# signal or it never re-enters the pipeline.
if grep -q 'phase-monitor-merge.json' "$SKILL_MD"; then
  pass "rescued work gets a downstream phase signal"
else
  fail "rescued work gets a downstream phase signal"
fi

# (4) The trigger field must actually be rendered into the delegate's context.
CTX="${REPO_ROOT}/plugins/dev/scripts/execution-core/recovery-pass-context.mjs"
if grep -q 'unownedInFlightDetail' "$CTX"; then
  pass "board-context renderer emits unownedInFlightDetail (the rubric's trigger)"
else
  fail "board-context renderer emits unownedInFlightDetail (the rubric's trigger)"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
