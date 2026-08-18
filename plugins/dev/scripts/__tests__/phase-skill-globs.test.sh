#!/usr/bin/env bash
# Verify phase-plan and phase-research SKILLs route artifact matching through
# the shared lib/phase-artifact-gate.sh (CTL-1081) and preserve the failure-reason
# strings that the orchestrator's wake-handler depends on.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PHASE_PLAN="${REPO_ROOT}/plugins/dev/skills/phase-plan/SKILL.md"
PHASE_RESEARCH="${REPO_ROOT}/plugins/dev/skills/phase-research/SKILL.md"
PHASE_IMPLEMENT="${REPO_ROOT}/plugins/dev/skills/phase-implement/SKILL.md"
PHASE_MONITOR_MERGE="${REPO_ROOT}/plugins/dev/skills/phase-monitor-merge/SKILL.md"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_grep() {
  local file="$1" pattern="$2" label="$3"
  if grep -qE "$pattern" "$file"; then
    pass "$label"
  else
    fail "$label — pattern '$pattern' not found in $(basename "$(dirname "$file")")/$(basename "$file")"
  fi
}

assert_count_at_least() {
  local file="$1" pattern="$2" min="$3" label="$4"
  local count
  count=$(grep -cE "$pattern" "$file")
  if [[ "$count" -ge "$min" ]]; then
    pass "$label (count=${count})"
  else
    fail "$label — expected >= ${min} matches, got ${count}"
  fi
}

for f in "$PHASE_PLAN" "$PHASE_RESEARCH" "$PHASE_IMPLEMENT" "$PHASE_MONITOR_MERGE"; do
  if [[ ! -f "$f" ]]; then
    echo "FATAL: skill file missing: $f" >&2
    exit 1
  fi
done

echo "Test: phase-plan SKILL routes through match_thoughts_artifact (CTL-1081)"
# The inline 3-step glob is replaced — both artifact checks now use the shared matcher.
assert_count_at_least "$PHASE_PLAN" 'match_thoughts_artifact' 2 \
  "phase-plan SKILL uses match_thoughts_artifact at >= 2 sites"
# Failure-reason names must be preserved so the orchestrator's wake-handler
# can still distinguish the two kinds of artifact miss.
assert_grep "$PHASE_PLAN" 'prior_artifact_missing:research_doc' \
  "phase-plan SKILL preserves research_doc failure reason"
assert_grep "$PHASE_PLAN" 'plan_doc_not_written' \
  "phase-plan SKILL preserves plan_doc_not_written failure reason"

echo ""
echo "Test: phase-research SKILL routes through match_thoughts_artifact (CTL-1081)"
assert_grep "$PHASE_RESEARCH" 'match_thoughts_artifact' \
  "phase-research SKILL uses match_thoughts_artifact"
assert_grep "$PHASE_RESEARCH" 'research_doc_not_written' \
  "phase-research SKILL preserves research_doc_not_written failure reason"

echo ""
echo "Test: phase-implement routes through match_thoughts_artifact (CTL-1998)"
# CTL-1998: phase-agent-dispatch:560 gates the implement dispatch with
# match_thoughts_artifact, which accepts BOTH `*-<ticket>.md` and
# `*-<ticket>-<slug>.md`. phase-implement re-resolved with a strict
# `*-<ticket>.md` glob and exited 1 "no plan found" on the slug form — the
# dispatcher and the phase disagreeing about the same file. This asserts the
# conversion, and that the strict glob does NOT come back.
# ⚠️ Match the CALL, not the bare token: a comment mentioning
# match_thoughts_artifact satisfies a token grep, and this file now contains
# exactly such a comment. Verified by reverting the fix — the token assertion
# still passed while the strict-glob assertion below was what actually caught it.
assert_grep "$PHASE_IMPLEMENT" '\$\(match_thoughts_artifact thoughts/shared/plans' \
  "phase-implement SKILL CALLS match_thoughts_artifact on thoughts/shared/plans"
if grep -qE 'PLAN_MATCHES=\( *thoughts/shared/plans/\*-' "$PHASE_IMPLEMENT"; then
  fail "phase-implement SKILL still carries the strict *-<ticket>.md plan glob"
else
  pass "phase-implement SKILL no longer uses the strict *-<ticket>.md plan glob"
fi

echo ""
echo "Test: phase-monitor-merge assigns EMIT before it uses it (CTL-1998)"
# CTL-1998: "$EMIT" was USED ~240 lines before it was assigned, under a
# `set -euo pipefail` prelude — so the unresolved-human-thread branch aborted with
# an unbound-variable error and emitted nothing, recording an undeclared
# abandonment. Assert ORDER, not mere presence: presence was never the problem.
EMIT_ASSIGN_LINE="$(grep -nE '^EMIT=' "$PHASE_MONITOR_MERGE" | head -1 | cut -d: -f1)"
EMIT_FIRST_USE_LINE="$(grep -nE '"\$EMIT"' "$PHASE_MONITOR_MERGE" | head -1 | cut -d: -f1)"
if [[ -z "$EMIT_ASSIGN_LINE" ]]; then
  fail "phase-monitor-merge SKILL never assigns EMIT"
elif [[ -z "$EMIT_FIRST_USE_LINE" ]]; then
  pass "phase-monitor-merge SKILL assigns EMIT and never expands it"
elif [[ "$EMIT_ASSIGN_LINE" -lt "$EMIT_FIRST_USE_LINE" ]]; then
  pass "phase-monitor-merge SKILL assigns EMIT (line ${EMIT_ASSIGN_LINE}) before first use (line ${EMIT_FIRST_USE_LINE})"
else
  fail "phase-monitor-merge SKILL uses \$EMIT at line ${EMIT_FIRST_USE_LINE} but assigns it at ${EMIT_ASSIGN_LINE} — unbound under set -u"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-skill-globs: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
