#!/usr/bin/env bash
# lib/executor.sh — executor seam for phase-agent background jobs (CTL-567).
#
# Sourceable library. The single place that owns the two `claude` background-job
# verbs — `claude --bg` (launch) and `claude stop` (reap). Keeping both behind
# this one file means a cloud executor (Claude Managed Agent, etc.) can swap the
# launch and the stop together by replacing this file alone (design doc D9).
#
# This file is sourced into scripts that run with `set -uo pipefail`; it does
# NOT `set -e` and every function is safe to call without aborting the caller.
#
# Functions:
#   executor_claude_bin          echo the claude binary to use
#   executor_job_cpu <job_id>    echo the job process CPU% (float), or "" if unknown
#   executor_reap <job_id>       CPU-safety-belt + `claude stop`; echo a status word
#
# Env overrides:
#   CATALYST_DISPATCH_CLAUDE_BIN  claude binary (default: `claude` on PATH). Same
#                                 var the dispatchers already honor for the launch.
#   CATALYST_EXECUTOR_JOBS_ROOT   bg-job state dir (default: $CLAUDE_BG_JOBS_DIR
#                                 or ~/.claude/jobs)
#   CATALYST_EXECUTOR_CPU_PROBE   test hook: a command run as `$cmd <job_id>` that
#                                 echoes the job's CPU%, bypassing the
#                                 state.json → claude agents → ps resolution chain
#   EXECUTOR_CPU_REAP_CEILING     CPU% above which a job counts as actively
#                                 computing and is NOT reaped (default: 3)

# executor_claude_bin — the claude binary. Cloud-executor swap point.
executor_claude_bin() {
	echo "${CATALYST_DISPATCH_CLAUDE_BIN:-claude}"
}

# executor_kind — CTL-1365a: which phase-worker substrate this node uses
# (bg|sdk|oneshot-legacy). Reads CATALYST_EXECUTOR; defaults to "bg" when unset —
# the seam 1b/1c branch on (e.g. executor_reap → no-op under sdk). INERT in this
# PR: the bg launch verb (executor_claude_bin) and executor_reap are unchanged,
# so a node with CATALYST_EXECUTOR unset behaves byte-identically to today.
executor_kind() {
	echo "${CATALYST_EXECUTOR:-bg}"
}

# _executor_jobs_root — where `claude --bg` writes per-job state.json dirs.
_executor_jobs_root() {
	echo "${CATALYST_EXECUTOR_JOBS_ROOT:-${CLAUDE_BG_JOBS_DIR:-$HOME/.claude/jobs}}"
}

# _executor_agents_json — `claude agents --json`, memoized for this process so a
# scan-and-reap loop pays the cost once rather than once per job.
_executor_agents_json() {
	if [ -z "${_EXECUTOR_AGENTS_CACHE+x}" ]; then
		_EXECUTOR_AGENTS_CACHE="$("$(executor_claude_bin)" agents --json 2>/dev/null || echo '[]')"
		[ -n "$_EXECUTOR_AGENTS_CACHE" ] || _EXECUTOR_AGENTS_CACHE='[]'
	fi
	printf '%s' "$_EXECUTOR_AGENTS_CACHE"
}

# executor_job_cpu <job_id> — echo the CPU% of the job's process, or "" when it
# cannot be determined (no state.json, no live process, etc.). The 8-hex bg job
# id does not itself name a process: resolve it via
#   state.json.sessionId → `claude agents --json` match → .pid → ps %cpu.
executor_job_cpu() {
	local job_id="$1"
	[ -n "$job_id" ] || {
		echo ""
		return 0
	}

	# Test hook: a probe command fully bypasses the resolution chain.
	if [ -n "${CATALYST_EXECUTOR_CPU_PROBE:-}" ]; then
		"$CATALYST_EXECUTOR_CPU_PROBE" "$job_id" 2>/dev/null || echo ""
		return 0
	fi

	local state_file sid pid cpu
	state_file="$(_executor_jobs_root)/${job_id}/state.json"
	[ -f "$state_file" ] || {
		echo ""
		return 0
	}
	sid="$(jq -r '.sessionId // empty' "$state_file" 2>/dev/null || echo "")"
	[ -n "$sid" ] || {
		echo ""
		return 0
	}
	pid="$(_executor_agents_json | jq -r --arg s "$sid" \
		'.[]? | select(.sessionId == $s) | .pid' 2>/dev/null | head -1)"
	[ -n "$pid" ] || {
		echo ""
		return 0
	}
	cpu="$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')"
	echo "$cpu"
}

# executor_reap <job_id> — CPU safety belt, then `claude stop <job_id>`.
# Echoes exactly one status word:
#   stopped        the job was stopped
#   skipped-active the process is above the CPU ceiling — left running
#   skipped-empty  no job id given
#   stop-failed    `claude stop` returned non-zero (already gone, or a real error)
# Returns 0 only on `stopped`. Best-effort by contract — callers treat a
# non-`stopped` result as informational, never fatal.
executor_reap() {
	local job_id="$1"
	if [ -z "$job_id" ]; then
		echo "skipped-empty"
		return 1
	fi

	local ceiling cpu
	ceiling="${EXECUTOR_CPU_REAP_CEILING:-3}"
	cpu="$(executor_job_cpu "$job_id")"

	# Safety belt: never reap an actively-computing process. Block only when the
	# CPU is known AND strictly above the ceiling — an unknown CPU means there is
	# no live process to protect, so reaping (a harmless no-op) is safe.
	if [ -n "$cpu" ] && awk -v c="$cpu" -v ceil="$ceiling" \
		'BEGIN { exit !((c + 0) > (ceil + 0)) }'; then
		echo "skipped-active"
		return 1
	fi

	if "$(executor_claude_bin)" stop "$job_id" >/dev/null 2>&1; then
		echo "stopped"
		return 0
	fi
	echo "stop-failed"
	return 1
}
