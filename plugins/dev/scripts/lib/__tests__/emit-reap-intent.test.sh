#!/usr/bin/env bash
# Shell tests for lib/emit-reap-intent.sh — event-log emission of reap-intent
# events (CTL-649 Phase 4).
#
# Run: bash plugins/dev/scripts/lib/__tests__/emit-reap-intent.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../emit-reap-intent.sh
. "$LIB_DIR/emit-reap-intent.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

export CATALYST_EVENTS_DIR="$SCRATCH/events"
EVENT_LOG="${CATALYST_EVENTS_DIR}/$(date -u +%Y-%m).jsonl"

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

echo "emit-reap-intent tests (CTL-649)"

# ── 1. happy path ────────────────────────────────────────────────────────────
rm -rf "$CATALYST_EVENTS_DIR"
if emit_reap_intent phase.yield.reap-requested \
	--ticket CTL-999 --phase implement --bg-job-id abc12345 \
	--reason duplicate-of-canonical; then
	pass "emit succeeded"
else
	fail "emit succeeded"
fi

[ -f "$EVENT_LOG" ] && pass "event log created" || fail "event log created"

LAST=$(tail -1 "$EVENT_LOG" 2>/dev/null)
[ "$(printf '%s' "$LAST" | jq -r '.event')" = "phase.yield.reap-requested" ] &&
	pass "event field correct" || fail "event field correct: $LAST"
[ "$(printf '%s' "$LAST" | jq -r '.ticket')" = "CTL-999" ] &&
	pass "ticket field correct" || fail "ticket field correct"
[ "$(printf '%s' "$LAST" | jq -r '.bg_job_id')" = "abc12345" ] &&
	pass "bg_job_id field correct" || fail "bg_job_id field correct"
[ "$(printf '%s' "$LAST" | jq -r '.reason')" = "duplicate-of-canonical" ] &&
	pass "reason field correct" || fail "reason field correct"

# Valid ISO ts
TS=$(printf '%s' "$LAST" | jq -r '.ts')
if [[ $TS =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
	pass "ts is ISO 8601"
else
	fail "ts is ISO 8601: $TS"
fi

# ── 2. unknown event rejected ────────────────────────────────────────────────
if emit_reap_intent nonsense.event --ticket CTL-1 2>/dev/null; then
	fail "unknown event type rejected"
else
	pass "unknown event type rejected"
fi

# ── 3. all 8 event types accepted ────────────────────────────────────────────
rm -rf "$CATALYST_EVENTS_DIR"
for evt in phase.yield.reap-requested phase.predecessor.reap-requested \
	phase.supersede.reap-requested phase.revive.reap-requested \
	phase.abort.reap-requested worktree.presweep.reap-requested \
	pr.merged.cleanup-requested orphans.reap-requested; do
	if emit_reap_intent "$evt" --ticket CTL-1 --phase x --bg-job-id deadbeef; then
		pass "accepts $evt"
	else
		fail "accepts $evt"
	fi
done

# ── 4. multi-flag payload preserves all values ───────────────────────────────
rm -rf "$CATALYST_EVENTS_DIR"
emit_reap_intent phase.revive.reap-requested \
	--ticket CTL-7 --phase implement \
	--bg-job-id 12345678 \
	--worktree-path /wt/CTL-7 \
	--quiet-ms 30000
LAST=$(tail -1 "$EVENT_LOG")
[ "$(printf '%s' "$LAST" | jq -r '.worktree_path')" = "/wt/CTL-7" ] &&
	pass "worktree_path threaded" || fail "worktree_path threaded"
[ "$(printf '%s' "$LAST" | jq -r '.quiet_ms')" = "30000" ] &&
	pass "quiet_ms threaded as number" || fail "quiet_ms threaded as number"

# ── 5. pr.merged.cleanup-requested carries branch ────────────────────────────
rm -rf "$CATALYST_EVENTS_DIR"
emit_reap_intent pr.merged.cleanup-requested \
	--ticket CTL-9 --worktree-path /wt/CTL-9 --branch ryan/ctl-9
LAST=$(tail -1 "$EVENT_LOG")
[ "$(printf '%s' "$LAST" | jq -r '.branch')" = "ryan/ctl-9" ] &&
	pass "branch field threaded" || fail "branch field threaded"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
