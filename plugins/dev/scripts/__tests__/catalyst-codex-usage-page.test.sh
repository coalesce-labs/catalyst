#!/usr/bin/env bash
# catalyst-codex-usage-page.test.sh — CTL-2072, the paging half.
#
# The property under test is NOT "does it page at 80%". It is that every way of
# being unable to see Codex quota renders as UNOBSERVABLE and pages through the
# SAME sinks, never as "under threshold". A pager whose input goes dark and says
# nothing is worse than no pager.
#
# ⛔ The specific false-clean this file exists to prevent: `[].every(p)` is true,
# so a payload with ZERO accounts trivially satisfies "no window over threshold"
# and would report all-clear having read nothing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../catalyst-codex-usage-page.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

# ── a fake usage source ─────────────────────────────────────────────────────
# Prints whatever CX_PAYLOAD holds. Stands in for codex-accounts-usage.mjs so no
# real codex app-server is ever spawned.
FAKE_SRC="$SCRATCH/fake-usage.mjs"
cat >"$FAKE_SRC" <<'EOF'
#!/usr/bin/env node
process.stdout.write(process.env.CX_PAYLOAD || "");
process.exit(Number(process.env.CX_RC || 0));
EOF
chmod +x "$FAKE_SRC"

mkpayload() { # mkpayload <handle> <status> <codexPct> <sparkPct>
	local handle="$1" status="$2" weekly="$3" five="$4"
	cat <<EOF
{"generatedAt":"2026-08-22T00:00:00Z","host":"testhost",
 "selector":{"kind":"symlink","activeHandle":"$handle"},
 "accounts":[{"label":"$handle","isActive":true,"email":"a@b.c","planType":"pro",
   "accountType":"chatgpt","status":"$status","reason":null,
   "binding":{"limitId":"codex","label":"weekly","usedPercent":$weekly,"resetsAt":1788049009},
   "buckets":[
     {"limitId":"codex","limitName":null,"windows":[{"label":"weekly","usedPercent":$weekly,"resetsAt":1788049009}]},
     {"limitId":"codex_bengalfox","limitName":"GPT-5.3-Codex-Spark","windows":[{"label":"5h","usedPercent":$five,"resetsAt":1787463418}]}
   ]}]}
EOF
}

# A weekly-ONLY account — the measured live shape of the `codex` bucket.
mkpayload_weekly_only() { # <handle> <weeklyPct>
	cat <<EOF
{"selector":{"kind":"symlink","activeHandle":"$1"},
 "accounts":[{"label":"$1","isActive":true,"email":"a@b.c","planType":"pro","accountType":"chatgpt",
   "status":"ok","reason":null,
   "binding":{"limitId":"codex","label":"weekly","usedPercent":$2,"resetsAt":1788049009},
   "buckets":[{"limitId":"codex","limitName":null,"windows":[{"label":"weekly","usedPercent":$2,"resetsAt":1788049009}]}]}]}
EOF
}

STATE="$SCRATCH/state"
CHANNELS="$SCRATCH/channels"
mkdir -p "$CHANNELS"
printf '# demo\n' >"$CHANNELS/demo.md"

run() { # run [args...]  — payload comes from $PAYLOAD
	CX_PAYLOAD="${PAYLOAD:-}" CX_RC="${RC:-0}" \
		CATALYST_CODEX_USAGE_SOURCE="${SRC_OVERRIDE:-$FAKE_SRC}" \
		CATALYST_CODEX_USAGE_PAGE_STATE="$STATE" \
		CATALYST_MD_CHANNELS="$CHANNELS" \
		CATALYST_CODEX_USAGE_CHANNEL="demo" \
		CATALYST_LINEAR_REPLY="" \
		CATALYST_CODEX_USAGE_TICKET="" \
		bash "$SUBJECT" "$@" 2>&1
}

reset_state() { rm -f "$STATE"; printf '# demo\n' >"$CHANNELS/demo.md"; }

echo ""
echo "=== threshold crossing ==="
reset_state
PAYLOAD="$(mkpayload acct1 ok 92 3)"
OUT="$(run --threshold 80)"
RC=$?
grep -qi 'paged' <<<"$OUT" && pass "pages when the binding window is at/over threshold" || fail "pages at threshold" "$OUT"
grep -q 'weekly' "$CHANNELS/demo.md" && pass "the page names the window honestly (weekly)" || fail "page names the window" "$(cat "$CHANNELS/demo.md")"
grep -q '92' "$CHANNELS/demo.md" && pass "the page carries the percentage" || fail "page carries percentage" "$(cat "$CHANNELS/demo.md")"

reset_state
PAYLOAD="$(mkpayload acct1 ok 30 5)"
OUT="$(run --threshold 80)"
grep -qi 'no window at or above' <<<"$OUT" && pass "does not page under threshold" || fail "no page under threshold" "$OUT"

# ⛔ The ticket's clause: a weekly-only account must page as "weekly", never as
# "5-hour". The naive positional port of the Claude shape would mislabel it.
reset_state
PAYLOAD="$(mkpayload_weekly_only acct1 95)"
OUT="$(run --threshold 80)"
if grep -q 'weekly' "$CHANNELS/demo.md" && ! grep -qiE '5-hour|5h' "$CHANNELS/demo.md"; then
	pass "a weekly-only account pages as weekly, and never mentions a 5h window"
else
	fail "weekly-only naming" "$(cat "$CHANNELS/demo.md")"
fi

# A per-window page: both windows over threshold must both be named.
reset_state
PAYLOAD="$(mkpayload acct1 ok 92 88)"
OUT="$(run --threshold 80)"
if grep -q 'weekly' "$CHANNELS/demo.md" && grep -q '5h' "$CHANNELS/demo.md"; then
	pass "pages per-window when several cross"
else
	fail "per-window paging" "$(cat "$CHANNELS/demo.md")"
fi

echo ""
echo "=== edge-trigger / dedup ==="
reset_state
PAYLOAD="$(mkpayload acct1 ok 92 3)"
run --threshold 80 >/dev/null
OUT="$(run --threshold 80)"
grep -qi 'already paged' <<<"$OUT" && pass "a sustained breach pages once, not every run" || fail "dedup" "$OUT"

reset_state
PAYLOAD="$(mkpayload acct1 ok 92 3)"; run --threshold 80 >/dev/null
PAYLOAD="$(mkpayload acct1 ok 10 3)"; run --threshold 80 >/dev/null   # recovers
PAYLOAD="$(mkpayload acct1 ok 93 3)"; OUT="$(run --threshold 80)"     # re-crosses
grep -qi 'paged 1' <<<"$OUT" && pass "a recovered then re-crossed window pages again" || fail "re-cross" "$OUT"

# ⛔ A page nobody accepted must NOT be recorded, or the retry is lost.
reset_state
rm -f "$CHANNELS/demo.md"   # no sink will accept
PAYLOAD="$(mkpayload acct1 ok 92 3)"
OUT="$(run --threshold 80)"
RC1=$?
printf '# demo\n' >"$CHANNELS/demo.md"   # sink returns
OUT2="$(run --threshold 80)"
if grep -qi 'NO SINK ACCEPTED' <<<"$OUT" && grep -q '92' "$CHANNELS/demo.md"; then
	pass "a failed delivery is not recorded — the next run retries and lands"
else
	fail "failed delivery retries" "first=$OUT" "second=$OUT2"
fi

echo ""
echo "=== UNOBSERVABLE is itself a page ==="
reset_state
SRC_OVERRIDE="$SCRATCH/no-such-source.mjs"
OUT="$(run --threshold 80)"
RC=$?
unset SRC_OVERRIDE
if [ "$RC" -eq 3 ] && grep -qi 'UNOBSERVABLE' <<<"$OUT" && grep -qi 'DARK' "$CHANNELS/demo.md"; then
	pass "a missing usage source pages DARK through the real sinks"
else
	fail "missing source pages dark" "rc=$RC" "$OUT" "chan=$(cat "$CHANNELS/demo.md")"
fi

reset_state
PAYLOAD='this is not json {{{'
OUT="$(run --threshold 80)"
RC=$?
if [ "$RC" -eq 3 ] && grep -qi 'DARK' "$CHANNELS/demo.md"; then
	pass "an unparseable payload pages DARK"
else
	fail "unparseable pages dark" "rc=$RC" "$OUT"
fi

reset_state
PAYLOAD='{"selector":{"activeHandle":null},"accounts":[]}'
OUT="$(run --threshold 80)"
RC=$?
if [ "$RC" -eq 3 ] && grep -qi 'DARK' "$CHANNELS/demo.md"; then
	pass "a payload with zero accounts pages DARK"
else
	fail "zero accounts pages dark" "rc=$RC" "$OUT"
fi

# ⛔ The false-clean this rule exists to prevent: [].every(p) is true.
reset_state
PAYLOAD='{"selector":{"activeHandle":null},"accounts":[]}'
OUT="$(run --threshold 80)"
if grep -qi 'no window at or above' <<<"$OUT"; then
	fail "zero accounts is never reported as under-threshold" "$OUT"
else
	pass "zero accounts is never reported as under-threshold"
fi

# An account whose windows carry no usable numbers is unreadable, not healthy.
reset_state
PAYLOAD='{"selector":{"activeHandle":"acct1"},"accounts":[{"label":"acct1","status":"ok","binding":null,"buckets":[]}]}'
OUT="$(run --threshold 80)"
RC=$?
if [ "$RC" -eq 3 ] && grep -qi 'DARK' "$CHANNELS/demo.md"; then
	pass "an account with no readable window pages DARK, not all-clear"
else
	fail "no readable window pages dark" "rc=$RC" "$OUT"
fi

# The dark flag must CLEAR when the source returns, so a later outage pages afresh.
reset_state
SRC_OVERRIDE="$SCRATCH/no-such-source.mjs"; run --threshold 80 >/dev/null; unset SRC_OVERRIDE
PAYLOAD="$(mkpayload acct1 ok 10 3)"; run --threshold 80 >/dev/null   # source returns, healthy
printf '# demo\n' >"$CHANNELS/demo.md"
SRC_OVERRIDE="$SCRATCH/no-such-source.mjs"; OUT="$(run --threshold 80)"; unset SRC_OVERRIDE
if grep -qi 'DARK' "$CHANNELS/demo.md"; then
	pass "the dark flag clears when the source returns, so a later outage pages afresh"
else
	fail "dark flag re-arms" "$OUT" "chan=$(cat "$CHANNELS/demo.md")"
fi

# ⛔ A REJECTED account must page even though its usedPercent may read 0 — the
# RPC succeeds on a throttled account (rateLimitReachedType non-null).
reset_state
PAYLOAD="$(mkpayload acct1 rejected 0 0)"
OUT="$(run --threshold 80)"
if grep -qi 'reject' "$CHANNELS/demo.md"; then
	pass "a rejected account pages regardless of percent"
else
	fail "rejected pages" "$OUT" "chan=$(cat "$CHANNELS/demo.md")"
fi

# An unauthenticated account is also not healthy.
reset_state
PAYLOAD="$(mkpayload acct1 unauthenticated 0 0)"
OUT="$(run --threshold 80)"
if grep -qiE 'unauthenticated|not usable' "$CHANNELS/demo.md"; then
	pass "an unauthenticated account pages regardless of percent"
else
	fail "unauthenticated pages" "$OUT" "chan=$(cat "$CHANNELS/demo.md")"
fi

echo ""
echo "=== hygiene ==="
reset_state
PAYLOAD="$(mkpayload acct1 ok 92 3)"
BEFORE="$(cat "$CHANNELS/demo.md")"
OUT="$(run --threshold 80 --dry-run)"
if [ ! -s "$STATE" ] && [ "$(cat "$CHANNELS/demo.md")" = "$BEFORE" ]; then
	pass "--dry-run mutates no state file and posts nothing"
else
	fail "dry-run purity" "state=$(cat "$STATE" 2>/dev/null)" "$OUT"
fi
grep -qi 'dry-run' <<<"$OUT" && pass "--dry-run says what it would have done" || fail "dry-run reports" "$OUT"

reset_state
PAYLOAD="$(mkpayload acct1 ok 92 3)"
OUT="$(run --threshold 80)"
if grep -qE 'eyJ[A-Za-z0-9_-]{5,}|sk-proj-|sk-ant-' "$CHANNELS/demo.md" "$STATE" 2>/dev/null; then
	fail "no token-shaped string in any page body"
else
	pass "no token-shaped string in any page body"
fi
# Positive control: the page body is genuinely non-empty.
grep -q 'acct1' "$CHANNELS/demo.md" && pass "positive control: the page body is non-empty" || fail "page body non-empty"

OUT="$(run --threshold notanumber 2>&1)"
RC=$?
[ "$RC" -eq 2 ] && pass "--threshold rejects a non-integer" || fail "threshold validated" "rc=$RC" "$OUT"

OUT="$(run --bogus-flag 2>&1)"
RC=$?
[ "$RC" -eq 2 ] && pass "an unknown flag is rejected" || fail "unknown flag rejected" "rc=$RC"

t_syntax_out="$(bash -n "$SUBJECT" 2>&1)"
[ -z "$t_syntax_out" ] && pass "the pager parses (bash -n)" || fail "bash -n" "$t_syntax_out"

echo ""
echo "catalyst-codex-usage-page: $((PASSES))/$((PASSES + FAILURES)) passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
