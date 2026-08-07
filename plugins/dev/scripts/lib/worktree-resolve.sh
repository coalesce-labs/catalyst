#!/usr/bin/env bash
# Read-only ticket -> worktree resolver (CAT-31). Keep in sync with
# execution-core/worktree.mjs:parseWorktreeForBranch.

[[ -n "${__CATALYST_WORKTREE_RESOLVE_SOURCED:-}" ]] && return 0
__CATALYST_WORKTREE_RESOLVE_SOURCED=1

_wtr_registry_path() { printf '%s/execution-core/registry.json' "${CATALYST_DIR:-$HOME/catalyst}"; }
_wtr_team_of() { printf '%s' "${1%-*}" | tr '[:lower:]' '[:upper:]'; }
_wtr_repo_root_for_team() {
	local team="$1" reg root
	reg="$(_wtr_registry_path)"
	[[ -r $reg ]] || return 0
	command -v jq >/dev/null 2>&1 || return 0
	root="$(jq -r --arg t "$team" '.projects[]? | select(.team == $t) | .repoRoot // empty' "$reg" 2>/dev/null | head -1)"
	[[ -n $root && -d $root ]] || return 0
	printf '%s' "$root"
}
_wtr_worktree_for_branch() {
	local repo="$1" ticket="$2" want="refs/heads/$2" cur="" line
	[[ -n $repo && -d $repo ]] || return 0
	while IFS= read -r line; do
		case "$line" in
		"worktree "*) cur="${line#worktree }" ;;
		"branch "*) [[ ${line#branch } == "$want" ]] && { printf '%s' "$cur"; return 0; } ;;
		esac
	done < <(git -C "$repo" worktree list --porcelain 2>/dev/null)
	return 0
}
_wtr_abs() { [[ -d $1 ]] || return 1; (cd "$1" 2>/dev/null && pwd -P) || return 1; }

resolve_ticket_worktree() {
	local ticket="$1" explicit="${2:-}" candidate="" repo=""
	# shellcheck disable=SC2034 # public breadcrumb consumed by source callers
	WT_RESOLVE_SOURCE=""
	if [[ -n $explicit ]]; then
		if candidate="$(_wtr_abs "$explicit")"; then WT_RESOLVE_SOURCE="explicit"; WTR_RESOLVED_PATH="$candidate"; printf '%s' "$candidate"; return 0; fi
		WT_RESOLVE_SOURCE="explicit-missing"; WTR_RESOLVED_PATH="$(pwd -P)"; printf '%s' "$WTR_RESOLVED_PATH"; return 0
	fi
	repo="$(_wtr_repo_root_for_team "$(_wtr_team_of "$ticket")")"
	if [[ -n $repo ]]; then
		candidate="$(_wtr_worktree_for_branch "$repo" "$ticket")"
		if [[ -n $candidate ]] && candidate="$(_wtr_abs "$candidate")"; then WT_RESOLVE_SOURCE="registry"; WTR_RESOLVED_PATH="$candidate"; printf '%s' "$candidate"; return 0; fi
	fi
	if repo="$(git rev-parse --show-toplevel 2>/dev/null)" && [[ -n $repo ]]; then
		candidate="$(_wtr_worktree_for_branch "$repo" "$ticket")"
		if [[ -n $candidate ]] && candidate="$(_wtr_abs "$candidate")"; then WT_RESOLVE_SOURCE="cwd-repo"; WTR_RESOLVED_PATH="$candidate"; printf '%s' "$candidate"; return 0; fi
	fi
	WT_RESOLVE_SOURCE="fallback-cwd"; WTR_RESOLVED_PATH="$(pwd -P)"; printf '%s' "$WTR_RESOLVED_PATH"; return 0
}
