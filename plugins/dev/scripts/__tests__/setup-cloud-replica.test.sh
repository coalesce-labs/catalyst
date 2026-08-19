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
[[ -f $SETUP ]] || {
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
#
# ⛔ CTL-2045: THE STUB IS ROUTE-AWARE, AND IT HAS TO BE. setup_cloud_replica now makes
# TWO authenticated calls — `GET /issues` (generic read, CTL-1913) and
# `GET /agent/attachments` (the per-host binding preflight) — and the 2026-08-18 incident
# is the case where those two answer DIFFERENTLY: the admin bearer read 200 from /issues
# and 403 from every /agent/* route. A single-code stub cannot express that signature at
# all, so a suite built on one would be structurally incapable of failing for the exact
# defect this ticket exists to prevent. AGENT_CODE defaults to CODE, so every pre-existing
# case keeps its old meaning.
make_curl_stub() {
	local bindir="$1" code="$2" agent_code="${3:-$2}"
	mkdir -p "$bindir"
	cat >"$bindir/curl" <<STUB
#!/usr/bin/env bash
# Records every invocation, then answers with a fixed HTTP code per route family.
echo "\$*" >>"$bindir/stub_calls"
# validate_cloud_token feeds the auth header on stdin via --config -; drain it so
# the writer never blocks on a full pipe, and prove the token never hit argv.
if [[ " \$* " == *" --config - "* ]]; then cat >"$bindir/stub_stdin" 2>/dev/null || true; fi
for a in "\$@"; do
  if [[ \$a == "-o" ]]; then next=out; continue; fi
  if [[ \${next:-} == out ]]; then : >"\$a" 2>/dev/null; next=; fi
done
# The route family decides the answer: /agent/* is the per-host binding path.
if [[ " \$* " == *"/agent/"* ]]; then printf '%s' "$agent_code"; else printf '%s' "$code"; fi
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
	local home="$1" token="$2" account="$3" code="${4:-200}" agent_code="${5:-${4:-200}}"
	local bindir="$home/.stub-bin"
	make_curl_stub "$bindir" "$code" "$agent_code"
	seal_stack "$bindir"
	(
		export HOME="$home"
		export PATH="$bindir:$PATH"
		export CATALYST_SETUP_LIB_ONLY=1
		export CATALYST_CLOUD_TOKEN="$token"
		export CATALYST_CLOUD_ACCOUNT="$account"
		# Deliberately NOT pinned by default: the base URL is left unset so the
		# cases below exercise the REAL shipped default (CTL-1910's whole subject).
		# Set CASE_BASE_URL to test the override path.
		[[ -n ${CASE_BASE_URL-} ]] && export CATALYST_CLOUD_BASE_URL="$CASE_BASE_URL"
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

# ⛔ seal_stack BINDIR — CTL-1968. THE SINGLE MOST IMPORTANT LINE IN THIS FILE.
#
# Every case here sets HOME to a `mktemp -d`, but PATH keeps a trailing ":$PATH",
# so `setup_cloud_replica`'s `command -v catalyst-stack` resolved the REAL
# INSTALLED binary and ran its `adopt-cloud-sync`. That renders LaunchAgent
# plists under the scratch HOME and then bootstraps them into `gui/$(id -u)` —
# a domain that is per-USER, not per-HOME. On 2026-08-18 two full gates on the
# primary laptop (04:01, 07:19 CT) thereby re-bound the live
# `ai.coalesce.catalyst-cloud-sync` label to a temp path and left
# `ai.coalesce.catalyst-health-responder` UNLOADED for 3h47m.
#
# ⚠️ Every one of those cases reported PASS while doing it. A scratch HOME is not
# a sandbox for launchd, and rc=0 was never evidence that nothing escaped.
#
# So a stack stub is planted for EVERY case by default. Cases that want a
# specific rc/message still call make_stack_stub first — this only fills the gap.
seal_stack() {
	local bindir="$1"
	mkdir -p "$bindir"
	[[ -x "$bindir/catalyst-stack" ]] && return 0
	make_stack_stub "$bindir" 0 'stubbed catalyst-stack (CTL-1968: the real one mutates gui/$(id -u))'
}

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
	local home="$1" token="$2" account="$3" code="${4:-200}" agent_code="${5:-${4:-200}}"
	local bindir="$home/.stub-bin"
	make_curl_stub "$bindir" "$code" "$agent_code"
	seal_stack "$bindir"
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

# ⛔ CTL-2045: every fixture token below is now a WELL-SHAPED per-host organization key.
# Provisioning refuses any other class outright, so the old `tok_test_abc` fixtures would
# have made every case below exercise the class refusal rather than the behaviour it was
# written to assert — a suite that stays green while testing nothing it names.
OK_TOKEN="ctc_acct_sk_fixture_testonly_000000000000000000000000000000"
OK_TOKEN_2="ctc_acct_sk_fixture_testonly_111111111111111111111111111111"

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
rc=$(run_case "$H2" "$OK_TOKEN" "")
if [[ $rc != "0" ]]; then ok "token without account → non-zero exit (refuses to guess the tenant)"; else bad "token without account → returned 0; it defaulted instead of refusing"; fi
if [[ ! -e "$H2/.config/catalyst/cloud-sync.env" ]]; then
	ok "token without account → no cloud-sync.env written"
else
	bad "token without account → wrote a credential file despite refusing"
fi
scrub "$H2"

# ── Case 3: token + account → env file written, 0600, explicit values ────────
H3=$(mktemp -d)
rc=$(run_case "$H3" "$OK_TOKEN" "tenant-7")
ENV_FILE="$H3/.config/catalyst/cloud-sync.env"
if [[ $rc == "0" ]]; then ok "token + account → returns 0"; else bad "token + account → expected rc 0, got $rc"; fi
if [[ -f $ENV_FILE ]]; then
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

	if grep -q "^export CATALYST_CLOUD_TOKEN=${OK_TOKEN}$" "$ENV_FILE"; then
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
CASE_BASE_URL="https://example.invalid/api/v1" rc=$(CASE_BASE_URL="https://example.invalid/api/v1" run_case "$H4" "$OK_TOKEN" "a")
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
rc=$(run_case "$H5" "$OK_TOKEN" "tenant-9")
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
rc=$(run_case "$H6" "$OK_TOKEN_2" "tenant-3")
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
		env | grep -q "^CATALYST_CLOUD_TOKEN=${OK_TOKEN_2}$"
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
# CTL-1968: this case rolls its own HOME/PATH instead of going through run_case,
# so it needs the stack seal explicitly — it was the one case still reaching the
# real `catalyst-stack adopt-cloud-sync`, and a verification run that only fixed
# run_case still recorded 4 escaped launchctl calls against gui/$(id -u).
seal_stack "$H7/.stub-bin"
(
	export HOME="$H7" CATALYST_SETUP_LIB_ONLY=1
	export PATH="$H7/.stub-bin:$PATH"
	export CATALYST_CLOUD_TOKEN_ENV="MY_CUSTOM_CLOUD_TOKEN"
	export MY_CUSTOM_CLOUD_TOKEN="ctc_acct_tok_custom_name"
	export CATALYST_CLOUD_ACCOUNT="tenant-4"
	# shellcheck disable=SC1090
	source "$SETUP" >/dev/null 2>&1
	set +e
	setup_cloud_replica >/dev/null 2>&1
)
E7="$H7/.config/catalyst/cloud-sync.env"
if grep -q '^export MY_CUSTOM_CLOUD_TOKEN=ctc_acct_tok_custom_name$' "$E7" 2>/dev/null; then
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
	out=$(run_case_capturing "$HB" "ctc_acct_FAKE-TOKEN-NOT-REAL" "acme-tenant" "$code" || true)
	if grep -qF "$expect_msg" <<<"$out"; then
		ok "HTTP $code → the message names its own cause (\"$expect_msg\")"
	else
		bad "HTTP $code → wrong or generic diagnostic; expected \"$expect_msg\", got: $(printf '%s' "$out" | tr '\n' '|' | head -c 200)"
	fi
	scrub "$HB"
	HB=$(mktemp -d)
	rc=$(run_case "$HB" "ctc_acct_FAKE-TOKEN-NOT-REAL" "acme-tenant" "$code")
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
rc=$(run_case "$HOK" "ctc_acct_tok_good" "tenant-1" 200)
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
if [[ -f "$HOK/.stub-bin/stub_stdin" ]] && grep -q 'Authorization: Bearer ctc_acct_tok_good' "$HOK/.stub-bin/stub_stdin"; then
	ok "the validation call carries the bearer token (authenticated, not a reachability ping)"
else
	bad "no Authorization header reached the transport — validation is unauthenticated"
fi
# ⛔ and the token must NOT be on argv: `ps` is world-readable, so a bearer token in
# the command line is visible to every local user for the life of the call.
if grep -q 'ctc_acct_tok_good' "$HOK/.stub-bin/stub_calls" 2>/dev/null; then
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
	rc=$(run_case "$HU" "ctc_acct_tok_unknown_code" "tenant-2" "$code")
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
out=$(run_case_capturing "$HD" "ctc_acct_tok_adopt" "tenant-5" 200 || true)
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
out=$(run_case_capturing "$HS" "ctc_acct_tok_adopt" "tenant-6" 200 || true)
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
rc=$(run_case "$HA" "$OK_TOKEN" "" 200)
if ! stub_was_called "$HA"; then
	ok "token without account → refused BEFORE any network call"
else
	bad "token without account → sent the token to the hub before refusing"
fi
scrub "$HA"

# ── CTL-2019: the account CARRY-FORWARD ──────────────────────────────────────
# ⛔ THE DEFECT THIS PINS, MEASURED ON MINI-2 DURING THE CTL-1975 REHEARSAL.
# setup_cloud_replica WRITES the account into ~/.config/catalyst/cloud-sync.env and,
# before this, never read it back — resolution was flag-then-env only. The account
# lives in a FILE, not in the environment, so on every host after its first install
# the function found a token, found no account, and returned 1. That call site is
# `setup_cloud_replica || exit 1`, so all of setup aborted — and with it every step
# `catalyst install` runs afterwards: set-class, pull-owner, install-cli,
# install-services, adopt-cloud-sync, start-stack, verify-node, doctor.
#
# The rebuilt node came up with 1 of 8 launchd agents, 0 daemons, node.class unset
# and NO REPLICA WRITER — which falls back to live `linearis` and burns the shared,
# rate-limited Linear quota. Nothing was red.
#
# ⚠️ These cases must not weaken Case 2's refusal, which is the load-bearing safety
# property of this whole file. A carry-forward re-uses what THIS host already recorded
# for itself; it is not a default, and "tenant-0" is still never guessed.
echo ""
echo "── CTL-2019: cloud account carry-forward ──"

# The happy path the defect broke: account absent from flag AND env, but present in
# the file this function itself wrote on a previous run.
HCF=$(mktemp -d)
mkdir -p "$HCF/.config/catalyst"
cat >"$HCF/.config/catalyst/cloud-sync.env" <<'CFEOF'
# Written by setup-catalyst.sh (CTL-1836).
export CATALYST_CLOUD_TOKEN=tok_from_a_previous_run
export CATALYST_CLOUD_ACCOUNT=tenant-carried
export CATALYST_CLOUD_BASE_URL=https://staging.catalystcloud.dev/api/v1
CFEOF
rc=$(run_case "$HCF" "$OK_TOKEN" "" 200)
if [[ $rc == "0" ]]; then
	ok "⭐ account absent from flag+env but recorded in cloud-sync.env → provisions (rc=0)"
else
	bad "account carry-forward → rc=$rc; the recorded account was ignored (this is the CTL-2019 defect)"
fi
# and it must have used the CARRIED value, not some other one
if grep -q '^export CATALYST_CLOUD_ACCOUNT=tenant-carried$' "$HCF/.config/catalyst/cloud-sync.env" 2>/dev/null; then
	ok "the carried account is the one written back (tenant-carried)"
else
	bad "the carried account was not preserved in the rewritten env file"
fi
scrub "$HCF"

# ⛔ INVERSION GUARD — the refusal must SURVIVE. Without this, a fix that simply
# defaulted the account would pass every case above.
HNF=$(mktemp -d)
mkdir -p "$HNF/.config/catalyst"
rc=$(run_case "$HNF" "$OK_TOKEN" "" 200)
if [[ $rc != "0" ]]; then
	ok "⛔ INVERSION GUARD: no flag, no env, NO file → still refuses (rc=$rc), never guesses tenant-0"
else
	bad "no account anywhere → returned 0; the carry-forward became a default"
fi
scrub "$HNF"

# A file with no account line is the same as no file — not an empty-string account.
HEL=$(mktemp -d)
mkdir -p "$HEL/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN=tok_only\nexport CATALYST_CLOUD_BASE_URL=https://x/api/v1\n' \
	>"$HEL/.config/catalyst/cloud-sync.env"
rc=$(run_case "$HEL" "$OK_TOKEN" "" 200)
if [[ $rc != "0" ]]; then
	ok "cloud-sync.env present but carrying NO account line → still refuses"
else
	bad "an account-less env file was treated as an account"
fi
scrub "$HEL"

# Precedence: an explicit env account must still beat the recorded file.
HPR=$(mktemp -d)
mkdir -p "$HPR/.config/catalyst"
printf 'export CATALYST_CLOUD_ACCOUNT=tenant-from-file\n' >"$HPR/.config/catalyst/cloud-sync.env"
rc=$(run_case "$HPR" "$OK_TOKEN" "tenant-from-env" 200)
if [[ $rc == "0" ]] && grep -q '^export CATALYST_CLOUD_ACCOUNT=tenant-from-env$' \
	"$HPR/.config/catalyst/cloud-sync.env" 2>/dev/null; then
	ok "precedence holds: env account beats the recorded file"
else
	bad "precedence broken: the file overrode an explicitly supplied account"
fi
scrub "$HPR"

# ⛔ The carry-forward must not drag the TOKEN out of that file. It reads one named
# non-secret field; sourcing the file would pull a live credential into this shell and
# every child it spawns. Proven by giving the file a DIFFERENT token from the caller's
# and asserting the caller's is the one that survives.
HTK=$(mktemp -d)
mkdir -p "$HTK/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN=tok_STALE_from_file\nexport CATALYST_CLOUD_ACCOUNT=tenant-carried\n' \
	>"$HTK/.config/catalyst/cloud-sync.env"
rc=$(run_case "$HTK" "ctc_acct_tok_CALLER_wins" "" 200)
if grep -q 'ctc_acct_tok_CALLER_wins' "$HTK/.config/catalyst/cloud-sync.env" 2>/dev/null &&
	! grep -q 'tok_STALE_from_file' "$HTK/.config/catalyst/cloud-sync.env" 2>/dev/null; then
	ok "⭐ reads the ACCOUNT only — the caller's token wins, the file's stale token is not adopted"
else
	bad "the carry-forward pulled the token out of the env file (it must read one named field)"
fi
scrub "$HTK"

# ══════════════════════════════════════════════════════════════════════════════════════
# CTL-2045 — the credential CLASS gate and the per-host BINDING preflight
# ══════════════════════════════════════════════════════════════════════════════════════
#
# The 2026-08-18 incident: mini-2's reinstall provisioned the tenant-wide ADMIN_TOKEN as
# this host's write credential. Every cross-host claim 403'd and the board froze for four
# hours — while `catalyst doctor` passed, the daemons ran, the heartbeat stayed fresh, and
# the local write ledger showed ZERO refusals.
#
# ⚠️ EVERY CASE BELOW WOULD HAVE PASSED BEFORE THIS TICKET. That is the point: the suite
# above is 59 green assertions that are all blind to a mis-provisioned credential class.
echo ""
echo "CTL-2045 — credential class + per-host binding"

# ── §1: the class gate refuses, BEFORE any packet leaves the host ────────────────────
# ⭐ Each row is a shape the cloud treats differently, and the `sk_` row is the one a
# blacklist implementation would let through (BE-12: the cloud ACCEPTS a bare sk_ key but
# derives no per-host binding from it). Implementing the ticket's TITLE — "refuse an admin
# bearer" — passes that row and reopens the hole one credential over.
while IFS='|' read -r label token expect_fragment; do
	[[ -z ${label// /} ]] && continue
	HC=$(mktemp -d)
	# ⛔ The transport answers 200 for EVERYTHING. So if the install still refuses, the
	# refusal cannot have come from the network — it came from the class gate. A case
	# that drove the stub to 403 could not tell the two apart.
	out=$(run_case_capturing "$HC" "$token" "tenant-1" 200 200 || true)
	rc=$(run_case "$HC" "$token" "tenant-1" 200 200)

	if [[ $rc != "0" ]]; then
		ok "class gate: ${label} → non-zero exit"
	else
		bad "class gate: ${label} → returned 0; a wrong-class credential was provisioned"
	fi
	if [[ ! -e "$HC/.config/catalyst/cloud-sync.env" ]]; then
		ok "class gate: ${label} → wrote NO cloud-sync.env"
	else
		bad "class gate: ${label} → wrote a credential it had already classified as unusable"
	fi
	# The operator has to be told WHICH class arrived, or the message is just another 403.
	if printf '%s' "$out" | grep -q "$expect_fragment"; then
		ok "class gate: ${label} → names the class it received (\"${expect_fragment}\")"
	else
		bad "class gate: ${label} → generic diagnostic; expected \"${expect_fragment}\", got: $(printf '%s' "$out" | tr '\n' '|' | head -c 160)"
	fi
	# ⛔ THE SECRET MUST NOT REACH THE TERMINAL. The refusal echoes a SHAPE precisely so
	# it never echoes a value; a message that pasted the token would leak it into every
	# CI log and support thread that carries a failed install.
	if printf '%s' "$out" | grep -q -- "$token"; then
		bad "class gate: ${label} → THE REFUSAL PRINTED THE TOKEN VALUE"
	else
		ok "class gate: ${label} → refusal carries the shape, never the secret"
	fi
	# ⭐ Refused with NO network call at all — the class is decidable on-host.
	if stub_was_called "$HC"; then
		bad "class gate: ${label} → made a network call before classifying (the class needs no round trip)"
	else
		ok "class gate: ${label} → refused before any network call"
	fi
	scrub "$HC"
done <<'CLASSCASES'
admin-bearer shape (64 chars, no prefix)|0123456789012345678901234567890123456789012345678901234567890123|no recognized prefix
a USER key (ctc_user_)|ctc_user_sk_fixture_000000000000000000000000000000000000|USER key
a bare issuer key (sk_)|sk_fixture_00000000000000000000000000000000000000000|RAW issuer key
CLASSCASES

# ── §2: the per-host BINDING preflight — the incident's exact signature ──────────────
# ⭐⭐ THE CASE THAT WOULD HAVE CAUGHT mini-2, and the reason the stub is route-aware.
# A well-SHAPED credential, `GET /issues` → 200, `GET /agent/attachments` → 403. That is
# byte-for-byte what the admin bearer did: it authenticated for generic reads and was
# refused on every agent route. CTL-1913's validation passes it; only this gate does not.
HB2=$(mktemp -d)
out=$(run_case_capturing "$HB2" "$OK_TOKEN" "tenant-1" 200 403 || true)
rc=$(run_case "$HB2" "$OK_TOKEN" "tenant-1" 200 403)
if [[ $rc != "0" ]]; then
	ok "⭐ binding: generic read 200 + agent route 403 → install REFUSES (the mini-2 signature)"
else
	bad "⭐ binding: generic read 200 + agent route 403 → returned 0 — this IS the four-hour freeze"
fi
if [[ ! -e "$HB2/.config/catalyst/cloud-sync.env" ]]; then
	ok "binding: refused → wrote NO cloud-sync.env"
else
	bad "binding: refused → still wrote the credential to disk"
fi
if printf '%s' "$out" | grep -q "agent write path"; then
	ok "binding: names the agent write path, not a generic auth failure"
else
	bad "binding: generic diagnostic; got: $(printf '%s' "$out" | tr '\n' '|' | head -c 160)"
fi
# Seal + route proof: the verdict came from the stub AND the stub was asked the /agent/
# route. Without the route assertion this case could pass on a probe that never ran.
if grep -q '/agent/attachments' "$HB2/.stub-bin/stub_calls" 2>/dev/null; then
	ok "binding: the preflight really requested /agent/attachments (sealed transport)"
else
	bad "binding: no /agent/attachments request recorded — the refusal came from somewhere else"
fi
scrub "$HB2"

# ── §2 positive controls: the pass arm must be WIDE, or every real install breaks ─────
# ⛔ 404 IS THE AUTHORIZED ANSWER on a probe issue id that does not exist. Measured
# 2026-08-18: a per-host key against its own account returns 404 for an absent issue,
# while the admin bearer returned 403 for the identical request. A gate pinned to
# "200 only" would refuse every correctly-provisioned host — a fix worse than the bug.
for agent_code in 200 404 400; do
	HP=$(mktemp -d)
	rc=$(run_case "$HP" "$OK_TOKEN" "tenant-1" 200 "$agent_code")
	if [[ $rc == "0" ]]; then
		ok "POSITIVE CONTROL: agent route ${agent_code} → install proceeds (authorized, past the binding check)"
	else
		bad "POSITIVE CONTROL: agent route ${agent_code} → rc ${rc}; a correctly-provisioned host was refused"
	fi
	scrub "$HP"
done

# An unreachable agent route is UNVERIFIED, and unverified is fatal here — the same
# posture CTL-1913 already takes for the generic read. Reporting success on a check that
# did not run is what produced green installs with permanently dead writers.
HN=$(mktemp -d)
rc=$(run_case "$HN" "$OK_TOKEN" "tenant-1" 200 000)
if [[ $rc != "0" ]]; then
	ok "binding: agent route unreachable (000) → refuses as UNVERIFIED, never assumes"
else
	bad "binding: agent route unreachable → returned 0; the binding was never proven"
fi
scrub "$HN"

# ── ⭐ THE ORDERING ASSERTION — §1 must run before §2, and §2 before the write ────────
# A well-shaped token whose agent route 403s reaches the network; a wrong-class token must
# not. Proving both in one place is what makes "cheapest gate first" a tested property
# rather than a comment. Without it, someone could reorder the three gates and every other
# case above would stay green.
HO=$(mktemp -d)
rc=$(run_case "$HO" "0123456789012345678901234567890123456789012345678901234567890123" "tenant-1" 403 403)
if [[ $rc != "0" ]] && ! stub_was_called "$HO"; then
	ok "⭐ ordering: a wrong-CLASS credential never reaches the network, even when the hub would also refuse it"
else
	bad "⭐ ordering: the class gate did not run first (stub called=$(stub_was_called "$HO" && echo yes || echo no), rc=$rc)"
fi
scrub "$HO"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
