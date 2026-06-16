#!/usr/bin/env bash
# Integration tests for catalyst-doctor runner (CTL-1203).
#
# Exercises the runner end-to-end using CATALYST_CONFIG_DIR / repo-root
# overrides so the real ~/.config is never touched.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-doctor.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="${SCRIPT_DIR}/../catalyst-doctor"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-doctor-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ "$expected" == "$actual" ]]; then pass "$label"
	else fail "$label — expected '$expected', got '$actual'"
	fi
}

assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ "$haystack" == *"$needle"* ]]; then pass "$label"
	else fail "$label — '$needle' not found in '$haystack'"
	fi
}

if [[ ! -f "$DOCTOR" ]]; then
	echo "FATAL: $DOCTOR not found — implement it first" >&2
	exit 1
fi

# ─── Test 1: clean scratch HOME + repo → exit 0 ──────────────────────────────

echo "Test 1: clean scratch HOME (600 configs, no git, no layer1 secrets) → exit 0"
CFG_DIR="${SCRATCH}/t1/cfg"
REPO_DIR="${SCRATCH}/t1/repo"
mkdir -p "$CFG_DIR" "$REPO_DIR/.catalyst"
echo '{}' > "${CFG_DIR}/config-proj.json"
chmod 600 "${CFG_DIR}/config-proj.json"
echo '{"catalyst":{"projectKey":"CTL"}}' > "${REPO_DIR}/.catalyst/config.json"

OUT="$(CATALYST_CONFIG_DIR="$CFG_DIR" \
	CATALYST_REPO_ROOT="$REPO_DIR" \
	bash "$DOCTOR" 2>&1 || true)"
RC=$?
assert_eq "0" "$RC" "clean state → exit 0"
assert_contains "$OUT" "ok" "output contains ok line"

# ─── Test 2: one 644 config file → non-zero, names failing check ─────────────

echo ""
echo "Test 2: one 644 config file → non-zero exit"
CFG_DIR2="${SCRATCH}/t2/cfg"
REPO_DIR2="${SCRATCH}/t2/repo"
mkdir -p "$CFG_DIR2" "$REPO_DIR2/.catalyst"
echo '{}' > "${CFG_DIR2}/config.json"
chmod 644 "${CFG_DIR2}/config.json"
echo '{"catalyst":{"projectKey":"CTL"}}' > "${REPO_DIR2}/.catalyst/config.json"

OUT2="$(CATALYST_CONFIG_DIR="$CFG_DIR2" \
	CATALYST_REPO_ROOT="$REPO_DIR2" \
	bash "$DOCTOR" 2>&1)"
RC2=$?
[[ $RC2 -ne 0 ]] && pass "644 file → non-zero exit" || fail "644 file → should be non-zero"
assert_contains "$OUT2" "FAIL" "output surfaces failing check"

# ─── Test 3: --help prints usage and exits 0 ─────────────────────────────────

echo ""
echo "Test 3: --help → exits 0, prints usage"
HELP_OUT="$(bash "$DOCTOR" --help 2>&1)"
HELP_RC=$?
assert_eq "0" "$HELP_RC" "--help → exit 0"
assert_contains "$HELP_OUT" "Usage" "help output has Usage"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
