#!/usr/bin/env bash
# Shell tests for lib/executor.sh (CTL-567).
# Run: bash plugins/dev/scripts/__tests__/lib-executor.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/executor.sh"

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

[ -f "$LIB" ] || {
	echo "FATAL: lib not found at $LIB"
	exit 1
}
# shellcheck source=/dev/null
source "$LIB"

# Fake `claude`: logs argv; `stop` honors $STOP_RC; `agents --json` echoes a
# session whose pid is $FAKE_PID (default 0 → no live process).
setup() {
	SCRATCH="$(mktemp -d)"
	CLAUDE_LOG="${SCRATCH}/claude.log"
	: >"$CLAUDE_LOG"
	cat >"${SCRATCH}/claude" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$CLAUDE_LOG"
case "$1" in
  stop)   exit "${STOP_RC:-0}" ;;
  agents) echo "[{\"sessionId\":\"sess-xyz\",\"pid\":${FAKE_PID:-0}}]" ;;
esac
EOF
	chmod +x "${SCRATCH}/claude"
	export CATALYST_DISPATCH_CLAUDE_BIN="${SCRATCH}/claude"
	export CLAUDE_LOG
	unset _EXECUTOR_AGENTS_CACHE
}

teardown() {
	rm -rf "$SCRATCH"
	unset SCRATCH CLAUDE_LOG CATALYST_DISPATCH_CLAUDE_BIN
	unset CATALYST_EXECUTOR_CPU_PROBE CATALYST_EXECUTOR_JOBS_ROOT
	unset STOP_RC FAKE_PID _EXECUTOR_AGENTS_CACHE
}

# make_cpu_probe VALUE — install a CPU probe that always echoes VALUE.
make_cpu_probe() {
	cat >"${SCRATCH}/cpuprobe" <<EOF
#!/usr/bin/env bash
echo "${1}"
EOF
	chmod +x "${SCRATCH}/cpuprobe"
	export CATALYST_EXECUTOR_CPU_PROBE="${SCRATCH}/cpuprobe"
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1: low CPU → job is stopped"
setup
make_cpu_probe "0.4"
OUT=$(executor_reap "abc12345")
RC=$?
[ "$OUT" = "stopped" ] && pass "echoes 'stopped'" || fail "echoes 'stopped'" "got: $OUT"
[ "$RC" = "0" ] && pass "returns 0" || fail "returns 0" "rc=$RC"
grep -q -- "stop abc12345" "$CLAUDE_LOG" && pass "claude stop called" || fail "claude stop called" "log: $(cat "$CLAUDE_LOG")"
teardown

echo "test 2: high CPU → skipped-active, no stop call"
setup
make_cpu_probe "40"
OUT=$(executor_reap "abc12345")
RC=$?
[ "$OUT" = "skipped-active" ] && pass "echoes 'skipped-active'" || fail "echoes 'skipped-active'" "got: $OUT"
[ "$RC" = "1" ] && pass "returns 1" || fail "returns 1" "rc=$RC"
! grep -q -- "stop" "$CLAUDE_LOG" && pass "claude stop NOT called" || fail "claude stop NOT called" "log: $(cat "$CLAUDE_LOG")"
teardown

echo "test 3: unknown CPU → job is stopped (fail-safe: nothing live to protect)"
setup
make_cpu_probe ""
OUT=$(executor_reap "abc12345")
[ "$OUT" = "stopped" ] && pass "unknown CPU still reaps" || fail "unknown CPU still reaps" "got: $OUT"
teardown

echo "test 4: empty job id → skipped-empty"
setup
OUT=$(executor_reap "")
RC=$?
[ "$OUT" = "skipped-empty" ] && pass "echoes 'skipped-empty'" || fail "echoes 'skipped-empty'" "got: $OUT"
[ "$RC" = "1" ] && pass "returns 1" || fail "returns 1" "rc=$RC"
teardown

echo "test 5: claude stop exits non-zero → stop-failed"
setup
make_cpu_probe "0"
export STOP_RC=1
OUT=$(executor_reap "abc12345")
RC=$?
[ "$OUT" = "stop-failed" ] && pass "echoes 'stop-failed'" || fail "echoes 'stop-failed'" "got: $OUT"
[ "$RC" = "1" ] && pass "returns 1" || fail "returns 1" "rc=$RC"
teardown

echo "test 6: executor_claude_bin honors CATALYST_DISPATCH_CLAUDE_BIN"
setup
[ "$(executor_claude_bin)" = "${SCRATCH}/claude" ] && pass "returns override" || fail "returns override" "got: $(executor_claude_bin)"
teardown

echo "test 7: CPU exactly at ceiling (3) is not 'active' — strictly greater wins"
setup
make_cpu_probe "3"
OUT=$(executor_reap "abc12345")
[ "$OUT" = "stopped" ] && pass "CPU==ceiling reaps" || fail "CPU==ceiling reaps" "got: $OUT"
teardown

echo "test 8: executor_job_cpu resolves via state.json → claude agents → ps"
setup
mkdir -p "${SCRATCH}/jobs/dead00ff"
echo '{"sessionId":"sess-xyz"}' >"${SCRATCH}/jobs/dead00ff/state.json"
export CATALYST_EXECUTOR_JOBS_ROOT="${SCRATCH}/jobs"
export FAKE_PID=$$ # this test's own pid — a guaranteed-live process
CPU=$(executor_job_cpu "dead00ff")
echo "$CPU" | grep -qE '^[0-9.]+$' && pass "resolves a numeric CPU via the chain" || fail "resolves a numeric CPU via the chain" "got: '$CPU'"
teardown

echo "test 9: executor_job_cpu → empty when state.json is missing"
setup
export CATALYST_EXECUTOR_JOBS_ROOT="${SCRATCH}/jobs" # dir absent
CPU=$(executor_job_cpu "nope0000")
[ -z "$CPU" ] && pass "missing state.json → empty CPU" || fail "missing state.json → empty CPU" "got: '$CPU'"
teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
