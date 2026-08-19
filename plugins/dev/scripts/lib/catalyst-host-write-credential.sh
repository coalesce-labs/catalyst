#!/usr/bin/env bash
# catalyst-host-write-credential.sh — CTL-2045 §1, the BASH mirror of
# lib/host-write-credential.mjs.
#
# Two engines exist because the two consumers cannot share one: `catalyst doctor` is JS,
# and `setup-catalyst.sh` is the INSTALLER — it runs before node/bun are guaranteed to be
# on the host, so it cannot shell out to the JS leaf for the one check that decides
# whether provisioning proceeds. Same one-registry/hand-written-mirror/cross-stack-parity
# shape as lib/secret-contract.mjs + lib/catalyst-secret-contract.sh.
#
# ⛔ THE MIRROR IS NOT TRUSTED TO STAY IN SYNC BY REVIEW. Both engines are driven over the
# SAME fixture table (__tests__/fixtures/host-write-credential-cases.txt) by
# __tests__/host-write-credential-parity.test.sh, which compares each against a
# COMPUTED-EXPECTED verdict — never merely against each other. Two engines agreeing on a
# wrong answer is the failure mode a bare A-vs-B comparison cannot see.
#
# See the JS leaf's header for WHY this is a positive allow-list and why it does not gate
# on length. Do not re-derive that reasoning here; change both or neither.

CATALYST_HOST_WRITE_CREDENTIAL_PREFIX="ctc_acct_"
CATALYST_USER_CREDENTIAL_PREFIX="ctc_user_"

# catalyst_classify_host_write_credential TOKEN
#
# Sets three globals and returns 0 when the token is an org key, 1 otherwise:
#   CATALYST_CREDENTIAL_VERDICT  org-key | user-key | raw-issuer | unrecognized | absent
#   CATALYST_CREDENTIAL_SHAPE    ⭐ SAFE TO PRINT — prefix + length, never secret bytes
#   CATALYST_CREDENTIAL_DETAIL   one operator-facing clause
#
# ⛔ GLOBALS, NOT STDOUT, AND CALLED DIRECTLY — NEVER `$(…)`. A command substitution runs
# the function in a SUBSHELL, so every global it sets is discarded the moment it returns
# and the caller reads a stale/empty verdict. That exact mistake has been made four times
# in this repo, three of them inside fixes for it (see the reference note in AGENTS.md's
# knowledge store). The return code carries the pass/fail; the globals carry the reason.
# shellcheck disable=SC2034  # the three globals below ARE this function's return channel;
# shellcheck cannot see the callers (setup-catalyst.sh, the parity suite) from this file.
catalyst_classify_host_write_credential() {
	local token="${1-}"
	local len=${#token}

	if [[ -z $token ]]; then
		CATALYST_CREDENTIAL_VERDICT="absent"
		CATALYST_CREDENTIAL_SHAPE="<empty>"
		CATALYST_CREDENTIAL_DETAIL="no credential supplied"
		return 1
	fi

	case "$token" in
	"${CATALYST_HOST_WRITE_CREDENTIAL_PREFIX}"*)
		CATALYST_CREDENTIAL_VERDICT="org-key"
		CATALYST_CREDENTIAL_SHAPE="${CATALYST_HOST_WRITE_CREDENTIAL_PREFIX}… (len ${len})"
		CATALYST_CREDENTIAL_DETAIL="per-host organization key"
		return 0
		;;
	"${CATALYST_USER_CREDENTIAL_PREFIX}"*)
		CATALYST_CREDENTIAL_VERDICT="user-key"
		CATALYST_CREDENTIAL_SHAPE="${CATALYST_USER_CREDENTIAL_PREFIX}… (len ${len})"
		CATALYST_CREDENTIAL_DETAIL="a USER key — bound to a person, not to this host; the cloud derives no per-host binding from it"
		return 1
		;;
	sk_*)
		# ⚠️ BE-12: the cloud ACCEPTS a bare sk_ key. A blacklist would pass it.
		CATALYST_CREDENTIAL_VERDICT="raw-issuer"
		CATALYST_CREDENTIAL_SHAPE="sk_… (len ${len})"
		CATALYST_CREDENTIAL_DETAIL="a RAW issuer key — the cloud accepts it but derives no per-host binding, so every claim write is refused"
		return 1
		;;
	*)
		CATALYST_CREDENTIAL_VERDICT="unrecognized"
		CATALYST_CREDENTIAL_SHAPE="<no recognized prefix> (len ${len})"
		CATALYST_CREDENTIAL_DETAIL="no recognized Catalyst Cloud key prefix — this is the shape the tenant-wide ADMIN_TOKEN presents"
		return 1
		;;
	esac
}
