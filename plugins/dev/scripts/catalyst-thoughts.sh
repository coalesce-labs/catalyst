#!/usr/bin/env bash
# catalyst-thoughts.sh — repair and verify the humanlayer thoughts system for a Catalyst project.
#
# Subcommands:
#   init-or-repair   Ensure thoughts/ is a correct humanlayer layout (symlinks + subdirs).
#                    Re-uses `humanlayer thoughts init --force` when humanlayer is configured
#                    and .catalyst/config.json declares catalyst.thoughts.{profile,directory}.
#                    Fails loudly (non-zero) if thoughts/shared exists as a regular directory —
#                    this is the bug state that silently masks a clobbered humanlayer symlink.
#                    Falls back to bare `mkdir -p` with a loud warning only when humanlayer is
#                    absent and no thoughts config exists (genuinely fresh project).
#
#   check            Verify thoughts/ state. Prints findings to stderr and exits non-zero when:
#                      - thoughts/shared or thoughts/global is a regular directory (bug state)
#                      - either is a dangling symlink
#                      - profile in .catalyst/config.json disagrees with humanlayer's mapping
#                      - directory in .catalyst/config.json disagrees with humanlayer's mapping

set -uo pipefail

CMD="${1:-}"
shift || true

CONFIG_FILE=".catalyst/config.json"
SUBDIRS=(research plans handoffs prs reports)

_read_thoughts_config() {
	[[ -f "$CONFIG_FILE" ]] || return 1
	CAT_PROFILE=$(jq -r '.catalyst.thoughts.profile // empty' "$CONFIG_FILE" 2>/dev/null)
	CAT_DIR=$(jq -r '.catalyst.thoughts.directory // empty' "$CONFIG_FILE" 2>/dev/null)
}

# Prints "<profile>\t<repo>" for the CWD, or empty string if no humanlayer or no mapping.
_humanlayer_mapping() {
	command -v humanlayer &>/dev/null || return 1
	local cwd
	cwd="$(pwd)"
	humanlayer thoughts config --json 2>/dev/null |
		jq -r --arg cwd "$cwd" '.repoMappings[$cwd] // empty | "\(.profile // "")\t\(.repo // "")"'
}

_mkdir_subdirs() {
	local base="$1"
	local d
	for d in "${SUBDIRS[@]}"; do
		mkdir -p "$base/$d"
	done
}

cmd_init_or_repair() {
	# Case A: thoughts/shared is a valid symlink → check for profile/directory drift
	# between .catalyst/config.json and humanlayer's mapping. If found, repair by
	# `humanlayer thoughts uninit --force` followed by re-`init` with the config's
	# profile/directory. Safe because thoughts content lives in the canonical
	# thoughts repo, not in the symlink target. Otherwise, just ensure subdirs.
	if [[ -L "thoughts/shared" && -d "thoughts/shared" ]]; then
		if command -v humanlayer &>/dev/null && _read_thoughts_config && [[ -n "${CAT_DIR:-}" ]]; then
			local mapping hl_profile hl_repo needs_fix=0
			mapping="$(_humanlayer_mapping 2>/dev/null || true)"
			if [[ -n "$mapping" ]]; then
				hl_profile="$(printf '%s' "$mapping" | cut -f1)"
				hl_repo="$(printf '%s' "$mapping" | cut -f2)"
				if [[ -n "${CAT_PROFILE:-}" && -n "$hl_profile" && "$CAT_PROFILE" != "$hl_profile" ]]; then
					needs_fix=1
				fi
				if [[ -n "$hl_repo" && "$CAT_DIR" != "$hl_repo" ]]; then
					needs_fix=1
				fi
			fi
			if [[ $needs_fix -eq 1 ]]; then
				echo "  Drift detected between .catalyst/config.json and humanlayer mapping — repairing."
				echo "  Running: humanlayer thoughts uninit --force"
				if ! humanlayer thoughts uninit --force; then
					echo "ERROR: humanlayer thoughts uninit failed" >&2
					return 1
				fi
				local init_args=(thoughts init --directory "$CAT_DIR")
				[[ -n "${CAT_PROFILE:-}" ]] && init_args+=(--profile "$CAT_PROFILE")
				echo "  Running: humanlayer ${init_args[*]}"
				if ! humanlayer "${init_args[@]}"; then
					echo "ERROR: humanlayer thoughts init failed" >&2
					return 1
				fi
				_mkdir_subdirs "thoughts/shared"
				return 0
			fi
		fi
		_mkdir_subdirs "thoughts/shared"
		return 0
	fi

	# Case B: thoughts/shared exists but is NOT a symlink → the bug state. Refuse to touch it.
	if [[ -e "thoughts/shared" && ! -L "thoughts/shared" ]]; then
		{
			echo "ERROR: thoughts/shared is a regular directory but humanlayer expects a symlink."
			echo "       The humanlayer symlink was clobbered (usually by a bare 'mkdir -p')."
			echo "       Writes to thoughts/shared/ are NOT syncing to any central thoughts repo."
			echo
			echo "Recovery:"
			echo "  mv thoughts/shared thoughts/shared.orphaned-\$(date +%Y%m%d)"
			echo "  rsync -a --ignore-existing thoughts/shared.orphaned-*/  <canonical-thoughts-path>/"
			echo "  bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
		} >&2
		return 2
	fi

	# Case C: thoughts/shared does not exist. Prefer humanlayer re-init when configured.
	if command -v humanlayer &>/dev/null && _read_thoughts_config && [[ -n "${CAT_DIR:-}" ]]; then
		local init_args=(thoughts init --force --directory "$CAT_DIR")
		if [[ -n "${CAT_PROFILE:-}" ]]; then
			init_args+=(--profile "$CAT_PROFILE")
		fi
		echo "  Running: humanlayer ${init_args[*]}"
		if humanlayer "${init_args[@]}"; then
			_mkdir_subdirs "thoughts/shared"
			return 0
		fi
		echo "ERROR: humanlayer thoughts init failed" >&2
		return 1
	fi

	# Case D: no humanlayer and/or no thoughts config. Fall back with a loud warning.
	{
		echo "WARNING: Creating thoughts/shared/ as a regular directory."
		echo "         Writes will NOT sync to a central thoughts repo."
		echo "         To enable syncing, install humanlayer and run:"
		echo "           humanlayer thoughts init --profile <profile> --directory <name>"
	} >&2
	_mkdir_subdirs "thoughts/shared"
	return 0
}

cmd_check() {
	local rc=0

	# 1. Symlink-vs-directory assertions on the two required top-level entries.
	local top
	for top in shared global; do
		if [[ -e "thoughts/$top" && ! -L "thoughts/$top" ]]; then
			{
				echo "ERROR: thoughts/$top is a regular directory but should be a symlink — humanlayer init was bypassed."
				echo "       Recovery: mv thoughts/$top thoughts/$top.orphaned-\$(date +%Y%m%d); bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
			} >&2
			rc=2
		elif [[ -L "thoughts/$top" && ! -e "thoughts/$top" ]]; then
			echo "ERROR: thoughts/$top is a symlink with a missing target." >&2
			rc=2
		fi
	done

	# 2. Profile / directory drift between .catalyst/config.json and humanlayer's mapping.
	if _read_thoughts_config; then
		local mapping hl_profile hl_repo
		mapping="$(_humanlayer_mapping 2>/dev/null || true)"
		if [[ -n "$mapping" ]]; then
			hl_profile="$(printf '%s' "$mapping" | cut -f1)"
			hl_repo="$(printf '%s' "$mapping" | cut -f2)"
			if [[ -n "${CAT_PROFILE:-}" && -n "$hl_profile" && "$CAT_PROFILE" != "$hl_profile" ]]; then
				echo "ERROR: Profile drift — .catalyst/config.json has '${CAT_PROFILE}', humanlayer has '${hl_profile}' for this repo." >&2
				rc=3
			fi
			if [[ -n "${CAT_DIR:-}" && -n "$hl_repo" && "$CAT_DIR" != "$hl_repo" ]]; then
				echo "ERROR: Directory drift — .catalyst/config.json has '${CAT_DIR}', humanlayer has '${hl_repo}' for this repo." >&2
				rc=3
			fi
		fi
	fi

	return $rc
}

case "$CMD" in
	init-or-repair) cmd_init_or_repair "$@" ;;
	check) cmd_check "$@" ;;
	*)
		cat >&2 <<EOF
Usage: catalyst-thoughts.sh {init-or-repair|check}

  init-or-repair   Create or repair thoughts/ for a Catalyst project.
                   Re-uses humanlayer when configured; fails loudly if thoughts/shared
                   exists as a regular directory (the symlink-clobbered bug state).

  check            Verify thoughts/ state; non-zero on any broken state.
EOF
		exit 64
		;;
esac
