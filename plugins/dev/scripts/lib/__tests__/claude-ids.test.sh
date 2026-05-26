#!/usr/bin/env bash
# Shell tests for lib/claude-ids.sh — short-id extraction + self-session
# detection (CTL-649).
#
# Run: bash plugins/dev/scripts/lib/__tests__/claude-ids.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../claude-ids.sh
. "$LIB_DIR/claude-ids.sh"

FAILURES=0
PASSES=0

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}

echo "claude-ids tests (CTL-649)"

# ── short_id_from_session_id ───────────────────────────────────────────────
[ "$(short_id_from_session_id 90c9a8a7-4a61-4dd7-b46d-8a4735afc6c2)" = "90c9a8a7" ] &&
	pass "full UUID → 8-char prefix" || fail "full UUID → 8-char prefix"

[ "$(short_id_from_session_id 90c9a8a7)" = "90c9a8a7" ] &&
	pass "already-short id passes through" || fail "already-short id passes through"

# Empty input
if short_id_from_session_id "" 2>/dev/null; then
	fail "empty input rejected"
else
	pass "empty input rejected"
fi

# Malformed (non-hex / too short)
if short_id_from_session_id "xyz" 2>/dev/null; then
	fail "non-hex input rejected"
else
	pass "non-hex input rejected"
fi

if short_id_from_session_id "abc" 2>/dev/null; then
	fail "short input rejected"
else
	pass "short input rejected"
fi

# ── is_self_session ─────────────────────────────────────────────────────────
export CLAUDE_CODE_SESSION_ID=90c9a8a7-4a61-4dd7-b46d-8a4735afc6c2
if is_self_session 90c9a8a7-4a61-4dd7-b46d-8a4735afc6c2; then
	pass "is_self detects matching full UUID"
else
	fail "is_self detects matching full UUID"
fi
if is_self_session 90c9a8a7; then
	pass "is_self detects matching short ID"
else
	fail "is_self detects matching short ID"
fi
if is_self_session ef567890-aaaa-bbbb-cccc-dddddddddddd; then
	fail "is_self false-positive on non-match"
else
	pass "is_self false on non-match"
fi

unset CLAUDE_CODE_SESSION_ID
if is_self_session 90c9a8a7; then
	fail "is_self false when CLAUDE_CODE_SESSION_ID unset"
else
	pass "is_self false when CLAUDE_CODE_SESSION_ID unset"
fi

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
