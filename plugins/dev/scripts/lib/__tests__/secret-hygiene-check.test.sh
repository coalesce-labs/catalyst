#!/usr/bin/env bash
# Unit tests for lib/secret-hygiene-check.sh (CTL-1203).
#
# Exercises check_secret_file_modes, check_secrets_not_in_worktree, and
# check_no_secrets_in_layer1 using mktemp scratch dirs — never touches the
# real ~/.config or the actual repo.
#
# Run: bash plugins/dev/scripts/lib/__tests__/secret-hygiene-check.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/../secret-hygiene-check.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t secret-hygiene-check-test-XXXXXX)"
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

if [[ ! -f "$LIB" ]]; then
	echo "FATAL: $LIB not found — implement it first" >&2
	exit 1
fi
# shellcheck source=/dev/null
source "$LIB"

# ─── check_secret_file_modes ─────────────────────────────────────────────────

echo "check_secret_file_modes: dir with only 600 config*.json → exit 0"
DIR_GOOD="${SCRATCH}/good"
mkdir -p "$DIR_GOOD"
echo '{}' > "${DIR_GOOD}/config-proj.json"
chmod 600 "${DIR_GOOD}/config-proj.json"
check_secret_file_modes "$DIR_GOOD" 2>/dev/null
assert_eq "0" "$?" "all 600 → exit 0"

echo ""
echo "check_secret_file_modes: dir with one 644 config.json → non-zero, names file"
DIR_BAD="${SCRATCH}/bad"
mkdir -p "$DIR_BAD"
echo '{}' > "${DIR_BAD}/config.json"
chmod 644 "${DIR_BAD}/config.json"
MSG="$(check_secret_file_modes "$DIR_BAD" 2>&1)"
RC=$?
[[ $RC -ne 0 ]] && pass "644 file → non-zero exit" || fail "644 file → should be non-zero"
assert_contains "$MSG" "config.json" "error message names the file"

echo ""
echo "check_secret_file_modes: empty dir / no config files → exit 0"
DIR_EMPTY="${SCRATCH}/empty"
mkdir -p "$DIR_EMPTY"
check_secret_file_modes "$DIR_EMPTY" 2>/dev/null
assert_eq "0" "$?" "empty dir → exit 0"

# ─── check_secrets_not_in_worktree ───────────────────────────────────────────

echo ""
echo "check_secrets_not_in_worktree: plain (non-git) dir → exit 0"
PLAIN_DIR="${SCRATCH}/plain"
mkdir -p "$PLAIN_DIR"
check_secrets_not_in_worktree "$PLAIN_DIR" 2>/dev/null
assert_eq "0" "$?" "non-git dir → exit 0"

echo ""
echo "check_secrets_not_in_worktree: git init inside dir → non-zero"
GIT_DIR="${SCRATCH}/gitdir"
mkdir -p "$GIT_DIR"
git -C "$GIT_DIR" init -q 2>/dev/null
MSG="$(check_secrets_not_in_worktree "$GIT_DIR" 2>&1)"
RC=$?
[[ $RC -ne 0 ]] && pass "git worktree → non-zero exit" || fail "git worktree → should be non-zero"
assert_contains "$MSG" "git work tree" "error mentions git work tree"

# ─── check_no_secrets_in_layer1 ──────────────────────────────────────────────

echo ""
echo "check_no_secrets_in_layer1: .catalyst/config.json with only projectKey → exit 0"
REPO_CLEAN="${SCRATCH}/repo-clean"
mkdir -p "${REPO_CLEAN}/.catalyst"
echo '{"catalyst":{"projectKey":"CTL"}}' > "${REPO_CLEAN}/.catalyst/config.json"
check_no_secrets_in_layer1 "$REPO_CLEAN" 2>/dev/null
assert_eq "0" "$?" "clean layer1 → exit 0"

echo ""
echo "check_no_secrets_in_layer1: .catalyst/config.json with lin_api_ token → non-zero, names pattern/file"
REPO_SECRET="${SCRATCH}/repo-secret"
mkdir -p "${REPO_SECRET}/.catalyst"
echo '{"catalyst":{"projectKey":"CTL","linearApiToken":"lin_api_deadbeef123"}}' \
	> "${REPO_SECRET}/.catalyst/config.json"
MSG="$(check_no_secrets_in_layer1 "$REPO_SECRET" 2>&1)"
RC=$?
[[ $RC -ne 0 ]] && pass "lin_api_ in layer1 → non-zero exit" || fail "lin_api_ in layer1 → should be non-zero"
assert_contains "$MSG" "lin_api_" "error mentions pattern"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
