#!/usr/bin/env bash
# Shell tests for the CTL-649 Phase 5 noun/verb dispatcher in
# catalyst-execution-core: backcompat daemon aliases, the `daemon` noun, and
# the `sessions` audit-CLI route. Run:
#   bash plugins/dev/scripts/__tests__/execution-core-cli-routing.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-execution-core"

FAILURES=0
PASSES=0
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

# A fake `claude` so `sessions list` is hermetic — emits an empty agent list.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
FAKE_CLAUDE="$SCRATCH/claude"
cat >"$FAKE_CLAUDE" <<'EOF'
#!/usr/bin/env bash
# `claude agents --json` → []
if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi
exit 0
EOF
chmod +x "$FAKE_CLAUDE"
export CATALYST_DISPATCH_CLAUDE_BIN="$FAKE_CLAUDE"
# A fake `gh` so worktrees/branches routing is hermetic + offline — emits [].
FAKE_GH="$SCRATCH/gh"
cat >"$FAKE_GH" <<'EOF'
#!/usr/bin/env bash
echo "[]"
EOF
chmod +x "$FAKE_GH"
export CATALYST_GH_BIN="$FAKE_GH"
# Point runs root at empty scratch so indexSignalsByBgJobId finds nothing.
export CATALYST_DIR="$SCRATCH/catalyst"

echo "test 1 (CTL-649): backcompat 'probe' routes to daemon probe (no daemon → nonzero)"
if "$SCRIPT" probe; then
	fail "probe exits nonzero when daemon down"
else
	pass "backcompat probe routes to daemon probe"
fi

echo "test 2 (CTL-649): backcompat 'status' routes to daemon status"
if "$SCRIPT" status | grep -q stopped; then
	pass "backcompat status routes to daemon status"
else
	fail "backcompat status routes to daemon status"
fi

echo "test 3 (CTL-649): 'daemon status' is the new canonical form"
if "$SCRIPT" daemon status | grep -q stopped; then
	pass "daemon status works"
else
	fail "daemon status works"
fi

echo "test 4 (CTL-649): 'daemon probe' routes to daemon probe"
if "$SCRIPT" daemon probe; then
	fail "daemon probe exits nonzero when daemon down"
else
	pass "daemon probe routes correctly"
fi

echo "test 4b (CTL-2147): backcompat 'rearm' routes to daemon rearm (no daemon → nonzero)"
OUT="$("$SCRIPT" rearm 2>&1)"
RC=$?
if [ "$RC" != "0" ] && echo "$OUT" | grep -qi "not running"; then
	pass "backcompat rearm routes to daemon rearm"
else
	fail "backcompat rearm routes to daemon rearm" "rc=$RC out=$OUT"
fi

echo "test 4c (CTL-2147): 'daemon rearm' is the canonical form"
OUT="$("$SCRIPT" daemon rearm 2>&1)"
RC=$?
if [ "$RC" != "0" ] && echo "$OUT" | grep -qi "not running"; then
	pass "daemon rearm routes correctly"
else
	fail "daemon rearm routes correctly" "rc=$RC out=$OUT"
fi

echo "test 4d (CTL-2147): 'rearm' success path — a live pid actually gets SIGHUP"
# Tests 4b/4c above only cover the "daemon not running" failure path. This exercises
# the success path with a real (fake) process: a tiny script that traps SIGHUP and
# writes a marker file, backgrounded and pointed to via EXECUTION_CORE_PID_FILE.
# AGENTS.md "Spawning a background process": the loop is self-limiting via its own
# SECONDS deadline (30s) so it exits on its own even if this test's cleanup below
# never runs — never an unbounded `while :; do :; done`.
REARM_MARKER="$SCRATCH/sighup-received"
FAKE_DAEMON="$SCRATCH/fake-daemon.sh"
cat >"$FAKE_DAEMON" <<'EOF'
#!/usr/bin/env bash
marker="$1"
trap 'touch "$marker"; exit 0' HUP
end=$((SECONDS + 30))
while [ "$SECONDS" -lt "$end" ]; do sleep 1; done
EOF
chmod +x "$FAKE_DAEMON"
rm -f "$REARM_MARKER"
"$FAKE_DAEMON" "$REARM_MARKER" &
FAKE_PID=$!
FAKE_PID_FILE="$SCRATCH/fake-daemon.pid"
echo "$FAKE_PID" > "$FAKE_PID_FILE"
# Give the backgrounded interpreter time to actually install the HUP trap before
# signalling it — without this, SIGHUP can arrive before `trap` runs and the
# process dies to the DEFAULT SIGHUP action instead (observed: "Hangup: 1").
sleep 0.3

OUT="$(EXECUTION_CORE_PID_FILE="$FAKE_PID_FILE" "$SCRIPT" rearm 2>&1)"
RC=$?

# Bounded wait for the trap to fire (never an unbounded poll — AGENTS.md).
end=$((SECONDS + 10))
while [ ! -e "$REARM_MARKER" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.2; done

if [ "$RC" = "0" ] && echo "$OUT" | grep -qi "SIGHUP sent" && [ -e "$REARM_MARKER" ]; then
	pass "rearm success path: SIGHUP delivered to a live pid, exit 0"
else
	fail "rearm success path: SIGHUP delivered to a live pid, exit 0" "rc=$RC out=$OUT marker_exists=$([ -e "$REARM_MARKER" ] && echo yes || echo no)"
fi

kill "$FAKE_PID" 2>/dev/null || true
rm -f "$FAKE_PID_FILE" "$REARM_MARKER" "$FAKE_DAEMON"

echo "test 5 (CTL-649): 'sessions list --json' routes to the sessions module"
OUT="$("$SCRIPT" sessions list --json 2>/dev/null)"
RC=$?
if [ "$RC" = "0" ] && echo "$OUT" | grep -q '\[\]'; then
	pass "sessions list --json emits a JSON array"
else
	fail "sessions list --json emits a JSON array" "rc=$RC out=$OUT"
fi

echo "test 5b (CTL-649): 'worktrees list --json' routes to the worktrees module"
OUT="$("$SCRIPT" worktrees list --json 2>/dev/null)"
RC=$?
if [ "$RC" = "0" ] && echo "$OUT" | grep -q '\['; then
	pass "worktrees list --json routes to worktrees module"
else
	fail "worktrees list --json routes to worktrees module" "rc=$RC out=$OUT"
fi

echo "test 5c (CTL-649): 'branches list --json' routes to the branches module"
OUT="$("$SCRIPT" branches list --json 2>/dev/null)"
RC=$?
if [ "$RC" = "0" ] && echo "$OUT" | grep -q '\['; then
	pass "branches list --json routes to branches module"
else
	fail "branches list --json routes to branches module" "rc=$RC out=$OUT"
fi

echo "test 6 (CTL-649): unknown noun fails with usage"
OUT="$("$SCRIPT" bogus 2>&1)"
RC=$?
if [ "$RC" != "0" ] && echo "$OUT" | grep -qi "Usage:"; then
	pass "unknown noun fails with usage"
else
	fail "unknown noun fails with usage" "rc=$RC out=$OUT"
fi

echo "test 7 (CTL-649): 'daemon bogus' fails with daemon usage"
OUT="$("$SCRIPT" daemon bogus 2>&1)"
RC=$?
if [ "$RC" != "0" ] && echo "$OUT" | grep -qi "daemon {start"; then
	pass "daemon bogus fails with daemon usage"
else
	fail "daemon bogus fails with daemon usage" "rc=$RC out=$OUT"
fi

echo "test 8 (CTL-649): '--help' exits 0 with a per-noun description + tidy --dry-run pointer"
OUT="$("$SCRIPT" --help 2>/dev/null)"
RC=$?
if [ "$RC" = "0" ] &&
	echo "$OUT" | grep -q "long-lived execution-core daemon" &&
	echo "$OUT" | grep -q "inventory / reap leaked" &&
	echo "$OUT" | grep -q "tidy --dry-run"; then
	pass "--help exits 0 with rich per-noun help"
else
	fail "--help exits 0 with rich per-noun help" "rc=$RC out=$OUT"
fi

echo "test 8b (CTL-649): 'help'/'-h' also print the help to stdout, exit 0"
if "$SCRIPT" help 2>/dev/null | grep -q "tidy --dry-run" && "$SCRIPT" -h 2>/dev/null | grep -q "tidy --dry-run"; then
	pass "help / -h print help and exit 0"
else
	fail "help / -h print help and exit 0"
fi

echo "test 9 (CTL-649): unknown noun names the bad input and exits 1"
OUT="$("$SCRIPT" frobnicate 2>&1)"
RC=$?
if [ "$RC" = "1" ] && echo "$OUT" | grep -q "unknown command: frobnicate"; then
	pass "unknown noun names the bad input, exit 1"
else
	fail "unknown noun names the bad input, exit 1" "rc=$RC out=$OUT"
fi

echo "test 10 (CTL-649): 'daemon status --json' emits JSON with a running key"
OUT="$("$SCRIPT" daemon status --json 2>/dev/null)"
RC=$?
if [ "$RC" = "0" ] && echo "$OUT" | grep -q '"running"'; then
	pass "daemon status --json emits JSON with running key"
else
	fail "daemon status --json emits JSON with running key" "rc=$RC out=$OUT"
fi

echo "test 10b (CTL-649): top-level 'status --json' alias also emits JSON"
OUT="$("$SCRIPT" status --json 2>/dev/null)"
RC=$?
if [ "$RC" = "0" ] && echo "$OUT" | grep -q '"running":false'; then
	pass "status --json alias emits JSON (daemon down → running:false)"
else
	fail "status --json alias emits JSON (daemon down → running:false)" "rc=$RC out=$OUT"
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
