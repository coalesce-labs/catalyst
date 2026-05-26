#!/usr/bin/env bash
# Shell tests for CTL-649: phase-agent-dispatch --name propagation + --attempt
# threading. Runs the dispatcher in --dry-run so no real `claude --bg` spawn
# is required. Verifies the structured session name shape is computed even
# when the bg launch is bypassed.
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-dispatch-name.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

setup_orch_fixture() {
	local orch_id="$1" ticket="$2"
	export CATALYST_ORCHESTRATOR_ID="$orch_id"
	export CATALYST_ORCHESTRATOR_DIR="$SCRATCH/runs/$orch_id"
	mkdir -p "$CATALYST_ORCHESTRATOR_DIR/workers/$ticket"
}

dispatch_dry() {
	"$DISPATCH" --dry-run "$@" 2>&1
}

assert_jq() {
	local label="$1" json="$2" filter="$3"
	local got
	got=$(printf '%s' "$json" | jq -r "$filter" 2>/dev/null)
	if [ "$got" = "true" ] || [ -n "$got" ]; then
		PASSES=$((PASSES + 1))
		echo "  PASS: $label"
	else
		FAILURES=$((FAILURES + 1))
		echo "  FAIL: $label"
		echo "    filter: $filter"
		echo "    json: $json"
	fi
}

echo "phase-agent-dispatch --name / --attempt tests (CTL-649)"

# ── 1. default attempt=1, name includes structured form ──────────────────────
setup_orch_fixture "o-test-1" "CTL-999"
OUT=$(dispatch_dry --phase triage --ticket CTL-999)
RC=$?
if [ $RC -ne 0 ]; then
	echo "  FAIL: dry-run with default attempt — exited $RC"
	echo "    output: $OUT"
	FAILURES=$((FAILURES + 1))
else
	assert_jq "default attempt is 1" "$OUT" '.attempt == 1 | tostring | test("true")'
	assert_jq "sessionName uses structured shape" "$OUT" '.sessionName | test("^o-o-test-1:CTL-999:triage:1$")'
fi

# ── 2. --attempt 3 threads into sessionName ──────────────────────────────────
setup_orch_fixture "o-test-2" "CTL-999"
OUT=$(dispatch_dry --phase triage --ticket CTL-999 --attempt 3)
RC=$?
if [ $RC -ne 0 ]; then
	echo "  FAIL: dry-run with --attempt 3 — exited $RC"
	echo "    output: $OUT"
	FAILURES=$((FAILURES + 1))
else
	assert_jq "sessionName includes attempt=3 suffix" "$OUT" '.sessionName | test("o-test-2:CTL-999:triage:3$")'
	assert_jq "attempt field is numeric 3" "$OUT" '.attempt == 3 | tostring | test("true")'
fi

# ── 3. invalid --attempt rejected ────────────────────────────────────────────
setup_orch_fixture "o-test-1" "CTL-999"
if "$DISPATCH" --dry-run --phase triage --ticket CTL-999 --attempt "abc" >/dev/null 2>&1; then
	echo "  FAIL: invalid --attempt should have been rejected"
	FAILURES=$((FAILURES + 1))
else
	PASSES=$((PASSES + 1))
	echo "  PASS: invalid --attempt rejected"
fi

# ── 4. orch_id sourced from env when no --orch-id ────────────────────────────
setup_orch_fixture "o-env-only" "CTL-100"
OUT=$(dispatch_dry --phase triage --ticket CTL-100)
RC=$?
if [ $RC -ne 0 ]; then
	echo "  FAIL: env-only orch_id — exited $RC"
	echo "    output: $OUT"
	FAILURES=$((FAILURES + 1))
else
	assert_jq "sessionName uses env CATALYST_ORCHESTRATOR_ID" "$OUT" \
		'.sessionName | test("^o-o-env-only:CTL-100:triage:1$")'
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
