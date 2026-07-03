#!/usr/bin/env bash
# lib/worktree-remove-guard.sh — CTL-1417. Refuse a `git worktree remove --force`
# whose target is the caller's own cwd (at-or-under) OR is held by a live
# process. The shell port of CTL-791 worktree-safety.mjs `lsofCwdUnder` /
# `cwdUnder`, for the three shell removal sites the Node reaper gate never
# covered. Fail-closed: if liveness cannot be probed, refuse.
#
# Usage:  assert_worktree_removal_safe <target-path>
# Returns 0 = safe to remove, non-zero = refuse (reason on stderr).
# Seam:   WT_GUARD_LSOF overrides the lsof binary (default: lsof) for tests.

_wtg_realpath() { # realpath with a pure-shell fallback (macOS/BSD flags differ)
	local p="${1%/}"
	if command -v realpath >/dev/null 2>&1; then
		realpath -q "$p" 2>/dev/null || printf '%s' "$p"
	else
		printf '%s' "$p"
	fi
}

assert_worktree_removal_safe() {
	local target="${1:-}"
	if [[ -z ${target// /} ]]; then
		echo "worktree-remove-guard: refusing removal of empty/blank target" >&2
		return 2
	fi
	local rt cwd
	rt="$(_wtg_realpath "$target")"
	cwd="$(_wtg_realpath "$PWD")"

	# (a) cwd-containment: cwd == target, or cwd nested under target.
	if [[ $cwd == "$rt" || $cwd == "$rt"/* ]]; then
		echo "worktree-remove-guard: refusing — cwd ($cwd) is at/under target ($rt)" >&2
		return 3
	fi

	# (b) foreign-liveness via lsof (fail-closed).
	local lsof_bin="${WT_GUARD_LSOF:-lsof}"
	local out rc
	out="$("$lsof_bin" -nP +D "$rt" 2>/dev/null)"
	rc=$?
	if [[ $rc -eq 1 && -z ${out// /} ]]; then
		return 0 # lsof: definitively nothing under the tree
	fi
	if [[ $rc -ne 0 && $rc -ne 1 ]]; then
		echo "worktree-remove-guard: refusing — lsof probe failed (rc=$rc) for $rt" >&2
		return 4 # fail-closed
	fi
	if [[ -n ${out// /} ]]; then
		echo "worktree-remove-guard: refusing — live handle(s) under $rt" >&2
		return 5
	fi
	return 0
}
