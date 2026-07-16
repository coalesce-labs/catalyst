#!/usr/bin/env bash
# detect-bare-linear-read.test.sh — CTL-1420: unit tests for the PreToolUse hook
# that detects a bare single-ticket Linear read bypassing the replica.
#
# WHY THIS FILE EXISTS: the hook shipped (CTL-1397 / #2543) with smoke cases run
# by hand but never committed. Two blind spots survived into production and cost a
# 2500/hr quota exhaustion:
#   1. the `linear` alias — the linearis package installs BOTH `linear` and
#      `linearis` symlinks to the same dist/main.js, and the matcher anchored on
#      `linearis` only;
#   2. wrapper prefixes — `direnv exec . linearis issues read X` failed the
#      command-word anchor. Every Linear call in a direnv repo carries that
#      prefix, so the hook was structurally blind in those repos.
# These are locked in below as MUST-DETECT cases.
#
# Single-quoted `$VAR` / `$(…)` in the cases below are DELIBERATE: the hook is fed
# the unexpanded command text, so the literal is the fixture.
# shellcheck disable=SC2016
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/../../hooks/detect-bare-linear-read.sh"

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

command -v jq >/dev/null 2>&1 || {
	echo "SKIP: jq not available"
	exit 0
}
[ -r "$HOOK" ] || {
	echo "FAIL: hook not found at $HOOK"
	exit 1
}

# Run the hook against a command string. Echoes "DETECT" or "PASS-THROUGH".
# CATALYST_LINEAR_READ_DETECT_MODE is forced to observe so a detection is a
# warn-on-stderr + exit 0 (we assert on the stderr, not the exit code).
# CATALYST_EVENTS_DIR is redirected so the telemetry emit can never touch the
# real event log from a test run.
run_hook() {
	local cmd="$1" mode="${2:-observe}" out
	out="$(printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | jq -Rs .)" |
		CATALYST_LINEAR_READ_DETECT_MODE="$mode" \
			CATALYST_EVENTS_DIR="$TMPDIR_T/events" \
			bash "$HOOK" 2>&1)"
	if [ -n "$out" ]; then printf 'DETECT'; else printf 'PASS-THROUGH'; fi
}

assert_detect() {
	local got
	got="$(run_hook "$2")"
	if [ "$got" = "DETECT" ]; then ok "$1"; else fail "$1" "expected DETECT, got $got — '$2'"; fi
}
assert_pass() {
	local got
	got="$(run_hook "$2")"
	if [ "$got" = "PASS-THROUGH" ]; then ok "$1"; else fail "$1" "expected PASS-THROUGH, got $got — '$2'"; fi
}

TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT

echo "detect-bare-linear-read: MUST DETECT (bare replica-bypassing reads)"
assert_detect "canonical linearis read" "linearis issues read CTC-198"
assert_detect "the \`linear\` alias (regression: CTL-1420)" "linear issues read CTC-198"
assert_detect "direnv wrapper + linearis (regression: CTL-1420)" "direnv exec . linearis issues read CTC-198"
assert_detect "direnv wrapper + linear alias (regression: CTL-1420)" "direnv exec . linear issues read CTC-198"
assert_detect "env-assignment prefix" "FOO=1 linearis issues read CTC-198"
assert_detect "env wrapper" "env linearis issues read CTC-198"
assert_detect "command wrapper" "command linear issues read CTC-198"
assert_detect "nested wrappers" "env FOO=1 direnv exec . linear issues read CTC-198"
assert_detect "variable ticket id" 'linear issues read "$TICKET"'
assert_detect "braced variable id" 'linearis issues read ${T}'
assert_detect "command-substitution id" 'linear issues read $(cat /tmp/t)'
assert_detect "flags before verb" "linearis --json issues read CTC-198"
assert_detect "sibling bare read after a sanctioned one" \
	"linearis issues read A --with-attachments; linear issues read B"
assert_detect "line-continuation split" "linear issues \\
read CTC-198"
# The shape that actually burned the quota: a for-loop over a ticket range. Splitting
# on `;` leaves a segment starting with the shell keyword `do`, so the command word
# is not the first token.
assert_detect "for-loop body (regression: CTL-1420)" \
	'for t in 198 199 200; do direnv exec . linear issues read CTC-$t; done'
assert_detect "while-loop body" 'while read t; do linear issues read $t; done < ids.txt'
assert_detect "then-branch" 'if [ -n "$T" ]; then linear issues read $T; fi'
assert_detect "&& chain" "cd /tmp && linear issues read CTC-198"
assert_detect "brace group" "{ linear issues read CTC-198; }"

echo
echo "detect-bare-linear-read: MUST NOT DETECT (sanctioned / not-a-read)"
assert_pass "sanctioned attachments read" "linearis issues read CTC-198 --with-attachments"
assert_pass "attachments read via alias" "linear issues read CTC-198 --with-attachments"
assert_pass "issues list (documented carve-out)" "linearis issues list --team CTC"
assert_pass "issues search (documented carve-out)" "linear issues search foo"
assert_pass "comments list (documented carve-out)" "linearis comments list CTC-198"
assert_pass "writes are never a bypass" "linearis issues update CTC-198 --status Done"
assert_pass "creates are never a bypass" "linear issues create --title x"
assert_pass "usage lookup" "linearis issues usage"
assert_pass "the replica helper itself" "linear_read_ticket CTC-198"
assert_pass "grep for the string is not a call" "rg 'linearis issues read' plugins/"
assert_pass "echo of the string is not a call" "echo 'linear issues read CTC-198'"
assert_pass "a substring binary is not linearis" "mylinearis issues read CTC-198"
assert_pass "linear-adjacent binary is not linearis" "linearisctl issues read CTC-198"
assert_pass "unrelated command" "ls -la"
# A wrapper must not license skipping to ANY later `linear` token: the command a
# wrapper runs is the first thing in command position after its own operands.
# Here the command is `echo`, so nothing hits the API. Detecting it would BLOCK a
# legitimate command under enforce. (Codex P2, PR #2658.)
assert_pass "wrapper running a different command" "env echo linear issues read CTC-198"
assert_pass "wrapper running a different command (direnv)" "direnv exec . echo linear issues read CTC-198"
assert_pass "printf of the string under a wrapper" "env printf '%s' 'linear issues read CTC-198'"

echo
echo "detect-bare-linear-read: enforce mode blocks"
out="$(printf '{"tool_input":{"command":"linear issues read CTC-198"}}' |
	CATALYST_LINEAR_READ_DETECT_MODE=enforce CATALYST_EVENTS_DIR="$TMPDIR_T/events" \
		bash "$HOOK" 2>&1)"
rc=$?
if [ "$rc" -eq 2 ]; then ok "enforce exits 2 (blocks the tool call)"; else fail "enforce exits 2" "got rc=$rc"; fi
case "$out" in
*Blocked*) ok "enforce message says Blocked" ;;
*) fail "enforce message says Blocked" "got: $out" ;;
esac

out="$(printf '{"tool_input":{"command":"linearis issues list --team CTC"}}' |
	CATALYST_LINEAR_READ_DETECT_MODE=enforce CATALYST_EVENTS_DIR="$TMPDIR_T/events" \
		bash "$HOOK" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then ok "enforce does not block a carve-out"; else fail "enforce does not block a carve-out" "got rc=$rc"; fi

# The remedy must be actionable from ANY repo. A relative `plugins/dev/...` path
# resolves only inside the catalyst checkout — and the repos where this hook newly
# fires (direnv-managed ones like catalyst-cloud) do not have that path. The hook
# already resolves the helper's real location for its own telemetry; the message
# must quote that same absolute path.
out="$(printf '{"tool_input":{"command":"linear issues read CTC-198"}}' |
	CATALYST_LINEAR_READ_DETECT_MODE=enforce CATALYST_EVENTS_DIR="$TMPDIR_T/events" \
		bash "$HOOK" 2>&1)"
case "$out" in
*"source plugins/dev/scripts/lib"* | *"source 'plugins/"*)
	fail "enforce remedy is an absolute path" "message quotes a repo-relative path that does not exist outside the catalyst checkout" ;;
*"source '/"* | *"source /"*) ok "enforce remedy is an absolute path" ;;
*) fail "enforce remedy is an absolute path" "no sourceable path in: $out" ;;
esac
if printf '%s' "$out" | grep -q "linear_read_ticket CTC-198"; then
	ok "enforce remedy names the ticket"
else fail "enforce remedy names the ticket" "got: $out"; fi

# The remedy is copy-pasted by an agent, so the path must survive a plugin root
# containing spaces — an unquoted `source /a b/c.sh` is a broken command.
# (Codex P2, PR #2658.)
SPACED="$TMPDIR_T/plugin root/hooks"
mkdir -p "$SPACED" "$TMPDIR_T/plugin root/scripts/lib"
cp "$HOOK" "$SPACED/detect-bare-linear-read.sh"
: >"$TMPDIR_T/plugin root/scripts/lib/linear-read-replica.sh"
out="$(printf '{"tool_input":{"command":"linear issues read CTC-198"}}' |
	CATALYST_LINEAR_READ_DETECT_MODE=enforce CATALYST_EVENTS_DIR="$TMPDIR_T/events" \
		bash "$SPACED/detect-bare-linear-read.sh" 2>&1)"
if printf '%s' "$out" | grep -qE "source ('[^']*'|\"[^\"]*\")"; then
	ok "enforce remedy quotes a path containing spaces"
else fail "enforce remedy quotes a path containing spaces" "unquoted/invalid in: $out"; fi

# The reported id must be the READ TARGET, not a wrapper operand that merely looks
# like a ticket — otherwise the remedy tells the agent to read the wrong ticket and
# the Loki event is misattributed. (Codex P2, PR #2658.)
out="$(printf '{"tool_input":{"command":"direnv exec /tmp/CTC-111 linear issues read CTC-198"}}' |
	CATALYST_LINEAR_READ_DETECT_MODE=enforce CATALYST_EVENTS_DIR="$TMPDIR_T/events" \
		bash "$HOOK" 2>&1)"
if printf '%s' "$out" | grep -q "linear_read_ticket CTC-198"; then
	ok "id comes from the read target, not a wrapper operand"
else fail "id comes from the read target, not a wrapper operand" "got: $out"; fi

echo
printf 'detect-bare-linear-read: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
