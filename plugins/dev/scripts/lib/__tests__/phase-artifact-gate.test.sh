#!/usr/bin/env bash
# Shell tests for lib/phase-artifact-gate.sh — prior-artifact gate specifications.
#
# Run: bash plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../phase-artifact-gate.sh
. "$LIB_DIR/phase-artifact-gate.sh"

FAILURES=0
PASSES=0
result=""

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

echo "phase-artifact-gate tests"

# ── 1. resolve-conflict prior artifact ────────────────────────────────────────
result="$(prior_artifact_for_phase resolve-conflict)"
if [[ "$result" != "signal:resolve-conflict-brief.json" ]]; then
	fail "prior_artifact_for_phase resolve-conflict = '${result}', expected 'signal:resolve-conflict-brief.json'"
else
	pass "prior_artifact_for_phase resolve-conflict"
fi

# ── 2. Entry point phases (no prior artifact) ────────────────────────────────────
for phase in triage; do
	result="$(prior_artifact_for_phase "$phase")"
	if [[ "$result" == "" ]]; then
		pass "prior_artifact_for_phase $phase (entry point)"
	else
		fail "prior_artifact_for_phase $phase = '${result}', expected ''"
	fi
done

# ── 3. Standard signal-based phases ──────────────────────────────────────────────
declare -A expected_signals=(
	[research]="signal:triage.json"
	[verify]="signal:phase-implement.json"
	[review]="signal:verify.json"
	[pr]="signal:review.json"
	[monitor-merge]="signal:phase-pr.json"
	[monitor-deploy]="signal:phase-monitor-merge.json"
	[remediate]="signal:verify.json"
	[recovery-pass]="signal:recovery-pass.json"
	[teardown]="signal:phase-monitor-deploy.json"
)

for phase in "${!expected_signals[@]}"; do
	result="$(prior_artifact_for_phase "$phase")"
	expected="${expected_signals[$phase]}"
	if [[ "$result" == "$expected" ]]; then
		pass "prior_artifact_for_phase $phase = '$expected'"
	else
		fail "prior_artifact_for_phase $phase = '${result}', expected '${expected}'"
	fi
done

# ── 4. Glob-based phases ─────────────────────────────────────────────────────────
declare -A expected_globs=(
	[plan]="glob:thoughts/shared/research"
	[implement]="glob:thoughts/shared/plans"
)

for phase in "${!expected_globs[@]}"; do
	result="$(prior_artifact_for_phase "$phase")"
	expected="${expected_globs[$phase]}"
	if [[ "$result" == "$expected" ]]; then
		pass "prior_artifact_for_phase $phase = '$expected'"
	else
		fail "prior_artifact_for_phase $phase = '${result}', expected '${expected}'"
	fi
done

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
