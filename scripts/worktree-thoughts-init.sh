#!/usr/bin/env bash
# Vendored replacement for `humanlayer thoughts init` (CTL-845).
# Creates the thoughts symlink layout + registers the per-worktree repoMapping
# directly, without invoking the crashing `humanlayer thoughts init` CLI
# (v0.17.2-npm: ERR_INVALID_ARG_TYPE on fresh installs).
#
# Usage: worktree-thoughts-init.sh --directory <dir> [--profile <profile>]
#   --directory  repo/dir name under <thoughtsRepo>/<reposDir>/  (required)
#   --profile    humanlayer profile whose thoughtsRepo/dirs to use (optional)
# Runs in the worktree cwd. Exits non-zero (no partial layout) when it cannot
# resolve humanlayer.json — the create-worktree CTL-513 guard then fails fast.
set -uo pipefail

DIRECTORY=""
PROFILE=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--directory)
		DIRECTORY="$2"
		shift 2
		;;
	--profile)
		PROFILE="$2"
		shift 2
		;;
	*)
		echo "worktree-thoughts-init: unknown arg: $1" >&2
		exit 2
		;;
	esac
done
[[ -n "$DIRECTORY" ]] || {
	echo "worktree-thoughts-init: --directory is required" >&2
	exit 2
}

HL="${HUMANLAYER_CONFIG:-$HOME/.config/humanlayer/humanlayer.json}"
[[ -f "$HL" ]] || {
	echo "worktree-thoughts-init: humanlayer.json not found at $HL" >&2
	exit 1
}
command -v jq >/dev/null 2>&1 || {
	echo "worktree-thoughts-init: jq is required" >&2
	exit 1
}

# Resolve config, preferring the profile's overrides, falling back to top-level.
read_cfg() {
	local field="$1" v=""
	if [[ -n "$PROFILE" ]]; then
		v="$(jq -r --arg p "$PROFILE" --arg k "$field" '.thoughts.profiles[$p][$k] // empty' "$HL")"
	fi
	[[ -n "$v" ]] || v="$(jq -r --arg k "$field" '.thoughts[$k] // empty' "$HL")"
	printf '%s' "$v"
}

THOUGHTS_REPO="$(read_cfg thoughtsRepo)"
REPOS_DIR="$(read_cfg reposDir)"
REPOS_DIR="${REPOS_DIR:-repos}"
GLOBAL_DIR="$(read_cfg globalDir)"
GLOBAL_DIR="${GLOBAL_DIR:-global}"
USER_NAME="$(jq -r '.thoughts.user // empty' "$HL")"

[[ -n "$THOUGHTS_REPO" ]] || {
	echo "worktree-thoughts-init: could not resolve thoughtsRepo from $HL" >&2
	exit 1
}

REPO_BASE="$THOUGHTS_REPO/$REPOS_DIR/$DIRECTORY"
# Ensure central targets exist (idempotent).
mkdir -p "$REPO_BASE/shared" "$THOUGHTS_REPO/$GLOBAL_DIR"
[[ -n "$USER_NAME" ]] && mkdir -p "$REPO_BASE/$USER_NAME"

# Build the layout in the worktree cwd (idempotent via ln -sfn).
mkdir -p thoughts/searchable
ln -sfn "$THOUGHTS_REPO/$GLOBAL_DIR" thoughts/global
ln -sfn "$REPO_BASE/shared" thoughts/shared
if [[ -n "$USER_NAME" ]]; then
	ln -sfn "$REPO_BASE/$USER_NAME" "thoughts/$USER_NAME"
else
	echo "worktree-thoughts-init: warning — no .thoughts.user in $HL; skipping per-user symlink" >&2
fi

# Register the per-worktree repoMapping so `humanlayer thoughts sync` indexes it.
WT_ABS="$(pwd -P)"
MAP_PROFILE="${PROFILE:-$(jq -r '.thoughts.defaultProfile // "coalesce-labs"' "$HL")}"
TMP="$(mktemp)"
jq --arg k "$WT_ABS" --arg r "$DIRECTORY" --arg p "$MAP_PROFILE" \
	'.thoughts.repoMappings[$k] = {"repo":$r,"profile":$p}' "$HL" >"$TMP" && mv "$TMP" "$HL"

echo "worktree-thoughts-init: thoughts layout ready in $WT_ABS ($DIRECTORY)"
