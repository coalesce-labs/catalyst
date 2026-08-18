#!/usr/bin/env bash
# check-direnv-fleet.sh — CTL-1944. Is THIS host owner-ready: can a remote owner launched here
# read Linear, call gh, and reach Cloudflare?
#
# THE INCIDENT: mini-2 had no direnv at all. A remote owner was launched onto it and every Linear
# read failed — discovered mid-run, not at provisioning time. `brew install direnv` on one host is
# the uncodified machine edit CTL-1908 just proved drifts, so the fix is a check that RUNS
# everywhere plus an --install that remediates.
#
# ⛔ THE TRAP THIS CHECK EXISTS TO AVOID: inferring configuration from the ABSENCE of output. A
# blocked .envrc produces no variables, which looks exactly like a host with nothing to load. The
# allowed-state must be read POSITIVELY, from `direnv status`.
#
# ⛔ AND THE SUBTLETY THAT MAKES A NAIVE READ WRONG: `direnv status` prints TWO blocks. "Loaded RC"
# describes the rc already active in the CALLING shell — on an agent host that is whatever
# directory the agent happens to sit in, and it is routinely allowed. "Found RC" describes the
# rc for the directory being CHECKED. Measured 2026-08-18 on mini, direnv 2.37.1, from an allowed
# repo against a blocked target: `Loaded RC allowed 0` (the caller's) and `Found RC allowed 1`
# (the target's). A check that greps for "RC allowed 0" anywhere in the output therefore passes a
# BLOCKED host. This reads `Found RC allowed` only. 0 = allowed, non-zero = blocked.
#
# ⚠️ Measured, contradicting CTL-1944's description: on direnv 2.37.1 `direnv exec .` against a
# blocked .envrc exits 1, not 0. That exit code is version-dependent and undocumented; the
# `Found RC allowed` field is neither. This does not rely on the exit code.
#
# Usage:
#   check-direnv-fleet.sh [--dir <path>] [--install] [--require-token LINEAR_API_TOKEN] [--probe]
#
# Exit: 0 all checks pass · 1 a check FAILED · 2 bad arguments
set -uo pipefail

DIR="$PWD"
DO_INSTALL=0
DO_PROBE=0
DIRENV_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/direnv"
# The profiles a Catalyst host must materialize. CTL-1944: mini-2 had none of them.
REQUIRED_PROFILES="${CATALYST_DIRENV_PROFILES:-personal catalyst catalyst-cloud}"
# The tokens an owner cannot work without. LINEAR_API_TOKEN is the one whose absence stalled the
# relaunch; the others are what the same profile chain is supposed to carry.
REQUIRED_TOKENS="${CATALYST_DIRENV_TOKENS:-LINEAR_API_TOKEN GITHUB_TOKEN CLOUDFLARE_API_TOKEN}"
BREW="${CATALYST_BREW:-brew}"

while [[ $# -gt 0 ]]; do
	case "$1" in
	--dir)
		DIR="${2-}"
		shift 2
		;;
	--install)
		DO_INSTALL=1
		shift
		;;
	--probe)
		DO_PROBE=1
		shift
		;;
	--require-token)
		REQUIRED_TOKENS="${2-}"
		shift 2
		;;
	-h | --help)
		sed -n '2,28p' "$0"
		exit 0
		;;
	*)
		echo "check-direnv-fleet: unknown argument '$1'" >&2
		exit 2
		;;
	esac
done
[[ -n $DIR ]] || {
	echo "check-direnv-fleet: --dir requires a path" >&2
	exit 2
}
[[ -d $DIR ]] || {
	echo "check-direnv-fleet: no such directory '$DIR'" >&2
	exit 2
}
# ⛔ Resolve to the PHYSICAL path. direnv's allow-record is keyed by a hash of the .envrc's path,
# and it stores the resolved one. Hand it a path that traverses a symlink (/tmp, or a symlinked
# home — an agent worktree under ~/catalyst/wt can be either) and the hash misses, so a correctly
# allowed host reports BLOCKED. A false red on the readiness check is how an owner gets held back
# from a host that was fine. Measured 2026-08-18 on mini: /var/folders/... blocked,
# /private/var/folders/... allowed, same directory.
DIR="$(cd "$DIR" && pwd -P)"

FAILURES=0
pass() { echo "  ✅  $1"; }
fail() {
	echo "  ❌  $1"
	FAILURES=$((FAILURES + 1))
}
info() { echo "  ℹ   $1"; }

echo "direnv fleet readiness — host $(hostname -s 2>/dev/null || echo unknown), dir $DIR"

# ─── 1. the binary, and (with --install) the whole runtime ──────────────────
# ⛔ CTL-1956: --install used to be `brew install direnv` inline, which remediated NOTHING on the
# two fleet minis (neither has brew) and could not have fixed the other three missing pieces
# anyway. It now delegates to the SAME library install-cli.sh uses, so the narrow remediation and
# the join stage cannot drift apart — and so `--install` on a bare host is a real fix rather than
# a message telling a human to type one.
if [[ $DO_INSTALL -eq 1 ]]; then
	PROVISION_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/direnv-provision.sh"
	if [[ -f $PROVISION_LIB ]]; then
		# shellcheck source=lib/direnv-provision.sh
		# shellcheck disable=SC1091
		source "$PROVISION_LIB"
		ensure_direnv || true
		ensure_direnv_runtime || true
		for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
			[[ -x "$p/direnv" ]] && PATH="$p:$PATH" && export PATH && break
		done
		hash -r 2>/dev/null || true
	else
		info "lib/direnv-provision.sh not found next to this script — cannot auto-install"
	fi
fi

if command -v direnv >/dev/null 2>&1; then
	pass "direnv installed ($(direnv version 2>/dev/null || echo '?')) at $(command -v direnv)"
else
	# ⛔ FAIL, not warn. CTL-1944: a warn is what let mini-2 stay un-provisioned while reading as
	# "recommended, optional" — it is not optional on a host that hosts owners.
	fail "direnv NOT installed — this host cannot materialize fleet tokens (install: $BREW install direnv)"
	echo ""
	echo "FAILED: $FAILURES"
	exit 1
fi

# ─── 1b. the direnv LIBRARY helpers ─────────────────────────────────────────
# ⛔ CTL-1956: the check was blind to these, and they are what actually break first. `use_profile`
# is not a direnv builtin — it is defined by ~/.config/direnv/lib/profiles.sh, and
# `use_otel_context` by lib/otel.sh. On mini-2 BOTH were absent, so every .envrc died on an
# undefined function and the token dump came back empty. Section 4 then reported three EMPTY
# tokens: red, correctly, but naming the symptom. A reader installs the binary, sees the same
# three reds, and has no idea the cause is a missing 60-line shell helper that is in no repo.
#
# So these are checked BEFORE the tokens and named individually. Their absence is a FAIL, not a
# warn: a host missing them cannot materialize a single token no matter what the profiles hold.
for lib in profiles otel; do
	if [[ -f "$DIRENV_CONFIG/lib/${lib}.sh" ]]; then
		pass "direnv lib ${lib}.sh present"
	else
		fail "direnv lib ${lib}.sh MISSING from $DIRENV_CONFIG/lib/ — $([[ $lib == profiles ]] && echo 'use_profile' || echo 'use_otel_context') is undefined, so EVERY .envrc here fails and every token reads empty (install: catalyst install-cli, which runs ensure_direnv_runtime)"
	fi
done

# ─── 2. the profiles ────────────────────────────────────────────────────────
for p in $REQUIRED_PROFILES; do
	if [[ -f "$DIRENV_CONFIG/profiles/${p}.env" ]]; then
		pass "profile ${p}.env present"
	else
		fail "profile ${p}.env MISSING from $DIRENV_CONFIG/profiles/"
	fi
done

# ─── 3. the .envrc, and whether it is ALLOWED ───────────────────────────────
if [[ -f "$DIR/.envrc" ]]; then
	pass ".envrc present in $DIR"

	# Read the allowed-state POSITIVELY, from the "Found RC" block only (see header).
	STATUS_OUT="$(cd "$DIR" && direnv status 2>/dev/null)"
	ALLOWED_LINE="$(printf '%s\n' "$STATUS_OUT" | grep -E '^Found RC allowed ' | head -n1)"
	if [[ -z $ALLOWED_LINE ]]; then
		fail ".envrc allowed-state UNREADABLE — direnv status printed no 'Found RC allowed' line"
	else
		ALLOWED_VAL="${ALLOWED_LINE##* }"
		# ⛔ TWO ENCODINGS, AND READING ONLY ONE INVERTS THE ANSWER. direnv changed this field's
		# representation: 2.32.1 (Ubuntu 24.04's apt package) prints `true`/`false`, while 2.37.1
		# (current homebrew) prints `0`/`1`. Both were measured 2026-08-18 — 2.37.1 on mini,
		# 2.32.1 on the CI runner, which is how this was caught.
		#
		# The trap is that the ALLOWED sentinel differs in TYPE, not just spelling: `0` means
		# allowed, and so does `true` — so a check written against only the numeric form reads
		# 2.32's `true` as non-zero and reports a correctly-allowed host as BLOCKED. That is a
		# FALSE RED on every host running the older direnv, which would have held owners back
		# from hosts that were fine. Handle both, and fail CLOSED on anything unrecognized rather
		# than guessing a third encoding right.
		case "$ALLOWED_VAL" in
		0 | true)
			pass ".envrc is ALLOWED (Found RC allowed $ALLOWED_VAL)"
			;;
		1 | 2 | false)
			# CTL-1956: with --install this is remediable here — `direnv allow` is a local,
			# reversible act on a repo the operator already checked out. Re-read the state
			# AFTERWARDS rather than assuming the allow worked; an allow that silently fails
			# must still render RED.
			if [[ $DO_INSTALL -eq 1 ]]; then
				info ".envrc BLOCKED — running: direnv allow $DIR"
				(cd "$DIR" && direnv allow . >/dev/null 2>&1) || true
				RECHECK="$(cd "$DIR" && direnv status 2>/dev/null | grep -E '^Found RC allowed ' | head -n1)"
				RECHECK_VAL="${RECHECK##* }"
				case "$RECHECK_VAL" in
				0 | true) pass ".envrc is ALLOWED (Found RC allowed $RECHECK_VAL, after --install)" ;;
				*) fail ".envrc still BLOCKED after direnv allow (Found RC allowed '$RECHECK_VAL')" ;;
				esac
			else
				fail ".envrc is BLOCKED (Found RC allowed $ALLOWED_VAL) — run: direnv allow $DIR"
			fi
			;;
		*)
			fail ".envrc allowed-state UNRECOGNIZED (Found RC allowed '$ALLOWED_VAL', direnv $(direnv version 2>/dev/null || echo '?')) — refusing to guess"
			;;
		esac
	fi
else
	fail "no .envrc in $DIR — direnv loads nothing here"
fi

# ─── 4. the tokens the .envrc is supposed to produce ────────────────────────
# Ask for exactly the names, so a value is never printed. `direnv exec` is used for the VALUES
# only — never to infer the allowed-state, which section 3 already established positively.
#
# ⛔ THE SCRUB, AND WHY IT IS THE WHOLE POINT. `direnv exec` ADDS what the .envrc exports to the
# environment it inherits; it does not scrub what was already there. Run from an agent whose own
# shell carries LINEAR_API_TOKEN, an UNPROVISIONED host therefore reports the token as "set" —
# the check passes on the CALLER's credentials while a freshly-launched owner on that host gets
# nothing. That is this ticket's exact failure (a host reading ready when it is not), reproduced
# inside the check meant to catch it; caught by the probe case in the test suite. So the dump runs
# under `env -i`, carrying only what direnv itself needs, and every value observed is one THIS
# HOST materialized.
direnv_dump() { # direnv_dump <dir> — the environment $1's .envrc produces, and nothing inherited
	env -i \
		HOME="$HOME" \
		PATH="$PATH" \
		TERM="${TERM:-dumb}" \
		XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}" \
		XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}" \
		direnv exec "$1" env 2>/dev/null
}

if [[ -f "$DIR/.envrc" ]]; then
	ENV_DUMP="$(direnv_dump "$DIR")"
	for t in $REQUIRED_TOKENS; do
		VAL="$(printf '%s\n' "$ENV_DUMP" | grep -E "^${t}=" | head -n1)"
		VAL="${VAL#*=}"
		if [[ -n $VAL ]]; then
			pass "$t is set (${#VAL} chars)"
		else
			fail "$t is EMPTY — an owner launched here cannot use it"
		fi
	done
fi

# ─── 5. optional live probe ─────────────────────────────────────────────────
if [[ $DO_PROBE -eq 1 ]]; then
	# Same scrub as section 4 — probe the token THIS HOST produces, not the caller's.
	TOKEN="$(printf '%s\n' "$(direnv_dump "$DIR")" | grep -E '^LINEAR_API_TOKEN=' | head -n1)"
	TOKEN="${TOKEN#*=}"
	if [[ -z $TOKEN ]]; then
		fail "live Linear probe SKIPPED — no LINEAR_API_TOKEN to probe with"
	else
		VIEWER="$(curl -sS --max-time 20 -X POST https://api.linear.app/graphql \
			-H "Content-Type: application/json" -H "Authorization: $TOKEN" \
			-d '{"query":"{ viewer { id } }"}' 2>/dev/null)"
		if printf '%s' "$VIEWER" | grep -q '"viewer"' && ! printf '%s' "$VIEWER" | grep -q '"errors"'; then
			pass "live Linear viewer probe OK"
		else
			fail "live Linear viewer probe FAILED (token present but not accepted)"
		fi
	fi
fi

echo ""
if [[ $FAILURES -eq 0 ]]; then
	echo "direnv fleet readiness: PASS"
	exit 0
fi
echo "direnv fleet readiness: FAIL ($FAILURES)"
exit 1
