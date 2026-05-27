#!/usr/bin/env bash
# Shell tests for CTL-649: orchestrate-dispatch-next refuses to dispatch in
# phase-agents mode when the execution-core daemon is down. Uses a tiny stub
# `catalyst-execution-core` on PATH to control the probe exit code.
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-dispatch-daemon-probe.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/orchestrate-dispatch-next"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Set up a minimal orchestrator dir with a config that pins phase-agents mode.
ORCH_DIR="$SCRATCH/orch"
mkdir -p "$ORCH_DIR/workers"
cat >"$ORCH_DIR/state.json" <<'JSON'
{
  "orchestrator": "o-probe-test",
  "worktreeBase": "/tmp/wt",
  "maxParallel": 1
}
JSON
cat >"$ORCH_DIR/config.json" <<'JSON'
{"catalyst": {"orchestration": {"dispatchMode": "phase-agents"}}}
JSON

stub_probe() {
	local rc="$1"
	local bin="$SCRATCH/bin"
	mkdir -p "$bin"
	cat >"$bin/catalyst-execution-core" <<EOF
#!/usr/bin/env bash
case "\$1" in
  probe) exit $rc ;;
  *) exit 0 ;;
esac
EOF
	chmod +x "$bin/catalyst-execution-core"
	export PATH="$bin:$PATH"
	export CATALYST_EXECUTION_CORE_BIN="$bin/catalyst-execution-core"
}

echo "orchestrate-dispatch-next daemon-probe tests (CTL-649)"

# ── 1. probe RC=1 → dispatcher refuses with documented error ─────────────────
stub_probe 1
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$ORCH_DIR/config.json" --phase triage 2>&1 || true)
RC=$?
if echo "$OUT" | grep -q "execution-core daemon is not running"; then
	PASSES=$((PASSES + 1))
	echo "  PASS: probe RC=1 refuses dispatch with documented error"
else
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: probe RC=1 expected refusal, got:"
	echo "$OUT" | sed 's/^/    /'
fi

# ── 2. CATALYST_DISPATCH_SKIP_DAEMON_PROBE=1 bypasses the gate ───────────────
stub_probe 1
OUT=$(CATALYST_DISPATCH_SKIP_DAEMON_PROBE=1 "$DISPATCH" --orch-dir "$ORCH_DIR" --config "$ORCH_DIR/config.json" --phase triage 2>&1 || true)
if echo "$OUT" | grep -q "execution-core daemon is not running"; then
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: skip-probe env still refused"
	echo "$OUT" | sed 's/^/    /'
else
	PASSES=$((PASSES + 1))
	echo "  PASS: CATALYST_DISPATCH_SKIP_DAEMON_PROBE=1 bypasses gate"
fi

# ── 3. probe RC=0 → no refusal message ───────────────────────────────────────
stub_probe 0
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$ORCH_DIR/config.json" --phase triage 2>&1 || true)
if echo "$OUT" | grep -q "execution-core daemon is not running"; then
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: probe RC=0 should not refuse"
	echo "$OUT" | sed 's/^/    /'
else
	PASSES=$((PASSES + 1))
	echo "  PASS: probe RC=0 does not refuse"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
