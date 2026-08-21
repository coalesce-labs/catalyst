#!/usr/bin/env bash
# account-rotation-watch.test.sh — CTL-2145 Phase 2. The account-rotation actor is the
# durable CONSUMER the CTL-1653 account-status latch never had.
#
# WHAT THIS PINS. The 2026-08-21 outage had two halves. Phase 1 fixed WHERE the kit lived;
# this half fixes the fact that when the active Claude account got rate-walled, NOTHING was
# wired to notice. `account-status-latch.mjs` has emitted an edge-triggered
# `account.status.changed` since CTL-1653 and written a durable
# `~/catalyst/account-status-latch.json` marker — with zero consumers. This actor reads that
# marker on a StartInterval tick and rotates on a fresh `rejected` EDGE.
#
# EDGE, NOT LEVEL, is the load-bearing property. The latch stays `latched:true` for the whole
# episode, so an actor that acted on the LEVEL would rotate accounts on every single tick for
# as long as the wall lasted — a rotation restarts the whole stack, so that is an outage, not
# a recovery. Tests 1+2 are the pair that proves edge semantics: one fires, the immediate
# re-tick does not.
#
# POSITIVE-CONTROL DISCIPLINE (AGENTS.md). Most cases here assert a NO-ROTATION outcome, and a
# "did not rotate" that came from a broken harness is indistinguishable from a real refusal.
# So (a) test 1 is a present positive — the same harness, the same stub, a real rotation — and
# (b) every refusal path must also SAY why on stdout, asserted here, so a silent no-op cannot
# pass as a deliberate one.
#
# Everything is CATALYST_DIR-scoped and the switch verb is injected via ROTATION_SWITCH_CMD
# (a recording stub), so no test touches real SOPS, real launchd, the real ~/catalyst, or the
# real event log.
#
# Run: bash plugins/dev/scripts/coord/__tests__/account-rotation-watch.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ACTOR="${COORD_DIR}/account-rotation-watch.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

if [[ ! -x "$ACTOR" ]]; then
	echo "  FAIL: ${ACTOR} is missing or not executable — nothing to exercise"
	echo ""
	echo "== 0 passed, 1 failed =="
	exit 1
fi

# ─── fixtures ────────────────────────────────────────────────────────────────

# make_accounts_env DEST ACTIVE HANDLE... — the shape catalyst-stack's claude-account verb
# reads: CLAUDE_TOKEN_<handle> definition lines plus one _catalyst_active_token selector.
# Token values are fake; the actor must never read or echo them.
make_accounts_env() {
	local dest="$1" active="$2"; shift 2
	: >"$dest"
	local h
	for h in "$@"; do printf 'CLAUDE_TOKEN_%s="sk-ant-fake-%s"\n' "$h" "$h" >>"$dest"; done
	printf '_catalyst_active_token="$CLAUDE_TOKEN_%s"\n' "$active" >>"$dest"
}

# make_switch_stub DEST RECORD [EXIT] [ACCOUNTS_ENV] — a recording stand-in for
# `catalyst-stack claude-account switch`. Appends its argv to RECORD, one invocation per
# line, so the tests can assert BOTH the call count and the handle it was called with.
#
# The 4th argument is what makes it a REAL switch rather than a no-op one. The actual verb
# re-materializes claude-accounts.env with the new selector and verifies it; its documented
# already-active branch returns 0 without doing either. The actor no longer infers success
# from rc=0 alone, so a stub that merely exits 0 models the NO-OP branch. Passing the
# accounts env makes the stub move the selector the way a real switch does, which keeps the
# present positive (test 1) a genuine end-to-end rotation instead of an assertion relaxed to
# fit a stub. Omit it to model the no-op branch on purpose.
make_switch_stub() {
	local dest="$1" record="$2" rc="${3:-0}" accts="${4:-}"
	{
		printf '#!/usr/bin/env bash\n'
		printf 'STUB_RECORD=%q\n' "$record"
		printf 'STUB_ACCTS=%q\n' "$accts"
		printf 'STUB_RC=%q\n' "$rc"
		cat <<'STUB'
printf '%s\n' "$*" >>"$STUB_RECORD"
if [[ -n "$STUB_ACCTS" && "$STUB_RC" -eq 0 ]]; then
	for a in "$@"; do
		case "$a" in
			acct[0-9]*)
				sed -e "s|^_catalyst_active_token=.*|_catalyst_active_token=\"\$CLAUDE_TOKEN_${a}\"|" \
					"$STUB_ACCTS" >"${STUB_ACCTS}.tmp" && mv "${STUB_ACCTS}.tmp" "$STUB_ACCTS"
				break
				;;
		esac
	done
fi
exit "$STUB_RC"
STUB
	} >"$dest"
	chmod +x "$dest"
}

# write_latch DIR LATCHED TS — the {latched, ts} marker account-status-latch.mjs persists
# (persistLatchToDisk: JSON.stringify({latched, ts: Date.now()}), so ts is epoch MILLIS).
write_latch() {
	local dir="$1" latched="$2" ts="$3"
	mkdir -p "$dir"
	printf '{"latched":%s,"ts":%s}\n' "$latched" "$ts" >"$dir/account-status-latch.json"
}

# new_case NAME — a fresh CATALYST_DIR + accounts env + switch stub for one scenario.
# Sets CDIR / ACCTS / STUB / RECORD / COORD_RT as globals for the case body.
new_case() {
	CDIR="$SCRATCH/$1"
	ACCTS="$SCRATCH/$1.accounts.env"
	STUB="$SCRATCH/$1.switch-stub.sh"
	RECORD="$SCRATCH/$1.switch-calls"
	COORD_RT="$CDIR/comms/coord"
	mkdir -p "$COORD_RT"
	: >"$RECORD"
	make_accounts_env "$ACCTS" acct1 acct1 acct2 acct3
	make_switch_stub "$STUB" "$RECORD" 0 "$ACCTS"
}

# run_actor MODE — one tick, fully scoped. EVENTS dir is redirected per-case so the
# emitted events land in the scratch tree and never in the real ~/catalyst/events.
run_actor() {
	CATALYST_DIR="$CDIR" \
		CLAUDE_ACCOUNTS_ENV="$ACCTS" \
		CATALYST_ACCOUNT_ROTATION="$1" \
		ROTATION_SWITCH_CMD="$STUB" \
		bash "$ACTOR" 2>&1
}

# switch_calls — how many times the stub was invoked. NOT `grep -c . || echo 0`: on an
# EMPTY record grep prints "0" and exits 1, so the `||` fires and appends a SECOND "0",
# yielding "0\n0" — which compares unequal to "0" and fails every no-rotation assertion in
# this file while printing the reassuring text "rotated ...: 0". A miscounting harness that
# reports the right number in the wrong shape is worse than one that crashes.
switch_calls() { awk 'END{print NR}' <"$RECORD" 2>/dev/null; }
marker_value() { cat "$COORD_RT/.account-rotation-acted" 2>/dev/null || true; }
announce_value() { cat "$COORD_RT/.account-rotation-announced" 2>/dev/null || true; }
current_account() { cat "$COORD_RT/fleet-account.current" 2>/dev/null || true; }

NOW_MS=$(( $(date +%s) * 1000 ))

# ─── 1. fresh rejected edge in enforce → rotates exactly once ────────────────
# The present positive. Every "did not rotate" assertion below is only meaningful because
# this one proves the harness, the stub, and the wiring can produce a rotation at all.

echo "Test 1: a fresh rejected edge in enforce rotates exactly once"
new_case t1
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "exit 0"; else fail "expected exit 0, got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "1" ]]; then
	pass "called the switch verb exactly once"
else
	fail "expected exactly 1 switch call, got $(switch_calls) — $OUT"
fi
if grep -q 'acct2' "$RECORD" 2>/dev/null; then
	pass "switched to the next handle after the walled one (acct1 -> acct2)"
else
	fail "expected the switch call to name acct2, got: $(cat "$RECORD")"
fi
if grep -q -- '--yes' "$RECORD" 2>/dev/null; then
	pass "passed --yes (the verb prompts interactively without it; a launchd tick has no tty)"
else
	fail "switch was called without --yes — it would block on a prompt under launchd: $(cat "$RECORD")"
fi
if [[ "$(current_account)" == "acct2" ]]; then
	pass "wrote fleet-account.current=acct2 so lane-relaunch picks the matching launcher"
else
	fail "expected fleet-account.current=acct2, got '$(current_account)'"
fi
if [[ "$(marker_value)" == "$NOW_MS" ]]; then
	pass "advanced the acted-marker to the latch ts"
else
	fail "expected marker '$NOW_MS', got '$(marker_value)'"
fi

# ─── 2. same episode, second tick → no second rotation ───────────────────────
# EDGE, not level. This is the assertion that separates a rotation from an outage: the
# latch stays true for the whole wall, and a StartInterval agent re-reads it every tick.

echo "Test 2: a second tick on the SAME latched episode does not rotate again"
OUT="$(run_actor enforce)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "exit 0"; else fail "expected exit 0, got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "1" ]]; then
	pass "still exactly 1 switch call — level would have made a second"
else
	fail "expected the call count to stay at 1, got $(switch_calls) — $OUT"
fi
if grep -qi 'already acted\|already rotated' <<<"$OUT"; then
	pass "said WHY it declined (a silent no-op is indistinguishable from a broken tick)"
else
	fail "declined silently — expected an already-acted line: $OUT"
fi
# Idempotence across repeated ticks, not just the second one.
run_actor enforce >/dev/null 2>&1
run_actor enforce >/dev/null 2>&1
if [[ "$(switch_calls)" == "1" ]]; then
	pass "still 1 call after four total ticks (idempotent)"
else
	fail "repeated ticks rotated again: $(switch_calls) calls"
fi

# ─── 3. recovered latch → no rotation, and a LATER re-trip still fires ───────

echo "Test 3: latched:false is a no-op, and a later re-trip re-fires"
new_case t3
write_latch "$CDIR" false "$NOW_MS"
OUT="$(run_actor enforce)"
if [[ "$(switch_calls)" == "0" ]]; then
	pass "recovered latch did not rotate"
else
	fail "rotated on a recovered latch: $(switch_calls) calls — $OUT"
fi
if grep -qi 'not latched\|recovered\|no open episode' <<<"$OUT"; then
	pass "named the recovered state"
else
	fail "no-op was unexplained: $OUT"
fi
# The re-trip: a NEW episode with a strictly newer ts must rotate.
RETRIP_MS=$((NOW_MS + 60000))
write_latch "$CDIR" true "$RETRIP_MS"
OUT="$(run_actor enforce)"
if [[ "$(switch_calls)" == "1" ]]; then
	pass "a later re-trip rotated (the recovery did not permanently suppress the actor)"
else
	fail "expected the re-trip to rotate exactly once, got $(switch_calls) — $OUT"
fi

# ─── 4. shadow → logs the intent, mutates nothing ────────────────────────────

echo "Test 4: shadow logs a would-rotate and mutates nothing"
new_case t4
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor shadow)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "exit 0"; else fail "expected exit 0, got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "0" ]]; then
	pass "made no switch call"
else
	fail "shadow called the switch verb: $(cat "$RECORD")"
fi
if [[ -z "$(current_account)" ]]; then
	pass "did not write fleet-account.current"
else
	fail "shadow wrote fleet-account.current='$(current_account)'"
fi
if grep -qi 'would' <<<"$OUT" && grep -q 'acct2' <<<"$OUT"; then
	pass "logged the rotation it WOULD have made, naming the target handle"
else
	fail "shadow output does not describe the intended rotation: $OUT"
fi
# TWO markers, and this pair is the reason. Shadow must announce ONCE per edge (not once
# per tick for a multi-hour wall) while leaving the edge LIVE — an operator who reads the
# dry run and flips to enforce must still find something to act on. One marker cannot hold
# both; the ACT marker stays untouched and shadow advances its own ANNOUNCE marker.
#
# (The plan's Phase 2 sketch said "do NOT mutate; advance marker" for shadow, which is
# self-contradictory and, read literally as the act marker, disarms the flip-to-enforce it
# exists to justify. This is the deliberate deviation; the properties it wanted are both
# kept.)
if [[ -z "$(marker_value)" ]]; then
	pass "left the ACT marker untouched — the edge stays live for a later flip to enforce"
else
	fail "shadow consumed the edge (act marker='$(marker_value)') — flipping to enforce mid-wall would then do nothing"
fi
if [[ "$(announce_value)" == "$NOW_MS" ]]; then
	pass "advanced its own ANNOUNCE marker so the edge is announced once, not once per tick"
else
	fail "expected the announce marker to be '$NOW_MS', got '$(announce_value)'"
fi
OUT2="$(run_actor shadow)"
if grep -qi 'already acted\|already announced' <<<"$OUT2"; then
	pass "the second shadow tick is quiet about the same edge"
else
	fail "shadow re-announced the same edge: $OUT2"
fi
if grep -qi 'still LIVE\|still live' <<<"$OUT2"; then
	pass "and says the edge is still live (so the quiet tick is not read as 'handled')"
else
	fail "the quiet tick does not distinguish 'announced' from 'acted': $OUT2"
fi
# The property the announce marker must NOT cost: a flip to enforce mid-episode still acts.
OUT3="$(run_actor enforce)"
if [[ "$(switch_calls)" == "1" ]]; then
	pass "flipping to enforce after a shadow announcement still rotates the SAME edge"
else
	fail "shadow disarmed the flip to enforce: $(switch_calls) switch calls — $OUT3"
fi

# ─── 5. off → total no-op ────────────────────────────────────────────────────

echo "Test 5: off is a total no-op"
new_case t5
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor off)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "exit 0"; else fail "expected exit 0, got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "0" ]]; then pass "no switch call"; else fail "off rotated"; fi
if [[ -z "$(current_account)" ]]; then pass "no fleet-account.current write"; else fail "off wrote the pointer"; fi
if [[ -z "$(marker_value)" ]]; then
	pass "no marker write — off leaves the edge entirely unconsumed"
else
	fail "off advanced the marker to '$(marker_value)', silently eating the edge for a later enforce"
fi

# An unrecognized mode must degrade to shadow — never to enforce, and never to silence.
echo "Test 5b: an invalid mode degrades to shadow (not to enforce, not to silence)"
new_case t5b
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor bogus-mode)"
if [[ "$(switch_calls)" == "0" ]]; then
	pass "invalid mode did not rotate"
else
	fail "invalid mode rotated — it must not degrade toward action: $(cat "$RECORD")"
fi
if grep -qi 'would' <<<"$OUT"; then
	pass "invalid mode still reported the intent (degraded to shadow, not to silence)"
else
	fail "invalid mode went silent: $OUT"
fi
# The warning must NAME THE SOURCE it read. It used to hardcode the env var even when the
# bad value came from .catalyst/config.json, sending an operator to grep the one place the
# typo is not — in a design whose contract is that every declining path names itself, a
# mis-attributed decline is the same defect one level down.
if grep -q "env CATALYST_ACCOUNT_ROTATION" <<<"$OUT"; then
	pass "an env typo is attributed to the env var"
else
	fail "the env source was not named in the warning: $OUT"
fi
# The config half: same typo, different source, and the message must follow it.
CFGDIR="$SCRATCH/t5c-proj"
mkdir -p "$CFGDIR/.catalyst"
printf '{"catalyst":{"accountRotation":{"mode":"shdow"}}}\n' >"$CFGDIR/.catalyst/config.json"
OUT_CFG="$(cd "$CFGDIR" && CATALYST_DIR="$CDIR" CLAUDE_ACCOUNTS_ENV="$ACCTS" \
	ROTATION_SWITCH_CMD="$STUB" bash "$ACTOR" 2>&1)"
if grep -q 'config.json' <<<"$OUT_CFG"; then
	pass "a config typo is attributed to the config file it was read from"
else
	fail "config typo not attributed to config.json: $OUT_CFG"
fi
if grep -q "env CATALYST_ACCOUNT_ROTATION" <<<"$OUT_CFG"; then
	fail "a config typo is STILL blamed on the env var: $OUT_CFG"
else
	pass "a config typo is no longer blamed on the env var"
fi
if [[ "$(switch_calls)" == "0" ]]; then
	pass "config typo still degrades to shadow and does not rotate (behaviour unchanged)"
else
	fail "config typo rotated: $(cat "$RECORD")"
fi

# ─── 6. rolling-window cap ───────────────────────────────────────────────────

echo "Test 6: past the rolling-window cap it refuses even a fresh edge"
new_case t6
# Pre-seed the window with `cap` in-window attempts (the same one-epoch-per-line shape
# lane-relaunch.sh uses for its relaunch counter).
NOW_S=$(date +%s)
printf '%s\n%s\n%s\n' "$NOW_S" "$NOW_S" "$NOW_S" >"$COORD_RT/.rotations"
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "exit 0 (capped is a refusal, not a crash)"; else fail "got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "0" ]]; then
	pass "did not rotate while capped"
else
	fail "rotated past the cap: $(cat "$RECORD")"
fi
if grep -qi 'capped' <<<"$OUT"; then pass "logged CAPPED"; else fail "cap refusal was silent: $OUT"; fi
if [[ -z "$(marker_value)" ]]; then
	pass "left the marker unadvanced so the edge is retried once the window ages out"
else
	fail "capped tick consumed the edge (marker='$(marker_value)') — the wall would never be acted on"
fi
# Positive control for the cap itself: stale attempts age out of the window and the SAME
# fresh edge then rotates. Without this, a cap that always refused would pass the test above.
printf '%s\n%s\n%s\n' "$((NOW_S - 7200))" "$((NOW_S - 7200))" "$((NOW_S - 7200))" >"$COORD_RT/.rotations"
OUT="$(run_actor enforce)"
if [[ "$(switch_calls)" == "1" ]]; then
	pass "positive control: with the window aged out, the same edge rotates"
else
	fail "the cap refuses unconditionally — stale attempts did not age out: $(switch_calls) calls — $OUT"
fi

# ─── 7. latch absent / malformed → inconclusive, never a rotation ────────────

echo "Test 7: an absent or unreadable latch is INCONCLUSIVE, never a rotation"
new_case t7
OUT="$(run_actor enforce)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "absent latch: exit 0"; else fail "absent latch: got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "0" ]]; then pass "absent latch: no rotation"; else fail "rotated with no latch"; fi
if grep -qi 'inconclusive' <<<"$OUT"; then
	pass "absent latch: reported INCONCLUSIVE (could-not-look, distinct from all-clear)"
else
	fail "absent latch: reported neither a rotation nor an inconclusive: $OUT"
fi
printf '{"latched":tr' >"$CDIR/account-status-latch.json"
OUT="$(run_actor enforce)"
if [[ "$(switch_calls)" == "0" ]]; then pass "malformed latch: no rotation"; else fail "rotated on malformed latch"; fi
if grep -qi 'inconclusive' <<<"$OUT"; then
	pass "malformed latch: reported INCONCLUSIVE"
else
	fail "malformed latch was not called out: $OUT"
fi

# ─── 8. no alternative handle → inconclusive no-op ───────────────────────────

echo "Test 8: with only the walled handle provisioned it refuses, loudly"
new_case t8
make_accounts_env "$ACCTS" acct1 acct1
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"; RC=$?
if [[ $RC -eq 0 ]]; then pass "exit 0"; else fail "got $RC — $OUT"; fi
if [[ "$(switch_calls)" == "0" ]]; then
	pass "did not rotate to the walled account itself"
else
	fail "rotated with no alternative handle: $(cat "$RECORD")"
fi
if grep -qi 'inconclusive\|no alternative\|only.*handle' <<<"$OUT"; then
	pass "named the reason (a real wall with nowhere to go is an operator problem, not a clean tick)"
else
	fail "refusal was unexplained: $OUT"
fi

# ─── 9. round-robin selection ────────────────────────────────────────────────

echo "Test 9: next-handle selection is round-robin after the active handle"
new_case t9
make_accounts_env "$ACCTS" acct2 acct1 acct2 acct3
write_latch "$CDIR" true "$NOW_MS"
run_actor enforce >/dev/null 2>&1
if grep -q 'acct3' "$RECORD" 2>/dev/null; then
	pass "walled acct2 -> acct3 (the NEXT handle, not the first in the file)"
else
	fail "expected acct3, got: $(cat "$RECORD")"
fi

echo "Test 9b: selection wraps around the end of the handle list"
new_case t9b
make_accounts_env "$ACCTS" acct3 acct1 acct2 acct3
write_latch "$CDIR" true "$NOW_MS"
run_actor enforce >/dev/null 2>&1
if grep -q 'acct1' "$RECORD" 2>/dev/null; then
	pass "walled acct3 wrapped to acct1"
else
	fail "expected the selection to wrap to acct1, got: $(cat "$RECORD")"
fi

# ─── 10. a failing switch must not consume the edge ──────────────────────────
# The never-lose direction, mirroring account-status-latch.mjs's own emit-then-advance:
# a transient failure re-attempts the SAME edge next tick rather than swallowing a real
# wall. The rolling-window cap is what bounds that retry.

echo "Test 10: a failing switch leaves the edge unconsumed (bounded by the cap)"
new_case t10
make_switch_stub "$STUB" "$RECORD" 1
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"
if [[ "$(switch_calls)" == "1" ]]; then pass "attempted the switch"; else fail "no attempt made — $OUT"; fi
if [[ -z "$(marker_value)" ]]; then
	pass "did not advance the marker on a failed switch"
else
	fail "a failed switch consumed the edge (marker='$(marker_value)')"
fi
if [[ -z "$(current_account)" ]]; then
	pass "did not write fleet-account.current for a rotation that did not happen"
else
	fail "wrote fleet-account.current='$(current_account)' after a FAILED switch — the two pointers now disagree"
fi
if grep -qi 'fail' <<<"$OUT"; then pass "logged the failure"; else fail "failure was silent: $OUT"; fi
OUT="$(run_actor enforce)"
if [[ "$(switch_calls)" == "2" ]]; then
	pass "retried the same edge on the next tick"
else
	fail "expected a retry (2 calls), got $(switch_calls)"
fi

# ─── 11. events ──────────────────────────────────────────────────────────────
# The actor is the only thing that knows a rotation happened; if it emits nothing, the
# fleet's own event log cannot answer "did we rotate, and when".

echo "Test 11: emits account.rotation.* to the event log"
new_case t11
write_latch "$CDIR" true "$NOW_MS"
run_actor enforce >/dev/null 2>&1
EVENTS="$(cat "$CDIR"/events/*.jsonl 2>/dev/null || true)"
if grep -q 'account.rotation.switched' <<<"$EVENTS"; then
	pass "enforce emitted account.rotation.switched"
else
	fail "no account.rotation.switched event: ${EVENTS:-<no events written>}"
fi
new_case t11b
write_latch "$CDIR" true "$NOW_MS"
run_actor shadow >/dev/null 2>&1
EVENTS="$(cat "$CDIR"/events/*.jsonl 2>/dev/null || true)"
if grep -q 'account.rotation.would-switch' <<<"$EVENTS"; then
	pass "shadow emitted account.rotation.would-switch"
else
	fail "no account.rotation.would-switch event: ${EVENTS:-<no events written>}"
fi
if grep -q 'account.rotation.switched' <<<"$EVENTS"; then
	fail "shadow emitted the ACTED event name — an alert cannot tell a real rotation from a dry run"
else
	pass "shadow did not emit the acted event name"
fi

# ─── 12. self-limiting: the actor is a one-shot tick, not a loop ─────────────
# D2's whole point. The zombie that survived the incident was an unbounded `while :` loop
# with no self-deadline; a StartInterval agent must exit every tick or it becomes the same
# thing under a new label.

echo "Test 12: the actor is a one-shot — it contains no unbounded poll loop"
if /usr/bin/grep -nE '^[[:space:]]*while[[:space:]]+(:|true)' "$ACTOR" >/dev/null 2>&1; then
	fail "the actor contains an unbounded 'while :' loop — that is the zombie shape this replaces"
else
	pass "no unbounded poll loop (StartInterval supervises the cadence)"
fi
# Positive control: the probe DOES fire on the watchdog, which legitimately has one.
if /usr/bin/grep -nE '^[[:space:]]*while[[:space:]]+(:|true)' "${COORD_DIR}/lane-relaunch.sh" >/dev/null 2>&1; then
	pass "positive control: the same probe finds lane-relaunch.sh's loop"
else
	fail "positive control FAILED — the loop probe cannot fire, so test 12's pass means nothing"
fi

# ─── 13. secrets hygiene ─────────────────────────────────────────────────────

echo "Test 13: no token VALUE reaches stdout or any file the actor writes"
new_case t13
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"
LEAK=0
grep -q 'sk-ant-fake' <<<"$OUT" && LEAK=1
grep -rq 'sk-ant-fake' "$COORD_RT" "$CDIR/events" 2>/dev/null && LEAK=1
if [[ $LEAK -eq 0 ]]; then
	pass "no token value in the log, the marker files, or the event log"
else
	fail "a token VALUE leaked out of the actor"
fi
# Positive control: the probe can see a token value when one is really present.
if grep -q 'sk-ant-fake' "$ACCTS"; then
	pass "positive control: the leak probe matches a real token value in the fixture"
else
	fail "positive control FAILED — the leak probe cannot match, so test 13 proves nothing"
fi

# ─── 14. rc=0 is not proof: the verb's already-active NO-OP branch ───────────
#
# `catalyst-stack claude-account switch` returns 0 when the target is ALREADY active,
# logging "nothing to do" without touching the selector. The actor and the verb can
# genuinely disagree about who is active — the actor parses the LOCAL claude-accounts.env
# selector while the verb parses one freshly pulled from the CLUSTER repo, and the local
# copy goes stale the moment any other node switches. On divergence NEXT is the handle the
# cluster already considers active, so the verb no-ops.
#
# Inferring success from rc alone is the worst available failure here: `latched:true` is a
# LEVEL held for the whole episode, so consuming the edge means no further attempt until
# the account recovers on its own. The actor's one job would silently not happen during
# the exact incident it exists for, while logging a completed rotation.

echo "Test 14: a switch that exits 0 WITHOUT moving the selector is not a rotation"
new_case t14
# The no-op stub: rc=0, selector untouched (4th arg omitted on purpose).
make_switch_stub "$STUB" "$RECORD" 0 ""
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"; RC=$?
if [[ "$(switch_calls)" == "1" ]]; then
	pass "the verb was actually called (so this case exercises the post-switch check)"
else
	fail "expected 1 switch call, got $(switch_calls) — $OUT"
fi
if [[ -z "$(marker_value)" ]]; then
	pass "acted-marker NOT advanced — the rejected edge stays live for the next tick"
else
	fail "marker advanced to '$(marker_value)' on a rotation that did not happen"
fi
if [[ -z "$(current_account)" ]]; then
	pass "fleet-account.current NOT written — the two pointers cannot disagree"
else
	fail "wrote fleet-account.current='$(current_account)' for a rotation that did not happen"
fi
if grep -qi 'INCONCLUSIVE' <<<"$OUT"; then
	pass "reported INCONCLUSIVE rather than a completed rotation"
else
	fail "did not report INCONCLUSIVE: $OUT"
fi
if grep -qi 'rotated acct1 -> acct2' <<<"$OUT"; then
	fail "logged a completed rotation that never happened: $OUT"
else
	pass "did NOT log 'rotated acct1 -> acct2'"
fi
if [[ $RC -ne 0 ]]; then
	pass "exited non-zero so the tick is not recorded as a success"
else
	fail "exited 0 on an unverified switch"
fi
EVENTS="$(cat "$CDIR"/events/*.jsonl 2>/dev/null || true)"
if grep -q 'account.rotation.unverified' <<<"$EVENTS"; then
	pass "emitted the DISTINCT account.rotation.unverified event"
else
	fail "no account.rotation.unverified event: ${EVENTS:-<no events written>}"
fi
if grep -q 'account.rotation.switched' <<<"$EVENTS"; then
	fail "emitted account.rotation.switched — downstream reads that as a completed rotation"
else
	pass "did NOT emit account.rotation.switched"
fi
# Positive control: the SAME case with a real switch stub must rotate, so the seven
# refusals above are evidence of the no-op branch and not of a broken t14 fixture.
new_case t14b
write_latch "$CDIR" true "$NOW_MS"
OUT="$(run_actor enforce)"
if [[ "$(marker_value)" == "$NOW_MS" && "$(current_account)" == "acct2" ]]; then
	pass "positive control: an identical case with a REAL switch stub does rotate"
else
	fail "positive control FAILED — marker '$(marker_value)', current '$(current_account)': test 14 proves nothing"
fi

# ─── 15. the launchd environment, reproduced ─────────────────────────────────
#
# The HIGH finding. The actor's default verb is resolved through PATH, and launchd hands a
# job only its built-in /usr/bin:/bin:/usr/sbin:/sbin unless the plist declares one. Every
# other way of running this actor — an operator shell, the smoke test in the plist's own
# comment block, this suite's ROTATION_SWITCH_CMD injection — inherits a usable PATH and
# passes. So the bug is only constructible by reproducing launchd's environment, which is
# what this case does: no ROTATION_SWITCH_CMD override, PATH set to launchd's built-in.

echo "Test 15: the PATH the installer bakes is what makes the verb resolvable"
new_case t15
write_latch "$CDIR" true "$NOW_MS"
FAKE_BIN="$SCRATCH/t15-catalyst-bin"
mkdir -p "$FAKE_BIN"
# A catalyst-stack that behaves like the real verb (moves the selector) so a resolvable
# PATH produces a real rotation rather than merely a different failure.
make_switch_stub "$FAKE_BIN/catalyst-stack" "$RECORD" 0 "$ACCTS"

# (a) NEGATIVE CONTROL — launchd's built-in PATH, no override. This must reproduce the
#     127 the finding measured; if it does not, (b) below proves nothing.
OUT_A="$(env -i HOME="$SCRATCH" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
	CATALYST_DIR="$CDIR" CLAUDE_ACCOUNTS_ENV="$ACCTS" CATALYST_ACCOUNT_ROTATION=enforce \
	/bin/bash "$ACTOR" 2>&1)"
# The strictness of this control is CONDITIONAL, and deliberately so. It is only a
# negative control where the verb really is unresolvable — on a host that happens to
# ship catalyst-stack in /usr/bin there is nothing to reproduce, and a branch that
# passes either way is a check that cannot fail. So: resolve first, then either assert
# strictly or declare the control inconclusive (counted as neither pass nor fail).
if env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin command -v catalyst-stack >/dev/null 2>&1; then
	echo "  INCONCLUSIVE: catalyst-stack IS on launchd's built-in PATH on this host — the negative control cannot run here (part b below still asserts strictly)"
elif grep -q 'rc=127' <<<"$OUT_A"; then
	pass "negative control: launchd's built-in PATH reproduces the rc=127 (verb unresolvable)"
else
	fail "negative control did NOT reproduce rc=127 though catalyst-stack is unresolvable under the built-in PATH: $OUT_A"
fi
if [[ -z "$(marker_value)" ]]; then
	pass "an unresolvable verb advances NO marker (the edge stays live)"
else
	fail "marker advanced to '$(marker_value)' though the verb could not run"
fi

# (b) THE FIX — the same tick with the dir the installer bakes into PATH prepended.
#     Nothing else differs, so a rotation here is attributable to the PATH alone.
OUT_B="$(env -i HOME="$SCRATCH" PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
	CATALYST_DIR="$CDIR" CLAUDE_ACCOUNTS_ENV="$ACCTS" CATALYST_ACCOUNT_ROTATION=enforce \
	/bin/bash "$ACTOR" 2>&1)"
if grep -q 'rc=127' <<<"$OUT_B"; then
	fail "still rc=127 with catalyst-stack on PATH: $OUT_B"
else
	pass "with catalyst-stack on PATH the verb resolves (no rc=127)"
fi
if [[ "$(marker_value)" == "$NOW_MS" && "$(current_account)" == "acct2" ]]; then
	pass "the rotation completed — the ONLY difference from (a) is the PATH"
else
	fail "expected a completed rotation, marker '$(marker_value)' current '$(current_account)': $OUT_B"
fi

# ─── 16. an unwritable COMMS_DIR must not disarm the cap ─────────────────────
#
# The HIGH finding. The circuit breaker's counter ($ROTATIONS) and the act-marker live in
# the SAME directory, so ONE unwritable dir takes out both at once — and the two failures
# compound instead of cancelling. cw_count_in_window reads a missing counter as 0, so
# `COUNT >= CAP` is never true and no tick is ever CAPPED; the marker write fails too, so
# the edge is never consumed. The pre-fix actor called cw_record_attempt un-checked under
# `set -uo pipefail` (no -e), so the failed append changed nothing and it rotated ANYWAY —
# every tick, indefinitely, each one a real SOPS selector flip + push to the cluster
# secrets repo + stack restart. The actor's own marker-write warning names the cap as the
# bound on that retry ("bounded by the cap"), which is precisely the bound that does not
# exist in this state.
#
# The assertion that matters is that the switch stub was NEVER invoked. Counting CAPPED
# lines would pass VACUOUSLY here — the unwritable run produces none either way, because
# never reaching the cap is the whole defect.

echo "Test 16: an unwritable COMMS_DIR refuses to rotate instead of rotating uncapped"
new_case t16
write_latch "$CDIR" true "$NOW_MS"
chmod 555 "$COORD_RT" 2>/dev/null || true

# Verify the INSTRUMENT before trusting what it measures: assert the directory really did
# become unwritable to THIS process. A mode change silently ignored (running as root, an
# ACL, a filesystem that does not honour the bits) would leave a perfectly writable dir, and
# the refusal assertions below would then be measuring nothing at all. Tested by probing the
# dir rather than by checking the uid, so every one of those causes is caught, not just root.
if touch "$COORD_RT/.writability-probe" 2>/dev/null; then
	rm -f "$COORD_RT/.writability-probe" 2>/dev/null || true
	echo "  INCONCLUSIVE: chmod 555 did not make ${COORD_RT} unwritable to this process (root? ACL?) — the unwritable-dir case cannot run here"
	chmod 755 "$COORD_RT" 2>/dev/null || true
else
	OUT="$(run_actor enforce)"; RC=$?
	# THE assertion. Everything else in this case is corroboration.
	if [[ "$(switch_calls)" == "0" ]]; then
		pass "did NOT invoke the switch verb when the attempt could not be recorded"
	else
		fail "rotated with a disarmed breaker: $(switch_calls) call(s) — $(cat "$RECORD")"
	fi
	if [[ $RC -ne 0 ]]; then
		pass "exited non-zero (a breaker that cannot record is a hard refusal, not a quiet skip)"
	else
		fail "exited 0 — an unusable circuit breaker read as a normal tick: $OUT"
	fi
	if grep -qi 'circuit breaker' <<<"$OUT"; then
		pass "named the decline (a bare 'Permission denied' on stderr is not a named decline)"
	else
		fail "refused without naming the circuit breaker: $OUT"
	fi
	if [[ -z "$(marker_value)" ]]; then
		pass "left the marker unadvanced so the edge stays live for a tick that can persist"
	else
		fail "consumed the edge (marker='$(marker_value)') despite refusing to rotate"
	fi
	# Restore BEFORE the positive control (and before the EXIT trap's rm -rf, which cannot
	# unlink through a 555 directory).
	chmod 755 "$COORD_RT" 2>/dev/null || true

	# POSITIVE CONTROL — the identical case with the dir writable again. Without it, an actor
	# that refused to rotate for any other reason (or a broken t16 fixture) would pass every
	# assertion above while proving nothing about the breaker.
	OUT="$(run_actor enforce)"
	if [[ "$(switch_calls)" == "1" && "$(marker_value)" == "$NOW_MS" ]]; then
		pass "positive control: the SAME edge rotates once the dir is writable — the refusal was the breaker, not the fixture"
	else
		fail "positive control FAILED — $(switch_calls) call(s), marker '$(marker_value)': test 16 proves nothing — $OUT"
	fi
fi
chmod 755 "$COORD_RT" 2>/dev/null || true

# ─── 17. an already-active no-op picks a DIFFERENT target next tick ──────────
#
# The CTL-2145 loop this closes (Codex #3867 P1). Another node switched since this host
# last materialized claude-accounts.env, so the LOCAL selector still reads acct1 while the
# cluster already holds the rejected acct2. The actor picks acct2, the verb's already-active
# branch returns 0 without re-materializing anything, and the rc=0-is-not-proof check
# correctly refuses to claim a rotation — but every INPUT to the selection is unchanged, so
# the old code recomputed acct2 on the next tick, and the next, until the hourly cap was
# spent. acct3 was never tried during the outage the actor exists for.
#
# The no-op branch is modelled by make_switch_stub WITHOUT its 4th argument: it exits 0 and
# leaves the selector alone, exactly as the real verb's already-active branch does.

echo "Test 17: after an already-active no-op the NEXT tick tries a different candidate"
new_case t17
make_switch_stub "$STUB" "$RECORD" 0            # no accounts env => models the no-op branch
write_latch "$CDIR" true "$NOW_MS"
# Raise the cap above the handle count so the cap can never be what stops the walk — the
# candidate ledger has to be the thing doing the work, or this test proves nothing.
ROTATION_HOURLY_CAP=9 run_actor enforce >/dev/null 2>&1
FIRST="$(tr ' ' '\n' <"$RECORD" | grep -m1 -E '^acct[0-9]+$' || true)"
ROTATION_HOURLY_CAP=9 run_actor enforce >/dev/null 2>&1
SECOND="$(tr ' ' '\n' <"$RECORD" | grep -E '^acct[0-9]+$' | sed -n 2p || true)"
if [[ "$FIRST" == "acct2" ]]; then
	pass "first tick targeted acct2 (the handle after the walled acct1)"
else
	fail "expected the first tick to target acct2, got '${FIRST}' — $(cat "$RECORD")"
fi
if [[ -n "$SECOND" && "$SECOND" != "$FIRST" ]]; then
	pass "second tick targeted a DIFFERENT candidate (${FIRST} -> ${SECOND}) instead of re-picking the dead one"
else
	fail "second tick re-picked '${SECOND}' after '${FIRST}' — the cap would be spent on one dead candidate: $(cat "$RECORD")"
fi
if [[ "$SECOND" == "acct3" ]]; then
	pass "and it is acct3 — the walk continues in file order rather than restarting"
else
	fail "expected acct3 on the second tick, got '${SECOND}'"
fi
if [[ -s "$COORD_RT/.account-rotation-tried" ]]; then
	pass "recorded the attempted-and-not-taken candidates in the per-episode ledger"
else
	fail "no per-episode candidate ledger was written — nothing would survive to the next tick"
fi
if [[ -z "$(marker_value)" ]]; then
	pass "consumed NO edge while walking (markers unadvanced, as an unverified switch requires)"
else
	fail "advanced the acted-marker (='$(marker_value)') on an unverified switch"
fi

# ─── 18. every candidate exhausted → says so and stops, WITHOUT rotating ─────
#
# The walk has to terminate. With acct2 and acct3 both attempted and neither taking, there
# is no third option, and the actor must say that in those words rather than silently
# re-picking or spinning. Note the count: exactly 2 switch calls for 3 handles — one per
# non-walled candidate, never a repeat.

echo "Test 18: with every candidate attempted the actor names the exhaustion and stops"
OUT="$(ROTATION_HOURLY_CAP=9 run_actor enforce)"; RC=$?
if [[ "$(switch_calls)" == "2" ]]; then
	pass "the third tick invoked the verb 0 more times (2 total = one per non-walled candidate)"
else
	fail "expected 2 total switch calls across the whole episode, got $(switch_calls) — $(cat "$RECORD")"
fi
if grep -qi 'every candidate has already been attempted' <<<"$OUT"; then
	pass "named the exhaustion (a silent no-op would be indistinguishable from a healthy tick)"
else
	fail "exhausted the candidates without saying so: $OUT"
fi
if [[ $RC -eq 0 ]]; then
	pass "exit 0 — exhaustion is a reported dead end, not a crash"
else
	fail "expected exit 0 on exhaustion, got $RC — $OUT"
fi
if [[ -z "$(marker_value)" ]]; then
	pass "left the edge live, so a later tick still acts if the active handle changes"
else
	fail "consumed the edge on exhaustion (marker='$(marker_value)')"
fi

# POSITIVE CONTROL — the ledger is EPISODE-scoped, not permanent. A newer latch ts is a new
# outage, and every handle is a first-class candidate again. Without this, test 18 would pass
# just as well if the actor had simply stopped rotating forever.
echo "Test 18b: positive control — a NEW episode re-arms every candidate"
NEWER_MS=$((NOW_MS + 60000))
write_latch "$CDIR" true "$NEWER_MS"
make_switch_stub "$STUB" "$RECORD" 0 "$ACCTS"   # a REAL switch again
OUT="$(ROTATION_HOURLY_CAP=9 run_actor enforce)"
if [[ "$(switch_calls)" == "3" && "$(current_account)" == "acct2" ]]; then
	pass "positive control: the new episode rotated to acct2 again — the ledger expired with the old episode"
else
	fail "positive control FAILED — $(switch_calls) call(s), current '$(current_account)': tests 17/18 prove nothing — $OUT"
fi

# ─── 19. an UNREADABLE counter refuses to rotate (read side of the breaker) ──
#
# cw_record_attempt's unwritable case is test 16; this is its read-side twin. A counter that
# cannot be inspected is "could not look", and reporting that as 0 attempts would leave the
# cap permanently clear while the actuator stayed fully live — the one direction a circuit
# breaker must not fail in. The script runs under `set -uo pipefail` with no `-e`, so an
# unchecked assignment would leave COUNT empty and `[[ "" -ge N ]]` reads the empty string
# as 0: the failure is silent by default, which is why it is pinned here.

echo "Test 19: an unreadable rotation counter refuses to rotate instead of reading as 0"
new_case t19
write_latch "$CDIR" true "$NOW_MS"
printf '%s\n' "$(date +%s)" >"$COORD_RT/.rotations"
chmod 200 "$COORD_RT/.rotations" 2>/dev/null || true
if [[ -r "$COORD_RT/.rotations" ]]; then
	echo "  INCONCLUSIVE: chmod 200 did not make the counter unreadable to this process (root? ACL?) — the unreadable-counter case cannot run here"
	chmod 644 "$COORD_RT/.rotations" 2>/dev/null || true
else
	OUT="$(run_actor enforce)"; RC=$?
	if [[ "$(switch_calls)" == "0" ]]; then
		pass "did NOT invoke the switch verb when the cap could not be read"
	else
		fail "rotated with an unreadable breaker: $(switch_calls) call(s) — $(cat "$RECORD")"
	fi
	if [[ $RC -ne 0 ]]; then
		pass "exited non-zero (an uninspectable breaker is a hard refusal, not a quiet skip)"
	else
		fail "exited 0 — an unreadable cap read as a normal tick: $OUT"
	fi
	if grep -qi 'circuit breaker' <<<"$OUT"; then
		pass "named the decline rather than dying on a bare permission error"
	else
		fail "refused without naming the circuit breaker: $OUT"
	fi
	chmod 644 "$COORD_RT/.rotations" 2>/dev/null || true

	# POSITIVE CONTROL — same fixture, counter readable again.
	OUT="$(run_actor enforce)"
	if [[ "$(switch_calls)" == "1" ]]; then
		pass "positive control: the SAME edge rotates once the counter is readable — the refusal was the breaker, not the fixture"
	else
		fail "positive control FAILED — $(switch_calls) call(s): test 19 proves nothing — $OUT"
	fi
fi

echo ""
echo "== ${PASSES} passed, ${FAILURES} failed =="
[[ $FAILURES -eq 0 ]]
