#!/usr/bin/env bash
# Contract tests for lib/phase-artifact-gate.sh (CTL-1081).
#
# Covers:
#  1. match_thoughts_artifact: tail form, slug form (lowercase), slug form (uppercase),
#     cross-ticket lookalike rejection, wrong-ticket rejection, no-match return.
#  2. Spec map: prior_artifact_for_phase, own_thoughts_artifact_dir_for_phase.
#  3. Contract / divergence: dispatch + emit-complete both source the lib;
#     phase-research + phase-plan SKILLs reference match_thoughts_artifact.
#
# Run: bash plugins/dev/scripts/__tests__/phase-artifact-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/phase-artifact-gate.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-artifact-gate-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then
		pass "$label"
	else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if printf '%s\n' "$haystack" | grep -qF "$needle"; then
		pass "$label"
	else
		fail "$label — output did not contain '$needle'"
	fi
}

assert_not_contains() {
	local haystack="$1" needle="$2" label="$3"
	if printf '%s\n' "$haystack" | grep -qF "$needle"; then
		fail "$label — output unexpectedly contained '$needle'"
	else
		pass "$label"
	fi
}

if [[ ! -f $LIB ]]; then
	echo "FATAL: lib not found — expected at $LIB" >&2
	exit 1
fi

# shellcheck source=../lib/phase-artifact-gate.sh
source "$LIB"

# ─── Build fixture dir ────────────────────────────────────────────────────────

FIXTURES="${SCRATCH}/thoughts/shared/research"
mkdir -p "$FIXTURES"
touch "${FIXTURES}/2026-06-12-ctl-1081.md"                         # tail form
touch "${FIXTURES}/2026-06-12-ctl-1081-per-image-ai-captions.md"   # lowercase slug
touch "${FIXTURES}/2026-06-12-CTL-1081-foo.md"                     # uppercase slug
touch "${FIXTURES}/2026-06-12-ctl-10812-bar.md"                    # cross-ticket lookalike
touch "${FIXTURES}/2026-06-12-ctl-999.md"                          # different ticket

echo "Test 1: match_thoughts_artifact returns 0 and prints the three valid fixtures"
OUT="$(match_thoughts_artifact "$FIXTURES" "CTL-1081")"
RC=$?
assert_eq "0" "$RC" "return code is 0 (at least one match)"
assert_contains "$OUT" "2026-06-12-ctl-1081.md"                       "output includes tail form"
assert_contains "$OUT" "2026-06-12-ctl-1081-per-image-ai-captions.md" "output includes lowercase slug"
assert_contains "$OUT" "2026-06-12-CTL-1081-foo.md"                   "output includes uppercase slug"

echo ""
echo "Test 2: match_thoughts_artifact excludes cross-ticket lookalike and wrong-ticket file"
assert_not_contains "$OUT" "2026-06-12-ctl-10812-bar.md" "cross-ticket lookalike NOT in output"
assert_not_contains "$OUT" "2026-06-12-ctl-999.md"       "wrong-ticket file NOT in output"

echo ""
echo "Test 3: match_thoughts_artifact returns non-zero when no match"
EMPTY_DIR="${SCRATCH}/empty"
mkdir -p "$EMPTY_DIR"
OUT3="$(match_thoughts_artifact "$EMPTY_DIR" "CTL-9999" 2>/dev/null || echo "")"
RC3=0
match_thoughts_artifact "$EMPTY_DIR" "CTL-9999" >/dev/null 2>&1 || RC3=$?
assert_eq "1" "$RC3" "no-match returns non-zero"
assert_eq "" "$OUT3" "no-match output is empty"

echo ""
echo "Test 4: prior_artifact_for_phase spec map"
assert_eq "glob:thoughts/shared/research" "$(prior_artifact_for_phase plan)"      "plan → research dir"
assert_eq "glob:thoughts/shared/plans"    "$(prior_artifact_for_phase implement)" "implement → plans dir"
assert_eq "signal:triage.json"            "$(prior_artifact_for_phase research)"  "research → triage signal"
assert_eq ""                              "$(prior_artifact_for_phase triage)"    "triage → empty (entry point)"

echo ""
echo "Test 5: own_thoughts_artifact_dir_for_phase"
assert_eq "thoughts/shared/research" "$(own_thoughts_artifact_dir_for_phase research)" "research → research dir"
assert_eq "thoughts/shared/plans"    "$(own_thoughts_artifact_dir_for_phase plan)"      "plan → plans dir"
assert_eq ""                         "$(own_thoughts_artifact_dir_for_phase verify)"    "verify → empty (not thoughts-producing)"
assert_eq ""                         "$(own_thoughts_artifact_dir_for_phase implement)" "implement → empty (not thoughts-producing)"

echo ""
echo "Test 6 (divergence): phase-agent-dispatch sources lib/phase-artifact-gate.sh"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
if grep -qF 'lib/phase-artifact-gate.sh' "$DISPATCH"; then
	pass "phase-agent-dispatch sources lib/phase-artifact-gate.sh"
else
	fail "phase-agent-dispatch does NOT source lib/phase-artifact-gate.sh"
fi

echo ""
echo "Test 7 (divergence): phase-agent-emit-complete sources lib/phase-artifact-gate.sh"
EMIT="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"
if grep -qF 'lib/phase-artifact-gate.sh' "$EMIT"; then
	pass "phase-agent-emit-complete sources lib/phase-artifact-gate.sh"
else
	fail "phase-agent-emit-complete does NOT source lib/phase-artifact-gate.sh"
fi

echo ""
echo "Test 8 (divergence/contract): phase-research SKILL references match_thoughts_artifact"
SKILL_RESEARCH="${REPO_ROOT}/plugins/dev/skills/phase-research/SKILL.md"
if [[ -f $SKILL_RESEARCH ]] && grep -qF 'match_thoughts_artifact' "$SKILL_RESEARCH"; then
	pass "phase-research SKILL references match_thoughts_artifact"
else
	fail "phase-research SKILL does NOT reference match_thoughts_artifact"
fi

echo ""
echo "Test 9 (divergence/contract): phase-plan SKILL references match_thoughts_artifact"
SKILL_PLAN="${REPO_ROOT}/plugins/dev/skills/phase-plan/SKILL.md"
if [[ -f $SKILL_PLAN ]] && grep -qF 'match_thoughts_artifact' "$SKILL_PLAN"; then
	pass "phase-plan SKILL references match_thoughts_artifact"
else
	fail "phase-plan SKILL does NOT reference match_thoughts_artifact"
fi

echo ""
echo "Test 10 (contract): slugged writer name matches the gate"
SLUG_DIR="${SCRATCH}/thoughts/shared/plans"
mkdir -p "$SLUG_DIR"
touch "${SLUG_DIR}/2026-06-12-ctl-1081-phase-artifact-gate-contracts.md"
OUT10="$(match_thoughts_artifact "$SLUG_DIR" "CTL-1081")"
RC10=$?
assert_eq "0" "$RC10" "slugged plan doc satisfies the gate (writer↔gate agreement)"
assert_contains "$OUT10" "phase-artifact-gate-contracts.md" "slugged plan doc found by matcher"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-artifact-gate: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
