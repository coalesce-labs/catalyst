#!/usr/bin/env bash
# CTL-866: assert thoughts-sync-gate is wired into research-codebase and that
# the call site precedes Step 0.
# CTL-2239: the phase-research/phase-plan assertions this file used to carry
# were removed along with those skills (B2 of the CTL-2218 cleanup plan) —
# their customer, the execution-core phase-agent dispatch loop, no longer has
# those skills to dispatch. research-codebase is a standalone, surviving
# skill, so its coverage stays.
# Run: bash plugins/dev/scripts/__tests__/phase-thoughts-sync-ordering.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

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
