#!/usr/bin/env bash
# CTL-633: unit tests for the linear-team-keys allowlist loader/filter helper.
# Each test runs in a temp XDG_CONFIG_HOME so the real ~/.config is untouched.
# Run: bash plugins/dev/scripts/__tests__/linear-team-keys.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/linear-team-keys.sh"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

if [[ ! -f "$HELPER" ]]; then
	fail "helper exists at lib/linear-team-keys.sh"
	echo ""
	echo "PASSES=$PASSES FAILURES=$FAILURES"
	exit 1
fi
# shellcheck source=/dev/null
source "$HELPER"

# Each case sets up a fresh sandbox.
sandbox() {
	local d
	d="$(mktemp -d)"
	mkdir -p "$d/catalyst"
	printf '%s' "$d"
}

# ─── Case 1: missing cache → empty load, fail-open ────────────────────────────
echo "▶ Case 1: missing cache returns empty"
HOME_TMP="$(sandbox)"
out=$(XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_load 2>/dev/null)
if [[ -z "$out" ]]; then
	pass "1: missing cache → empty"
else
	fail "1: missing cache → empty" "got: $out"
fi
rm -rf "$HOME_TMP"

# ─── Case 2: well-formed cache returns sorted keys ────────────────────────────
echo "▶ Case 2: well-formed cache returns sorted keys"
HOME_TMP="$(sandbox)"
printf '{"keys":["ENG","ADV","CTL"],"fetched_at":"2026-05-25T00:00:00Z"}\n' \
	> "$HOME_TMP/catalyst/linear-team-keys.json"
out=$(XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_load 2>/dev/null)
expected=$'ADV\nCTL\nENG'
if [[ "$out" == "$expected" ]]; then
	pass "2: keys sorted ADV/CTL/ENG"
else
	fail "2: keys sorted ADV/CTL/ENG" "got: $out"
fi
rm -rf "$HOME_TMP"

# ─── Case 3: empty cache → empty load ─────────────────────────────────────────
echo "▶ Case 3: empty keys array returns empty"
HOME_TMP="$(sandbox)"
printf '{"keys":[]}\n' > "$HOME_TMP/catalyst/linear-team-keys.json"
out=$(XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_load 2>/dev/null)
if [[ -z "$out" ]]; then
	pass "3: empty keys → empty"
else
	fail "3: empty keys → empty" "got: $out"
fi
rm -rf "$HOME_TMP"

# ─── Case 4: malformed JSON → empty, no fatal stderr ──────────────────────────
echo "▶ Case 4: malformed cache fails open silently"
HOME_TMP="$(sandbox)"
printf 'not json\n' > "$HOME_TMP/catalyst/linear-team-keys.json"
err=$(XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_load 2>&1 >/dev/null)
out=$(XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_load 2>/dev/null)
if [[ -z "$out" && -z "$err" ]]; then
	pass "4: malformed → empty stdout, empty stderr"
else
	fail "4: malformed → empty (stdout+stderr)" "stdout=$out stderr=$err"
fi
rm -rf "$HOME_TMP"

# ─── Case 5: unreadable cache → empty (fail-open) ─────────────────────────────
echo "▶ Case 5: unreadable cache fails open"
HOME_TMP="$(sandbox)"
printf '{"keys":["X"]}\n' > "$HOME_TMP/catalyst/linear-team-keys.json"
chmod 000 "$HOME_TMP/catalyst/linear-team-keys.json"
out=$(XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_load 2>/dev/null)
chmod 644 "$HOME_TMP/catalyst/linear-team-keys.json" 2>/dev/null || true
if [[ -z "$out" ]]; then
	pass "5: unreadable → empty"
else
	fail "5: unreadable → empty" "got: $out"
fi
rm -rf "$HOME_TMP"

# ─── Case 6: filter with empty allowlist is passthrough ───────────────────────
echo "▶ Case 6: filter passthrough on empty allowlist"
HOME_TMP="$(sandbox)"
out=$(printf 'CTL-1\nENG-2\nADV-3\n' \
	| XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_filter)
expected=$'CTL-1\nENG-2\nADV-3'
if [[ "$out" == "$expected" ]]; then
	pass "6: passthrough on empty allowlist"
else
	fail "6: passthrough on empty allowlist" "got: $out"
fi
rm -rf "$HOME_TMP"

# ─── Case 7: filter with populated allowlist drops non-members ────────────────
echo "▶ Case 7: filter drops non-allowlist tokens"
HOME_TMP="$(sandbox)"
printf '{"keys":["CTL","ENG"]}\n' > "$HOME_TMP/catalyst/linear-team-keys.json"
out=$(printf 'CTL-1\nENG-2\nADV-3\nOAUTH-2\n' \
	| XDG_CONFIG_HOME="$HOME_TMP" linear_team_keys_filter)
expected=$'CTL-1\nENG-2'
if [[ "$out" == "$expected" ]]; then
	pass "7: only CTL/ENG retained"
else
	fail "7: only CTL/ENG retained" "got: $out"
fi
rm -rf "$HOME_TMP"

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ $FAILURES -eq 0 ]]
