#!/usr/bin/env bash
# Shell tests for catalyst-execution-core — the daemon-lifecycle script (CTL-554).
# Run: bash plugins/dev/scripts/__tests__/catalyst-execution-core.test.sh

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

setup() {
	SCRATCH=$(mktemp -d)
	export CATALYST_DIR="$SCRATCH"
	# fake daemon: write the PID file it is handed, then sleep so kill-0 sees it.
	FAKE="$SCRATCH/fake-daemon.sh"
	cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = "--pid-file" ] && echo $$ > "$2"; shift; done
sleep 30
EOF
	chmod +x "$FAKE"
	export EXECUTION_CORE_DAEMON_SCRIPT="$FAKE"
	export EXECUTION_CORE_RUNTIME="bash" # run the fake under bash, not bun
}

teardown() {
	"$SCRIPT" stop >/dev/null 2>&1 || true
	pkill -f "fake-daemon.sh" 2>/dev/null || true
	rm -rf "$SCRATCH"
	unset CATALYST_DIR EXECUTION_CORE_DAEMON_SCRIPT EXECUTION_CORE_RUNTIME
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1 (CTL-554): start is idempotent"
setup
"$SCRIPT" start >/dev/null 2>&1
PID1=$(cat "$SCRATCH/execution-core/daemon.pid" 2>/dev/null)
"$SCRIPT" start >/dev/null 2>&1
PID2=$(cat "$SCRATCH/execution-core/daemon.pid" 2>/dev/null)
if [ -n "$PID1" ] && [ "$PID1" = "$PID2" ]; then
	pass "start is idempotent"
else
	fail "start idempotent" "pid1=$PID1 pid2=$PID2"
fi

echo "test 2 (CTL-554): status + probe report running"
if "$SCRIPT" probe; then pass "probe exits 0 while running"; else fail "probe exits 0 while running"; fi
if "$SCRIPT" status | grep -q running; then pass "status says running"; else fail "status says running"; fi

echo "test 3 (CTL-554): stop removes the PID file and probe then fails"
"$SCRIPT" stop >/dev/null 2>&1
if [ ! -f "$SCRATCH/execution-core/daemon.pid" ]; then
	pass "stop removes pidfile"
else
	fail "stop removes pidfile"
fi
"$SCRIPT" probe || pass "probe exits non-zero after stop"
teardown

echo "test 4 (CTL-554): start fails loudly when the daemon never writes its PID file"
setup
# A daemon that stays alive but never writes a PID file — simulates a hang
# mid-init. cmd_start must NOT fabricate a PID file or report success.
NOPID="$SCRATCH/nopid-daemon.sh"
cat >"$NOPID" <<'EOF'
#!/usr/bin/env bash
sleep 30
EOF
chmod +x "$NOPID"
export EXECUTION_CORE_DAEMON_SCRIPT="$NOPID"
OUT=$("$SCRIPT" start 2>&1)
RC=$?
if [ "$RC" != "0" ]; then
	pass "start exits non-zero on a hung daemon"
else
	fail "start exits non-zero on a hung daemon" "rc=$RC"
fi
if [ ! -f "$SCRATCH/execution-core/daemon.pid" ]; then
	pass "start does not fabricate a PID file"
else
	fail "start does not fabricate a PID file" "pidfile present"
fi
if echo "$OUT" | grep -qi "hung"; then
	pass "start reports the degraded state"
else
	fail "start reports the degraded state" "out=$OUT"
fi
pkill -f "nopid-daemon.sh" 2>/dev/null || true
teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
