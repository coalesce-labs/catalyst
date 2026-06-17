#!/usr/bin/env bash
# CTL-866: assert thoughts-sync-gate is wired into phase-research and phase-plan
# and that the call site precedes --status complete.
# Run: bash plugins/dev/scripts/__tests__/phase-thoughts-sync-ordering.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

for skill in phase-research phase-plan; do
  f="${SKILLS_DIR}/${skill}/SKILL.md"

  # 1. Gate is referenced in the skill
  echo "Test: ${skill} references thoughts-sync-gate.sh"
  if grep -q "thoughts-sync-gate.sh" "$f"; then
    pass "${skill} references thoughts-sync-gate.sh"
  else
    fail "${skill} references thoughts-sync-gate.sh" \
      "thoughts-sync-gate.sh not found in ${f}"
  fi

  # 2. Gate line precedes the first --status complete emit-complete call
  echo "Test: ${skill} — gate call is before --status complete"
  gate_line=$(grep -n "thoughts-sync-gate.sh" "$f" | head -1 | cut -d: -f1)
  complete_line=$(grep -n -- "--status complete" "$f" | head -1 | cut -d: -f1)
  if [[ -z "$gate_line" ]]; then
    fail "${skill} gate ordering: gate not found"
  elif [[ -z "$complete_line" ]]; then
    fail "${skill} gate ordering: --status complete not found"
  elif [[ "$gate_line" -lt "$complete_line" ]]; then
    pass "${skill} gate (line ${gate_line}) before --status complete (line ${complete_line})"
  else
    fail "${skill} gate ordering: gate (line ${gate_line}) is NOT before --status complete (line ${complete_line})"
  fi

  # 3. Skill does NOT inline raw `humanlayer thoughts sync` (must go through the gate)
  echo "Test: ${skill} does not inline raw humanlayer thoughts sync"
  if grep -q "humanlayer thoughts sync" "$f"; then
    fail "${skill} does not inline raw humanlayer thoughts sync" \
      "found raw 'humanlayer thoughts sync' in ${f} — must go through the gate"
  else
    pass "${skill} does not inline raw humanlayer thoughts sync"
  fi
done

# ── CTL-1236: pull-before-read gate in phase-research and research-codebase ───

# phase-research: thoughts-pull-sync-gate.sh is referenced AND precedes learnings grep
echo "Test: phase-research references thoughts-pull-sync-gate.sh"
PR_FILE="${SKILLS_DIR}/phase-research/SKILL.md"
if grep -q "thoughts-pull-sync-gate.sh" "$PR_FILE"; then
  pass "phase-research references thoughts-pull-sync-gate.sh"
else
  fail "phase-research references thoughts-pull-sync-gate.sh" \
    "thoughts-pull-sync-gate.sh not found in ${PR_FILE}"
fi

echo "Test: phase-research — pull gate is before the learnings grep"
pull_gate_line=$(grep -n "thoughts-pull-sync-gate.sh" "$PR_FILE" | head -1 | cut -d: -f1)
learn_line=$(grep -n "LEARN_DIR\|thoughts/shared/learnings" "$PR_FILE" | head -1 | cut -d: -f1)
if [[ -z "$pull_gate_line" ]]; then
  fail "phase-research pull gate ordering: pull gate not found"
elif [[ -z "$learn_line" ]]; then
  fail "phase-research pull gate ordering: learnings grep not found"
elif [[ "$pull_gate_line" -lt "$learn_line" ]]; then
  pass "phase-research pull gate (line ${pull_gate_line}) before learnings grep (line ${learn_line})"
else
  fail "phase-research pull gate ordering: pull gate (line ${pull_gate_line}) is NOT before learnings grep (line ${learn_line})"
fi

echo "Test: phase-research pull gate does not use 'humanlayer thoughts sync'"
if grep -A2 "thoughts-pull-sync-gate.sh" "$PR_FILE" | grep -q "humanlayer thoughts sync"; then
  fail "phase-research pull gate must not use 'humanlayer thoughts sync'"
else
  pass "phase-research pull gate does not use 'humanlayer thoughts sync'"
fi

# research-codebase: thoughts-pull-sync-gate.sh is referenced AND before Step 0
echo "Test: research-codebase references thoughts-pull-sync-gate.sh"
RC_FILE="${SKILLS_DIR}/research-codebase/SKILL.md"
if grep -q "thoughts-pull-sync-gate.sh" "$RC_FILE"; then
  pass "research-codebase references thoughts-pull-sync-gate.sh"
else
  fail "research-codebase references thoughts-pull-sync-gate.sh" \
    "thoughts-pull-sync-gate.sh not found in ${RC_FILE}"
fi

echo "Test: research-codebase — pull gate is before Step 0"
rc_pull_gate_line=$(grep -n "thoughts-pull-sync-gate.sh" "$RC_FILE" | head -1 | cut -d: -f1)
step0_line=$(grep -n "### Step 0" "$RC_FILE" | head -1 | cut -d: -f1)
if [[ -z "$rc_pull_gate_line" ]]; then
  fail "research-codebase pull gate ordering: pull gate not found"
elif [[ -z "$step0_line" ]]; then
  fail "research-codebase pull gate ordering: Step 0 not found"
elif [[ "$rc_pull_gate_line" -lt "$step0_line" ]]; then
  pass "research-codebase pull gate (line ${rc_pull_gate_line}) before Step 0 (line ${step0_line})"
else
  fail "research-codebase pull gate ordering: pull gate (line ${rc_pull_gate_line}) is NOT before Step 0 (line ${step0_line})"
fi

echo "Test: research-codebase pull gate does not use 'humanlayer thoughts sync'"
if grep -A2 "thoughts-pull-sync-gate.sh" "$RC_FILE" | grep -q "humanlayer thoughts sync"; then
  fail "research-codebase pull gate must not use 'humanlayer thoughts sync'"
else
  pass "research-codebase pull gate does not use 'humanlayer thoughts sync'"
fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
