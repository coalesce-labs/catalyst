#!/usr/bin/env bash
# Secret-hygiene check functions (CTL-1203). Source me; do not execute directly.
# Each function prints FAIL: … to stderr on violation and returns non-zero.
# bash-3.2 safe: no mapfile, no associative arrays.

# Portable file-mode reader (BSD stat vs GNU stat).
_shc_file_mode() {
	stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

# check_secret_file_modes [config_dir]
# Fail if any config_dir/config*.json is group/other readable (perm bits & 077 set).
check_secret_file_modes() {
	local config_dir="${1:-${CATALYST_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/catalyst}}"
	local rc=0 mode f
	for f in "${config_dir}"/config*.json; do
		[[ -f "$f" ]] || continue
		mode="$(_shc_file_mode "$f")"
		# Check if group or other bits are set (last two octal digits != 00)
		local last2="${mode#?}"  # strip leading digit (owner)
		if [[ "$last2" != "00" ]]; then
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
