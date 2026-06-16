#!/usr/bin/env bash
# Unit tests for lib/secrets-hygiene.sh (CTL-1203).
#
# Tests harden_secrets_dir, ensure_secrets_gitignore, and write_secret_file
# using a mktemp scratch dir so the real ~/.config is never touched.
#
# Run: bash plugins/dev/scripts/lib/__tests__/secrets-hygiene.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/../secrets-hygiene.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t secrets-hygiene-test-XXXXXX)"
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

file_mode() {
	stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

if [[ ! -f "$LIB" ]]; then
	echo "FATAL: $LIB not found — implement it first" >&2
	exit 1
fi
# shellcheck source=/dev/null
source "$LIB"

# ─── harden_secrets_dir ──────────────────────────────────────────────────────

echo "harden_secrets_dir: creates missing dir at mode 700"
DIR1="${SCRATCH}/new-dir"
harden_secrets_dir "$DIR1"
assert_eq "700" "$(file_mode "$DIR1")" "new dir mode = 700"

echo ""
echo "harden_secrets_dir: tightens existing 755 dir to 700"
DIR2="${SCRATCH}/loose-dir"
mkdir -p "$DIR2"
chmod 755 "$DIR2"
harden_secrets_dir "$DIR2"
assert_eq "700" "$(file_mode "$DIR2")" "755→700 tightened"

echo ""
echo "harden_secrets_dir: idempotent — second call still 700, exit 0"
harden_secrets_dir "$DIR2"
RC=$?
assert_eq "0" "$RC" "second call exit 0"
assert_eq "700" "$(file_mode "$DIR2")" "still 700 after second call"

# ─── ensure_secrets_gitignore ────────────────────────────────────────────────

echo ""
echo "ensure_secrets_gitignore: missing .gitignore → created with both lines"
GI_DIR="${SCRATCH}/gi-dir"
mkdir -p "$GI_DIR"
ensure_secrets_gitignore "$GI_DIR"
GI="${GI_DIR}/.gitignore"
[[ -f "$GI" ]] && pass ".gitignore created" || fail ".gitignore not created"
GI_CONTENT="$(cat "$GI")"
assert_contains "$GI_CONTENT" "config*.json" "contains config*.json"
assert_contains "$GI_CONTENT" "*.env" "contains *.env"

echo ""
echo "ensure_secrets_gitignore: existing with only config-*.json → both lines present"
GI_DIR2="${SCRATCH}/gi-dir2"
mkdir -p "$GI_DIR2"
printf 'config-*.json\n' > "${GI_DIR2}/.gitignore"
ensure_secrets_gitignore "$GI_DIR2"
GI2_CONTENT="$(cat "${GI_DIR2}/.gitignore")"
assert_contains "$GI2_CONTENT" "config*.json" "config*.json added"
assert_contains "$GI2_CONTENT" "*.env" "*.env added"

echo ""
echo "ensure_secrets_gitignore: idempotent — second call adds no duplicates"
LINE_COUNT_BEFORE="$(wc -l < "${GI_DIR2}/.gitignore")"
ensure_secrets_gitignore "$GI_DIR2"
LINE_COUNT_AFTER="$(wc -l < "${GI_DIR2}/.gitignore")"
assert_eq "$LINE_COUNT_BEFORE" "$LINE_COUNT_AFTER" "line count stable (no duplicates)"

# ─── write_secret_file ───────────────────────────────────────────────────────

echo ""
echo "write_secret_file: writes content to new path at mode 600"
WF_DIR="${SCRATCH}/write-dir"
mkdir -p "$WF_DIR"
WF_PATH="${WF_DIR}/config.json"
write_secret_file '{"key":"value"}' "$WF_PATH"
assert_eq "600" "$(file_mode "$WF_PATH")" "new file mode = 600"
assert_eq '{"key":"value"}' "$(cat "$WF_PATH")" "content matches"

echo ""
echo "write_secret_file: overwrites existing 644 file, result is 600"
chmod 644 "$WF_PATH"
write_secret_file '{"key":"updated"}' "$WF_PATH"
assert_eq "600" "$(file_mode "$WF_PATH")" "overwrite → mode 600"
assert_eq '{"key":"updated"}' "$(cat "$WF_PATH")" "overwrite content matches"

echo ""
echo "write_secret_file: parent dir mode not modified"
DIR_MODE_BEFORE="$(file_mode "$WF_DIR")"
write_secret_file '{"x":1}' "$WF_PATH"
assert_eq "$DIR_MODE_BEFORE" "$(file_mode "$WF_DIR")" "parent dir mode unchanged"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
