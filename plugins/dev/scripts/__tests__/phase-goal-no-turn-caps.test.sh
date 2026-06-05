#!/usr/bin/env bash
# Regression guard: no phase skill /goal block may contain self-stop
# turn-cap language after CTL-748.
#
# Run: bash plugins/dev/scripts/__tests__/phase-goal-no-turn-caps.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

SKILLS=(
  "plugins/dev/skills/phase-triage/SKILL.md"
  "plugins/dev/skills/phase-research/SKILL.md"
  "plugins/dev/skills/phase-plan/SKILL.md"
  "plugins/dev/skills/phase-implement/SKILL.md"
  "plugins/dev/skills/phase-verify/SKILL.md"
  "plugins/dev/skills/phase-review/SKILL.md"
  "plugins/dev/skills/phase-pr/SKILL.md"
  "plugins/dev/skills/phase-monitor-merge/SKILL.md"
  "plugins/dev/skills/phase-remediate/SKILL.md"
)

FAILURES=0; PASSES=0

for rel in "${SKILLS[@]}"; do
  f="${REPO_ROOT}/${rel}"
  if grep -q "OR I have stopped after\|OR I am within.*turn.*cap\|OR I am within.*turns\|stopped after.*turns" "$f" 2>/dev/null; then
    echo "  FAIL: $rel still contains turn-cap self-stop language"
    FAILURES=$((FAILURES + 1))
  else
    echo "  PASS: $rel — no turn-cap self-stop language"
    PASSES=$((PASSES + 1))
  fi
done

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
