#!/usr/bin/env bash
# Unit tests for lib/linear-app-actor.sh (CTL-1612 round 4, Codex P1 follow-up).
#
# Focus: the SCOPED branch (linear_app_actor_auth <daemon> <target-var>) must
# actively clear any INHERITED LINEAR_API_TOKEN/LINEAR_API_KEY it finds already
# set, regardless of whether its own mint attempt succeeds, fails, or finds no
# orchestrator creds configured at all — this is what closes the broker
# stack-reload → catalyst-monitor restart inheritance path (catalyst-broker
# exports the app-actor token under those two names; broker/stack-reload.mjs's
# restart spawn carries no `env` override, so the child inherits verbatim).
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

echo "scoped mode: clears a pre-set (simulated-inherited) LINEAR_API_TOKEN/LINEAR_API_KEY"
OUT="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="fake-inherited-bot-token" LINEAR_API_KEY="fake-inherited-bot-token" \
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
echo "unscoped mode (broker/execution-core, no target-var): a pre-set LINEAR_API_TOKEN is left untouched by the NEW clearing logic (it is still overwritten by the mint's OWN export path exactly as before, but never by the clear)"
OUT3="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="pre-existing-personal-token" LINEAR_API_KEY="pre-existing-personal-token" \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon"
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
	' 2>&1)"
if echo "$OUT3" | grep -qxF "LINEAR_API_TOKEN=[pre-existing-personal-token]"; then
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
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
