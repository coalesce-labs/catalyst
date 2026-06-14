#!/usr/bin/env bash
# lib/assert-thoughts-project.sh — assert thoughts/shared belongs to this project (CTL-1081).
#
# Verifies that the thoughts/shared symlink target contains /repos/<directory>/
# where <directory> is read from the nearest ancestor .catalyst/config.json's
# catalyst.thoughts.directory field.
#
# Exit codes:
#   0  — assertion passed (or cannot be determined — fail-open)
#   1  — mismatch (wrong project's thoughts root); stderr names both paths
#
# Usage: source or execute from the worktree cwd.
# Bash-3.2 safe.

set -uo pipefail

_resolve_config_dir() {
	command -v jq >/dev/null 2>&1 || return 0
	local dir
	dir="$(pwd)"
	while [[ $dir != "/" ]]; do
		if [[ -f "${dir}/.catalyst/config.json" ]]; then
			echo "$dir"
			return 0
		fi
		dir="$(dirname "$dir")"
	done
}

CONFIG_DIR="$(_resolve_config_dir)"
if [[ -z "$CONFIG_DIR" ]]; then
	# No config found — fail-open (non-orchestrated run or missing config).
	exit 0
fi

THOUGHTS_DIR="$(jq -r '.catalyst.thoughts.directory // empty' \
	"${CONFIG_DIR}/.catalyst/config.json" 2>/dev/null || true)"
if [[ -z "$THOUGHTS_DIR" ]]; then
	# thoughts.directory not configured — fail-open.
	exit 0
fi

# Resolve the symlink target of thoughts/shared (relative to the worktree cwd).
SYMLINK_TARGET=""
if [[ -L "thoughts/shared" ]]; then
	SYMLINK_TARGET="$(readlink "thoughts/shared" 2>/dev/null || true)"
elif [[ -L "${CONFIG_DIR}/thoughts/shared" ]]; then
	SYMLINK_TARGET="$(readlink "${CONFIG_DIR}/thoughts/shared" 2>/dev/null || true)"
fi

if [[ -z "$SYMLINK_TARGET" ]]; then
	# Symlink absent or unresolvable — fail-open.
	exit 0
fi

# The expected layout segment inside the target path.
EXPECTED_SEGMENT="/repos/${THOUGHTS_DIR}/"

if printf '%s' "$SYMLINK_TARGET" | grep -qF "$EXPECTED_SEGMENT"; then
	# Assertion passed — the symlink points to the right project's thoughts tree.
	exit 0
fi

# Extract the actual segment for the error message.
ACTUAL_SEGMENT="$(printf '%s' "$SYMLINK_TARGET" | sed -n 's|.*/repos/\([^/]*\)/.*|\1|p')"
if [[ -z "$ACTUAL_SEGMENT" ]]; then
	ACTUAL_SEGMENT="$SYMLINK_TARGET"
fi

echo "assert-thoughts-project: thoughts/shared points to wrong project" >&2
echo "  expected: …/repos/${THOUGHTS_DIR}/shared" >&2
echo "  actual:   ${SYMLINK_TARGET} (segment: ${ACTUAL_SEGMENT})" >&2
exit 1
