#!/usr/bin/env bash
# lib/emit-reap-intent.sh — append a reap-intent event to the canonical event
# log at ~/catalyst/events/YYYY-MM.jsonl. Sourced by producers; vocabulary is
# closed (unknown event types are rejected) to keep the schema disciplined.
#
# The reconciler (execution-core/reaper.mjs) consumes these events and calls
# the appropriate executor (`claude stop`, `git worktree remove`, etc.).
# Producers emit, the daemon reacts — the executor seam is single.
#
# Events:
#   phase.yield.reap-requested        worker bowed out via inverse-yield
#   phase.predecessor.reap-requested  successor phase wants its predecessor reaped
#   phase.supersede.reap-requested    stale signal dominated by later phase
#   phase.revive.reap-requested       revive's defensive-kill of a previous worker
#   phase.abort.reap-requested        abort-worker path
#   worktree.presweep.reap-requested  one entry per session under a worktree
#   pr.merged.cleanup-requested       worktree + branch teardown on merge
#   orphans.reap-requested            periodic-timer hint to scan for orphans
#
# Each has corresponding `*.reap-complete` and `*.reap-failed` echoes emitted
# by the reconciler.

if [[ -n "${__CATALYST_EMIT_REAP_INTENT_SOURCED:-}" ]]; then
	return 0
fi
__CATALYST_EMIT_REAP_INTENT_SOURCED=1

_REAP_INTENT_TYPES=(
	phase.yield.reap-requested
	phase.predecessor.reap-requested
	phase.supersede.reap-requested
	phase.revive.reap-requested
	phase.abort.reap-requested
	worktree.presweep.reap-requested
	pr.merged.cleanup-requested
	orphans.reap-requested
)

# _reap_events_dir — resolve the canonical event log directory. Honors
# CATALYST_EVENTS_DIR (tests set this to a scratch path); falls back to
# ~/catalyst/events. Matches execution-core/config.mjs:getEventLogPath().
_reap_events_dir() {
	if [[ -n ${CATALYST_EVENTS_DIR:-} ]]; then
		printf '%s' "$CATALYST_EVENTS_DIR"
	else
		printf '%s/catalyst/events' "$HOME"
	fi
}

# emit_reap_intent EVENT_TYPE [--ticket T] [--phase P] [--bg-job-id ID]
#                             [--worktree-path P] [--session-id S]
#                             [--branch B] [--reason R]
#                             [--canonical-bg-job-id ID]
#                             [--dominant-phase P] [--quiet-ms N]
#
# Appends one JSONL line to the monthly event log. Returns 2 on unknown event
# type or unknown flag, 0 on success, non-zero on write failure (producer
# falls back to inline reap).
emit_reap_intent() {
	local event_type="${1-}"
	[[ -z $event_type ]] && {
		echo "emit_reap_intent: event type required" >&2
		return 2
	}
	shift

	local valid=0 t
	for t in "${_REAP_INTENT_TYPES[@]}"; do
		[[ "$t" == "$event_type" ]] && {
			valid=1
			break
		}
	done
	if [[ $valid -eq 0 ]]; then
		echo "emit_reap_intent: unknown reap-intent event type: $event_type" >&2
		return 2
	fi

	local ts
	ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	local payload="{\"ts\":\"$ts\",\"event\":\"$event_type\""

	while [[ $# -gt 0 ]]; do
		case "$1" in
		--ticket) payload+=",\"ticket\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--phase) payload+=",\"phase\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--bg-job-id) payload+=",\"bg_job_id\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--worktree-path) payload+=",\"worktree_path\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--session-id) payload+=",\"session_id\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--branch) payload+=",\"branch\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--reason) payload+=",\"reason\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--canonical-bg-job-id) payload+=",\"canonical_bg_job_id\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--dominant-phase) payload+=",\"dominant_phase\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		--quiet-ms) payload+=",\"quiet_ms\":$2"; shift 2 ;;
		--orch-id) payload+=",\"orch_id\":$(printf '%s' "$2" | jq -R .)"; shift 2 ;;
		*)
			echo "emit_reap_intent: unknown flag: $1" >&2
			return 2
			;;
		esac
	done
	payload+="}"

	local dir
	dir="$(_reap_events_dir)"
	mkdir -p "$dir" 2>/dev/null || return 1
	local month_file
	month_file="${dir}/$(date -u +%Y-%m).jsonl"
	printf '%s\n' "$payload" >>"$month_file" 2>/dev/null || return 1
	return 0
}

# Allow direct invocation for ad-hoc testing / scripts.
if ! (return 0 2>/dev/null); then
	emit_reap_intent "$@"
fi
