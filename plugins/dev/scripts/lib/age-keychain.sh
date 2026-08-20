#!/usr/bin/env bash
# age-keychain.sh — CTL-1985. Keychain read/write/presence for the host's age private key.
#
# WHY A KEYCHAIN? The enrollment AC is absolute: the generated private key must NEVER be
# written to any disk file. The macOS security(1) keychain is the only local store that
# can hold a high-entropy secret outside the filesystem while still being readable by a
# daemon launched under a restricted PATH.
#
# PLATFORM: macOS only. The ENROL_SECURITY override (or the ENROL_SECURITY env var) lets
# tests inject a stub without touching the real keychain. On non-Darwin, every function
# returns "absent"/"failed" rather than erroring — callers fall back to the disk path.
#
# NAMING CONVENTION (Q3 from the plan):
#   service = ai.coalesce.catalyst.age-key
#   account = <hostname -s output>
# Matches the ai.coalesce.* LaunchAgent label convention. Fixed here so every consumer
# (catalyst-enrol.sh, age-key-resolve.sh/mjs, doctor) agrees without re-deriving.
#
# CONTRACT: Functions that write use a tmp → mv atomicity idiom where possible, but
# the keychain write itself is atomic by the OS. The read function emits the key ONLY
# to stdout — never to a variable that lingers in the shell environment longer than
# needed, and NEVER logged.

AGE_KEYCHAIN_SERVICE="ai.coalesce.catalyst.age-key"

# age_keychain_account — the account name for this host's keychain entry.
age_keychain_account() {
	hostname -s 2>/dev/null || echo "unknown-host"
}

# age_keychain_service_name — the keychain service name (constant).
age_keychain_service_name() {
	printf '%s' "${AGE_KEYCHAIN_SERVICE}"
}

# _age_security — the security(1) binary, overridable via ENROL_SECURITY for tests.
_age_security() {
	printf '%s' "${ENROL_SECURITY:-security}"
}

# age_keychain_present — 0 if the key is in the keychain, 1 otherwise.
# Never reads the key value. Uses find-generic-password with -w piped to /dev/null.
age_keychain_present() {
	if [[ "$(uname -s 2>/dev/null || true)" != "Darwin" ]]; then
		return 1
	fi
	local svc acct
	svc="$(age_keychain_service_name)"
	acct="$(age_keychain_account)"
	"$(_age_security)" find-generic-password \
		-s "$svc" -a "$acct" -w >/dev/null 2>&1
}

# age_keychain_store PRIVATE_KEY — write the private key to the keychain.
# Returns 0 on success. On failure, prints an error to stderr and returns 1.
# NEVER falls back to writing the key to disk.
age_keychain_store() {
	local privkey="$1"
	if [[ -z "$privkey" ]]; then
		echo "age_keychain_store: private key is empty" >&2
		return 1
	fi
	if [[ "$(uname -s 2>/dev/null || true)" != "Darwin" ]]; then
		echo "age_keychain_store: keychain storage requires macOS (platform: $(uname -s 2>/dev/null || echo unknown))" >&2
		return 1
	fi
	local svc acct
	svc="$(age_keychain_service_name)"
	acct="$(age_keychain_account)"
	# -U: update-or-add (idempotent); -w: password is on stdin so it never appears on argv
	printf '%s' "$privkey" | \
		"$(_age_security)" add-generic-password -U \
			-s "$svc" -a "$acct" \
			-w 2>&1 || {
		echo "age_keychain_store: security add-generic-password failed (service=${svc} account=${acct})" >&2
		return 1
	}
	return 0
}

# age_keychain_read — echo the private key from the keychain to stdout.
# Returns 0 on success, 1 if absent or on error.
# CALLER RESPONSIBILITY: assign to a variable with `local key; key="$(age_keychain_read)"`
# and clear it when done (unset key). Never log the output.
age_keychain_read() {
	if [[ "$(uname -s 2>/dev/null || true)" != "Darwin" ]]; then
		return 1
	fi
	local svc acct
	svc="$(age_keychain_service_name)"
	acct="$(age_keychain_account)"
	"$(_age_security)" find-generic-password \
		-s "$svc" -a "$acct" -w 2>/dev/null
}
