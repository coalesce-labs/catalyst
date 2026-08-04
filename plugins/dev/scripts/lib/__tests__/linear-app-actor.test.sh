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

# CTL-1612 round 13 (Codex P1 follow-up): lib/linear-app-actor.sh's own mint
# chain has a documented, tested fallback for a jq-less host (round 9: jq →
# bun -e → node -e, loud warning + fail-open when all three are absent). This
# SUITE never got the matching guard, so on a truly bash-and-git-only
# checkout (no jq/bun/node) the fake-credential mint cases below fail to
# parse their fixtures and the suite itself hard-fails — Codex reproduced
# exit 1 with 18 pass / 12 fail via the aggregate runner. "SKIP:" (column 0)
# is the marker run-tests.sh's `grep -q '^SKIP:'` recognizes as a clean skip,
# matching the round-12 precedent (rebase-telemetry.test.sh,
# emit-reap-intent.test.sh) — the suite should skip, not fail, when its
# subject's own documented no-parser case is the actual host state.
if
	! command -v jq >/dev/null 2>&1 &&
		! command -v bun >/dev/null 2>&1 &&
		! command -v node >/dev/null 2>&1
then
	echo "SKIP: linear-app-actor tests require a JSON parser (jq, bun, or node — none on PATH)"
	exit 0
fi

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
		echo "SCOPED_TARGET_SOURCE=[${SCOPED_TARGET_SOURCE:-}]"
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
# No orchestrator creds configured (absent Layer-2 file) → mint no-ops. Since
# CTL-1612 round 6, SCOPED_TARGET is now seeded from the captured inherited
# bot-shaped token in this exact case (a usable credential is reused rather
# than discarded — see the dedicated "inherited-token fallback" section
# below for the full behavior matrix). This still proves the ALIAS CLEAR
# happens independent of mint outcome (asserted above) — only the target-var
# SEEDING behavior changed in round 6.
if echo "$OUT" | grep -qxF "SCOPED_TARGET=[lin_oauth_fake_inherited_bot_token]"; then
	pass "SCOPED_TARGET is seeded from the inherited token when no orchestrator creds are configured (CTL-1612 round 6 fallback)"
else
	fail "SCOPED_TARGET not seeded from the inherited fallback; output: $OUT"
fi
if echo "$OUT" | grep -qxF "SCOPED_TARGET_SOURCE=[inherited]"; then
	pass "SCOPED_TARGET_SOURCE=inherited (CTL-1612 round 7 provenance marker)"
else
	fail "SCOPED_TARGET_SOURCE not marked inherited; output: $OUT"
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
echo "scoped mode: a PADDED personal lin_api_* key (surrounding whitespace) still survives (CTL-1612 round 6)"
OUT_PADDED="$(env -i HOME="$HOME" PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$ABSENT_LAYER2" \
	LINEAR_API_TOKEN="  lin_api_fake_padded_key  " \
	bash -c '
		set -uo pipefail
		source "'"$LIB"'"
		linear_app_actor_auth "test-daemon" SCOPED_TARGET
		echo "LINEAR_API_TOKEN=[${LINEAR_API_TOKEN:-}]"
	' 2>&1)"
if echo "$OUT_PADDED" | grep -qxF "LINEAR_API_TOKEN=[  lin_api_fake_padded_key  ]"; then
	pass "padded personal lin_api_* key survives untouched (including its original padding — only the CLASSIFICATION trims, never the stored value)"
else
	fail "padded personal LINEAR_API_TOKEN was cleared or mutated; output: $OUT_PADDED"
fi
if echo "$OUT_PADDED" | grep -q "clearing inherited"; then
	fail "logged a clear line for a padded personal key; output: $OUT_PADDED"
else
	pass "no clear log line for a padded personal key"
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

# ─── Inherited-token fallback (CTL-1612 round 6, Codex P2 resilience follow-up) ─
# A usable inherited app-actor token must not be discarded when the monitor's
# OWN mint then fails — it should seed the scoped target var instead, so
# self-reads keep working until the next successful mint. A SUCCESSFUL mint
# still always wins. These fixtures need REAL (fake) orchestrator creds — a
# stubbed curl on PATH stands in for the network so the mint can genuinely
# succeed or fail without ever reaching api.linear.app.
echo ""
echo "inherited-token fallback: mint FAILS + inherited bot token present → scoped var seeded from inherited (CTL-1612 round 6)"

FAKE_L2="${SCRATCH}/fake-layer2-with-creds.json"
cat > "$FAKE_L2" <<'EOF'
{"catalyst":{"linear":{"bot":{"orchestrator":{"clientId":"fake-r6-client-id","clientSecret":"fake-r6-client-secret"}}}}}
EOF

STUB_BIN="${SCRATCH}/bin"
mkdir -p "$STUB_BIN"

# Stub curl that ALWAYS fails the mint (no access_token in the response) —
# never reaches the real network.
cat > "${STUB_BIN}/curl-fail" <<'CURLSTUB'
#!/usr/bin/env bash
echo '{"error":"invalid_client"}'
CURLSTUB
chmod +x "${STUB_BIN}/curl-fail"

# Stub curl that ALWAYS succeeds with a fixed fake access_token.
cat > "${STUB_BIN}/curl-success" <<'CURLSTUB'
#!/usr/bin/env bash
echo '{"access_token":"fake-r6-fresh-mint-token"}'
CURLSTUB
chmod +x "${STUB_BIN}/curl-success"

# CTL-1612 round 15 (Codex P2 follow-up): these three scenarios drive
# linear_app_actor_auth against the REAL (unstubbed) catalyst_resolve_secret
# with a REAL $FAKE_L2 file — unlike the "Tiered jq-less JSON parsing"
# scenarios further below, which deliberately STUB catalyst_resolve_secret to
# isolate linear-app-actor.sh's OWN round-9 tiered parsing from that
# function's separate jq dependency (see the header comment above that
# section). catalyst_resolve_secret's Layer-2 reader (lib/catalyst-secret-
# contract.sh) requires jq specifically — round 9's mint-chain tiering never
# touched it (documented out-of-scope boundary) — so on a host with bun or
# node but no jq, the suite-level guard above passes (a parser exists) yet
# these three cases still can't resolve $FAKE_L2's clientId/clientSecret.
# Codex reproduced this concretely: exit 1 with 28 pass / 4 failures — the
# successful-mint fixture can't resolve creds, and the failed-mint fixture
# never reaches the warning path it expects. Case-level (not suite-level)
# SKIP: everything else in this file (the clear-inherited cases above, which
# never touch catalyst_resolve_secret because $ABSENT_LAYER2 short-circuits
# it before any parsing, and the tiered-parsing cases below, which stub it
# out) must keep running even when jq is absent.
if command -v jq >/dev/null 2>&1; then
	ln -sf "${STUB_BIN}/curl-fail" "${STUB_BIN}/curl"
	OUT_FAIL_FALLBACK="$(env -i HOME="$HOME" PATH="${STUB_BIN}:${PATH}" CATALYST_LAYER2_CONFIG_FILE="$FAKE_L2" \
		LINEAR_API_TOKEN="lin_oauth_fake_inherited_for_fallback" \
		bash -c '
			set -uo pipefail
			source "'"$LIB"'"
			linear_app_actor_auth "test-daemon" SCOPED_TARGET
			echo "SCOPED_TARGET=[${SCOPED_TARGET:-}]"
			echo "SCOPED_TARGET_SOURCE=[${SCOPED_TARGET_SOURCE:-}]"
		' 2>&1)"
	if echo "$OUT_FAIL_FALLBACK" | grep -qxF "SCOPED_TARGET=[lin_oauth_fake_inherited_for_fallback]"; then
		pass "mint-fails + inherited-bot-token: SCOPED_TARGET seeded from the inherited token"
	else
		fail "mint-fails + inherited-bot-token: SCOPED_TARGET not seeded; output: $OUT_FAIL_FALLBACK"
	fi
	if echo "$OUT_FAIL_FALLBACK" | grep -q "reusing the inherited app-actor token"; then
		pass "mint-fails + inherited-bot-token: logs the reuse"
	else
		fail "mint-fails + inherited-bot-token: did not log the reuse; output: $OUT_FAIL_FALLBACK"
	fi
	if echo "$OUT_FAIL_FALLBACK" | grep -qxF "SCOPED_TARGET_SOURCE=[inherited]"; then
		pass "mint-fails + inherited-bot-token: SCOPED_TARGET_SOURCE=inherited (CTL-1612 round 7)"
	else
		fail "mint-fails + inherited-bot-token: SCOPED_TARGET_SOURCE not marked inherited; output: $OUT_FAIL_FALLBACK"
	fi
	rm -f "${STUB_BIN}/curl"

	echo ""
	echo "inherited-token fallback: mint SUCCEEDS + inherited bot token present → fresh token wins"
	ln -sf "${STUB_BIN}/curl-success" "${STUB_BIN}/curl"
	OUT_SUCCESS_WINS="$(env -i HOME="$HOME" PATH="${STUB_BIN}:${PATH}" CATALYST_LAYER2_CONFIG_FILE="$FAKE_L2" \
		LINEAR_API_TOKEN="lin_oauth_fake_inherited_should_be_replaced" \
		bash -c '
			set -uo pipefail
			source "'"$LIB"'"
			linear_app_actor_auth "test-daemon" SCOPED_TARGET
			echo "SCOPED_TARGET=[${SCOPED_TARGET:-}]"
			echo "SCOPED_TARGET_SOURCE=[${SCOPED_TARGET_SOURCE:-}]"
		' 2>&1)"
	if echo "$OUT_SUCCESS_WINS" | grep -qxF "SCOPED_TARGET=[fake-r6-fresh-mint-token]"; then
		pass "mint-succeeds: fresh token wins over the inherited fallback"
	else
		fail "mint-succeeds: fresh token did not win; output: $OUT_SUCCESS_WINS"
	fi
	if echo "$OUT_SUCCESS_WINS" | grep -q "reusing the inherited app-actor token"; then
		fail "mint-succeeds: incorrectly logged a fallback reuse; output: $OUT_SUCCESS_WINS"
	else
		pass "mint-succeeds: no fallback-reuse log line"
	fi
	if echo "$OUT_SUCCESS_WINS" | grep -qxF "SCOPED_TARGET_SOURCE=[minted]"; then
		pass "mint-succeeds: SCOPED_TARGET_SOURCE=minted (CTL-1612 round 7) — not left at 'inherited' from the pre-set env value"
	else
		fail "mint-succeeds: SCOPED_TARGET_SOURCE not marked minted; output: $OUT_SUCCESS_WINS"
	fi
	rm -f "${STUB_BIN}/curl"

	echo ""
	echo "inherited-token fallback: mint FAILS + NO inherited token → scoped var stays unset"
	ln -sf "${STUB_BIN}/curl-fail" "${STUB_BIN}/curl"
	OUT_FAIL_NOFALLBACK="$(env -i HOME="$HOME" PATH="${STUB_BIN}:${PATH}" CATALYST_LAYER2_CONFIG_FILE="$FAKE_L2" \
		bash -c '
			set -uo pipefail
			source "'"$LIB"'"
			linear_app_actor_auth "test-daemon" SCOPED_TARGET
			echo "SCOPED_TARGET=[${SCOPED_TARGET:-}]"
			echo "SCOPED_TARGET_SOURCE=[${SCOPED_TARGET_SOURCE:-}]"
		' 2>&1)"
	if echo "$OUT_FAIL_NOFALLBACK" | grep -qxF "SCOPED_TARGET=[]"; then
		pass "mint-fails + no-inherited-token: SCOPED_TARGET stays unset"
	else
		fail "mint-fails + no-inherited-token: SCOPED_TARGET unexpectedly set; output: $OUT_FAIL_NOFALLBACK"
	fi
	if echo "$OUT_FAIL_NOFALLBACK" | grep -q "WARNING orchestrator token mint failed"; then
		pass "mint-fails + no-inherited-token: logs the existing WARNING (unchanged)"
	else
		fail "mint-fails + no-inherited-token: did not log the WARNING; output: $OUT_FAIL_NOFALLBACK"
	fi
	if echo "$OUT_FAIL_NOFALLBACK" | grep -qxF "SCOPED_TARGET_SOURCE=[]"; then
		pass "mint-fails + no-inherited-token: SCOPED_TARGET_SOURCE stays unset too (CTL-1612 round 7 — no token, no provenance to report)"
	else
		fail "mint-fails + no-inherited-token: SCOPED_TARGET_SOURCE unexpectedly set; output: $OUT_FAIL_NOFALLBACK"
	fi
	rm -f "${STUB_BIN}/curl"
else
	echo "  SKIP: inherited-token fallback mint-path cases (jq required — catalyst_resolve_secret's Layer-2 reader has its own jq dependency, CTL-1612 round 9 documented scope boundary; a JSON parser existing for the suite-level guard above is not enough)"
fi

# ─── Tiered jq-less JSON parsing in the mint chain (CTL-1612 round 9) ──────
# linear-app-actor.sh's OWN field-parsing (clientId/clientSecret/access_token
# extraction, @uri encoding) now falls back jq → bun -e → node -e, mirroring
# create-worktree.sh's #2966 packageManager-sniff precedent. NOTE:
# catalyst_resolve_secret (lib/catalyst-secret-contract.sh) has its OWN,
# SEPARATE jq dependency that this round deliberately does not touch (core,
# heavily-hardened shared infrastructure used by every config-json registry
# row — see the header comment above linear_app_actor_auth and the round-9
# report for why extending it was judged out of proportion for this
# finding). Both cases below therefore STUB catalyst_resolve_secret (a plain
# bash function redefinition after sourcing $LIB — later definition wins) so
# they can isolate and prove linear-app-actor.sh's OWN tier, independent of
# that separate, still-jq-dependent concern.
echo ""
echo "jq-less-but-bun-present: mint SUCCEEDS via the bun tier (CTL-1612 round 9)"
NOJQ_BIN="${SCRATCH}/nojq-bin"
mkdir -p "$NOJQ_BIN"
_r9_missing=""
for _r9_tool in bash bun; do
	_r9_real="$(command -v "$_r9_tool" 2>/dev/null || true)"
	if [[ -n "$_r9_real" ]]; then
		ln -sf "$_r9_real" "${NOJQ_BIN}/${_r9_tool}"
	else
		_r9_missing="$_r9_tool"
	fi
done
ln -sf "${STUB_BIN}/curl-success" "${NOJQ_BIN}/curl"

if [[ -n "$_r9_missing" ]]; then
	echo "  SKIP: jq-less-but-bun-present mint test ('$_r9_missing' not found on this host)"
else
	OUT_NOJQ_BUN="$(env -i HOME="$HOME" PATH="$NOJQ_BIN" \
		bash -c '
			set -uo pipefail
			command -v jq >/dev/null 2>&1 && echo "FATAL: jq unexpectedly reachable in the jq-less fixture" >&2 && exit 1
			source "'"$LIB"'"
			catalyst_resolve_secret() {
				CATALYST_SECRET_LAST_VALUE="{\"clientId\":\"fake-r9-client-id\",\"clientSecret\":\"fake-r9-client-secret\"}"
			}
			linear_app_actor_auth "test-daemon" SCOPED_TARGET
			echo "SCOPED_TARGET=[${SCOPED_TARGET:-}]"
			echo "SCOPED_TARGET_SOURCE=[${SCOPED_TARGET_SOURCE:-}]"
		' 2>&1)"
	if echo "$OUT_NOJQ_BUN" | grep -qxF "SCOPED_TARGET=[fake-r6-fresh-mint-token]"; then
		pass "jq-less-but-bun-present: mint succeeds, SCOPED_TARGET set from the bun-parsed access_token"
	else
		fail "jq-less-but-bun-present: mint did not succeed via bun; output: $OUT_NOJQ_BUN"
	fi
	if echo "$OUT_NOJQ_BUN" | grep -qxF "SCOPED_TARGET_SOURCE=[minted]"; then
		pass "jq-less-but-bun-present: SCOPED_TARGET_SOURCE=minted"
	else
		fail "jq-less-but-bun-present: SCOPED_TARGET_SOURCE not marked minted; output: $OUT_NOJQ_BUN"
	fi
fi

echo ""
echo "no JSON parser available (jq/bun/node all absent): loud warning, mint stays impossible (CTL-1612 round 9)"
NONE_BIN="${SCRATCH}/none-bin"
mkdir -p "$NONE_BIN"
_r9b_bash="$(command -v bash 2>/dev/null || true)"
if [[ -z "$_r9b_bash" ]]; then
	fail "no-parser test: could not resolve bash itself for the restricted PATH fixture"
else
	ln -sf "$_r9b_bash" "${NONE_BIN}/bash"
	OUT_NONE="$(env -i HOME="$HOME" PATH="$NONE_BIN" \
		bash -c '
			set -uo pipefail
			source "'"$LIB"'"
			catalyst_resolve_secret() {
				CATALYST_SECRET_LAST_VALUE="{\"clientId\":\"fake-r9-client-id\",\"clientSecret\":\"fake-r9-client-secret\"}"
			}
			linear_app_actor_auth "test-daemon" SCOPED_TARGET
			echo "SCOPED_TARGET=[${SCOPED_TARGET:-}]"
		' 2>&1)"
	if echo "$OUT_NONE" | grep -q "WARNING no JSON parser available"; then
		pass "no-parser: logs the loud warning (jq/bun/node all absent)"
	else
		fail "no-parser: did not log the loud warning; output: $OUT_NONE"
	fi
	if echo "$OUT_NONE" | grep -qxF "SCOPED_TARGET=[]"; then
		pass "no-parser: SCOPED_TARGET stays unset (mint impossible without a JSON parser)"
	else
		fail "no-parser: SCOPED_TARGET unexpectedly set; output: $OUT_NONE"
	fi
fi

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
