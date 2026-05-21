#!/usr/bin/env bash
# Shell tests for the phase-agent-watch-bg `reap` subcommand (CTL-567).
# Run: bash plugins/dev/scripts/__tests__/phase-agent-watch-bg.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
WATCH_BG="${REPO_ROOT}/plugins/dev/scripts/phase-agent-watch-bg"

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

scratch_setup() {
	SCRATCH="$(mktemp -d)"
	ORCH_DIR="${SCRATCH}/orch"
	mkdir -p "${ORCH_DIR}/workers"

	# Fake `claude`: logs argv; `stop` succeeds; `agents` is unused (CPU probe).
	CLAUDE_LOG="${SCRATCH}/claude.log"
	: >"$CLAUDE_LOG"
	cat >"${SCRATCH}/claude" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$CLAUDE_LOG"
case "$1" in
  stop)   exit 0 ;;
  agents) echo '[]' ;;
esac
EOF
	chmod +x "${SCRATCH}/claude"
	export CATALYST_DISPATCH_CLAUDE_BIN="${SCRATCH}/claude"
	export CLAUDE_LOG

	# CPU probe: every job idle (0%) unless its id contains "busy" (99%).
	cat >"${SCRATCH}/cpuprobe" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *busy*) echo "99" ;;
  *)      echo "0" ;;
esac
EOF
	chmod +x "${SCRATCH}/cpuprobe"
	export CATALYST_EXECUTOR_CPU_PROBE="${SCRATCH}/cpuprobe"
}

scratch_teardown() {
	rm -rf "$SCRATCH"
	unset SCRATCH ORCH_DIR CLAUDE_LOG
	unset CATALYST_DISPATCH_CLAUDE_BIN CATALYST_EXECUTOR_CPU_PROBE
}

# make_signal TICKET PHASE STATUS BG_JOB_ID  (BG_JOB_ID="null" → JSON null)
make_signal() {
	local t="$1" p="$2" s="$3" bg="$4"
	mkdir -p "${ORCH_DIR}/workers/${t}"
	if [ "$bg" = "null" ]; then
		jq -n --arg t "$t" --arg p "$p" --arg s "$s" \
			'{ticket:$t, phase:$p, status:$s, bg_job_id:null}' \
			>"${ORCH_DIR}/workers/${t}/phase-${p}.json"
	else
		jq -n --arg t "$t" --arg p "$p" --arg s "$s" --arg bg "$bg" \
			'{ticket:$t, phase:$p, status:$s, bg_job_id:$bg}' \
			>"${ORCH_DIR}/workers/${t}/phase-${p}.json"
	fi
}

run_reap() { "$WATCH_BG" reap --orch-dir "$ORCH_DIR" --json "$@"; }

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1: --scope done reaps only done signals"
scratch_setup
make_signal "T-1" "research" "done" "aaaa1111"
make_signal "T-1" "plan" "running" "bbbb2222"
make_signal "T-2" "implement" "failed" "cccc3333"
OUT=$(run_reap --scope "done")
echo "$OUT" | jq -e '.scanned == 1 and .reaped == 1 and .skipped == 0' >/dev/null \
	&& pass "only the done signal is reaped" || fail "only the done signal is reaped" "got: $OUT"
grep -q -- "stop aaaa1111" "$CLAUDE_LOG" && pass "done job stopped" || fail "done job stopped" "log: $(cat "$CLAUDE_LOG")"
! grep -q "bbbb2222" "$CLAUDE_LOG" && pass "running job left alone" || fail "running job left alone"
! grep -q "cccc3333" "$CLAUDE_LOG" && pass "failed job left alone (exemption)" || fail "failed job left alone (exemption)"
scratch_teardown

echo "test 2: --scope all reaps every signal with a bg_job_id"
scratch_setup
make_signal "T-1" "research" "done" "aaaa1111"
make_signal "T-1" "plan" "running" "bbbb2222"
make_signal "T-2" "implement" "failed" "cccc3333"
OUT=$(run_reap --scope all)
echo "$OUT" | jq -e '.scanned == 3 and .reaped == 3' >/dev/null \
	&& pass "all three reaped" || fail "all three reaped" "got: $OUT"
grep -q -- "stop aaaa1111" "$CLAUDE_LOG" && grep -q -- "stop bbbb2222" "$CLAUDE_LOG" &&
	grep -q -- "stop cccc3333" "$CLAUDE_LOG" && pass "every bg job stopped" || fail "every bg job stopped" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 3: signals with null bg_job_id are skipped"
scratch_setup
make_signal "T-1" "research" "done" "null"
make_signal "T-2" "plan" "done" "dddd4444"
OUT=$(run_reap --scope "done")
echo "$OUT" | jq -e '.scanned == 1 and .reaped == 1' >/dev/null \
	&& pass "null bg_job_id not counted" || fail "null bg_job_id not counted" "got: $OUT"
grep -q -- "stop dddd4444" "$CLAUDE_LOG" && pass "real job still reaped" || fail "real job still reaped"
scratch_teardown

echo "test 4: --dry-run reaps nothing, reports would-reap"
scratch_setup
make_signal "T-1" "research" "done" "aaaa1111"
OUT=$(run_reap --scope "done" --dry-run)
echo "$OUT" | jq -e '.dryRun == true and .reaped == 1' >/dev/null \
	&& pass "dry-run reports a candidate" || fail "dry-run reports a candidate" "got: $OUT"
echo "$OUT" | jq -e '.results[0].result == "would-reap"' >/dev/null \
	&& pass "result is would-reap" || fail "result is would-reap" "got: $OUT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude stop NOT called in dry-run" || fail "claude stop NOT called in dry-run" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 5: CPU safety belt — an active job is skipped, not stopped"
scratch_setup
make_signal "T-1" "research" "done" "busy0001"
OUT=$(run_reap --scope "done")
echo "$OUT" | jq -e '.scanned == 1 and .reaped == 0 and .skipped == 1' >/dev/null \
	&& pass "active job counted as skipped" || fail "active job counted as skipped" "got: $OUT"
echo "$OUT" | jq -e '.results[0].result == "skipped-active"' >/dev/null \
	&& pass "result is skipped-active" || fail "result is skipped-active" "got: $OUT"
! grep -q "stop busy0001" "$CLAUDE_LOG" && pass "active job NOT stopped" || fail "active job NOT stopped" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 6: unknown --scope value → exit 1 with a clear message"
scratch_setup
OUT=$("$WATCH_BG" reap --orch-dir "$ORCH_DIR" --scope bogus 2>&1)
RC=$?
[ "$RC" = "1" ] && pass "exit 1 on bad scope" || fail "exit 1 on bad scope" "rc=$RC"
echo "$OUT" | grep -qi "scope" && pass "message mentions scope" || fail "message mentions scope" "got: $OUT"
scratch_teardown

echo "test 7: empty run directory → scanned 0, reaped 0"
scratch_setup
OUT=$(run_reap --scope all)
echo "$OUT" | jq -e '.scanned == 0 and .reaped == 0 and .skipped == 0' >/dev/null \
	&& pass "empty run reaps nothing" || fail "empty run reaps nothing" "got: $OUT"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
