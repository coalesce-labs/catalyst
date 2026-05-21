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

# Test 2: all-pass fixture exits 0
FIX="$(make_fixture "aaa:0" "bbb:0")"
trap 'rm -rf "$FIX" "$FIX2" "$FIX3" "$FIX4"' EXIT
if SHELL_TEST_DIR="$FIX" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	pass "all-pass fixture exits 0"
else fail "all-pass fixture should exit 0"; fi

# Test 3: a failing test (exit 1) makes the runner exit non-zero
FIX2="$(make_fixture "ok:0" "bad:1")"
if SHELL_TEST_DIR="$FIX2" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	fail "fixture with a failing test should exit non-zero"
else pass "failing test makes runner exit non-zero"; fi

# Test 4: exit-with-count pattern (exit 3) is treated as failure, not pass
FIX3="$(make_fixture "ok:0" "counted:3")"
if SHELL_TEST_DIR="$FIX3" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" >/dev/null 2>&1; then
	fail "exit-code 3 should count as failure"
else pass "any rc>0 (exit 3) counts as failure"; fi

# Test 5: SKIP (exit 0 + 'SKIP:' on stderr) is not a failure; summary line present
FIX4="$(make_fixture "ok:0" "skipme:0:SKIP: dependency absent")"
OUT="$(SHELL_TEST_DIR="$FIX4" EXTRA_SHELL_TESTS="" SKIP_BUN=1 bash "$RUNNER" 2>&1)"
RC=$?
if [[ $RC -eq 0 ]]; then
	pass "SKIP test does not fail the runner"
else fail "SKIP test should not fail the runner" "rc=$RC"; fi
if grep -q 'summary:' <<<"$OUT" && grep -q 'skipped' <<<"$OUT"; then
	pass "summary line printed and reports skips"
else fail "summary line missing or has no skip count" "$OUT"; fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
