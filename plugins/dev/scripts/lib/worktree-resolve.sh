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

# A branch serves $ticket when it IS the ticket (execution-core convention) or
# ends in "-<ticket>" (the legacy "<orch-id>-<ticket>" convention that
# orchestrate-dispatch-next uses for ${WORKTREE_BASE}/${ORCH_ID}-${T}).
_wtr_branch_serves_ticket() {
	local branch="$1" ticket="$2"
	[[ -n $branch && -n $ticket ]] || return 1
	[[ $branch == "$ticket" || $branch == *-"$ticket" ]]
}

# Print the toplevel of the CURRENT worktree when its checked-out branch already
# serves $ticket; otherwise fail. Used to keep an already-correct caller in place.
_wtr_cwd_serves_ticket() {
	local ticket="$1" branch="" top=""
	branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
	_wtr_branch_serves_ticket "$branch" "$ticket" || return 1
	top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
	[[ -n $top ]] || return 1
	printf '%s' "$top"
}

resolve_ticket_worktree() {
	local ticket="$1" explicit="${2:-}" candidate="" repo="" bad_explicit=0
	# shellcheck disable=SC2034 # public breadcrumbs consumed by source callers
	WT_RESOLVE_SOURCE=""
	WT_RESOLVE_EXPLICIT_MISSING=0
	if [[ -n $explicit ]]; then
		if candidate="$(_wtr_abs "$explicit")"; then WT_RESOLVE_SOURCE="explicit"; WTR_RESOLVED_PATH="$candidate"; printf '%s' "$candidate"; return 0; fi
		# CAT-31 review P1: a stale or mistyped --worktree must NOT short-circuit to
		# the caller's cwd — with strict mode off by default that silently creates
		# signals, rebases and launches the ticket worker in an unrelated checkout.
		# Fall through to the rungs that resolve BY TICKET instead.
		bad_explicit=1
		WT_RESOLVE_EXPLICIT_MISSING=1
	fi
	# CAT-31 review P1: when the caller is already standing in a worktree whose
	# branch serves this ticket, keep it. A registry-first lookup would otherwise
	# redirect an already-correct legacy dispatch (branch "<orch-id>-<ticket>")
	# into a same-ticket execution-core checkout and rebase the wrong tree.
	if candidate="$(_wtr_cwd_serves_ticket "$ticket")" && [[ -n $candidate ]] && candidate="$(_wtr_abs "$candidate")"; then
		WT_RESOLVE_SOURCE="cwd-serves-ticket"; WTR_RESOLVED_PATH="$candidate"; printf '%s' "$candidate"; return 0
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
	# Nothing resolved by ticket. Preserve "explicit-missing" when the caller passed
	# a bad --worktree so strict mode still refuses the dispatch.
	if [[ $bad_explicit == 1 ]]; then WT_RESOLVE_SOURCE="explicit-missing"; else WT_RESOLVE_SOURCE="fallback-cwd"; fi
	WTR_RESOLVED_PATH="$(pwd -P)"; printf '%s' "$WTR_RESOLVED_PATH"; return 0
}
