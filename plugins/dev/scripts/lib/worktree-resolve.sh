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

# A branch serves $ticket when it IS the ticket (execution-core convention) or is
# EXACTLY "<orch-id>-<ticket>" (the legacy convention orchestrate-dispatch-next
# uses for ${WORKTREE_BASE}/${ORCH_ID}-${T}).
#
# CAT-31 review P1: the legacy arm used to be a bare `*-<ticket>` glob, which also
# matched any ordinary developer branch whose name happens to end in the ticket key
# — `fix-CAT-100`, `revert-CAT-100`, `wip-CAT-100`. Because the cwd-serving rung is
# consulted BEFORE the registry, dispatch standing in such a checkout would rebase
# and launch the worker there instead of the registered CAT-100 worktree, and strict
# mode would accept it as a legitimate source. A suffix alone does not establish
# orchestrator identity.
#
# There is no shape to pattern-match against: real orchestrator ids are arbitrary
# (`demo`, `exec-core-tracer`, `o-adv-1103-1088-...`, `ctl-123-126`). The only sound
# discriminator is the id itself, which every dispatch path already has — the
# dispatchers export CATALYST_ORCHESTRATOR_ID, and phase-agent-dispatch keeps it in
# ORCH_ID when it came from --orch-id. WTR_ORCH_ID lets a caller pass it explicitly.
#
# FAILS CLOSED: with no orchestrator id in scope we cannot establish that identity,
# so only the exact ticket branch serves. The resolver then falls through to the
# registry / cwd-repo rungs, which resolve BY TICKET — the safe answer.
_wtr_branch_serves_ticket() {
	local branch="$1" ticket="$2"
	local orch="${WTR_ORCH_ID:-${CATALYST_ORCHESTRATOR_ID:-${ORCH_ID:-}}}"
	[[ -n $branch && -n $ticket ]] || return 1
	[[ $branch == "$ticket" ]] && return 0
	[[ -n $orch ]] || return 1
	[[ $branch == "${orch}-${ticket}" ]]
}

# Print nothing; succeed when $1 is the TOP LEVEL of a git worktree whose checked-out
# branch serves $ticket.
#
# CAT-31 review P1: `--worktree` was accepted on `[[ -d ]]` alone, so an unrelated
# existing checkout — or a stale path since repurposed for another ticket — was
# returned as source=explicit and strict mode permitted the dispatch. The dispatcher
# then cd's there, rebases it, and launches the ticket's worker in the wrong tree.
# Requiring the path to BE a worktree root (not a subdirectory of one) and to be
# serving this ticket closes that without loosening anything: the in-tree caller
# passes a freshly created worktree root checked out on the ticket branch.
_wtr_path_serves_ticket() {
	# NB: the first local is named wt_path, NOT path. Under zsh, `path` is a
	# special array tied to $PATH; `local path` scopes it locally and resets it
	# to empty, making `git` unresolvable (command not found) so the function
	# always returns 1. Bash treats `path` as ordinary. CTL-1777; see also
	# linear-team-keys.sh:22-27 for the prior fix in the same class.
	local wt_path="$1" ticket="$2" top="" branch=""
	[[ -n $wt_path && -n $ticket ]] || return 1
	top="$(git -C "$wt_path" rev-parse --show-toplevel 2>/dev/null)" || return 1
	[[ -n $top ]] || return 1
	top="$(cd "$top" 2>/dev/null && pwd -P)" || return 1
	[[ $top == "$wt_path" ]] || return 1
	branch="$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
	_wtr_branch_serves_ticket "$branch" "$ticket"
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
	# shellcheck disable=SC2034 # public breadcrumb consumed by source callers
	WT_RESOLVE_EXPLICIT_MISMATCH=0
	if [[ -n $explicit ]]; then
		if candidate="$(_wtr_abs "$explicit")" && _wtr_path_serves_ticket "$candidate" "$ticket"; then
			WT_RESOLVE_SOURCE="explicit"; WTR_RESOLVED_PATH="$candidate"; printf '%s' "$candidate"; return 0
		fi
		# CAT-31 review P1: a stale, mistyped, or WRONG --worktree must NOT
		# short-circuit to the caller's cwd — with strict mode off by default that
		# silently creates signals, rebases and launches the ticket worker in an
		# unrelated checkout. Fall through to the rungs that resolve BY TICKET.
		#
		# "Wrong" covers an existing directory that is not a worktree root, or one
		# whose branch serves a different ticket; MISMATCH distinguishes that from a
		# path that simply is not there. Both keep source=explicit-missing, because
		# that is the value CATALYST_DISPATCH_WORKTREE_STRICT refuses on — a new
		# source string would silently slip past the strict-mode case.
		bad_explicit=1
		WT_RESOLVE_EXPLICIT_MISSING=1
		[[ -n $candidate ]] && WT_RESOLVE_EXPLICIT_MISMATCH=1
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
