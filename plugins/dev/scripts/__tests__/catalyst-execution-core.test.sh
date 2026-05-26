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
if echo "$OUT" | grep -qi "wedged"; then
	pass "start reports the degraded state"
else
	fail "start reports the degraded state" "out=$OUT"
fi
pkill -f "nopid-daemon.sh" 2>/dev/null || true
teardown

echo "test 5 (CTL-635): _neutralize_otel_attrs transform"
# shellcheck source=/dev/null
source "$SCRIPT" # source-safe: dispatch guarded, helpers defined
POISONED="project=adva,hostname=mac-1,branch=CTL-635-x,linear.key=ADV-1039,catalyst.orchestration=CTL-635,task.type=phase-plan"
OUT="$(_neutralize_otel_attrs "$POISONED")"
# poisoning keys gone
if ! echo "$OUT" | grep -q 'linear.key='; then pass "drops linear.key"; else fail "drops linear.key" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'catalyst.orchestration='; then pass "drops catalyst.orchestration"; else fail "drops catalyst.orchestration" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'branch='; then pass "drops branch"; else fail "drops branch" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'task.type='; then pass "drops task.type"; else fail "drops task.type" "out=$OUT"; fi
if ! echo "$OUT" | grep -q 'project=adva'; then pass "drops borrowed project"; else fail "drops borrowed project" "out=$OUT"; fi
# neutral identity + honest attrs preserved
if echo "$OUT" | grep -q 'project=catalyst'; then pass "stamps project=catalyst"; else fail "stamps project=catalyst" "out=$OUT"; fi
if echo "$OUT" | grep -q 'catalyst.role=execution-core-daemon'; then pass "stamps daemon role"; else fail "stamps daemon role" "out=$OUT"; fi
if echo "$OUT" | grep -q 'hostname=mac-1'; then pass "preserves hostname"; else fail "preserves hostname" "out=$OUT"; fi
# empty input still yields the neutral identity
OUT_EMPTY="$(_neutralize_otel_attrs "")"
if echo "$OUT_EMPTY" | grep -q 'catalyst.role=execution-core-daemon'; then pass "empty input → neutral identity"; else fail "empty input → neutral identity" "out=$OUT_EMPTY"; fi

echo "test 6 (CTL-635): start neutralizes the daemon's OTEL_RESOURCE_ATTRIBUTES"
setup
# fake daemon that records the OTEL env it was launched with, then behaves normally
ENVDUMP="$SCRATCH/otel-env.txt"
REC="$SCRATCH/rec-daemon.sh"
cat >"$REC" <<EOF
#!/usr/bin/env bash
printf '%s' "\${OTEL_RESOURCE_ATTRIBUTES-}" > "$ENVDUMP"
while [ \$# -gt 0 ]; do [ "\$1" = "--pid-file" ] && echo \$\$ > "\$2"; shift; done
sleep 30
EOF
chmod +x "$REC"
export EXECUTION_CORE_DAEMON_SCRIPT="$REC"
export EXECUTION_CORE_RUNTIME="bash"
# simulate a poisoned launch environment
export OTEL_RESOURCE_ATTRIBUTES="project=adva,hostname=mac-1,linear.key=ADV-1039,catalyst.orchestration=CTL-635"
"$SCRIPT" start >/dev/null 2>&1
sleep 0.3
GOT="$(cat "$ENVDUMP" 2>/dev/null)"
if ! echo "$GOT" | grep -q 'linear.key='; then pass "daemon env has no linear.key"; else fail "daemon env has no linear.key" "got=$GOT"; fi
if echo "$GOT" | grep -q 'catalyst.role=execution-core-daemon'; then pass "daemon env carries neutral identity"; else fail "daemon env carries neutral identity" "got=$GOT"; fi
unset OTEL_RESOURCE_ATTRIBUTES
teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
