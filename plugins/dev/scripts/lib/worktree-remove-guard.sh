#!/usr/bin/env bash
# lib/worktree-remove-guard.sh — CTL-1417. Refuse a `git worktree remove --force`
# whose target is the caller's own cwd (at-or-under) OR is held by a live
# process. The shell port of CTL-791 worktree-safety.mjs `lsofCwdUnder` /
# `cwdUnder`, for the shell removal sites the Node reaper gate never covered.
# Fail-closed: if liveness cannot be probed, refuse.
#
# Usage:  assert_worktree_removal_safe <target-path>
# Returns 0 = safe to remove, non-zero = refuse (reason on stderr).
# Seam:   WT_GUARD_LSOF overrides the lsof binary (default: lsof) for tests.

[[ -n "${_WT_REMOVE_GUARD_LOADED:-}" ]] && return 0
_WT_REMOVE_GUARD_LOADED=1

_wtg_realpath() { # realpath with a pure-shell fallback (macOS/BSD lack -m widely)
	local p="${1%/}"
	if command -v realpath >/dev/null 2>&1; then
		realpath -q "$p" 2>/dev/null || printf '%s' "$p"
	else
		printf '%s' "$p"
	fi
}

# _wtg_self_pids — the PID set to EXEMPT from the foreign-liveness probe: this
# guard's own shell ($$), its parent ($PPID) and the full ancestor chain up to
# init. Mirrors orphan-sweep.sh `_sweep_self_pids` / worktree-safety.mjs's
# self-exclusion. During normal teardown the Claude worker stays alive with its
# cwd AT the ticket worktree while its Bash child (this guard) moves to the
# primary checkout — that worker is one of our ANCESTORS, so walking the chain
# is what stops the guard from detecting itself and refusing every removal.
# Populates the memo $_WTG_SELF_PIDS (a space-delimited " a b c " set) rather
# than printing — a `$( )` read would run the walk in a subshell and discard it.
_WTG_SELF_PIDS=""
_wtg_self_pids() {
	[[ -n "$_WTG_SELF_PIDS" ]] && return 0
	local p="$$" n=0 parent
	_WTG_SELF_PIDS=" 1 $$ ${PPID:-1} "
	while [[ "$p" =~ ^[0-9]+$ ]] && [[ "$p" -gt 1 ]] && [[ $n -lt 32 ]]; do
		parent="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' | head -1)"
		[[ "$parent" =~ ^[0-9]+$ ]] || break
		_WTG_SELF_PIDS="${_WTG_SELF_PIDS}${parent} "
		p="$parent"
		n=$((n + 1))
	done
	return 0
}

_wtg_is_self_pid() { # <pid> — true iff pid is this guard's shell or an ancestor
	_wtg_self_pids # no $( ) — must mutate THIS shell
	case "$_WTG_SELF_PIDS" in *" $1 "*) return 0 ;; esac
	return 1
}

# _wtg_run_capped — run a command under a 10s wall-clock cap, mirroring the
# bound worktree-safety.mjs puts on the same `lsof +D` (an unbounded recursive
# lsof can block forever on a slow/stale mount and wedge orphan-sweep /
# phase-dispatch, which now call this guard SYNCHRONOUSLY). Prefers GNU
# `timeout`/`gtimeout`; when neither exists (stock macOS) it backgrounds the
# command and kills it after the cap. Exit 124 on timeout — the caller treats
# that as inconclusive → fail-closed.
_wtg_run_capped() { # <secs> <cmd...>
	local secs="$1"
	shift
	if command -v timeout >/dev/null 2>&1; then
		timeout "$secs" "$@"
	elif command -v gtimeout >/dev/null 2>&1; then
		gtimeout "$secs" "$@"
	else
		# Pure-shell fallback: run in the background, poll for completion up to
		# the cap, then SIGKILL and report 124 (matching `timeout`'s convention).
		"$@" &
		local cmd_pid=$! waited=0
		while kill -0 "$cmd_pid" 2>/dev/null; do
			if [[ $waited -ge $((secs * 10)) ]]; then
				kill -9 "$cmd_pid" 2>/dev/null
				wait "$cmd_pid" 2>/dev/null
				return 124
			fi
			sleep 0.1
			waited=$((waited + 1))
		done
		wait "$cmd_pid"
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

	# (b) foreign-liveness via lsof (fail-closed). Three hardening rules vs. the
	# original bare probe (CTL-1417 codex review):
	#   • BOUND it (10s cap) — an unbounded recursive `lsof +D` can wedge on a
	#     slow/stale mount and stall the synchronous callers (orphan-sweep,
	#     phase-dispatch). Timeout → inconclusive → refuse.
	#   • CAPTURE stderr — `lsof +D` can exit 1 with a traversal/permission
	#     DIAGNOSTIC and empty stdout; that is inconclusive, NOT "nothing under
	#     the tree". A diagnostic → refuse rather than let --force delete a tree
	#     whose live handles couldn't be enumerated.
	#   • EXEMPT self — `-F pn` yields one `p<pid>` line per holder; we drop the
	#     teardown worker's own process tree ($$/ancestors) before deciding, so
	#     the guard doesn't detect ITSELF and refuse every merged worktree.
	local lsof_bin="${WT_GUARD_LSOF:-lsof}"
	local out rc errfile
	errfile="$(mktemp -t wtg-lsof-err-XXXXXX 2>/dev/null)" || errfile=""
	if [[ -n $errfile ]]; then
		out="$(_wtg_run_capped 10 "$lsof_bin" -nP -F pn +D "$rt" 2>"$errfile")"
		rc=$?
	else
		# mktemp unavailable — cannot separate stderr; fail-closed conservatively.
		out="$(_wtg_run_capped 10 "$lsof_bin" -nP -F pn +D "$rt" 2>/dev/null)"
		rc=$?
	fi
	local err=""
	[[ -n $errfile ]] && { err="$(cat "$errfile" 2>/dev/null)"; rm -f "$errfile"; }

	# Timeout (124 from the cap) → inconclusive → refuse.
	if [[ $rc -eq 124 ]]; then
		echo "worktree-remove-guard: refusing — lsof probe timed out (>10s) for $rt" >&2
		return 4 # fail-closed
	fi
	# lsof binary missing / unable to spawn (rc≥126) → refuse.
	if [[ $rc -ge 126 ]]; then
		echo "worktree-remove-guard: refusing — lsof probe failed (rc=$rc) for $rt" >&2
		return 4 # fail-closed
	fi
	# A stderr diagnostic means the traversal was incomplete — inconclusive,
	# regardless of rc. lsof exits 1 both for "nothing found" (clean) and for a
	# partial/permission-denied walk (diagnostic on stderr) — only the latter
	# emits to stderr, so the diagnostic is the discriminator.
	if [[ -n ${err// /} ]]; then
		echo "worktree-remove-guard: refusing — lsof reported an error (inconclusive) for $rt" >&2
		return 4 # fail-closed
	fi
	# Any other unexpected rc (not 0 = matches, not 1 = none) → refuse.
	if [[ $rc -ne 0 && $rc -ne 1 ]]; then
		echo "worktree-remove-guard: refusing — lsof probe failed (rc=$rc) for $rt" >&2
		return 4 # fail-closed
	fi

	# Enumerate the holder PIDs from the `-F p` lines, dropping our own session's
	# process tree. Any FOREIGN pid left ⇒ a live handle we must respect.
	local line pid foreign=0
	while IFS= read -r line; do
		[[ $line == p* ]] || continue # only PID field lines
		pid="${line#p}"
		[[ $pid =~ ^[0-9]+$ ]] || continue
		_wtg_is_self_pid "$pid" && continue
		foreign=1
		break
	done <<<"$out"

	if [[ $foreign -eq 1 ]]; then
		echo "worktree-remove-guard: refusing — live handle(s) under $rt" >&2
		return 5
	fi
	return 0 # nothing foreign under the tree
}
