#!/usr/bin/env bash
# Verifies the Makefile test/lint/check targets are wired correctly (CTL-528).
# Run: bash plugins/dev/scripts/__tests__/makefile-targets.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# make -n test invokes run-tests.sh
if make -n -C "$REPO_ROOT" test 2>/dev/null | grep -q 'run-tests.sh'
then pass "make test invokes run-tests.sh"
else fail "make test does not invoke run-tests.sh"; fi

# make -n lint invokes trunk check
if make -n -C "$REPO_ROOT" lint 2>/dev/null | grep -q 'trunk check'
then pass "make lint invokes trunk check"
else fail "make lint does not invoke trunk check"; fi

# make -n check covers BOTH lint and the test runner
CHECK_OUT="$(make -n -C "$REPO_ROOT" check 2>/dev/null)"
if grep -q 'trunk check' <<<"$CHECK_OUT" && grep -q 'run-tests.sh' <<<"$CHECK_OUT"
then pass "make check chains lint + test"
else fail "make check does not chain lint + test" "$CHECK_OUT"; fi

# No broken hack/ reference remains in the Makefile
if grep -q 'hack/validate-frontmatter' "$REPO_ROOT/Makefile"
then fail "Makefile still references hack/validate-frontmatter.sh"
else pass "no hack/validate-frontmatter reference in Makefile"; fi

# check-frontmatter target is gone
if make -n -C "$REPO_ROOT" check-frontmatter >/dev/null 2>&1
then fail "check-frontmatter target still exists"
else pass "check-frontmatter target removed"; fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
