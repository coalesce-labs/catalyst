#!/usr/bin/env bash
# CTL-633 phase-review regression: linear-pr-skip.sh must work when SOURCED
# under zsh, because the Catalyst Bash tool runs /bin/zsh — that is the real
# production runtime for the create-pr/describe-pr/ci-describe-pr producers.
#
# The original helper resolved its sibling-lib dir via ${BASH_SOURCE[0]} (unset
# in zsh ⇒ collapsed to CWD ⇒ team-keys lib never sourced) and guarded the
# filter with `declare -F` (returns SUCCESS for an absent function in zsh ⇒
# called a missing command ⇒ the whole pipe emitted EMPTY output with exit 0).
# Net effect: the sibling-skip guard was SILENTLY nullified under zsh while all
# bash-shebang suites stayed green. This suite exercises the helper through
# `zsh -c` so the harness catches that class of regression.
#
# The harness itself runs under bash (run-tests.sh invokes via `bash "$f"`); the
# assertions shell out to zsh to test the runtime shell.
#
# Run: bash plugins/dev/scripts/__tests__/linear-pr-skip-zsh.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/linear-pr-skip.sh"
# Mirror the producers: they source via "${CLAUDE_PLUGIN_ROOT}/scripts/lib/...".
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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

if ! command -v zsh >/dev/null 2>&1; then
	echo "zsh not available — skipping zsh runtime regression suite (no-op)."
	echo "PASSES=0 FAILURES=0"
	exit 0
fi

# Run a snippet under zsh from an UNRELATED cwd (/tmp) so a BASH_SOURCE-relative
# resolver would collapse to /tmp — the exact failure geometry of finding #1.
run_zsh() {
	local plugin_root="$1" snippet="$2"
	if [[ -n "$plugin_root" ]]; then
		zsh -c "cd /tmp; export CLAUDE_PLUGIN_ROOT='$plugin_root'; source '$HELPER'; $snippet" 2>&1
	else
		zsh -c "cd /tmp; unset CLAUDE_PLUGIN_ROOT; source '$HELPER'; $snippet" 2>&1
	fi
}

# Sandbox the team-key cache so a real workstation's allowlist can't skew us.
TK_SANDBOX="$(mktemp -d)"
mkdir -p "$TK_SANDBOX/catalyst"
export XDG_CONFIG_HOME="$TK_SANDBOX"
trap 'rm -rf "$TK_SANDBOX"' EXIT

# ─── Case 1: branch mode under zsh (CLAUDE_PLUGIN_ROOT anchor) ─────────────────
echo "Test: branch mode emits sibling skips when sourced under zsh"
out="$(run_zsh "$PLUGIN_ROOT" \
	'linear_sibling_skip_block_from_branch ADV-1155 "o-adv-1155-1156-1157-ADV-1155"')"
if grep -q '^skip ADV-1156$' <<<"$out" \
	&& grep -q '^skip ADV-1157$' <<<"$out" \
	&& ! grep -q '^skip ADV-1155$' <<<"$out" \
	&& ! grep -qi 'command not found' <<<"$out"; then
	pass "zsh branch mode: skip ADV-1156/1157 emitted (own excluded), no command-not-found"
else
	fail "zsh branch mode emits sibling skips" "got: $out"
fi

# ─── Case 2: body mode under zsh ──────────────────────────────────────────────
echo "Test: body mode emits canonical token when sourced under zsh"
out="$(run_zsh "$PLUGIN_ROOT" \
	'linear_sibling_skip_block_from_body CTL-633 "see ENG-50, released 2026-05-25, oauth2 utf8 abc123"')"
if grep -q '^skip ENG-50$' <<<"$out" \
	&& ! grep -q '^skip UTF-' <<<"$out" \
	&& ! grep -q '^skip OAUTH-' <<<"$out" \
	&& ! grep -qi 'command not found' <<<"$out"; then
	pass "zsh body mode: canonical ENG-50 emitted, prose did not fabricate"
else
	fail "zsh body mode emits canonical token" "got: $out"
fi

# ─── Case 3: allowlist filter actually applies under zsh ──────────────────────
# With CLAUDE_PLUGIN_ROOT set, the team-keys lib IS sourced, so a populated
# allowlist must drop a non-allowlisted prefix (proves the filter ran, not the
# fail-open passthrough).
echo "Test: populated allowlist filters under zsh (lib was sourced)"
printf '{"keys":["ADV"]}\n' >"$TK_SANDBOX/catalyst/linear-team-keys.json"
out="$(run_zsh "$PLUGIN_ROOT" \
	'linear_sibling_skip_block_from_body CTL-633 "see ENG-50 and ADV-200"')"
if grep -q '^skip ADV-200$' <<<"$out" && ! grep -q '^skip ENG-50$' <<<"$out"; then
	pass "zsh: allowlist applied (ADV-200 kept, ENG-50 dropped) — lib was sourced"
else
	fail "zsh: allowlist applied" "got: $out"
fi
rm -f "$TK_SANDBOX/catalyst/linear-team-keys.json"

# ─── Case 4: fail-open path under zsh (no CLAUDE_PLUGIN_ROOT) ──────────────────
# The lib cannot be resolved (no anchor), so the filter must fall back to `cat`
# rather than dropping all output. This is the `command -v` guard's job.
echo "Test: fail-open passthrough under zsh when lib cannot be resolved"
out="$(run_zsh "" \
	'linear_sibling_skip_block_from_branch ADV-1155 "o-adv-1155-1156-1157-ADV-1155"')"
if grep -q '^skip ADV-1156$' <<<"$out" \
	&& grep -q '^skip ADV-1157$' <<<"$out" \
	&& ! grep -qi 'command not found' <<<"$out"; then
	pass "zsh fail-open: skips still emitted via cat fallback, no command-not-found"
else
	fail "zsh fail-open passthrough emits skips" "got: $out"
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ $FAILURES -eq 0 ]]
