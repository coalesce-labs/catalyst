#!/usr/bin/env bash
# direnv-provision.sh — the direnv half of making a host owner-ready (CTL-1944, CTL-1956).
#
# ⛔ WHY THIS IS A LIBRARY AND NOT JUST PART OF install-cli.sh. install-cli is a full join stage:
# CLI wrappers, PATH bootstrap, alloy, agent-browser. Remediating a host that is merely missing
# direnv should not require running all of that — during a schema rollout it is exactly the kind
# of broad, badly-timed change an operator declines, so the narrow fix never gets applied and the
# host stays broken. Sourcing the same two functions from `check-direnv-fleet.sh --install` gives
# the narrow path WITHOUT a second implementation to drift (CTL-1908's whole lesson).
#
# Both functions are IDEMPOTENT and WARN+CONTINUE (never return non-zero): install-cli must not
# exit non-zero over direnv. The loud signal is check-direnv-fleet.sh's exit code.

# ensure_direnv — install direnv when absent (CTL-1944). Every fleet host must be able to
# materialize the direnv-backed tokens (LINEAR_API_TOKEN / GITHUB_TOKEN / CLOUDFLARE_API_TOKEN)
# that a remote owner needs; mini-2 had no direnv at all and every Linear read on it failed,
# discovered mid-run rather than at provisioning time.
#
# ⛔ Why this INSTALLS instead of only reporting: `brew install direnv` typed on one host is the
# uncodified machine edit CTL-1908 proved drifts — that fix lived on the laptop for nine hours
# while both minis still carried the incident condition. The codified installer is the fix.
#
# Same warn+continue contract as ensure_alloy/ensure_agent_browser: install-cli must not exit
# non-zero here. The RED signal is check-direnv-fleet.sh, which fails the host loudly.
ensure_direnv() {
	if command -v direnv >/dev/null 2>&1; then
		echo "  direnv $(direnv version 2>/dev/null || echo '?') present ($(command -v direnv))"
		return 0
	fi

	if command -v brew >/dev/null 2>&1; then
		echo "  Installing direnv via brew (CTL-1944)…"
		brew install direnv >/dev/null 2>&1 || true
		hash -r 2>/dev/null || true
		if command -v direnv >/dev/null 2>&1; then
			echo "  Installed direnv $(direnv version 2>/dev/null || echo '?') ($(command -v direnv))"
			return 0
		fi
		echo "  warning: 'brew install direnv' failed — falling back to the release download" >&2
	fi

	# ⛔ CTL-1956: THE BREW-ONLY PATH SHIPPED INERT ON THE HOSTS THIS EXISTS FOR. CTL-1944 returned
	# here with a warning whenever brew was absent — and NEITHER fleet mini has brew. So on mini and
	# mini-2, the two hosts the ticket was written about, the codified installer installed nothing,
	# and mini's direnv is at ~/.local/bin because somebody typed it. That is the CTL-1919/CTL-1935
	# "the fix is real, the delivery is not" class, and it is the reason this fallback exists.
	#
	# direnv ships a BARE static binary per platform (direnv.<os>-<arch>) — no archive, no jq needed
	# for the asset name. Mirrors ensure_alloy's release-download shape otherwise: arch/OS detect →
	# ~/.local/bin → verify on PATH. Same warn+continue contract.
	if ! command -v curl >/dev/null 2>&1; then
		echo "  warning: direnv absent and neither brew nor curl is available — this host cannot materialize fleet tokens" >&2
		return 0
	fi
	local dv_os dv_arch dv_ver dv_url
	case "$(uname -s)" in Darwin) dv_os="darwin" ;; Linux) dv_os="linux" ;; *) dv_os="" ;; esac
	case "$(uname -m)" in arm64 | aarch64) dv_arch="arm64" ;; x86_64 | amd64) dv_arch="amd64" ;; *) dv_arch="" ;; esac
	if [[ -z $dv_os || -z $dv_arch ]]; then
		echo "  warning: unsupported platform for direnv auto-install ($(uname -s)/$(uname -m)) — install direnv manually" >&2
		return 0
	fi
	# Pin to the version the fleet already runs, so a host joining today does not silently land on a
	# direnv whose `direnv status` output this stack has never parsed. check-direnv-fleet.sh handles
	# the 2.32/2.37 `Found RC allowed` encodings and FAILS CLOSED on a third — an unpinned upgrade is
	# exactly how a host would acquire that third encoding.
	dv_ver="${CATALYST_DIRENV_VERSION:-v2.37.1}"
	dv_url="https://github.com/direnv/direnv/releases/download/${dv_ver}/direnv.${dv_os}-${dv_arch}"
	mkdir -p "$HOME/.local/bin"
	echo "  Installing direnv ${dv_ver} → ~/.local/bin (no brew on this host — CTL-1956)…"
	if curl -fsSL "$dv_url" -o "$HOME/.local/bin/direnv.tmp" 2>/dev/null; then
		chmod +x "$HOME/.local/bin/direnv.tmp" 2>/dev/null || true
		# Prove the download RUNS before it takes the name. A truncated or HTML-error-page download is
		# still a file; moving it into place first would leave a direnv that exists and cannot execute,
		# which reads as "installed" to every `command -v` check downstream.
		if "$HOME/.local/bin/direnv.tmp" version >/dev/null 2>&1; then
			mv -f "$HOME/.local/bin/direnv.tmp" "$HOME/.local/bin/direnv"
		else
			rm -f "$HOME/.local/bin/direnv.tmp"
			echo "  warning: downloaded direnv did not execute (truncated or wrong asset) — left the previous state alone" >&2
		fi
	fi
	export PATH="$HOME/.local/bin:$PATH"
	hash -r 2>/dev/null || true

	if command -v direnv >/dev/null 2>&1; then
		echo "  Installed direnv $(direnv version 2>/dev/null || echo '?') ($(command -v direnv))"
	else
		echo "  warning: direnv install failed — this host cannot materialize fleet tokens, and a remote owner launched here will not be able to read Linear" >&2
	fi
	return 0
}

# ensure_direnv_runtime — the rest of the direnv runtime, which the binary alone does not give you
# (CTL-1956). Measured on mini-2: direnv was one of FOUR missing pieces, and three of them were
# invisible to every check we had.
#
#   lib/profiles.sh   defines `use_profile`      — was in NO repo; now vendored next to otel.sh
#   lib/otel.sh       defines `use_otel_context` — vendored already, but nothing INSTALLED it
#   coalesce-labs/.envrc  the `source_up` target every catalyst-cloud .envrc walks up to
#   profiles/*.env    the token files themselves (cluster-sync owns catalyst-cloud.env)
#
# ⛔ NEVER CLOBBER. mini's personal.env / catalyst.env are richer than anything this could write,
# and overwriting them would break a working host to fix a broken one. Every write here is
# create-if-absent; the lib/ helpers are the sole exception (they are code, not credentials, and
# the vendored copy is by definition the current one). Same warn+continue contract as ensure_direnv.
ensure_direnv_runtime() {
	local cfg="${XDG_CONFIG_HOME:-$HOME/.config}/direnv"
	# ⛔ Resolved from THIS FILE, two levels up (plugins/dev/scripts/lib → plugins/dev), not from the
	# caller. When these functions lived in install-cli.sh one level was correct; moving them here
	# silently re-pointed the lookup at plugins/dev/scripts/direnv/lib, which does not exist — so the
	# provisioning step would have "run" and installed nothing. The test asserts the vendored files
	# are found, which is what catches this.
	local vendored
	vendored="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/direnv/lib"

	mkdir -p "$cfg/lib" "$cfg/profiles" 2>/dev/null || true
	local lib
	for lib in profiles otel; do
		if [[ -f "$vendored/${lib}.sh" ]]; then
			if ! cmp -s "$vendored/${lib}.sh" "$cfg/lib/${lib}.sh" 2>/dev/null; then
				cp "$vendored/${lib}.sh" "$cfg/lib/${lib}.sh" 2>/dev/null &&
					echo "  Installed direnv lib/${lib}.sh → $cfg/lib/" ||
					echo "  warning: could not install direnv lib/${lib}.sh — use_profile/use_otel_context will be undefined here" >&2
			fi
		else
			echo "  warning: vendored direnv lib/${lib}.sh missing from the checkout — cannot provision it" >&2
		fi
	done

	# The `source_up` target. catalyst-cloud/.envrc calls source_up, which walks to
	# <repos>/coalesce-labs/.envrc; absent, `use_profile personal` never runs and CLOUDFLARE_API_TOKEN
	# is empty. Two non-secret lines, so it is created — but only if it is not already there.
	local org_dir="$HOME/code-repos/github/coalesce-labs"
	if [[ -d $org_dir && ! -f "$org_dir/.envrc" ]]; then
		printf 'use_profile personal
use_otel_context "coalesce-labs"
' >"$org_dir/.envrc" 2>/dev/null &&
			echo "  Created $org_dir/.envrc (source_up target, CTL-1956)" ||
			echo "  warning: could not create $org_dir/.envrc — source_up will find nothing" >&2
	fi

	# Placeholder profiles. `use_profile X` FAILS the whole .envrc when profiles/X.env is absent, so
	# a host without personal.env cannot load catalyst-cloud.env either — one missing file takes down
	# every token. A placeholder makes the chain evaluate; the credentials still come from the
	# cluster bundle. Create-if-absent, so mini's real files are untouched.
	local prof
	for prof in personal catalyst; do
		if [[ ! -f "$cfg/profiles/${prof}.env" ]]; then
			cat >"$cfg/profiles/${prof}.env" <<PLACEHOLDER 2>/dev/null || true
# ${prof}.env — PLACEHOLDER created by install-cli.sh (CTL-1956).
#
# Empty on purpose. \`use_profile ${prof}\` fails the ENTIRE .envrc when this file does not exist,
# which on mini-2 meant one absent file emptied every token including the ones another profile
# supplies. Cluster-shared credentials arrive via cluster-sync in catalyst-cloud.env; anything
# host-local goes here by hand and this file is then never rewritten (create-if-absent).
PLACEHOLDER
			chmod 600 "$cfg/profiles/${prof}.env" 2>/dev/null || true
			echo "  Created placeholder profile ${prof}.env (was absent — CTL-1956)"
		fi
	done
	return 0
}
