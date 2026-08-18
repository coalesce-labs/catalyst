#!/usr/bin/env bash
# exec-runtime-guard.test.sh — CTL-1937.
#
# Measured 2026-08-17 22:42–23:08 CT: a chain of 7,592 `bash` processes, each the parent of
# the next, all running `bash …/cli/drain.mjs [--off] [--json]`. 87% of kern.maxprocperuid;
# `fork()` failed for every agent on the machine for ~25 minutes.
#
# ⚠️ THE END-TO-END CASE BELOW DELIBERATELY SLEEPS AT EACH LEVEL. If the guard is broken
# the recursion is unbounded AND fast, so a test that reproduced it at full speed would
# re-run the incident on the machine running the test. With a sleep per level plus an
# external watchdog, a broken guard produces a handful of processes instead of thousands —
# still a clear failure, without taking the box down to prove it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${SCRIPT_DIR}/../catalyst-execution-core"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}
assert_grep() {
	if grep -qF -- "$3" <<<"$2"; then pass "$1"; else fail "$1" "expected: $3" "got: $(head -c 400 <<<"$2")"; fi
}

echo ""
echo "=== the depth guard refuses a re-entry ==="
OUT=$(CATALYST_EXEC_RUNTIME_DEPTH=3 CATALYST_EXEC_RUNTIME_MAX_DEPTH=3 bash "$CLI" drain --status-read 2>&1)
assert_grep "a re-entry at the cap is refused" "$OUT" "REFUSING"
assert_grep "the refusal names the guard's ticket" "$OUT" "CTL-1937"
assert_grep "it points at the actual cause to check" "$OUT" "shell is being used as the JS runtime"

echo ""
echo "--- ⛔ CONTROL: below the cap it does NOT refuse ---"
# Without this the assertions above would pass against a wrapper that refuses everything.
OUT=$(CATALYST_EXEC_RUNTIME_DEPTH=0 CATALYST_EXEC_RUNTIME_MAX_DEPTH=3 bash "$CLI" drain --status-read 2>&1)
if grep -qF "REFUSING" <<<"$OUT"; then
	fail "a normal invocation is not refused" "it printed REFUSING at depth 0"
else
	pass "a normal invocation is not refused"
fi

echo ""
echo "=== a shell resolved as the JS runtime is refused by name ==="
# The override is EXECUTION_CORE_RUNTIME (script line 37), not RUNTIME — the first cut of
# this test used the wrong name and the case silently did not exercise the guard at all.
OUT=$(EXECUTION_CORE_RUNTIME=bash bash "$CLI" drain --status-read 2>&1)
assert_grep "a bash 'runtime' is refused" "$OUT" "resolved JS runtime is a shell"
assert_grep "the reason is the doc-comment evaluation" "$OUT" "evaluates its own doc comment"

echo ""
echo "=== end-to-end: a genuine chain is BOUNDED (slowed, and watchdogged) ==="
# A stub 'bun' that is really a shell — the exact mis-resolution — pointed at a module
# whose first line re-invokes the CLI, i.e. the doc-comment bomb in miniature.
mkdir -p "$SCRATCH/bin" "$SCRATCH/scripts/execution-core/cli"
cp "$CLI" "$SCRATCH/scripts/catalyst-execution-core"
COUNTER="$SCRATCH/levels"
: >"$COUNTER"
# ⛔ THE FIXTURE SELF-TERMINATES, and that is the point (Codex #3511 P1).
#
# My first cut relied on an external watchdog killing `$runner`. That is exactly the
# antipattern AGENTS.md forbids: when the guard is broken — the case this test exists to
# contain — every level has ALREADY spawned its child, so killing the first ancestor leaves
# the descendants reparented and still recursing. Cleanup was load-bearing, in a test about
# a fork bomb.
#
# The chain now carries its own deadline. The bound sits WELL ABOVE the guard's cap, so it
# never decides the assertion: a working guard stops at 3 and the hard stop is never
# reached; a broken guard stops at 10 instead of at the process table, and the level count
# fails the test loudly.
FIXTURE_HARD_STOP=10
cat >"$SCRATCH/scripts/execution-core/cli/drain.mjs" <<EOF
// drain.mjs — the bomb in miniature: a backticked command example on line 1.
echo x >> "$COUNTER"
if [ "\$(wc -l < "$COUNTER" | tr -d ' ')" -ge $FIXTURE_HARD_STOP ]; then exit 0; fi
sleep 0.2
\`bash "$SCRATCH/scripts/catalyst-execution-core" drain --status-read\`
EOF
cat >"$SCRATCH/bin/bun" <<'EOF'
#!/usr/bin/env bash
exec /bin/bash "$@"
EOF
chmod +x "$SCRATCH/bin/bun"

# The chain's own hard stop (above) is what bounds it. This watchdog is a THIRD line of
# defence and it kills the whole PROCESS GROUP — killing `$runner` alone leaves reparented
# descendants running, which is what made the first version of this test unsafe.
set -m
(PATH="$SCRATCH/bin:/usr/bin:/bin" CATALYST_EXEC_RUNTIME_MAX_DEPTH=3 \
	bash "$SCRATCH/scripts/catalyst-execution-core" drain --status-read >/dev/null 2>&1) &
runner=$!
(
	sleep 12
	kill -9 -"$runner" 2>/dev/null
	kill -9 "$runner" 2>/dev/null
) &
watchdog=$!
wait "$runner" 2>/dev/null
kill "$watchdog" 2>/dev/null
set +m

# ⛔ Fail closed on residue: a passing level-count must not hide a leak.
if pgrep -f "$SCRATCH/scripts/catalyst-execution-core" >/dev/null 2>&1; then
	pkill -9 -f "$SCRATCH/scripts/catalyst-execution-core" 2>/dev/null
	fail "the fixture left processes behind" "residue found and killed — the chain is not self-limiting"
else
	pass "no fixture processes survived the run"
fi

LEVELS=$(wc -l <"$COUNTER" | tr -d ' ')
if [[ $LEVELS -ge 1 && $LEVELS -le 4 ]]; then
	pass "the chain ran but STOPPED — ${LEVELS} level(s), cap 3"
elif [[ $LEVELS -ge $FIXTURE_HARD_STOP ]]; then
	# The fixture's own deadline stopped it, which means the GUARD did not. Telling these
	# two apart is the whole reason the hard stop sits well above the cap.
	fail "the GUARD did not bound the chain — the fixture's hard stop did" \
		"levels reached: ${LEVELS} (hard stop ${FIXTURE_HARD_STOP}, guard cap 3)"
else
	fail "the chain was not bounded by the guard" "levels reached: ${LEVELS} (expected 1..4)"
fi
# ⛔ The positive control for the whole case: if the module never ran at all, a bound of
# zero would "pass" a guard that does nothing because nothing was ever invoked.
if [[ $LEVELS -ge 1 ]]; then
	pass "control — the module really was invoked (a zero here would prove nothing)"
else
	fail "control — the module never ran, so the bound above is meaningless"
fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
