#!/usr/bin/env bash
# CTL-558: the deterministic coordinator (execution-core scheduler /
# orchestrate-phase-advance) owns Linear status write-back. The six shared
# phase-* skills must NOT carry their own `linear-transition.sh --transition`
# prose, and create-pr / describe-pr must gate their interactive inReview
# transition on CATALYST_PHASE so the phase-agent path does not double-write.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

echo "Test: phase-* skills carry no linear-transition status-write prose"
# The removed prose has two signatures: the `## Linear state transition`
# heading, and a `--transition <statekey>` invocation. Either present means
# the prose deliverable-4 removes still lingers.
for skill in phase-research phase-plan phase-implement phase-verify phase-review; do
  f="${SKILLS_DIR}/${skill}/SKILL.md"
  if [[ ! -f "$f" ]]; then
    fail "${skill}/SKILL.md exists"
    continue
  fi
  hit=""
  grep -qE '^## Linear state transition' "$f" && hit="heading"
  grep -qE -- '--transition (researching|planning|inProgress|verifying|reviewing)' "$f" \
    && hit="${hit:+$hit+}invocation"
  if [[ -n "$hit" ]]; then
    fail "${skill} carries no Linear status-write prose" \
      "found: $hit — $(grep -nE '^## Linear state transition|--transition (researching|planning|inProgress|verifying|reviewing)' "$f" | head -2)"
  else
    pass "${skill} carries no Linear status-write prose"
  fi
done

echo "Test: phase-monitor-merge KEEPS its terminal --transition done writer"
# Plan Phase 4 §2 'Keep' — in phase-agents mode this is the terminal-Done
# writer (orchestrate-phase-advance never advances past monitor-deploy).
MM="${SKILLS_DIR}/phase-monitor-merge/SKILL.md"
if grep -qE "linear-transition.*--transition done|--transition done" "$MM"; then
  pass "phase-monitor-merge keeps --transition done (terminal writer)"
else
  fail "phase-monitor-merge keeps --transition done (terminal writer)" \
    "the phase-agents-mode terminal Done writer must NOT be removed"
fi

echo "Test: create-pr / describe-pr gate the inReview transition on CATALYST_PHASE"
for skill in create-pr describe-pr; do
  f="${SKILLS_DIR}/${skill}/SKILL.md"
  if [[ ! -f "$f" ]]; then
    fail "${skill}/SKILL.md exists"
    continue
  fi
  if grep -q "CATALYST_PHASE" "$f"; then
    pass "${skill} references CATALYST_PHASE (transition gated under phase agents)"
  else
    fail "${skill} references CATALYST_PHASE (transition gated under phase agents)"
  fi
done

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
