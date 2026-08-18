#!/usr/bin/env bash
# ─── launchd domain guard (CTL-1968) ─────────────────────────────────────────
#
# `launchctl bootstrap gui/$(id -u) <plist>` targets a domain that is PER-USER,
# not per-HOME. Every install path in this repo derives its plist path from
# "${HOME}/Library/LaunchAgents/…" but bootstraps into gui/<uid>, so a caller
# running under a scratch HOME registers the REAL label bound to a temp path —
# and, when the plist's directory is later cleaned up, leaves a dangling label
# that `launchctl kickstart` can never revive.
#
# That is not hypothetical. On 2026-08-18 two full shell-suite runs on the
# primary laptop (04:01 and 07:19 CT) squatted `ai.coalesce.catalyst-cloud-sync`
# and left `ai.coalesce.catalyst-health-responder` UNLOADED for 3h47m — the
# self-heal that exists to fix exactly this was itself a casualty. The vector was
# __tests__/setup-cloud-replica.test.sh, which seals HOME but keeps the real
# PATH, so `setup_cloud_replica` resolved the REAL installed `catalyst-stack` and
# ran its `adopt-cloud-sync`. The test PASSED while doing it: the damage is
# entirely invisible to the caller, which is why this guard lives in the product
# rather than in any one test.
#
# ⚠️ The guard is deliberately NOT "is launchctl stubbed?" — that question cannot
# be answered reliably from inside a shell. It asks the answerable one: is $HOME
# the invoking user's real home? A caller that HAS sealed launchctl and wants to
# exercise the bootstrap path declares so with
# CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1. Sealing therefore becomes an explicit
# statement; forgetting to seal is what refuses.
#
# Contract (house discipline: value + reason globals, never `$(fn)` — a command
# substitution discards the named reason, which is how this class of bug hides):
#
#   CATALYST_LAUNCHD_GUARD_REAL_HOME  the resolved real home (when resolvable)
#   CATALYST_LAUNCHD_GUARD_REASON     why the last call decided what it decided
#
#   launchd_guard_resolve_real_home   rc 0 = resolved
#   launchd_guard_ok <context>        rc 0 = safe to mutate gui/<uid>
#   launchd_guard_message <context>   the operator-facing refusal text

CATALYST_LAUNCHD_GUARD_REAL_HOME=""
CATALYST_LAUNCHD_GUARD_REASON=""

# Normalize a path to its physical form when it exists; otherwise return it
# unchanged. macOS makes this load-bearing: /var is a symlink to /private/var,
# so a scratch HOME reads as /var/folders/… from mktemp and /private/var/folders/…
# from launchd, and a literal string compare on those two is a false match risk
# in both directions.
_ldg_physical() {
	local p="${1:-}"
	if [[ -d $p ]]; then (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"; else printf '%s' "$p"; fi
}

# Resolve the invoking user's real home WITHOUT trusting $HOME. Three
# independent resolvers, tried in order; each is authoritative on its own, so
# "cannot resolve" means all three failed, which on a macOS host is genuinely
# anomalous rather than merely unusual.
launchd_guard_resolve_real_home() {
	CATALYST_LAUNCHD_GUARD_REAL_HOME=""
	CATALYST_LAUNCHD_GUARD_REASON=""
	local user home
	user="$(id -un 2>/dev/null)"
	if [[ -z $user ]]; then
		CATALYST_LAUNCHD_GUARD_REASON="could not resolve the current user name (id -un)"
		return 1
	fi

	# 1. Directory Services — the authority on macOS.
	if command -v dscl >/dev/null 2>&1; then
		home="$(dscl . -read "/Users/${user}" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p' | head -1)"
		if [[ -n $home ]]; then
			CATALYST_LAUNCHD_GUARD_REAL_HOME="$home"
			CATALYST_LAUNCHD_GUARD_REASON="real home resolved via dscl"
			return 0
		fi
	fi

	# 2. getpwuid(3) — perl ships with macOS and is not shadowed by $HOME.
	if command -v perl >/dev/null 2>&1; then
		home="$(perl -e 'my @p = getpwuid($<); print $p[7] if @p' 2>/dev/null)"
		if [[ -n $home ]]; then
			CATALYST_LAUNCHD_GUARD_REAL_HOME="$home"
			CATALYST_LAUNCHD_GUARD_REASON="real home resolved via getpwuid"
			return 0
		fi
	fi

	# 3. `~user` tilde expansion consults the passwd database, NOT $HOME.
	#    (A bare `~` WOULD read $HOME, which is exactly the value under suspicion.)
	home="$(eval printf '%s' "~${user}" 2>/dev/null)"
	if [[ -n $home && $home != "~${user}" ]]; then
		CATALYST_LAUNCHD_GUARD_REAL_HOME="$home"
		CATALYST_LAUNCHD_GUARD_REASON="real home resolved via ~${user} expansion"
		return 0
	fi

	CATALYST_LAUNCHD_GUARD_REASON="could not resolve the real home for '${user}' (dscl, getpwuid and ~${user} all failed)"
	return 1
}

# rc 0 = safe to mutate gui/<uid>. Fails CLOSED: an unresolvable real home
# refuses rather than assuming the current $HOME is fine.
launchd_guard_ok() {
	local ctx="${1:-launchd agent install}"
	CATALYST_LAUNCHD_GUARD_REASON=""

	if [[ ${CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD:-0} == "1" ]]; then
		CATALYST_LAUNCHD_GUARD_REASON="allowed: CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1 (caller declares launchctl is sealed)"
		return 0
	fi

	if ! launchd_guard_resolve_real_home; then
		# REASON already names which resolvers failed.
		return 1
	fi

	local real cur
	real="$(_ldg_physical "$CATALYST_LAUNCHD_GUARD_REAL_HOME")"
	cur="$(_ldg_physical "${HOME:-}")"

	if [[ -z ${HOME:-} ]]; then
		CATALYST_LAUNCHD_GUARD_REASON="HOME is unset, so the plist path for ${ctx} cannot be trusted"
		return 1
	fi

	if [[ $cur != "$real" ]]; then
		CATALYST_LAUNCHD_GUARD_REASON="HOME (${cur}) is not this user's real home (${real})"
		return 1
	fi

	CATALYST_LAUNCHD_GUARD_REASON="HOME matches the real home (${real})"
	return 0
}

# The operator-facing refusal. Says what was refused, why, both paths, and the
# two ways forward — because "refused" with no route is how a guard gets deleted.
launchd_guard_message() {
	local ctx="${1:-launchd agent install}"
	printf '%s\n' \
		"REFUSING to bootstrap ${ctx} into gui/$(id -u 2>/dev/null)." \
		"  reason: ${CATALYST_LAUNCHD_GUARD_REASON}" \
		"  The launchd per-user domain is per-USER, not per-HOME: bootstrapping a" \
		"  plist rendered under a scratch HOME would re-bind the REAL label to a" \
		"  path that disappears when that HOME is cleaned up (CTL-1968)." \
		"  If you are a test that has already sealed launchctl, declare it:" \
		"    export CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1" \
		"  If you meant to install for real, run with your own HOME."
}
