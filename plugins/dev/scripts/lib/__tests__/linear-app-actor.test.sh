#!/usr/bin/env bash
# Unit tests for lib/linear-app-actor.sh (CTL-1612 rounds 4-5, Codex P1/P2 follow-ups).
#
# Focus: the SCOPED branch (linear_app_actor_auth <daemon> <target-var>, and
# the shared linear_app_actor_clear_inherited helper it delegates to) must
# actively clear any INHERITED, NON-PERSONAL LINEAR_API_TOKEN/LINEAR_API_KEY
# it finds already set, regardless of whether its own mint attempt succeeds,
# fails, or finds no orchestrator creds configured at all — this is what
# closes the broker stack-reload → catalyst-monitor restart inheritance path
# (catalyst-broker exports the app-actor token under those two names;
# broker/stack-reload.mjs's restart spawn carries no `env` override, so the
# child inherits verbatim).
#
# CTL-1612 round 5: the clear is PRECISE — a genuinely personal `lin_api_*`
# key (case-insensitive prefix) SURVIVES, since it's the only credential the
# estimate/title fallbacks can use when no Layer-2 personal token is
# configured. Anything else (bot/oauth-shaped, or an unrecognized shape) is
# cleared — see the "preserves a personal lin_api_* key" case below.
#
# The UNSCOPED branch (broker/execution-core's own startup call) must be
# UNCHANGED — it never clears anything, it only ever sets the two vars itself.
#
# CATALYST_LAYER2_CONFIG_FILE is pinned to an absent sandbox path in EVERY
# call below so catalyst_resolve_secret finds no orchestrator creds — the mint
# silently no-ops (documented fail-open), isolating the clearing behavior
# (which is unconditional, independent of mint outcome) from any real network
# call. This machine has real orchestrator creds configured in
# ~/.config/catalyst/config.json, so this pin is load-bearing, not decorative.
#
# Run: bash plugins/dev/scripts/lib/__tests__/linear-app-actor.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/../linear-app-actor.sh"
SCRATCH="$(mktemp -d -t linear-app-actor-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
ABSENT_LAYER2="${SCRATCH}/absent-layer2-config.json"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

if [[ ! -f "$LIB" ]]; then
	echo "FATAL: $LIB not found" >&2
	exit 1
fi

echo "scoped mode: clears a pre-set (simulated-inherited) bot/oauth-shaped LINEAR_API_TOKEN/LINEAR_API_KEY"
OUT="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="lin_oauth_fake_inherited_bot_token" LINEAR_API_KEY="lin_oauth_fake_inherited_bot_token" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon" SCOPED_TARGET
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
		echo "LINEAR_API_KEY=[${LINEAR_API_KEY:-}]"
		echo "SCOPED_TARGET=[${SCOPED_TARGET:-}]"
	' 2>&1)"
if echo "$OUT" | grep -qxF "LINEAR_API_TOKEN=[]"; then
	pass "LINEAR_API_TOKEN cleared"
else
	fail "LINEAR_API_TOKEN not cleared; output: $OUT"
fi
if echo "$OUT" | grep -qxF "LINEAR_API_KEY=[]"; then
	pass "LINEAR_API_KEY cleared"
else
	fail "LINEAR_API_KEY not cleared; output: $OUT"
fi
if echo "$OUT" | grep -q "clearing inherited LINEAR_API_TOKEN/LINEAR_API_KEY"; then
	pass "logs the clear"
else
	fail "did not log the clear; output: $OUT"
fi
# No orchestrator creds configured (absent Layer-2 file) → mint no-ops →
# SCOPED_TARGET stays unset. This proves the clear happens EVEN WHEN the
# mint itself never runs — the two are independent.
if echo "$OUT" | grep -qxF "SCOPED_TARGET=[]"; then
	pass "SCOPED_TARGET stays unset when no orchestrator creds are configured (clear is independent of mint outcome)"
else
	fail "SCOPED_TARGET unexpectedly set; output: $OUT"
fi

echo ""
echo "scoped mode: PRESERVES a legitimate personal lin_api_* key (CTL-1612 round 5)"
OUT_PERSONAL="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="lin_api_fake_personal_key_1234" LINEAR_API_KEY="lin_api_fake_personal_key_1234" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon" SCOPED_TARGET
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
		echo "LINEAR_API_KEY=[${LINEAR_API_KEY:-}]"
	' 2>&1)"
if echo "$OUT_PERSONAL" | grep -qxF "LINEAR_API_TOKEN=[lin_api_fake_personal_key_1234]"; then
	pass "LINEAR_API_TOKEN (personal lin_api_* key) survives"
else
	fail "personal LINEAR_API_TOKEN was cleared; output: $OUT_PERSONAL"
fi
if echo "$OUT_PERSONAL" | grep -qxF "LINEAR_API_KEY=[lin_api_fake_personal_key_1234]"; then
	pass "LINEAR_API_KEY (personal lin_api_* key) survives"
else
	fail "personal LINEAR_API_KEY was cleared; output: $OUT_PERSONAL"
fi
if echo "$OUT_PERSONAL" | grep -q "clearing inherited"; then
	fail "logged a clear line even though both vars were personal keys; output: $OUT_PERSONAL"
else
	pass "no clear log line when both vars are personal keys"
fi

echo ""
echo "scoped mode: matches lin_api_* case-insensitively"
OUT_UPPER="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="LIN_API_FAKE_UPPERCASE_KEY" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon" SCOPED_TARGET
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
	' 2>&1)"
if echo "$OUT_UPPER" | grep -qxF "LINEAR_API_TOKEN=[LIN_API_FAKE_UPPERCASE_KEY]"; then
	pass "uppercase LIN_API_* is recognized as personal (case-insensitive) and survives"
else
	fail "uppercase LIN_API_* was cleared; output: $OUT_UPPER"
fi

echo ""
echo "scoped mode: per-variable independence — a personal LINEAR_API_TOKEN survives while a bot-shaped LINEAR_API_KEY is cleared"
OUT_MIXED="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="lin_api_fake_personal_key_5678" LINEAR_API_KEY="lin_oauth_fake_inherited_bot_key" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon" SCOPED_TARGET
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
		echo "LINEAR_API_KEY=[${LINEAR_API_KEY:-}]"
	' 2>&1)"
if echo "$OUT_MIXED" | grep -qxF "LINEAR_API_TOKEN=[lin_api_fake_personal_key_5678]"; then
	pass "personal LINEAR_API_TOKEN survives alongside a cleared LINEAR_API_KEY"
else
	fail "personal LINEAR_API_TOKEN was unexpectedly cleared; output: $OUT_MIXED"
fi
if echo "$OUT_MIXED" | grep -qxF "LINEAR_API_KEY=[]"; then
	pass "bot-shaped LINEAR_API_KEY is cleared alongside a preserved LINEAR_API_TOKEN"
else
	fail "bot-shaped LINEAR_API_KEY was not cleared; output: $OUT_MIXED"
fi
if echo "$OUT_MIXED" | grep -q "clearing inherited"; then
	pass "logs the clear when at least one var was non-personal"
else
	fail "did not log the clear for the mixed case; output: $OUT_MIXED"
fi

echo ""
echo "scoped mode: nothing pre-set → clears silently, no spurious log line"
OUT2="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon" SCOPED_TARGET
	' 2>&1)"
if echo "$OUT2" | grep -q "clearing inherited LINEAR_API_TOKEN/LINEAR_API_KEY"; then
	fail "logged a clear when nothing was inherited; output: $OUT2"
else
	pass "no spurious clear log when nothing was pre-set"
fi

echo ""
echo "unscoped mode (broker/execution-core, no target-var): a pre-set LINEAR_API_TOKEN (even a bot-shaped one) is left untouched by the clearing logic (it is still overwritten by the mint's OWN export path exactly as before, but never by the clear)"
OUT3="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="lin_oauth_pre_existing_token" LINEAR_API_KEY="lin_oauth_pre_existing_token" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon"
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
	' 2>&1)"
if echo "$OUT3" | grep -qxF "LINEAR_API_TOKEN=[lin_oauth_pre_existing_token]"; then
	pass "unscoped mode never clears LINEAR_API_TOKEN (broker/execution-core behavior unchanged)"
else
	fail "unscoped mode unexpectedly touched LINEAR_API_TOKEN; output: $OUT3"
fi
if echo "$OUT3" | grep -q "clearing inherited"; then
	fail "unscoped mode logged a clear line — it must never reach that branch"
else
	pass "unscoped mode never logs the scoped-mode clear line"
fi

echo ""
echo "linear_app_actor_clear_inherited (standalone, CTL-1612 round 5): usable without a mint attempt"
OUT4="$(env -i HOME="$HOME" PATH="$PATH" \
	LINEAR_API_TOKEN="lin_oauth_standalone_bot_token" LINEAR_API_KEY="lin_api_standalone_personal_key" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_clear_inherited "test-daemon"
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
		echo "LINEAR_API_KEY=[${LINEAR_API_KEY:-}]"
	' 2>&1)"
if echo "$OUT4" | grep -qxF "LINEAR_API_TOKEN=[]"; then
	pass "standalone clear: bot-shaped LINEAR_API_TOKEN cleared with no mint attempt"
else
	fail "standalone clear did not clear the bot-shaped token; output: $OUT4"
fi
if echo "$OUT4" | grep -qxF "LINEAR_API_KEY=[lin_api_standalone_personal_key]"; then
	pass "standalone clear: personal LINEAR_API_KEY survives with no mint attempt"
else
	fail "standalone clear touched the personal key; output: $OUT4"
fi

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
