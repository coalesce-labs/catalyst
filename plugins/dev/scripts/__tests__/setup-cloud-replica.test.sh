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

# Run setup_cloud_replica in a subshell with a fake HOME, sourcing the real script.
# setup-catalyst.sh already guards main() behind a sourced-detection test;
# CATALYST_SETUP_LIB_ONLY is its explicit belt-and-braces form.
run_case() {
	local home="$1" token="$2" account="$3"
	(
		export HOME="$home"
		export CATALYST_SETUP_LIB_ONLY=1
		export CATALYST_CLOUD_TOKEN="$token"
		export CATALYST_CLOUD_ACCOUNT="$account"
		# shellcheck disable=SC1090
		source "$SETUP" >/dev/null 2>&1
		# setup-catalyst.sh sets -e; re-disable AFTER sourcing so a deliberate
		# non-zero return is reportable instead of killing this subshell.
		set +e
		setup_cloud_replica >/dev/null 2>&1
		echo "$?"
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
rm -rf "$H1"

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
rm -rf "$H2"

# ── Case 3: token + account → env file written, 0600, explicit values ────────
H3=$(mktemp -d)
rc=$(run_case "$H3" "tok_test_abc" "tenant-7")
ENV_FILE="$H3/.config/catalyst/cloud-sync.env"
if [[ $rc == "0" ]]; then ok "token + account → returns 0"; else bad "token + account → expected rc 0, got $rc"; fi
if [[ -f "$ENV_FILE" ]]; then
	ok "token + account → cloud-sync.env written"

	mode=$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE" 2>/dev/null)
	if [[ $mode == "600" ]]; then ok "cloud-sync.env is 0600"; else bad "cloud-sync.env mode is $mode, expected 600"; fi
	# ⚠️ NOTE: the assertion above is NOT sufficient on its own and must not be
	# trusted alone. mktemp creates its file 0600 by default and mv preserves the
	# mode, so this passes even with EVERY chmod removed — mutation-verified.
	# Case 5 below is what actually makes the permission behaviour load-bearing.

	if grep -q '^CATALYST_CLOUD_ACCOUNT=tenant-7$' "$ENV_FILE"; then
		ok "account pinned EXPLICITLY (never left to the tenant-0 default)"
	else
		bad "account not pinned explicitly in cloud-sync.env"
	fi

	# The legacy host is being retired; a new user must not be pointed at it.
	if grep -q '^CATALYST_CLOUD_BASE_URL=' "$ENV_FILE"; then
		ok "base URL pinned explicitly"
	else
		bad "base URL not pinned — new install would inherit the LEGACY default"
	fi
	if grep -q 'api\.catalyst-cloud\.coalescelabs\.ai' "$ENV_FILE"; then
		bad "cloud-sync.env pins the LEGACY base URL"
	else
		ok "cloud-sync.env does not pin the legacy base URL"
	fi

	if grep -q '^CATALYST_CLOUD_TOKEN=tok_test_abc$' "$ENV_FILE"; then
		ok "token written"
	else
		bad "token missing from cloud-sync.env"
	fi
else
	bad "token + account → no cloud-sync.env written"
fi
rm -rf "$H3"

# ── Case 4: CATALYST_CLOUD_BASE_URL override is honoured ─────────────────────
H4=$(mktemp -d)
(
	export HOME="$H4" CATALYST_SETUP_LIB_ONLY=1 CATALYST_CLOUD_TOKEN="t" CATALYST_CLOUD_ACCOUNT="a"
	export CATALYST_CLOUD_BASE_URL="https://example.invalid/api/v1"
	# shellcheck disable=SC1090
	source "$SETUP" >/dev/null 2>&1
	set +e
	setup_cloud_replica >/dev/null 2>&1
)
if grep -q '^CATALYST_CLOUD_BASE_URL=https://example.invalid/api/v1$' "$H4/.config/catalyst/cloud-sync.env" 2>/dev/null; then
	ok "explicit CATALYST_CLOUD_BASE_URL override is honoured"
else
	bad "base URL override ignored"
fi
rm -rf "$H4"

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
pre_mode=$(stat -f %Lp "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null || stat -c %a "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null)
rc=$(run_case "$H5" "tok_test_abc" "tenant-9")
post_mode=$(stat -f %Lp "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null || stat -c %a "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null)
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
if [[ $(grep -c '^CATALYST_CLOUD_TOKEN=' "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null) == "1" ]]; then
	ok "env file replaced, not appended (exactly one token line)"
else
	bad "env file has $(grep -c '^CATALYST_CLOUD_TOKEN=' "$H5/.config/catalyst/cloud-sync.env" 2>/dev/null) token lines — expected exactly 1"
fi
rm -rf "$H5"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
