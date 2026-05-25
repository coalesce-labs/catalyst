#!/usr/bin/env bash
# Tests for the shared linearis stub helper (CTL-632 Phase 1).
#
# Run: bash plugins/dev/scripts/__tests__/lib/linearis-stub.sh.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/linearis-stub.sh"

PASS=0
FAIL=0

ok() {
	PASS=$((PASS + 1))
	printf '  PASS: %s\n' "$1"
}
fail() {
	FAIL=$((FAIL + 1))
	printf '  FAIL: %s\n    %s\n' "$1" "$2"
}

assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }

if [ ! -f "$HELPER" ]; then
	echo "FAIL: helper not found at $HELPER"
	exit 1
fi

# shellcheck source=/dev/null
source "$HELPER"

TMPROOT="$(mktemp -d -t linearis-stub-test.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

echo "linearis-stub helper tests"

# ─────────────────────────────────────────────────────────────────────────────
# Case 1: linearis_stub_install with default (no fixture) returns {} for read.

CASE1="$TMPROOT/case1"
mkdir -p "$CASE1/bin"
LOG1="$CASE1/calls.log"

linearis_stub_install "$CASE1/bin" "$LOG1"

if [ -x "$CASE1/bin/linearis" ]; then
	ok "case1: linearis stub is executable"
else
	fail "case1: stub executable" "$CASE1/bin/linearis not executable"
fi

OUT1="$(PATH="$CASE1/bin:$PATH" linearis issues read FOO 2>/dev/null)"
assert_eq "case1: read returns {} when no fixture" "{}" "$OUT1"

# Each arg on its own line per the phase-triage stub convention.
if grep -q '^read$' "$LOG1" 2>/dev/null && grep -q '^FOO$' "$LOG1" 2>/dev/null; then
	ok "case1: read args logged one-per-line"
else
	fail "case1: read args logged" "log:$(printf '\n%s' "$(cat "$LOG1")")"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case 2: discuss logs args and returns ok JSON, exits 0.

CASE2="$TMPROOT/case2"
mkdir -p "$CASE2/bin"
LOG2="$CASE2/calls.log"

linearis_stub_install "$CASE2/bin" "$LOG2"

OUT2="$(PATH="$CASE2/bin:$PATH" linearis issues discuss BAR --body "x" 2>/dev/null)"
DISCUSS_EXIT=$?
assert_eq "case2: discuss exits 0" 0 "$DISCUSS_EXIT"

# Verify arg logging (discuss + BAR + --body + x, each on its own line)
DISCUSS_LINES="$(grep -c '^discuss$' "$LOG2" 2>/dev/null || echo 0)"
assert_eq "case2: discuss recorded once" 1 "$DISCUSS_LINES"

if grep -q '^BAR$' "$LOG2" && grep -q '^--body$' "$LOG2" && grep -q '^x$' "$LOG2"; then
	ok "case2: all discuss args logged one-per-line"
else
	fail "case2: discuss args" "log:$(printf '\n%s' "$(cat "$LOG2")")"
fi

# Verify body shape (the existing phase-triage assertions look for '"ok"' and 'discuss')
case "$OUT2" in
*ok*) ok "case2: discuss returns ok-shaped JSON" ;;
*) fail "case2: discuss JSON shape" "got '$OUT2'" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: read with fixture path returns the fixture contents.

FIXTURE3="$TMPROOT/fixture3.json"
cat >"$FIXTURE3" <<'EOF'
{"identifier":"CTL-1111","title":"hello"}
EOF

CASE3="$TMPROOT/case3"
mkdir -p "$CASE3/bin"
LOG3="$CASE3/calls.log"

linearis_stub_install "$CASE3/bin" "$LOG3" "$FIXTURE3"

OUT3="$(PATH="$CASE3/bin:$PATH" linearis issues read CTL-1111 2>/dev/null)"
EXPECTED3='{"identifier":"CTL-1111","title":"hello"}'
assert_eq "case3: read returns fixture JSON" "$EXPECTED3" "$OUT3"

# ─────────────────────────────────────────────────────────────────────────────
# Case 4: linearis_stub_install_failing — discuss exits non-zero, read still works.

CASE4="$TMPROOT/case4"
mkdir -p "$CASE4/bin"
LOG4="$CASE4/calls.log"

linearis_stub_install_failing "$CASE4/bin" "$LOG4" "$FIXTURE3"

# discuss must exit non-zero
PATH="$CASE4/bin:$PATH" linearis issues discuss CTL-1111 --body x >/dev/null 2>&1
FAIL_EXIT=$?
if [ "$FAIL_EXIT" -ne 0 ]; then
	ok "case4: failing stub discuss exits non-zero"
else
	fail "case4: failing discuss exit" "expected non-zero got $FAIL_EXIT"
fi

# read still works and returns fixture
OUT4="$(PATH="$CASE4/bin:$PATH" linearis issues read CTL-1111 2>/dev/null)"
assert_eq "case4: failing stub read returns fixture JSON" "$EXPECTED3" "$OUT4"

# Discuss args still logged so tests can assert which subcommands were attempted.
if grep -q '^discuss$' "$LOG4"; then
	ok "case4: failing stub still logs discuss args"
else
	fail "case4: failing stub logs discuss" "log:$(printf '\n%s' "$(cat "$LOG4")")"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case 5: update arm exists (phase-triage CTL-558 negative invariant must keep working
# under the helper).

CASE5="$TMPROOT/case5"
mkdir -p "$CASE5/bin"
LOG5="$CASE5/calls.log"
linearis_stub_install "$CASE5/bin" "$LOG5"

PATH="$CASE5/bin:$PATH" linearis issues update CTL-1 --state-id X >/dev/null 2>&1
UPDATE_EXIT=$?
assert_eq "case5: update arm exits 0" 0 "$UPDATE_EXIT"
if grep -q '^update$' "$LOG5"; then
	ok "case5: update args logged"
else
	fail "case5: update args" "log:$(printf '\n%s' "$(cat "$LOG5")")"
fi

# ─────────────────────────────────────────────────────────────────────────────

echo
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "$FAIL" -ne 0 ]; then
	exit 1
fi
exit 0
