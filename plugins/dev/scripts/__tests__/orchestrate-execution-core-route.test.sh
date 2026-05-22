#!/usr/bin/env bash
# Shell tests for orchestrate-execution-core-route.sh — the /orchestrate
# execution-core routing helper (CTL-554, CTL-582). CTL-582 (D4) retired the
# enroll/stop actions — enrolled projects are the central registry.json — so
# the helper now only ensures the machine-level daemon is running.
# Run: bash plugins/dev/scripts/__tests__/orchestrate-execution-core-route.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/orchestrate-execution-core-route.sh"

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

SCRATCH=$(cd "$(mktemp -d)" && pwd -P)

# A stub daemon that succeeds for every subcommand (`start`, `probe`).
cat >"$SCRATCH/daemon-ok" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/daemon-ok"

# A stub daemon whose `probe` fails (start ok, probe non-zero) — the daemon
# never came up.
cat >"$SCRATCH/daemon-down" <<'EOF'
#!/usr/bin/env bash
[ "${1-}" = "probe" ] && exit 1
exit 0
EOF
chmod +x "$SCRATCH/daemon-down"

echo "test 1 (CTL-582): exits 0 and points at the registry when the daemon is up"
OUT=$(EXECUTION_CORE_ENSURE_DAEMON="$SCRATCH/daemon-ok" bash "$HELPER" 2>&1)
RC=$?
if [ "$RC" = "0" ]; then
	pass "exits 0 when the daemon probes ok"
else
	fail "exits 0" "rc=$RC out=$OUT"
fi
if echo "$OUT" | grep -q "registry"; then
	pass "reports projects are registry-managed"
else
	fail "reports registry-managed" "out=$OUT"
fi

echo "test 2 (CTL-582): exits non-zero when the daemon never comes up"
OUT=$(EXECUTION_CORE_ENSURE_DAEMON="$SCRATCH/daemon-down" bash "$HELPER" 2>&1)
RC=$?
if [ "$RC" != "0" ]; then
	pass "exits non-zero when probe fails"
else
	fail "exits non-zero" "rc=$RC out=$OUT"
fi

rm -rf "$SCRATCH"

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
