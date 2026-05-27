#!/usr/bin/env bash
# Unit tests for plugins/dev/scripts/lib/phase-sequence.sh (CTL-607).
#
# Asserts:
#   - latest_phase_in_dir returns the highest-index PHASES entry that has a
#     phase-<name>.json present (mirrors scheduler.mjs:270).
#   - The bash PHASES mirror stays in lockstep with lib/phase-fsm.mjs PHASES
#     (drift guard — catches divergence in CI).
#
# Run: bash plugins/dev/scripts/__tests__/phase-sequence.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/phase-sequence.sh"
FSM_MJS="${REPO_ROOT}/plugins/dev/scripts/lib/phase-fsm.mjs"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

[ -f "$LIB" ] || { echo "lib not found: $LIB" >&2; exit 2; }
# shellcheck disable=SC1090
. "$LIB"

scratch_setup() {
  SCRATCH="$(mktemp -d -t phase-sequence-XXXXXX)"
}
scratch_teardown() {
  rm -rf "$SCRATCH"
  unset SCRATCH
}

# ─── 1. Empty dir → empty string ─────────────────────────────────────────────
echo "test 1: empty dir returns empty string"
scratch_setup
result=$(latest_phase_in_dir "$SCRATCH")
[ -z "$result" ] \
  && pass "empty dir → empty" \
  || fail "empty dir → empty" "got: '$result'"
scratch_teardown

# ─── 2. Single signal: triage ────────────────────────────────────────────────
echo "test 2: single phase-triage.json → triage"
scratch_setup
: > "$SCRATCH/phase-triage.json"
result=$(latest_phase_in_dir "$SCRATCH")
[ "$result" = "triage" ] \
  && pass "single triage → triage" \
  || fail "single triage → triage" "got: '$result'"
scratch_teardown

# ─── 3. Multiple: triage + implement → implement (sequence wins, not mtime) ──
echo "test 3: triage + implement (implement first by mtime) → implement"
scratch_setup
: > "$SCRATCH/phase-implement.json"
# Create triage AFTER implement; if the function went by mtime it would pick
# triage. The contract is sequence order, so the result must still be implement.
sleep 1
: > "$SCRATCH/phase-triage.json"
result=$(latest_phase_in_dir "$SCRATCH")
[ "$result" = "implement" ] \
  && pass "max-index by sequence (not mtime)" \
  || fail "max-index by sequence (not mtime)" "got: '$result'"
scratch_teardown

# ─── 4. Out-of-order set: research + plan + verify → verify ──────────────────
echo "test 4: research + plan + verify → verify"
scratch_setup
: > "$SCRATCH/phase-verify.json"
: > "$SCRATCH/phase-research.json"
: > "$SCRATCH/phase-plan.json"
result=$(latest_phase_in_dir "$SCRATCH")
[ "$result" = "verify" ] \
  && pass "out-of-order set → verify" \
  || fail "out-of-order set → verify" "got: '$result'"
scratch_teardown

# ─── 5. Terminal tail: monitor-deploy is the max ─────────────────────────────
echo "test 5: chain ending in monitor-deploy → monitor-deploy"
scratch_setup
for p in triage research plan implement verify review pr monitor-merge monitor-deploy; do
  : > "$SCRATCH/phase-${p}.json"
done
result=$(latest_phase_in_dir "$SCRATCH")
[ "$result" = "monitor-deploy" ] \
  && pass "monitor-deploy tail" \
  || fail "monitor-deploy tail" "got: '$result'"
scratch_teardown

# ─── 6. Drift guard: bash PHASES == lib/phase-fsm.mjs PHASES ─────────────────
echo "test 6: PHASES drift guard (bash mirror == phase-fsm.mjs)"
if ! command -v node >/dev/null 2>&1; then
  echo "  SKIP: node not on PATH (drift guard requires node in test env)"
else
  MJS_PHASES=$(node --input-type=module -e \
    "import('file://${FSM_MJS}').then(m=>process.stdout.write(m.PHASES.join(' ')))" 2>/dev/null || echo "")
  BASH_PHASES="${PHASES[*]}"
  if [ -z "$MJS_PHASES" ]; then
    fail "extract PHASES from phase-fsm.mjs" "node import returned empty"
  elif [ "$MJS_PHASES" = "$BASH_PHASES" ]; then
    pass "bash PHASES matches phase-fsm.mjs PHASES"
  else
    fail "bash PHASES matches phase-fsm.mjs PHASES" "bash='$BASH_PHASES' mjs='$MJS_PHASES'"
  fi
fi

# ─── 7. CTL-667: REBASE_PHASES subset + exact-set drift guard ────────────────
# REBASE_PHASES drives the dispatch-time front-load rebase (phase-agent-dispatch).
# It must stay a strict subset of PHASES and equal exactly the named build set —
# adding/removing a build phase forces a conscious update here.
echo "test 7: REBASE_PHASES subset of PHASES + exact named build set"
missing=""
for rp in "${REBASE_PHASES[@]}"; do
  found=0
  for p in "${PHASES[@]}"; do [ "$p" = "$rp" ] && found=1; done
  [ "$found" = "1" ] || missing="$missing $rp"
done
[ -z "$missing" ] \
  && pass "every REBASE_PHASES element is present in PHASES" \
  || fail "REBASE_PHASES is a subset of PHASES" "not in PHASES:$missing"
EXPECTED_REBASE="research plan implement verify review"
[ "${REBASE_PHASES[*]}" = "$EXPECTED_REBASE" ] \
  && pass "REBASE_PHASES equals exactly 'research plan implement verify review'" \
  || fail "REBASE_PHASES exact set" "got: '${REBASE_PHASES[*]}'"

# ─── 8. CTL-667: monitor phases are excluded from the front-load rebase ──────
# Regression guard for the exemption: monitor-merge/monitor-deploy operate on the
# PR / merged SHA and have their own BEHIND handling — they must never rebase.
echo "test 8: is_rebase_phase false for monitor-merge and monitor-deploy"
if is_rebase_phase monitor-merge; then
  fail "is_rebase_phase monitor-merge → false"
else
  pass "is_rebase_phase monitor-merge → false"
fi
if is_rebase_phase monitor-deploy; then
  fail "is_rebase_phase monitor-deploy → false"
else
  pass "is_rebase_phase monitor-deploy → false"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
