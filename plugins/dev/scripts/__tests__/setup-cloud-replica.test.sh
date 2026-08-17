#!/usr/bin/env bash
# CTL-1836: setup-catalyst.sh must be able to provision the Catalyst Cloud replica,
# and must REFUSE to guess the tenant when it cannot.
#
# The refusal is the load-bearing case, not the happy path. cloud-sync.mjs:125 and
# cloud-sync/launch.sh:68 both default CATALYST_CLOUD_ACCOUNT to "tenant-0" — the
# Catalyst maintainer's own tenant. An external user who omits the account would
# silently point their host at somebody else's workspace; with a per-tenant key that
# fails CLOSED (the mirror forces the account to match the key) but surfaces as an
# opaque 403 with no hint. So a token WITHOUT an account must be a loud failure here,
# never a default.
#
# The second load-bearing case is the no-op: with no cloud flags at all, this function
# must not touch anything. Existing installs must be byte-identical to before.
#
# Driven against the REAL shipped function by sourcing setup-catalyst.sh with a guard
# that stops it before main() runs — never a re-implementation of it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"
[[ -f "$SETUP" ]] || {
	echo "FAIL: setup-catalyst.sh not found at $SETUP"
	exit 1
}

PASS=0
FAIL=0
ok() {
	PASS=$((PASS + 1))
	echo "  ok   — $1"
}
bad() {
	FAIL=$((FAIL + 1))
	echo "  FAIL — $1"
}

# ⚠️ Transient rm failures must not abort the suite. Observed once on macOS:
# `rm: <tmpdir>: Directory not empty` on a directory that removed cleanly on retry
# (a filesystem/indexer hiccup, not a test failure). Under `set -e` that aborted the
# whole run mid-suite, which reads as a red suite for a reason unrelated to anything
# under test — a cleanup step must never be able to fail the thing it cleans up after.
scrub() { rm -rf "$@" 2>/dev/null || rm -rf "$@" 2>/dev/null || true; }

# file_mode PATH -> the octal permission bits, portably.
# ⛔ ORDER MATTERS AND BSD-FIRST IS WRONG. On Linux `stat -f` is --file-system, which
# SUCCEEDS and prints filesystem info, so a `stat -f ... || stat -c ...` chain never
# reaches the fallback and yields garbage like `File: "/tmp/..."`. GNU (-c) is tried
# first for exactly that reason — the same ordering AGENTS.md's replica freshness-gate
# snippet uses. Returns empty when neither form works, so callers fail loudly rather
# than comparing against a non-numeric string.
file_mode() {
	local m
	m="$(stat -c %a "$1" 2>/dev/null)" || m=""
	[[ $m =~ ^[0-7]+$ ]] || m="$(stat -f %Lp "$1" 2>/dev/null)" || m=""
	[[ $m =~ ^[0-7]+$ ]] || m=""
	printf '%s' "$m"
}

# ── TRANSPORT SEAL (CTL-1913) ────────────────────────────────────────────────
# setup_cloud_replica now makes a real authenticated call before it writes
# anything, so every case below needs the network sealed — otherwise this suite
# either fails offline or, worse, sends fixture tokens to the live hub.
#
# ⛔ The seal is a `curl` STUB ON PATH, not an overridden shell function. A
# function override only intercepts the one call site you thought of; a PATH stub
# intercepts the transport, so a future call added anywhere in the sourced script
# is caught too. `stub_calls` is what proves the seal actually held — a case that
# asserts only on the outcome cannot tell "the stub answered 401" from "real curl
# reached the internet and got 401".
#
# The stub speaks the ONE contract validate_cloud_token relies on: honour
# `-w '%{http_code}'` by printing the code on stdout, and send the body to -o.
make_curl_stub() {
	local bindir="$1" code="$2"
	mkdir -p "$bindir"
	cat >"$bindir/curl" <<STUB
#!/usr/bin/env bash
# Records every invocation, then answers with a fixed HTTP code.
echo "\$*" >>"$bindir/stub_calls"
# validate_cloud_token feeds the auth header on stdin via --config -; drain it so
# the writer never blocks on a full pipe, and prove the token never hit argv.
if [[ " \$* " == *" --config - "* ]]; then cat >"$bindir/stub_stdin" 2>/dev/null || true; fi
for a in "\$@"; do
  if [[ \$a == "-o" ]]; then next=out; continue; fi
  if [[ \${next:-} == out ]]; then : >"\$a" 2>/dev/null; next=; fi
done
printf '%s' "$code"
exit 0
STUB
	chmod +x "$bindir/curl"
}

# Run setup_cloud_replica in a subshell with a fake HOME, sourcing the real script.
# setup-catalyst.sh already guards main() behind a sourced-detection test;
# CATALYST_SETUP_LIB_ONLY is its explicit belt-and-braces form.
#
# HTTP_CODE (4th arg, default 200) is what the sealed transport answers. Cases that
# only care about the FILE the function writes leave it at 200; the CTL-1913 cases
# drive it to 401/403/000.
run_case() {
	local home="$1" token="$2" account="$3" code="${4:-200}"
	local bindir="$home/.stub-bin"
	make_curl_stub "$bindir" "$code"
	(
		export HOME="$home"
		export PATH="$bindir:$PATH"
		export CATALYST_SETUP_LIB_ONLY=1
		export CATALYST_CLOUD_TOKEN="$token"
		export CATALYST_CLOUD_ACCOUNT="$account"
		# Deliberately NOT pinned by default: the base URL is left unset so the
		# cases below exercise the REAL shipped default (CTL-1910's whole subject).
		# Set CASE_BASE_URL to test the override path.
		[[ -n ${CASE_BASE_URL:-} ]] && export CATALYST_CLOUD_BASE_URL="$CASE_BASE_URL"
		# shellcheck disable=SC1090
		source "$SETUP" >/dev/null 2>&1
		# setup-catalyst.sh sets -e; re-disable AFTER sourcing so a deliberate
		# non-zero return is reportable instead of killing this subshell.
		set +e
		setup_cloud_replica >/dev/null 2>&1
		echo "$?"
	)
}

# stub_was_called HOME -> 0 when the sealed transport handled the request.
stub_was_called() { [[ -s "$1/.stub-bin/stub_calls" ]]; }

# make_stack_stub BINDIR RC MESSAGE — a `catalyst-stack` on PATH that exits RC
# after printing MESSAGE on stderr. Needed because `adopt-cloud-sync` is the other
# thing CTL-1913 changed: its output used to go to /dev/null.
make_stack_stub() {
	local bindir="$1" rc="$2" msg="$3"
	mkdir -p "$bindir"
	cat >"$bindir/catalyst-stack" <<STACKSTUB
#!/usr/bin/env bash
echo "$msg" >&2
exit $rc
STACKSTUB
	chmod +x "$bindir/catalyst-stack"
}

# run_case_capturing — like run_case, but returns the function's OUTPUT rather
# than its rc, so assertions can be made about what the operator actually sees.
#
# ⚠️ CALL IT AS `out=$(run_case_capturing ... || true)`. An assignment takes the
# exit status of its command substitution, so under `set -euo pipefail` a case that
# deliberately drives a NON-ZERO return (every rejection case does) aborts the whole
# suite mid-run instead of asserting. Cost one debugging round.
run_case_capturing() {
	local home="$1" token="$2" account="$3" code="${4:-200}"
	local bindir="$home/.stub-bin"
	make_curl_stub "$bindir" "$code"
	(
		export HOME="$home"
		export PATH="$bindir:$PATH"
		export CATALYST_SETUP_LIB_ONLY=1
		export CATALYST_CLOUD_TOKEN="$token"
		export CATALYST_CLOUD_ACCOUNT="$account"
		# shellcheck disable=SC1090
		source "$SETUP" >/dev/null 2>&1
		set +e
		setup_cloud_replica 2>&1
	)
}

echo "CTL-1836 — setup-catalyst.sh cloud replica provisioning"

# ── Case 1: no token → complete no-op (existing installs untouched) ──────────
H1=$(mktemp -d)
rc=$(run_case "$H1" "" "")
if [[ $rc == "0" ]]; then ok "no token → returns 0 (no-op)"; else bad "no token → expected rc 0, got $rc"; fi
if [[ ! -e "$H1/.config/catalyst/cloud-sync.env" ]]; then
	ok "no token → writes NO cloud-sync.env"
else
	bad "no token → wrote cloud-sync.env, which would change existing-install behaviour"
fi
scrub "$H1"

# ── Case 2: token WITHOUT account → loud refusal, nothing written ────────────
# This is the tenant-0 footgun. It must fail, and it must not leave a half-written
# credential behind.
H2=$(mktemp -d)
rc=$(run_case "$H2" "tok_test_abc" "")
if [[ $rc != "0" ]]; then ok "token without account → non-zero exit (refuses to guess the tenant)"; else bad "token without account → returned 0; it defaulted instead of refusing"; fi
if [[ ! -e "$H2/.config/catalyst/cloud-sync.env" ]]; then
	ok "token without account → no cloud-sync.env written"
else
	bad "token without account → wrote a credential file despite refusing"
fi
scrub "$H2"

# ── Case 3: token + account → env file written, 0600, explicit values ────────
H3=$(mktemp -d)
rc=$(run_case "$H3" "tok_test_abc" "tenant-7")
ENV_FILE="$H3/.config/catalyst/cloud-sync.env"
if [[ $rc == "0" ]]; then ok "token + account → returns 0"; else bad "token + account → expected rc 0, got $rc"; fi
if [[ -f "$ENV_FILE" ]]; then
	ok "token + account → cloud-sync.env written"

	mode=$(file_mode "$ENV_FILE")
	if [[ $mode == "600" ]]; then ok "cloud-sync.env is 0600"; else bad "cloud-sync.env mode is $mode, expected 600"; fi
	# ⚠️ NOTE: the assertion above is NOT sufficient on its own and must not be
	# trusted alone. mktemp creates its file 0600 by default and mv preserves the
	# mode, so this passes even with EVERY chmod removed — mutation-verified.
	# Case 5 below is what actually makes the permission behaviour load-bearing.

	if grep -q '^export CATALYST_CLOUD_ACCOUNT=tenant-7$' "$ENV_FILE"; then
		ok "account pinned EXPLICITLY (never left to the tenant-0 default)"
	else
		bad "account not pinned explicitly in cloud-sync.env"
	fi

	if grep -q '^export CATALYST_CLOUD_BASE_URL=' "$ENV_FILE"; then
		ok "base URL pinned explicitly"
	else
		bad "base URL not pinned — new install would inherit the code default"
	fi
	# ⛔ CTL-1910: the pinned default must be a host that EXISTS. This function used
	# to write app.catalystcloud.dev, which is NXDOMAIN, into every customer's
	# launchd-sourced config — a green install with a permanently empty replica.
	if grep -q 'app\.catalystcloud\.dev' "$ENV_FILE"; then
		bad "pins app.catalystcloud.dev — NXDOMAIN; the writer can never reach the hub (CTL-1910)"
	else
		ok "does not pin the NXDOMAIN host app.catalystcloud.dev"
	fi
	if grep -q '^export CATALYST_CLOUD_BASE_URL=https://staging\.catalystcloud\.dev/api/v1$' "$ENV_FILE"; then
		ok "pins the ruled default staging.catalystcloud.dev (verified 200 with a live token)"
	else
		bad "expected the staging.catalystcloud.dev default, got: $(grep '^export CATALYST_CLOUD_BASE_URL=' "$ENV_FILE")"
	fi

	if grep -q '^export CATALYST_CLOUD_TOKEN=tok_test_abc$' "$ENV_FILE"; then
		ok "token written"
	else
		bad "token missing from cloud-sync.env"
	fi
else
	bad "token + account → no cloud-sync.env written"
fi
scrub "$H3"

# ── Case 4: CATALYST_CLOUD_BASE_URL override is honoured ─────────────────────
H4=$(mktemp -d)
CASE_BASE_URL="https://example.invalid/api/v1" rc=$(CASE_BASE_URL="https://example.invalid/api/v1" run_case "$H4" "t" "a")
if grep -q '^export CATALYST_CLOUD_BASE_URL=https://example.invalid/api/v1$' "$H4/.config/catalyst/cloud-sync.env" 2>/dev/null; then
	ok "explicit CATALYST_CLOUD_BASE_URL override is honoured"
else
	bad "base URL override ignored"
fi
# CTL-1913: the override must also be the host the token is VALIDATED against —
# validating against the default while pinning an override would verify a hub the
# writer never talks to.
if grep -q 'example\.invalid' "$H4/.stub-bin/stub_calls" 2>/dev/null; then
	ok "the token is validated against the OVERRIDE host, not the default"
else
	bad "validation call did not target the override host: $(cat "$H4/.stub-bin/stub_calls" 2>/dev/null)"
fi
scrub "$H4"

# ── Case 5: a PRE-EXISTING world-readable env file must be tightened ─────────
# This is the case that makes the permission behaviour real. A 0644 cloud-sync.env
# left behind by an earlier manual step is a credential readable by every local
# user. Setup must replace it with a 0600 file, not append to it or leave the mode
# alone. Unlike the mode check in case 3 (which mktemp satisfies for free), this
# one fails if the write stops going through the tmp+mv path.
H5=$(mktemp -d)
mkdir -p "$H5/.config/catalyst"
: >"$H5/.config/catalyst/cloud-sync.env"
chmod 644 "$H5/.config/catalyst/cloud-sync.env"
pre_mode=$(file_mode "$H5/.config/catalyst/cloud-sync.env")
rc=$(run_case "$H5" "tok_test_abc" "tenant-9")
post_mode=$(file_mode "$H5/.config/catalyst/cloud-sync.env")
if [[ $pre_mode == "644" ]]; then
	ok "precondition established: env file started 0644 (proves this case can discriminate)"
else
	bad "precondition NOT established: pre-mode was $pre_mode, not 644 — case 5 proves nothing"
fi
if [[ $post_mode == "600" ]]; then
	ok "a pre-existing 0644 cloud-sync.env is tightened to 0600"
else
	bad "pre-existing 0644 env file left at $post_mode — credential readable by other local users"
fi
# And it must be REPLACED, not appended to: a stale token line surviving alongside
# the new one would leave the writer reading whichever the shell sourced last.
if [[ $(grep -c '^export CATALYST_CLOUD_TOKEN=' "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null) == "1" ]]; then
	ok "env file replaced, not appended (exactly one token line)"
else
	bad "env file has $(grep -c '^export CATALYST_CLOUD_TOKEN=' "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null) token lines — expected exactly 1"
fi
scrub "$H5"

# ── Case 6: EVERY line must be exported (Codex P1 on #3365) ─────────────────
# launch.sh SOURCES this file and then execs bun. A bare `FOO=bar` in a sourced
# file is shell-local — not in the child's environment — so the writer would see no
# token, take its tokenless idle path, and process.exit(0). Under
# KeepAlive={SuccessfulExit:false} that clean exit is PERMANENT: launchd never
# restarts it and the only symptom is a replica that quietly stops advancing.
# This is not theoretical bookkeeping — it is the exact silent-death shape of
# CTL-1844, which cost hours to diagnose on a live host.
H6=$(mktemp -d)
rc=$(run_case "$H6" "tok_export_check" "tenant-3")
E6="$H6/.config/catalyst/cloud-sync.env"
if [[ -f $E6 ]]; then
	assigns=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$E6" || true)
	exports=$(grep -cE '^export [A-Za-z_][A-Za-z0-9_]*=' "$E6" || true)
	if [[ $assigns -eq 0 && $exports -gt 0 ]]; then
		ok "every assignment is exported ($exports exported, 0 bare) — the writer's child process sees them"
	else
		bad "$assigns BARE assignment(s) present — a sourced non-exported var never reaches bun (silent idle exit)"
	fi
	# Prove the child really would see it, rather than trusting the text: source the
	# file in a subshell and check the variable is in the ENVIRONMENT, not just set.
	if (
		# shellcheck disable=SC1090
		. "$E6"
		env | grep -q '^CATALYST_CLOUD_TOKEN=tok_export_check$'
	); then
		ok "sourcing the file puts the token in the ENVIRONMENT (env|grep, not just set)"
	else
		bad "after sourcing, the token is not in env — bun would receive no token"
	fi
else
	bad "case 6: no env file written"
fi
scrub "$H6"

# ── Case 7: the configured token NAME is honoured (CTL-1668, Codex P2) ──────
# Writing a fixed name while the writer resolves a custom one produces the same
# silent idle as case 6.
H7=$(mktemp -d)
make_curl_stub "$H7/.stub-bin" 200
(
	export HOME="$H7" CATALYST_SETUP_LIB_ONLY=1
	export PATH="$H7/.stub-bin:$PATH"
	export CATALYST_CLOUD_TOKEN_ENV="MY_CUSTOM_CLOUD_TOKEN"
	export MY_CUSTOM_CLOUD_TOKEN="tok_custom_name"
	export CATALYST_CLOUD_ACCOUNT="tenant-4"
	# shellcheck disable=SC1090
	source "$SETUP" >/dev/null 2>&1
	set +e
	setup_cloud_replica >/dev/null 2>&1
)
E7="$H7/.config/catalyst/cloud-sync.env"
if grep -q '^export MY_CUSTOM_CLOUD_TOKEN=tok_custom_name$' "$E7" 2>/dev/null; then
	ok "token written under the CONFIGURED name, not the hardcoded default"
else
	bad "configured token name ignored — writer would resolve a name the file never sets"
fi
scrub "$H7"

# ═════════════════════════════════════════════════════════════════════════════
# CTL-1913 — AN UNUSABLE CLOUD TOKEN MUST FAIL THE INSTALL LOUDLY
#
# Before this, setup_cloud_replica made NO network call at all: it accepted a
# token, wrote it to a 0600 launchd-sourced file, printed two green checkmarks and
# exited 0. A correct token and `FAKE-TOKEN-NOT-REAL` were byte-identical to the
# caller. The writer then exits 0 on a bad token, and under
# KeepAlive={SuccessfulExit:false} that clean exit is PERMANENT — so the customer's
# only symptom was a replica that never appeared.
#
# The load-bearing assertion in each case below is NOT just "rc != 0" — it is that
# NOTHING WAS WRITTEN. A non-zero exit that still leaves a broken 0600 config on
# disk (which launchd sources on every boot) is most of the original defect.
# ═════════════════════════════════════════════════════════════════════════════
echo ""
echo "CTL-1913 — token validation"

# The three rejection classes, measured live against the hub 2026-08-17:
#   401 garbage/expired/revoked token
#   403 valid token, but not scoped to the requested account (the tenant footgun)
#   000 curl could not reach the host at all (the CTL-1910 NXDOMAIN shape)
#
# ⚠️ Each case also asserts the MESSAGE names its own cause. Refusing with the
# wrong explanation is not equivalent to refusing with the right one: the three
# classes need three different operator actions (get a new token / fix the
# account / fix DNS-or-reachability), and the unreachable case is the one that
# carries the CTL-1910 shape plus the exact curl to re-run. Found by mutation —
# breaking the `000` branch so it fell through to the generic catch-all SURVIVED a
# suite that asserted only "non-zero, nothing written".
for spec in "401:a garbage or revoked token:REJECTED by the hub" \
	"403:a token not scoped to this account:NOT scoped to account" \
	"000:an unreachable hub:Could not reach the hub"; do
	code="${spec%%:*}"
	rest="${spec#*:}"
	desc="${rest%%:*}"
	expect_msg="${rest#*:}"
	HB=$(mktemp -d)
	out=$(run_case_capturing "$HB" "FAKE-TOKEN-NOT-REAL" "acme-tenant" "$code" || true)
	if grep -qF "$expect_msg" <<<"$out"; then
		ok "HTTP $code → the message names its own cause (\"$expect_msg\")"
	else
		bad "HTTP $code → wrong or generic diagnostic; expected \"$expect_msg\", got: $(printf '%s' "$out" | tr '\n' '|' | head -c 200)"
	fi
	scrub "$HB"
	HB=$(mktemp -d)
	rc=$(run_case "$HB" "FAKE-TOKEN-NOT-REAL" "acme-tenant" "$code")
	if [[ $rc != "0" ]]; then
		ok "HTTP $code ($desc) → non-zero exit"
	else
		bad "HTTP $code ($desc) → returned 0; a green install with a dead writer"
	fi
	# ⭐ the one that matters most: no credential file, so launchd has nothing to
	# source and no permanently-inert writer is left behind.
	if [[ ! -e "$HB/.config/catalyst/cloud-sync.env" ]]; then
		ok "HTTP $code → wrote NO cloud-sync.env (validated BEFORE persisting)"
	else
		bad "HTTP $code → wrote a config it had already proven cannot work"
	fi
	# Seal proof: this verdict came from the stub, not from the real internet.
	if stub_was_called "$HB"; then
		ok "HTTP $code → verdict came from the sealed transport (stub invoked)"
	else
		bad "HTTP $code → curl stub was never invoked; the seal did not hold, so this case proves nothing"
	fi
	scrub "$HB"
done

# ── POSITIVE CONTROL for all of the above ────────────────────────────────────
# Identical fixture, only the HTTP code differs. Without this, every assertion
# above would pass on a function that refused unconditionally — which would break
# every real install rather than fix it.
HOK=$(mktemp -d)
rc=$(run_case "$HOK" "tok_good" "tenant-1" 200)
if [[ $rc == "0" ]]; then
	ok "POSITIVE CONTROL: HTTP 200 → returns 0 (the refusal is driven by the CODE, not unconditional)"
else
	bad "POSITIVE CONTROL: HTTP 200 → rc $rc; validation rejects even a good token"
fi
if [[ -f "$HOK/.config/catalyst/cloud-sync.env" ]]; then
	ok "POSITIVE CONTROL: HTTP 200 → cloud-sync.env written"
else
	bad "POSITIVE CONTROL: HTTP 200 → no env file; a valid install is now blocked"
fi

# ── The validation must actually be AUTHENTICATED, and must not leak ─────────
# A probe that omits the token would return 401 for a perfectly good token, and an
# unauthenticated reachability ping would pass for a garbage one — the exact
# "correct and garbage are indistinguishable" defect, reintroduced.
if [[ -f "$HOK/.stub-bin/stub_stdin" ]] && grep -q 'Authorization: Bearer tok_good' "$HOK/.stub-bin/stub_stdin"; then
	ok "the validation call carries the bearer token (authenticated, not a reachability ping)"
else
	bad "no Authorization header reached the transport — validation is unauthenticated"
fi
# ⛔ and the token must NOT be on argv: `ps` is world-readable, so a bearer token in
# the command line is visible to every local user for the life of the call.
if grep -q 'tok_good' "$HOK/.stub-bin/stub_calls" 2>/dev/null; then
	bad "the token appears in curl's ARGV — readable by any local user via ps"
else
	ok "the token is never on curl's argv (passed via --config on stdin)"
fi
# It must query the account it is about to pin, or a 403 mismatch goes undetected.
if grep -q 'account=tenant-1' "$HOK/.stub-bin/stub_calls" 2>/dev/null; then
	ok "validation is scoped to the account being pinned"
else
	bad "validation did not pass the account: $(cat "$HOK/.stub-bin/stub_calls" 2>/dev/null)"
fi
scrub "$HOK"

# ── An UNLISTED status code must not be accepted ─────────────────────────────
# Found by mutation: inserting `return 0` into the catch-all `*)` branch SURVIVED
# the suite, because every case above drove a code the function names explicitly.
# A 5xx, a 404 from a reshaped API, or a captive-portal 302 all land here — and
# none of them is evidence the token works.
for code in 500 502 404 302 418; do
	HU=$(mktemp -d)
	rc=$(run_case "$HU" "tok_unknown_code" "tenant-2" "$code")
	if [[ $rc != "0" ]]; then
		ok "HTTP $code (unlisted) → non-zero exit"
	else
		bad "HTTP $code (unlisted) → returned 0; an unrecognised response is treated as proof the token works"
	fi
	if [[ ! -e "$HU/.config/catalyst/cloud-sync.env" ]]; then
		ok "HTTP $code (unlisted) → wrote NO cloud-sync.env"
	else
		bad "HTTP $code (unlisted) → wrote a config on an unverified token"
	fi
	scrub "$HU"
done

# ── adopt-cloud-sync's diagnostics must SURVIVE (CTL-1913 scenario 3) ────────
# Also found by mutation: restoring `>/dev/null 2>&1` on the adopt call SURVIVED,
# because nothing asserted on what the operator is shown. The whole point of that
# change is that the reason for the failure is recoverable.
HD=$(mktemp -d)
mkdir -p "$HD/.stub-bin"
make_stack_stub "$HD/.stub-bin" 3 "launchctl: Bootstrap failed: 5: Input/output error"
out=$(run_case_capturing "$HD" "tok_adopt" "tenant-5" 200 || true)
if grep -q 'Bootstrap failed: 5: Input/output error' <<<"$out"; then
	ok "adopt-cloud-sync's stderr reaches the operator (not discarded to /dev/null)"
else
	bad "adopt-cloud-sync failed and its diagnostics were swallowed — the operator gets a generic warning for every possible cause"
fi
if grep -q 'rc=3' <<<"$out"; then
	ok "the adopt exit code is reported"
else
	bad "the adopt exit code is not reported"
fi
# ...and a FAILED adopt must not be announced as a success.
if grep -qi 'writer adopted' <<<"$out"; then
	bad "printed the adopted success line despite a non-zero adopt"
else
	ok "no success line printed for a failed adopt"
fi
# NEGATIVE CONTROL: a SUCCEEDING adopt must not dump its output as if it failed.
HS=$(mktemp -d)
mkdir -p "$HS/.stub-bin"
make_stack_stub "$HS/.stub-bin" 0 "some ordinary chatter on stderr"
out=$(run_case_capturing "$HS" "tok_adopt" "tenant-6" 200 || true)
if grep -qi 'writer adopted' <<<"$out" && ! grep -q 'ordinary chatter' <<<"$out"; then
	ok "NEGATIVE CONTROL: a successful adopt prints the success line and stays quiet"
else
	bad "successful adopt output is wrong: $(printf '%s' "$out" | tr '\n' '|')"
fi
scrub "$HD" "$HS"

# ── The no-token no-op must remain network-free ──────────────────────────────
# Case 1 proved it writes nothing. It must also not have PHONED HOME: a validation
# call on the no-op path would make `setup-catalyst.sh` contact the hub on every
# ordinary non-cloud install.
HN=$(mktemp -d)
rc=$(run_case "$HN" "" "")
if ! stub_was_called "$HN"; then
	ok "no token → no validation call at all (ordinary installs stay network-free)"
else
	bad "no token → still called out to the hub: $(cat "$HN/.stub-bin/stub_calls")"
fi
scrub "$HN"

# ── The account refusal must also precede the network ────────────────────────
# A token without an account is refused syntactically; spending a hub round-trip
# first would be wasted work and would send the token somewhere before we had
# decided the input was even usable.
HA=$(mktemp -d)
rc=$(run_case "$HA" "tok_test_abc" "" 200)
if ! stub_was_called "$HA"; then
	ok "token without account → refused BEFORE any network call"
else
	bad "token without account → sent the token to the hub before refusing"
fi
scrub "$HA"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
