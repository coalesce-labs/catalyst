#!/usr/bin/env bash
# Secret-hygiene check functions (CTL-1203). Source me; do not execute directly.
# Each function prints FAIL: … to stderr on violation and returns non-zero.
# bash-3.2 safe: no mapfile, no associative arrays.

# Portable self-path: BASH_SOURCE under bash, prompt-expansion %x under zsh.
# shellcheck disable=SC2296
__SHC_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
__SHC_LIB_DIR="$(cd "$(dirname "$__SHC_SELF")" && pwd)"
source "${__SHC_LIB_DIR}/portable-stat.sh"

# check_secret_file_modes [config_dir]
# Fail if any config_dir/config*.json is group/other readable (perm bits & 077 set).
check_secret_file_modes() {
	local config_dir="${1:-${CATALYST_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/catalyst}}"
	local rc=0 mode oct f
	for f in "${config_dir}"/config*.json; do
		[[ -f "$f" ]] || continue
		if ! mode="$(portable_stat_mode "$f")"; then
			echo "FAIL: ${f} mode unreadable" >&2
			rc=1
			continue
		fi
		if ! oct="$(portable_stat_mode_oct "$f")"; then
			echo "FAIL: ${f} mode unreadable" >&2
			rc=1
			continue
		fi
		if (( (oct & 63) != 0 )); then
			echo "FAIL: ${f} is mode ${mode} (expected 600, group/other readable)" >&2
			rc=1
		fi
	done
	return $rc
}

# check_secrets_not_in_worktree [config_dir]
# Fail if config_dir is inside a git work tree.
check_secrets_not_in_worktree() {
	local config_dir="${1:-${CATALYST_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/catalyst}}"
	if git -C "$config_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		echo "FAIL: ${config_dir} is inside a git work tree — secrets must not be git-tracked" >&2
		return 1
	fi
	return 0
}

# check_no_secrets_in_layer1 [repo_root]
# Grep committed Layer-1 file(s) for known secret prefixes. Fail on any match.
check_no_secrets_in_layer1() {
	local repo_root="${1:-${CATALYST_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}}"
	local layer1="${repo_root}/.catalyst/config.json"
	local rc=0 pattern
	if [[ ! -f "$layer1" ]]; then
		return 0
	fi
	for pattern in 'lin_api_' 'lin_oauth' 'sntrys_' 'phc_'; do
		if grep -q "$pattern" "$layer1" 2>/dev/null; then
			echo "FAIL: secret pattern '${pattern}' found in Layer-1 file ${layer1}" >&2
			rc=1
		fi
	done
	return $rc
}
