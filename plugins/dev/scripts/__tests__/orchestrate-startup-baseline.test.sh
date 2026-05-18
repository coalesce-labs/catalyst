#!/usr/bin/env bash
# Structural regression test for the Phase 2 baseline-capture block + the
# Phase 4 replay invocation in orchestrate/SKILL.md (CTL-491).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-startup-baseline.test.sh
#
# The orchestrate skill is a markdown runbook and cannot be unit-tested at the
# bash level. These tests greps the SKILL.md to confirm that:
#   (a) Phase 2 sets up state.json.race.{startLineCursor,startEventsFile}
#   (b) Phase 4 invokes orchestrate-replay-phase-events.sh before the live
#       Monitor/wait-for loop.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/orchestrate/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

[ -f "$SKILL_MD" ] || { echo "MISSING: $SKILL_MD"; exit 2; }

echo "test 10: SKILL.md captures state.json.race baseline before Phase 3 dispatch"
# We assert that the literal jq filter for .race.startLineCursor appears in
# the SKILL.md AND that it appears before the dispatch-next invocation.
BASELINE_LINE=$(grep -n 'startLineCursor' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
DISP_LINE=$(grep -n 'orchestrate-dispatch-next' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
REPLAY_LINE=$(grep -n 'orchestrate-replay-phase-events' "$SKILL_MD" | head -1 | cut -d: -f1 || true)

[ -n "$BASELINE_LINE" ] && pass "race.startLineCursor referenced" \
  || fail "race.startLineCursor referenced" "no match in $SKILL_MD"
[ -n "$DISP_LINE" ] && pass "dispatch-next referenced" \
  || fail "dispatch-next referenced"
if [ -n "$BASELINE_LINE" ] && [ -n "$DISP_LINE" ]; then
  if [ "$BASELINE_LINE" -lt "$DISP_LINE" ]; then
    pass "baseline capture (line $BASELINE_LINE) precedes dispatch-next (line $DISP_LINE)"
  else
    fail "baseline capture precedes dispatch-next" "baseline=$BASELINE_LINE dispatch=$DISP_LINE"
  fi
fi

echo "test 11: SKILL.md invokes orchestrate-replay-phase-events.sh on Phase 4 entry (before wait-for)"
[ -n "$REPLAY_LINE" ] && pass "replay helper referenced" \
  || fail "replay helper referenced" "no match in $SKILL_MD"
# Locate the Phase 4 wait-for invocation specifically (the one bound to
# filter.wake.${ORCH_NAME} — the Monitor loop entry that this orchestrator
# blocks on). Other wait-for references upstream are in instructional /
# fallback blocks and aren't part of the live invocation path.
WAITFOR_LINE=$(grep -n 'WAKE_EVENT=.*catalyst-events wait-for' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
[ -n "$WAITFOR_LINE" ] && pass "Phase 4 wait-for invocation located" || fail "Phase 4 wait-for invocation located" "no match"
if [ -n "$REPLAY_LINE" ] && [ -n "$WAITFOR_LINE" ]; then
  if [ "$REPLAY_LINE" -lt "$WAITFOR_LINE" ]; then
    pass "replay (line $REPLAY_LINE) precedes Phase 4 wait-for (line $WAITFOR_LINE)"
  else
    fail "replay precedes Phase 4 wait-for" "replay=$REPLAY_LINE wait-for=$WAITFOR_LINE"
  fi
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
