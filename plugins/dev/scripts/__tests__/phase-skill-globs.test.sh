#!/usr/bin/env bash
# Verify phase-plan and phase-research SKILLs route artifact matching through
# the shared lib/phase-artifact-gate.sh (CTL-1081) and preserve the failure-reason
# strings that the orchestrator's wake-handler depends on.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PHASE_PLAN="${REPO_ROOT}/plugins/dev/skills/phase-plan/SKILL.md"
PHASE_RESEARCH="${REPO_ROOT}/plugins/dev/skills/phase-research/SKILL.md"

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

for f in "$PHASE_PLAN" "$PHASE_RESEARCH"; do
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
echo "─────────────────────────────────────────────"
echo "phase-skill-globs: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
