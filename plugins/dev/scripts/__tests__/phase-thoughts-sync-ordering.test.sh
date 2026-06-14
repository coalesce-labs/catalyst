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

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
