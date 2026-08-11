#!/usr/bin/env bash
# Shell tests for rotate_log_on_start (CTL-1755).
# Run: bash plugins/dev/scripts/__tests__/rotate-log-on-start.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/rotate-log-on-start.sh"

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

setup() {
	SCRATCH=$(mktemp -d)
	LOG="${SCRATCH}/daemon.log"
}

teardown() {
	rm -rf "${SCRATCH:-}"
}

# Cross-platform inode probe
inode_of() {
	if stat -f %i "$1" 2>/dev/null; then return; fi
	stat -c %i "$1" 2>/dev/null
}

# -----------------------------------------------------------------------
echo "Test 1: absent log → no-op"
setup
# shellcheck source=/dev/null
source "$HELPER" 2>/dev/null || true
rotate_log_on_start "$LOG"
if [[ ! -e "${LOG}.1" ]]; then
	pass "no .1 created for absent log"
else
	fail "absent log" ".1 was created unexpectedly"
fi
teardown

# -----------------------------------------------------------------------
echo "Test 2: empty log → no-op"
setup
source "$HELPER" 2>/dev/null || true
touch "$LOG"
rotate_log_on_start "$LOG"
if [[ ! -e "${LOG}.1" ]]; then
	pass "no .1 created for empty log"
else
	fail "empty log" ".1 was created for zero-byte log"
fi
teardown

# -----------------------------------------------------------------------
echo "Test 3: first rotation copies to .1, preserves inode"
setup
source "$HELPER" 2>/dev/null || true
printf 'run-1\n' > "$LOG"
INODE_BEFORE="$(inode_of "$LOG")"
rotate_log_on_start "$LOG"
INODE_AFTER="$(inode_of "$LOG")"
OK=1
if [[ ! -f "${LOG}.1" ]]; then
	fail "first rotation" ".1 was not created"
	OK=0
fi
if [[ -f "${LOG}.1" ]] && ! grep -q 'run-1' "${LOG}.1" 2>/dev/null; then
	fail "first rotation" ".1 does not contain 'run-1'"
	OK=0
fi
if [[ ! -f "$LOG" ]]; then
	fail "first rotation" "primary log was removed (should be preserved in place)"
	OK=0
fi
if [[ -f "${LOG}.2" ]]; then
	fail "first rotation" ".2 was created after first rotation"
	OK=0
fi
if [[ "${INODE_BEFORE}" != "${INODE_AFTER}" ]]; then
	fail "first rotation" "inode changed (got ${INODE_AFTER}, want ${INODE_BEFORE})"
	OK=0
fi
[[ "$OK" -eq 1 ]] && pass "first rotation: .1 correct, primary inode preserved"
teardown

# -----------------------------------------------------------------------
echo "Test 4: ring shift + ordering"
setup
source "$HELPER" 2>/dev/null || true
# Rotation 1: seed log with run-1
printf 'run-1\n' > "$LOG"
rotate_log_on_start "$LOG"
printf '' > "$LOG"   # simulate daemon > truncation

# Rotation 2: seed with run-2
printf 'run-2\n' > "$LOG"
rotate_log_on_start "$LOG"
printf '' > "$LOG"

# Rotation 3: seed with run-3
printf 'run-3\n' > "$LOG"
rotate_log_on_start "$LOG"

OK=1
if ! grep -q 'run-3' "${LOG}.1" 2>/dev/null; then
	fail "ring shift" ".1 does not contain run-3 (newest)"
	OK=0
fi
if ! grep -q 'run-2' "${LOG}.2" 2>/dev/null; then
	fail "ring shift" ".2 does not contain run-2"
	OK=0
fi
if ! grep -q 'run-1' "${LOG}.3" 2>/dev/null; then
	fail "ring shift" ".3 does not contain run-1 (oldest)"
	OK=0
fi
[[ "$OK" -eq 1 ]] && pass "ring shift: .1=run-3, .2=run-2, .3=run-1"
teardown

# -----------------------------------------------------------------------
echo "Test 5: bounded retention (CATALYST_LOG_RETAIN=2)"
setup
source "$HELPER" 2>/dev/null || true
export CATALYST_LOG_RETAIN=2
# Three rotations
for i in 1 2 3; do
	printf 'run-%s\n' "$i" > "$LOG"
	rotate_log_on_start "$LOG"
	printf '' > "$LOG"
done
OK=1
if [[ ! -f "${LOG}.1" ]]; then
	fail "bounded retention" ".1 missing after 3 rotations with retain=2"
	OK=0
fi
if [[ ! -f "${LOG}.2" ]]; then
	fail "bounded retention" ".2 missing after 3 rotations with retain=2"
	OK=0
fi
if [[ -f "${LOG}.3" ]]; then
	fail "bounded retention" ".3 exists but retain=2 (should be capped)"
	OK=0
fi
[[ "$OK" -eq 1 ]] && pass "bounded retention=2: only .1 and .2 created"
unset CATALYST_LOG_RETAIN
teardown

# -----------------------------------------------------------------------
echo "Test 6: CATALYST_LOG_RETAIN=0 disables rotation"
setup
source "$HELPER" 2>/dev/null || true
export CATALYST_LOG_RETAIN=0
printf 'run-1\n' > "$LOG"
rotate_log_on_start "$LOG"
if [[ ! -e "${LOG}.1" ]]; then
	pass "retain=0 disables rotation"
else
	fail "retain=0" ".1 was created even though CATALYST_LOG_RETAIN=0"
fi
unset CATALYST_LOG_RETAIN
teardown

# -----------------------------------------------------------------------
echo "Test 7: fail-open on unwritable dir"
# Skip if running as root (permissions are bypassed)
if [[ "$(id -u)" -eq 0 ]]; then
	echo "  SKIP: running as root, permission test not meaningful"
	PASSES=$((PASSES + 1))
else
	UNWRITABLE_DIR=$(mktemp -d)
	chmod 000 "$UNWRITABLE_DIR"
	UNWRITABLE_LOG="${UNWRITABLE_DIR}/daemon.log"
	source "$HELPER" 2>/dev/null || true
	# The helper must return 0 even on a path that can't be written
	if rotate_log_on_start "$UNWRITABLE_LOG" 2>/dev/null; then
		pass "fail-open: unwritable dir returns 0"
	else
		fail "fail-open" "returned non-zero on unwritable dir"
	fi
	chmod 755 "$UNWRITABLE_DIR"
	rm -rf "$UNWRITABLE_DIR"
fi

# -----------------------------------------------------------------------
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
