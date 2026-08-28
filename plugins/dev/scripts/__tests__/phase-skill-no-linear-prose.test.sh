#!/usr/bin/env bash
# CTL-558: the deterministic coordinator (execution-core scheduler /
# orchestrate-phase-advance) owns Linear status write-back. create-pr /
# describe-pr must gate their interactive inReview transition on
# CATALYST_PHASE so the phase-agent path does not double-write.
# CTL-2239: the phase-* SKILL.md assertions this file used to carry (the
# no-Linear-prose loop, the phase-monitor-merge/phase-teardown --transition
# done pair) were removed along with those skills (B2 of the CTL-2218
# cleanup plan) — their customer, the execution-core phase-agent dispatch
# loop, no longer has those skills to dispatch. create-pr/describe-pr and
# implement-plan are standalone, surviving skills, so their coverage stays.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

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
echo "Test: implement-plan gates inProgress writes on CATALYST_PHASE"
for skill in implement-plan; do
  f="${SKILLS_DIR}/${skill}/SKILL.md"
  if [[ ! -f "$f" ]]; then
    fail "${skill}/SKILL.md exists"
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
