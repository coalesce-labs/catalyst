#!/usr/bin/env bash
# catalyst-account-usage-page.test.sh — CTL-1908, the paging half.
#
# The property under test is NOT "does it page at 80%". It is that every way of being unable to
# see usage renders as UNOBSERVABLE and a non-zero exit, never as "under threshold". A pager whose
# input goes dark and reports fine is worse than no pager.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../catalyst-account-usage-page.sh"

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

mklog() { # mklog <five> <seven>  — a payload in the daemon's real format
	# ⛔ The stamp must be NOW. The pager checks the payload's own [HH:MM:SS] against the clock
	# (Codex #3526 P1: a fresh mtime does not mean a fresh payload), so a fixture frozen at
	# 00:00:01 is correctly rejected as stale — which is what happened to every case here on the
	# first run after that check landed.
	local ts
	ts="$(date '+%H:%M:%S')"
	printf '[%s] Connected\n[%s] Sending: {"s":%s,"sr":240,"w":%s,"wr":9000,"st":"allowed","ok":true,"acct":"acct1@example.com"}\n' \
		"$ts" "$ts" "$1" "$2" >"$SCRATCH/usage.log"
}

run() {
	CATALYST_USAGE_LOG="${LOG_OVERRIDE:-$SCRATCH/usage.log}" \
		CATALYST_USAGE_PAGE_STATE="$SCRATCH/state" \
		CATALYST_MD_CHANNELS="$SCRATCH/channels" \
		CATALYST_LINEAR_REPLY="$SCRATCH/no-such-reply-tool" \
		bash "$SUBJECT" "$@" 2>&1
}

mkdir -p "$SCRATCH/channels"
printf '# demo\n' >"$SCRATCH/channels/demo.md"

echo ""
echo "=== under the threshold: nothing paged, exit 0 ==="
mklog 30 5
OUT="$(run --threshold 80 --dry-run)"
RC=$?
grep -q "no window at or above 80%" <<<"$OUT" && pass "reports nothing crossed" || fail "reports nothing crossed" "$OUT"
[ "$RC" -eq 0 ] && pass "exits 0" || fail "exits 0" "rc=$RC"

echo ""
echo "=== a 5-hour crossing pages ==="
# ⛔ NOT --dry-run for the suppression cases below: a dry run deliberately records NO state
# (Codex #3526 P1 — recording a crossing that was never delivered suppresses every later run),
# so suppression and re-arming can only be exercised through a real delivery.
rm -f "$SCRATCH/state"
: >"$SCRATCH/channels/demo.md"
mklog 85 5
OUT="$(run --threshold 80 --channel demo)"
grep -q "85% of its 5-hour window" "$SCRATCH/channels/demo.md" && pass "pages the 5-hour window" || fail "pages the 5-hour window" "$OUT"

echo ""
echo "=== ...and does NOT repeat on the next run ==="
OUT="$(run --threshold 80 --channel demo)"
grep -q "already paged" <<<"$OUT" && pass "the repeat is suppressed" || fail "the repeat is suppressed" "$OUT"
# Count PAGE HEADERS, not the phrase: one page writes "5-hour window" in both its heading and
# its body, so a phrase count of 1 was never reachable.
[ "$(grep -c '^## Turn FLEET-AUTO' "$SCRATCH/channels/demo.md")" -eq 1 ] && pass "no second page reached the channel" || fail "no second page reached the channel" "$(grep -c '^## Turn FLEET-AUTO' "$SCRATCH/channels/demo.md") pages"

echo ""
echo "--- ⛔ ...but it RE-ARMS after the window falls back below ---"
# Without this a single page per lifetime would look identical to a working pager.
mklog 30 5
run --threshold 80 --channel demo >/dev/null
mklog 88 5
OUT="$(run --threshold 80 --channel demo)"
grep -q "88% of its 5-hour window" "$SCRATCH/channels/demo.md" && pass "a fresh crossing pages again" || fail "a fresh crossing pages again" "$OUT"

echo ""
echo "=== the 7-day window pages independently ==="
rm -f "$SCRATCH/state"
: >"$SCRATCH/channels/demo.md"
mklog 10 92
OUT="$(run --threshold 80 --channel demo)"
grep -q "92% of its 7-day window" "$SCRATCH/channels/demo.md" && pass "pages the 7-day window" || fail "pages the 7-day window" "$OUT"
grep -q "5-hour window" "$SCRATCH/channels/demo.md" && fail "only the crossed window pages" "it also paged 5-hour at 10%" || pass "the uncrossed 5-hour window did not page"

echo ""
echo "--- ⛔ EVERY way of not seeing usage is UNOBSERVABLE + non-zero, never 'under threshold' ---"
rm -f "$SCRATCH/state"
# ⛔ `LOG_OVERRIDE=x OUT=$(...)` is TWO assignments, not a prefixed command — LOG_OVERRIDE then
# leaked into every later case and four of them "failed" against a file that never existed.
OUT="$(LOG_OVERRIDE="$SCRATCH/does-not-exist.log" run --dry-run)"
RC=$?
grep -q "UNOBSERVABLE" <<<"$OUT" && [ "$RC" -eq 3 ] && pass "an ABSENT source is UNOBSERVABLE (rc 3)" || fail "an absent source is UNOBSERVABLE" "rc=$RC: $OUT"

# ⛔ Codex #3526 P1: under launchd, exiting to stderr puts the most important condition in a log
# nobody reads. Being unable to SEE usage must go out through the same sink as a crossing.
: >"$SCRATCH/channels/demo.md"
OUT="$(LOG_OVERRIDE="$SCRATCH/does-not-exist.log" CATALYST_USAGE_PAGE_STATE="$SCRATCH/state-dark" run --channel demo)"
grep -q "usage source is DARK" "$SCRATCH/channels/demo.md" && pass "a dark source PAGES the channel, not just stderr" || fail "a dark source pages the channel" "$OUT"
OUT2="$(LOG_OVERRIDE="$SCRATCH/does-not-exist.log" CATALYST_USAGE_PAGE_STATE="$SCRATCH/state-dark" run --channel demo)"
[ "$(grep -c 'usage source is DARK' "$SCRATCH/channels/demo.md")" -eq 1 ] && pass "…and does not repeat it every run" || fail "the dark page repeats" "$(grep -c 'usage source is DARK' "$SCRATCH/channels/demo.md") copies"

mklog 30 5
touch -t 202601010000 "$SCRATCH/usage.log"
OUT="$(run --dry-run)"
RC=$?
grep -q "UNOBSERVABLE" <<<"$OUT" && [ "$RC" -eq 3 ] && pass "a STALE source is UNOBSERVABLE (rc 3)" || fail "a stale source is UNOBSERVABLE" "rc=$RC: $OUT"
grep -q "NOT 'under threshold'" <<<"$OUT" && pass "it says so in those words" || fail "it says so in those words" "$OUT"

# ⛔ Codex #3526 P1: a FRESH mtime with a STALE payload. The daemon keeps logging connection
# lines while its last real payload is hours old — an unbounded search returns the old one and
# the pager reports stale percentages as current.
{
	old_ts="$(date -v-2H '+%H:%M:%S' 2>/dev/null || date -d '2 hours ago' '+%H:%M:%S')"
	now_ts="$(date '+%H:%M:%S')"
	printf '[%s] Sending: {"s":95,"sr":10,"w":9,"wr":900,"st":"allowed","ok":true,"acct":"acct1@example.com"}\n' "$old_ts"
	i=0
	while [ $i -lt 60 ]; do printf '[%s] Connecting to a device...\n' "$now_ts"; i=$((i + 1)); done
} >"$SCRATCH/usage.log"
OUT="$(run --dry-run)"
RC=$?
grep -q "UNOBSERVABLE" <<<"$OUT" && [ "$RC" -eq 3 ] && pass "a stale payload behind a FRESH mtime is UNOBSERVABLE" || fail "a stale payload behind a fresh mtime is caught" "rc=$RC: $OUT"
grep -q "not usage" <<<"$OUT" && pass "…and says the daemon is writing but not usage" || fail "it explains why" "$OUT"

printf '[00:00:00] some unrelated log line\n' >"$SCRATCH/usage.log"
OUT="$(run --dry-run)"
RC=$?
grep -q "UNOBSERVABLE" <<<"$OUT" && [ "$RC" -eq 3 ] && pass "an UNPARSABLE source is UNOBSERVABLE (rc 3)" || fail "an unparsable source is UNOBSERVABLE" "rc=$RC: $OUT"

# ⛔ A payload with a MISSING percentage must not be read as 0% (i.e. as healthy).
printf '[%s] Sending: {"sr":240,"wr":9000,"st":"allowed","ok":true,"acct":"acct1@example.com"}\n' "$(date '+%H:%M:%S')" >"$SCRATCH/usage.log"
OUT="$(run --dry-run)"
RC=$?
grep -q "UNOBSERVABLE" <<<"$OUT" && [ "$RC" -eq 3 ] && pass "a payload with NO percentages is UNOBSERVABLE, not 0%" || fail "a missing percentage is not read as 0" "rc=$RC: $OUT"

# ⛔ Positive control for the whole block: the same harness DOES produce a clean reading on a
# good log, so the UNOBSERVABLE results above are about the input, not a broken invocation.
mklog 30 5
OUT="$(run --threshold 80 --dry-run)"
RC=$?
[ "$RC" -eq 0 ] && grep -q "5h=30%" <<<"$OUT" && pass "control — a good log still reads cleanly (rc 0)" || fail "control — a good log reads cleanly" "rc=$RC: $OUT"

echo ""
echo "=== a real (non-dry-run) page writes a channel line ==="
rm -f "$SCRATCH/state"
mklog 91 5
OUT="$(run --threshold 80 --channel demo)"
grep -q "91% of its 5-hour window" "$SCRATCH/channels/demo.md" && pass "the channel file received the page" || fail "the channel file received the page" "$OUT"
grep -qE "Linear sink only PARTLY configured|FAILED to comment|no channel file" <<<"$OUT" &&
	pass "an unusable sink is reported, not swallowed" ||
	pass "both sinks were usable (nothing to report)"

echo ""
echo "--- ⛔ a page NO SINK accepted is NOT recorded, so the next run retries (Codex #3526 P1) ---"
# Recording a crossing that was never delivered suppresses every later run until the window falls
# back below threshold — hiding the entire exhaustion.
rm -f "$SCRATCH/state"
mklog 93 5
OUT="$(CATALYST_USAGE_LOG="$SCRATCH/usage.log" CATALYST_USAGE_PAGE_STATE="$SCRATCH/state" \
	CATALYST_MD_CHANNELS="$SCRATCH/no-such-channels" CATALYST_LINEAR_REPLY="" \
	bash "$SUBJECT" --threshold 80 --channel demo 2>&1)"
RC=$?
grep -q "NO SINK ACCEPTED" <<<"$OUT" && pass "an undeliverable page says so" || fail "an undeliverable page says so" "$OUT"
[ "$RC" -eq 4 ] && pass "it exits 4 rather than 0" || fail "it exits 4 rather than 0" "rc=$RC"
OUT2="$(run --threshold 80 --channel demo)"
grep -q "already paged" <<<"$OUT2" && fail "the next run RETRIES" "it was suppressed despite never being delivered" || pass "the next run RETRIES rather than suppressing"

echo ""
echo "--- ⛔ no internal ticket default (Codex #3526 P1) ---"
grep -q 'CATALYST_USAGE_TICKET:-CTL-' "$SUBJECT" && fail "no committed ticket default" "a team-internal issue is hardcoded as the default" || pass "no committed ticket default"
grep -q 'CATALYST_LINEAR_REPLY:-\$HOME' "$SUBJECT" && fail "no operator-local reply-tool default" "defaults to a path no installer creates" || pass "no operator-local reply-tool default"

echo ""
echo "=== argument validation ==="
run --threshold abc >/dev/null 2>&1
[ $? -eq 2 ] && pass "a non-numeric --threshold is refused (rc 2)" || fail "a non-numeric --threshold is refused (rc 2)"
run --max-age-min "" >/dev/null 2>&1
[ $? -eq 2 ] && pass "a non-numeric --max-age-min is refused (rc 2)" || fail "a non-numeric --max-age-min is refused (rc 2)"

echo ""
echo "=== the installer renders a plist with NO unsubstituted tokens ==="
INSTALLER="$SCRIPT_DIR/../install-usage-page.sh"
OUT="$(bash "$INSTALLER" --print-only 2>&1)"
RC=$?
[ "$RC" -eq 0 ] && pass "--print-only succeeds" || fail "--print-only succeeds" "$OUT"
grep -q "__[A-Z_]*__" <<<"$OUT" && fail "every token is substituted" "tokens remain: $(grep -o '__[A-Z_]*__' <<<"$OUT" | sort -u | tr '\n' ' ')" || pass "every token is substituted"
printf '%s\n' "$OUT" >"$SCRATCH/rendered.plist"
# ⛔ `plutil` is macOS-only and CI is ubuntu, where it simply does not exist — the first cut of
# this case failed on CI for that reason alone. Skipping there would leave the assertion absent
# on the platform that actually runs it in CI, so fall back to a real XML well-formedness parse:
# a different check, but still a check, and it catches the malformed-render case either way.
if command -v plutil >/dev/null 2>&1; then
	plutil -lint "$SCRATCH/rendered.plist" >/dev/null 2>&1 && pass "the rendered plist lints (plutil)" || fail "the rendered plist lints (plutil)"
else
	python3 -c "import sys,xml.dom.minidom as m; m.parse(sys.argv[1])" "$SCRATCH/rendered.plist" >/dev/null 2>&1 &&
		pass "the rendered plist is well-formed XML (no plutil on this platform)" ||
		fail "the rendered plist is well-formed XML"
fi

echo ""
echo "--- ⛔ CONTROL: the installer REFUSES a template whose tokens did not substitute ---"
# An unsubstituted token yields a plist launchd accepts and an agent that never does anything —
# installed-looking and inert. Without this control the check above only proves today's template.
FAKE="$SCRATCH/fake-scripts"
mkdir -p "$FAKE/usage-page"
cp "$SCRIPT_DIR/../catalyst-account-usage-page.sh" "$FAKE/"
cp "$INSTALLER" "$FAKE/"
# CTL-1975: the installer now loads lib/launchd-domain-guard.sh (CTL-1968 family), so the fake
# scripts dir has to carry it or the script refuses before it ever renders the template — and this
# control would then "pass" on the WRONG refusal.
mkdir -p "$FAKE/lib"
cp "$SCRIPT_DIR/../lib/launchd-domain-guard.sh" "$FAKE/lib/"
sed 's|__SCRIPT__|__NEVER_SUBSTITUTED__|' "$SCRIPT_DIR/../usage-page/ai.coalesce.catalyst-usage-page.plist" \
	>"$FAKE/usage-page/ai.coalesce.catalyst-usage-page.plist"
OUT="$(bash "$FAKE/install-usage-page.sh" --print-only 2>&1)"
RC=$?
# ⛔ Matched on the TOKEN-SPECIFIC line, not a bare "REFUSING": this script now has a second refusal
# (the launchd domain guard), so the loose needle would let a run that never reached the template
# check certify the template check. That is not hypothetical — it is exactly what a missing
# lib/launchd-domain-guard.sh produced here before the copy above was added.
[ "$RC" -ne 0 ] && grep -q "unsubstituted token(s) remain" <<<"$OUT" && pass "an unsubstituted token is refused" || fail "an unsubstituted token is refused" "rc=$RC: $OUT"

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
