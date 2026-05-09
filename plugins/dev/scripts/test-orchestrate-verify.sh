#!/usr/bin/env bash
# Regression tests for orchestrate-verify.sh. CTL-317.
#
# Static assertions. No subprocess invocation of the verify script —
# its real path executes `git diff` against an orchestrator base ref
# that doesn't exist in test fixtures. We assert the test-command
# selection logic stays correct.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY_SCRIPT="$SCRIPT_DIR/orchestrate-verify.sh"

PASS=true
TESTS=0
FAILURES=0

fail() { echo "  FAIL: $1"; PASS=false; FAILURES=$((FAILURES + 1)); }
pass() { echo "  PASS: $1"; }
run_test() { TESTS=$((TESTS + 1)); echo ""; echo "--- Test $TESTS: $1 ---"; }

# ───────────────────────────────────────────────────────────────────────────

run_test "verify script exists and is readable"
[ -f "$VERIFY_SCRIPT" ] && pass "found at $VERIFY_SCRIPT" || fail "missing: $VERIFY_SCRIPT"

run_test "Bun branch uses 'bun run test', not bare 'bun test' (CTL-317)"
# Grep just the assignment. Bare `bun test` invokes Bun's native runner,
# which breaks vitest's `vi` namespace and hangs on heavy SDK auto-discovery.
if grep -E '^\s*TEST_CMD="bun run test"\s*$' "$VERIFY_SCRIPT" >/dev/null; then
	pass "TEST_CMD=\"bun run test\" present"
else
	fail "expected TEST_CMD=\"bun run test\" in verify script"
fi

if grep -E '^\s*TEST_CMD="bun test"\s*$' "$VERIFY_SCRIPT" >/dev/null; then
	fail "regression: bare TEST_CMD=\"bun test\" reintroduced (see CTL-317)"
else
	pass "no bare TEST_CMD=\"bun test\" assignment"
fi

run_test "npm fallback branch unchanged"
if grep -E '^\s*TEST_CMD="npm test"\s*$' "$VERIFY_SCRIPT" >/dev/null; then
	pass "npm fallback present"
else
	fail "expected TEST_CMD=\"npm test\" fallback branch"
fi

# ───────────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$PASS" = true ]; then
	echo "✅ All $TESTS tests passed"
	exit 0
else
	echo "❌ $FAILURES of $TESTS tests failed"
	exit 1
fi
