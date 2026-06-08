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

echo "Test: phase-monitor-merge does NOT write --transition done (CTL-703: teardown owns it)"
# CTL-703: terminal Done write moved from monitor-merge to the new phase-teardown (10th phase).
MM="${SKILLS_DIR}/phase-monitor-merge/SKILL.md"
if grep -qE "linear-transition.*--transition done|--transition done" "$MM"; then
  fail "phase-monitor-merge does NOT write --transition done (CTL-703: teardown owns it)" \
    "phase-monitor-merge must NOT transition to done — that is phase-teardown's sole responsibility"
else
  pass "phase-monitor-merge does NOT write --transition done (CTL-703: teardown owns it)"
fi

echo "Test: phase-teardown is the terminal --transition done writer (CTL-703)"
TD="${SKILLS_DIR}/phase-teardown/SKILL.md"
if grep -qE "linear-transition.*--transition done|--transition done" "$TD"; then
  pass "phase-teardown is the terminal --transition done writer (CTL-703)"
else
  fail "phase-teardown is the terminal --transition done writer (CTL-703)" \
    "phase-teardown must contain the sole --transition done call"
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

# CTL-601: implement-plan is invoked as a sub-task from inside other phase
# agents (e.g. create-pr's Post-PR Monitoring & Resolution Loop calls it to
# address review-comment fix-ups; monitor-merge calls it for CI fix-ups).
# Without the CATALYST_PHASE gate, implement-plan writes stateMap.inProgress
# directly, regressing the ticket state from PR back to Implement
# (CTL-600 tracer-bullet evidence: 2 regression flickers during pr + monitor-merge).
# Same risk for code-first-draft (could be called from re-implementation loops).
echo "Test: implement-plan / code-first-draft gate inProgress writes on CATALYST_PHASE"
for skill in implement-plan code-first-draft; do
  f="${SKILLS_DIR}/${skill}/SKILL.md"
  if [[ ! -f "$f" ]]; then
    # code-first-draft is optional; only fail if it exists AND lacks the gate.
    [[ "$skill" == "implement-plan" ]] && fail "${skill}/SKILL.md exists"
    continue
  fi
  # If the skill writes stateMap.inProgress, it MUST also reference CATALYST_PHASE.
  if grep -qE "stateMap\.inProgress|--transition[[:space:]]+inProgress|status.*[Ii]n.?[Pp]rogress" "$f"; then
    if grep -q "CATALYST_PHASE" "$f"; then
      pass "${skill} writes inProgress AND gates on CATALYST_PHASE"
    else
      fail "${skill} writes inProgress but does NOT gate on CATALYST_PHASE" \
        "$(grep -nE 'stateMap\.inProgress|--transition[[:space:]]+inProgress' "$f" | head -2)"
    fi
  else
    pass "${skill} does not write inProgress (vacuously safe)"
  fi
done

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
