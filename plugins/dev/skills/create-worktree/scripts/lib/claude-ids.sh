#!/usr/bin/env bash
# lib/claude-ids.sh — translate between full UUID `.sessionId` (returned by
# `claude agents --json`) and the 8-char short job ID that `claude stop`,
# `claude kill`, `claude attach`, `claude logs`, `claude respawn`, and
# `claude rm` all require.
#
# Background (CTL-649 comment 9a3d0645): feeding a full UUID to `claude stop`
# returns `No job matching '<uuid>'` and rc=1 — silently 100% of the time.
# Truncating to the first 8 hex chars matches the short job ID that
# `claude --bg` prints to stdout as the "backgrounded · <hex>" banner.
#
# Sourceable. Idempotent.

if [[ -n "${__CATALYST_CLAUDE_IDS_SOURCED:-}" ]]; then
	return 0
fi
__CATALYST_CLAUDE_IDS_SOURCED=1

# short_id_from_session_id INPUT
#
# Echoes the 8-char hex short ID.
#   90c9a8a7-4a61-4dd7-b46d-8a4735afc6c2 → 90c9a8a7
#   90c9a8a7                              → 90c9a8a7
# Rejects empty/malformed input with rc=2.
short_id_from_session_id() {
	local input="${1-}"
	if [[ -z $input ]]; then
		echo "short_id_from_session_id: empty input" >&2
		return 2
	fi
	if [[ $input =~ ^[0-9a-f]{8}$ ]]; then
		printf '%s' "$input"
		return 0
	fi
	if [[ $input =~ ^([0-9a-f]{8})- ]]; then
		printf '%s' "${BASH_REMATCH[1]}"
		return 0
	fi
	echo "short_id_from_session_id: malformed input '$input'" >&2
	return 2
}

# is_self_session CANDIDATE
#
# Returns 0 (true) when CANDIDATE matches $CLAUDE_CODE_SESSION_ID — either as
# the full UUID or the 8-char prefix. Returns 1 (false) otherwise, including
# when $CLAUDE_CODE_SESSION_ID is unset (no self to protect).
#
# Mandatory guard for prune subcommands: without it, an operator running
# `catalyst-execution-core sessions prune --yes` kills their own controlling
# session mid-cleanup.
is_self_session() {
	local candidate="${1-}"
	[[ -z $candidate || -z ${CLAUDE_CODE_SESSION_ID-} ]] && return 1
	local self_short candidate_short
	self_short="$(short_id_from_session_id "$CLAUDE_CODE_SESSION_ID" 2>/dev/null)" || return 1
	candidate_short="$(short_id_from_session_id "$candidate" 2>/dev/null)" || return 1
	[[ "$self_short" == "$candidate_short" ]]
}
