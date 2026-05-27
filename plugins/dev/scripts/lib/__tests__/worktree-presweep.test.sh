#!/usr/bin/env bash
# Shell tests for lib/worktree-presweep.sh — stop bg sessions whose cwd is
# under a worktree before the worktree is removed (CTL-649 Phase 2 — primary
# 70% leak fix).
#
# Uses stub `claude` binary on PATH so the test never hits the real CLI.
#
# Run: bash plugins/dev/scripts/lib/__tests__/worktree-presweep.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PRESWEEP="$LIB_DIR/worktree-presweep.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Stub claude binary on PATH. CLAUDE_AGENTS_JSON_FIXTURE / CLAUDE_STOP_RC /
# CLAUDE_STOP_LOG control its behaviour per test.
STUB_BIN="$SCRATCH/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/claude" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  agents)
    cat "${CLAUDE_AGENTS_JSON_FIXTURE:-/dev/null}"
    ;;
  stop)
    echo "$2" >> "${CLAUDE_STOP_LOG:-/tmp/claude_stop.log}"
    exit "${CLAUDE_STOP_RC:-0}"
    ;;
esac
STUB
chmod +x "$STUB_BIN/claude"
export PATH="$STUB_BIN:$PATH"
export CATALYST_DISPATCH_CLAUDE_BIN="$STUB_BIN/claude"
export EXECUTOR_CPU_REAP_CEILING=100   # never block on CPU in tests
export CATALYST_EVENTS_DIR="$SCRATCH/events"

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; echo "    log: $(cat "${CLAUDE_STOP_LOG:-/dev/null}" 2>/dev/null)"; }

write_agents_fixture() {
	local f="$SCRATCH/agents.json"
	cat >"$f"
	export CLAUDE_AGENTS_JSON_FIXTURE="$f"
}
reset_stop_log() {
	CLAUDE_STOP_LOG="$SCRATCH/stop.log"
	export CLAUDE_STOP_LOG
	: >"$CLAUDE_STOP_LOG"
}
reset_event_log() {
	rm -rf "$CATALYST_EVENTS_DIR"
}

echo "worktree-presweep tests (CTL-649)"

# ── 1. stops sessions matching the worktree prefix; truncates to 8 chars ─────
write_agents_fixture <<'JSON'
[
  {"pid":100,"cwd":"/wt/CTL-1","sessionId":"11111111-aaaa-bbbb-cccc-dddddddddddd","status":"idle"},
  {"pid":101,"cwd":"/wt/CTL-1/sub","sessionId":"22222222-aaaa-bbbb-cccc-dddddddddddd","status":"active"},
  {"pid":102,"cwd":"/wt/CTL-2","sessionId":"33333333-aaaa-bbbb-cccc-dddddddddddd","status":"idle"}
]
JSON
reset_stop_log
reset_event_log

if "$PRESWEEP" /wt/CTL-1; then
	pass "presweep with matching sessions exits 0"
else
	fail "presweep with matching sessions exits 0"
fi

grep -q '^11111111$' "$CLAUDE_STOP_LOG" && pass "stopped 11111111 (short ID)" || fail "stopped 11111111"
grep -q '^22222222$' "$CLAUDE_STOP_LOG" && pass "stopped 22222222 (sub-dir match)" || fail "stopped 22222222"
grep -q '^33333333$' "$CLAUDE_STOP_LOG" && fail "did NOT stop 33333333 (out of scope)" || pass "spared 33333333"
grep -q '\-aaaa\-' "$CLAUDE_STOP_LOG" && fail "no full UUID leaked to stop" || pass "no full UUID leaked to stop"

# ── 2. empty agents JSON → exit 0, no stops ─────────────────────────────────
write_agents_fixture <<<'[]'
reset_stop_log
reset_event_log
if "$PRESWEEP" /wt/CTL-1; then
	pass "empty agents → exit 0"
else
	fail "empty agents → exit 0"
fi
[ ! -s "$CLAUDE_STOP_LOG" ] && pass "no stops when no sessions" || fail "no stops when no sessions"

# ── 3. self-protection: skips $CLAUDE_CODE_SESSION_ID ──────────────────────
export CLAUDE_CODE_SESSION_ID="11111111-aaaa-bbbb-cccc-dddddddddddd"
write_agents_fixture <<'JSON'
[
  {"pid":100,"cwd":"/wt/CTL-1","sessionId":"11111111-aaaa-bbbb-cccc-dddddddddddd","status":"idle"},
  {"pid":101,"cwd":"/wt/CTL-1","sessionId":"22222222-aaaa-bbbb-cccc-dddddddddddd","status":"idle"}
]
JSON
reset_stop_log
reset_event_log
"$PRESWEEP" /wt/CTL-1 2>/dev/null || true
grep -q '^11111111$' "$CLAUDE_STOP_LOG" && fail "self-session NOT skipped" || pass "self-session skipped"
grep -q '^22222222$' "$CLAUDE_STOP_LOG" && pass "non-self stopped" || fail "non-self stopped"
unset CLAUDE_CODE_SESSION_ID

# ── 4. failure without --force exits 1; with --force exits 0 ────────────────
export CLAUDE_STOP_RC=1
write_agents_fixture <<'JSON'
[{"pid":100,"cwd":"/wt/CTL-1","sessionId":"11111111-aaaa-bbbb-cccc-dddddddddddd","status":"active"}]
JSON
reset_stop_log
reset_event_log
if "$PRESWEEP" /wt/CTL-1 2>/dev/null; then
	fail "stop-failed without --force should exit nonzero"
else
	pass "stop-failed without --force exits nonzero"
fi

if "$PRESWEEP" --force /wt/CTL-1 2>/dev/null; then
	pass "--force ignores stop failures"
else
	fail "--force ignores stop failures"
fi
unset CLAUDE_STOP_RC

# ── 5. trailing-slash normalization (no spurious false negatives) ───────────
write_agents_fixture <<'JSON'
[{"pid":100,"cwd":"/wt/CTL-1","sessionId":"11111111-aaaa-bbbb-cccc-dddddddddddd","status":"idle"}]
JSON
reset_stop_log
reset_event_log
"$PRESWEEP" /wt/CTL-1/
grep -q '^11111111$' "$CLAUDE_STOP_LOG" && pass "trailing slash normalized" || fail "trailing slash normalized"

# ── 6. sibling-prefix boundary: /wt/CTL-64 must NOT match /wt/CTL-649 ────────
# A plain startswith("/wt/CTL-64") would wrongly reap the sibling CTL-649
# session. Exact-or-child matching must spare it while still reaping the
# exact path and a sub-dir under it.
write_agents_fixture <<'JSON'
[
  {"pid":200,"cwd":"/wt/CTL-64","sessionId":"aaaaaaaa-aaaa-bbbb-cccc-dddddddddddd","status":"idle"},
  {"pid":201,"cwd":"/wt/CTL-64/sub","sessionId":"bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd","status":"active"},
  {"pid":202,"cwd":"/wt/CTL-649","sessionId":"cccccccc-aaaa-bbbb-cccc-dddddddddddd","status":"idle"}
]
JSON
reset_stop_log
reset_event_log
"$PRESWEEP" /wt/CTL-64
grep -q '^aaaaaaaa$' "$CLAUDE_STOP_LOG" && pass "sibling-prefix: stopped exact /wt/CTL-64" || fail "sibling-prefix: stopped exact /wt/CTL-64"
grep -q '^bbbbbbbb$' "$CLAUDE_STOP_LOG" && pass "sibling-prefix: stopped /wt/CTL-64/sub child" || fail "sibling-prefix: stopped /wt/CTL-64/sub child"
grep -q '^cccccccc$' "$CLAUDE_STOP_LOG" && fail "sibling-prefix: did NOT stop /wt/CTL-649 sibling" || pass "sibling-prefix: spared /wt/CTL-649 sibling"

# ── 7. emits worktree.presweep.reap-requested per session ───────────────────
write_agents_fixture <<'JSON'
[{"pid":100,"cwd":"/wt/CTL-1","sessionId":"11111111-aaaa-bbbb-cccc-dddddddddddd","status":"idle"}]
JSON
reset_stop_log
reset_event_log
"$PRESWEEP" /wt/CTL-1
EVENT_LOG="${CATALYST_EVENTS_DIR}/$(date -u +%Y-%m).jsonl"
if [ -f "$EVENT_LOG" ] && grep -q 'worktree.presweep.reap-requested' "$EVENT_LOG"; then
	pass "emits worktree.presweep.reap-requested event"
else
	fail "emits worktree.presweep.reap-requested event"
fi

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
