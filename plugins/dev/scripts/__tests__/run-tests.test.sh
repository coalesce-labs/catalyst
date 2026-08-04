#!/usr/bin/env bash
# Smoke test for the aggregate test runner run-tests.sh (CTL-528).
# Run: bash plugins/dev/scripts/__tests__/run-tests.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RUNNER="${REPO_ROOT}/plugins/dev/scripts/run-tests.sh"

FAILURES=0
PASSES=0
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

# Build a fixture __tests__ dir; args are "name:exitcode[:stderr-line]" specs.
make_fixture() {
	local dir
	dir="$(mktemp -d)"
	local spec name code line
	for spec in "$@"; do
		name="${spec%%:*}"
		spec="${spec#*:}"
		code="${spec%%:*}"
		line="${spec#*:}"
		[[ $line == "$code" ]] && line=""
		{
			echo '#!/usr/bin/env bash'
			[[ -n $line ]] && echo "echo '${line}' >&2"
			echo "exit ${code}"
		} >"${dir}/${name}.test.sh"
	done
	echo "$dir"
}

# Test 1: runner exists and is executable
if [[ -x $RUNNER ]]; then
	pass "run-tests.sh exists and is executable"
else fail "run-tests.sh missing or not executable" "$RUNNER"; fi

# CTL-1612 round 7: run-tests.sh now ALSO globs LIB_SHELL_TEST_DIR
# (lib/__tests__/*.test.sh) in addition to SHELL_TEST_DIR. Every fixture case
# below must pin LIB_SHELL_TEST_DIR to this shared EMPTY directory too — left
# at its real default, the runner would glob in all of the REAL
# lib/__tests__ suites alongside each fixture's 2 fake tests, breaking every
# exact-count assertion in tests 2-6 (e.g. "shell 1 passed / 0 failed / 1
# skipped" would instead count 1 + N real suites).
EMPTY_LIB_DIR="$(mktemp -d)"

# Test 2: all-pass fixture exits 0
FIX="$(make_fixture "aaa:0" "bbb:0")"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$EMPTY_LIB_DIR"' EXIT
if SHELL_TEST_DIR="$FIX" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	pass "all-pass fixture exits 0"
else fail "all-pass fixture should exit 0"; fi

# Test 3: a failing test (exit 1) makes the runner exit non-zero
FIX2="$(make_fixture "ok:0" "bad:1")"
if SHELL_TEST_DIR="$FIX2" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	fail "fixture with a failing test should exit non-zero"
else pass "failing test makes runner exit non-zero"; fi

# Test 4: exit-with-count pattern (exit 3) is treated as failure, not pass
FIX3="$(make_fixture "ok:0" "counted:3")"
if SHELL_TEST_DIR="$FIX3" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	fail "exit-code 3 should count as failure"
else pass "any rc>0 (exit 3) counts as failure"; fi

# Test 5: a column-0 'SKIP:' (exit 0) is counted as a skip — not a pass, not a
# failure. The exact-count assertion is load-bearing: the summary template
# always contains the word "skipped", so a bare substring grep would pass even
# if SKIP detection were broken and the suite miscounted as a pass.
FIX4="$(make_fixture "ok:0" "skipme:0:SKIP: dependency absent")"
OUT="$(SHELL_TEST_DIR="$FIX4" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
RC=$?
if [[ $RC -eq 0 ]]; then
	pass "SKIP test does not fail the runner"
else fail "SKIP test should not fail the runner" "rc=$RC"; fi
if grep -qE '^  SKIP .*skipme\.test\.sh' <<<"$OUT"; then
	pass "skip fixture classified SKIP on its own line (not PASS)"
else fail "skip fixture not classified SKIP" "$OUT"; fi
if grep -q 'shell 1 passed / 0 failed / 1 skipped' <<<"$OUT"; then
	pass "summary counts exactly 1 passed / 0 failed / 1 skipped"
else fail "summary skip/pass/fail count wrong" "$OUT"; fi

# Test 6: SKIP detection is anchored to '^SKIP:'. A passing suite that merely
# mentions SKIP mid-line (indented, or with leading text) must stay PASS.
FIX5="$(make_fixture "ok:0" "mentions:0:  note: SKIP: handling exercised")"
OUT="$(SHELL_TEST_DIR="$FIX5" LIB_SHELL_TEST_DIR="$EMPTY_LIB_DIR" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'shell 2 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "indented 'SKIP:' does not trigger skip classification (^SKIP: anchored)"
else fail "non-column-0 'SKIP:' wrongly classified" "$OUT"; fi

# Test 7 (CTL-1612 round 7): LIB_SHELL_TEST_DIR is genuinely wired, not just
# harmlessly ignored — a fixture placed there is discovered and run, proving
# it is not a dead override.
FIX6="$(make_fixture "libok:0")"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4" "$FIX5" "$FIX6" "$FIX7" "$FIX7_LIB" "$EMPTY_LIB_DIR"' EXIT
OUT="$(SHELL_TEST_DIR="$EMPTY_LIB_DIR" LIB_SHELL_TEST_DIR="$FIX6" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
if grep -q 'shell 1 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "LIB_SHELL_TEST_DIR fixture is discovered and run"
else fail "LIB_SHELL_TEST_DIR override was not wired into the shell suite" "$OUT"; fi

# Test 8 (CTL-1612 round 9, Codex P2 follow-up): a suite matching one of
# run-tests.sh's hardcoded LIB_SHELL_TEST_WRAPPED basenames must be counted
# EXACTLY ONCE even when a file with that same basename exists in BOTH
# SHELL_TEST_DIR and LIB_SHELL_TEST_DIR — the real-world shape of
# __tests__/secrets-hygiene.test.sh (a wrapper) coexisting with
# lib/__tests__/secrets-hygiene.test.sh (the wrapped suite). Uses the REAL
# wrapped basename "secrets-hygiene.test.sh" (not an arbitrary fixture name)
# so this test breaks LOUDLY — not silently — if run-tests.sh's hardcoded
# LIB_SHELL_TEST_WRAPPED list ever drifts out of sync with the real wrapper
# set (a 7th wrapper added without updating that list would show up here as
# a double-count, per that list's own header comment). Counts occurrences of
# the suite's own PASS marker line directly in the runner's combined output —
# the property this test exists to pin.
FIX7="$(make_fixture "secrets-hygiene:0")"
FIX7_LIB="$(mktemp -d)"
cp "${FIX7}/secrets-hygiene.test.sh" "${FIX7_LIB}/secrets-hygiene.test.sh"
OUT="$(SHELL_TEST_DIR="$FIX7" LIB_SHELL_TEST_DIR="$FIX7_LIB" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
MARKER_COUNT="$(grep -c 'PASS .*secrets-hygiene\.test\.sh' <<<"$OUT")"
if [[ "$MARKER_COUNT" -eq 1 ]]; then
	pass "wrapped basename (secrets-hygiene.test.sh) runs exactly once, present under both SHELL_TEST_DIR and LIB_SHELL_TEST_DIR"
else fail "wrapped basename ran $MARKER_COUNT time(s), expected exactly 1" "$OUT"; fi
if grep -q 'shell 1 passed / 0 failed / 0 skipped' <<<"$OUT"; then
	pass "aggregate summary counts exactly 1 (not 2) for the wrapped-basename fixture"
else fail "aggregate summary miscounted the wrapped-basename fixture" "$OUT"; fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
