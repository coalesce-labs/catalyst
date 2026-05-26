#!/usr/bin/env bash
# lib/worktree-presweep.sh — stop all claude --bg sessions whose cwd is under
# the given worktree path. Must be called BEFORE any `git worktree remove` to
# prevent ORPHAN supervisor leaks (CTL-649 Component 5: ~70% of the observed
# 157-session leak was sessions whose cwd worktree had been yanked out from
# under them).
#
# Usage: worktree-presweep.sh [--force] <worktree-path>
#
# Exit codes:
#   0 — no sessions remain (or --force was set and we tried)
#   1 — sessions still alive after the attempt and --force was not set
#   2 — usage error

set -uo pipefail

_SRC="${BASH_SOURCE[0]}"
while [[ -L $_SRC ]]; do _SRC="$(readlink "$_SRC")"; done
LIB_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

# shellcheck source=./claude-ids.sh
. "$LIB_DIR/claude-ids.sh"
# shellcheck source=./executor.sh
. "$LIB_DIR/executor.sh"
# shellcheck source=./emit-reap-intent.sh
. "$LIB_DIR/emit-reap-intent.sh"

FORCE=0
WORKTREE=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	--force)
		FORCE=1
		shift
		;;
	-*)
		echo "worktree-presweep: unknown flag: $1" >&2
		exit 2
		;;
	*)
		WORKTREE="$1"
		shift
		;;
	esac
done

if [[ -z $WORKTREE ]]; then
	echo "usage: worktree-presweep.sh [--force] <path>" >&2
	exit 2
fi

# Normalise: strip trailing slash. We compare cwd prefixes with startswith()
# so a trailing slash would mismatch `/wt/CTL-1` against `/wt/CTL-1/`.
WORKTREE="${WORKTREE%/}"

# Prefer the --cwd filter when available — `claude agents --json --cwd <path>`
# is the cleanest primitive. Fall back to a full listing if the flag is not
# supported (older claude binaries).
sessions_json=""
if sessions_json="$("$(executor_claude_bin)" agents --json --cwd "$WORKTREE" 2>/dev/null)"; then
	:
else
	sessions_json="$("$(executor_claude_bin)" agents --json 2>/dev/null || echo '[]')"
fi
[[ -z $sessions_json || $sessions_json == "null" ]] && exit 0

# Extract sessionIds whose cwd starts with $WORKTREE. We do this in jq
# unconditionally — even when --cwd worked — so the prefix-match contract is
# enforced from one code path.
mapfile -t session_ids < <(
	printf '%s' "$sessions_json" | jq -r --arg wt "$WORKTREE" \
		'.[]? | select(.cwd != null and (.cwd | startswith($wt))) | .sessionId' 2>/dev/null
)

if [[ ${#session_ids[@]} -eq 0 ]]; then
	exit 0
fi

failures=0
for sid in "${session_ids[@]}"; do
	[[ -z $sid ]] && continue

	# CTL-649 comment 9a3d0645: feeding a full UUID to `claude stop` returns
	# rc=1 silently. Convert to the 8-char short ID first.
	short_id="$(short_id_from_session_id "$sid" 2>/dev/null)" || {
		failures=$((failures + 1))
		continue
	}

	# Self-protection: skip the operator's own controlling session. If the
	# presweep is ever called against the operator's own worktree, killing
	# self mid-cleanup disconnects them.
	if is_self_session "$sid"; then
		echo "worktree-presweep: skipping self-session $short_id" >&2
		continue
	fi

	# Emit intent for traceability (consumer is execution-core/reaper.mjs).
	# The reconciler is idempotent: even if our direct executor_reap below
	# also stops the session, the reaper's no-op-when-already-gone branch
	# absorbs the duplicate.
	emit_reap_intent worktree.presweep.reap-requested \
		--session-id "$short_id" --worktree-path "$WORKTREE" 2>/dev/null || true

	# Directly stop the session — we cannot wait for the reconciler before
	# `git worktree remove` runs (would re-introduce the ORPHAN race).
	if ! executor_reap "$short_id" >/dev/null 2>&1; then
		failures=$((failures + 1))
	fi
done

if [[ $failures -gt 0 && $FORCE -eq 0 ]]; then
	echo "worktree-presweep: $failures session(s) still alive in $WORKTREE; pass --force to proceed" >&2
	exit 1
fi

exit 0
