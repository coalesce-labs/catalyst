#!/usr/bin/env bash
# CTL-1494: focused tests for catalyst-stack's coordination-publish lifecycle
# primitives — the off-inert no-op path and the bun-missing fail-closed path.
#
#   - node-class gating (worker/monitor start it, developer doesn't) is covered by
#     catalyst-stack-start-node-class.test.sh
#   - the status-line inventory is covered by catalyst-stack.test.sh
#   - LIVE shadow/enforce launch (the mirror is actually written) is a MANUAL step:
#     it needs a real bun runtime and a coordination-stamped event on the log, which
#     a hermetic shell test can't provide. Out of scope here (plan Testing Strategy).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-coordination.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass()  { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
failx() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [[ -n "${2:-}" ]] && sed 's/^/      /' <<<"$2"; }

echo ""
echo "=== catalyst-stack coordination-publish lifecycle (CTL-1494) ==="
echo ""

# --- off-skip: a fake bun that resolves mode=off ⇒ clean no-op, no PID file, rc 0 ---
STUB_OFF="${SCRATCH}/stub-off"
mkdir -p "$STUB_OFF"
cat > "${STUB_OFF}/bun" <<'BUN'
#!/usr/bin/env bash
# Fake bun: the coordination_mode probe expects the resolved mode on stdout.
printf 'off'
BUN
chmod +x "${STUB_OFF}/bun"

CATALYST_DIR_OFF="${SCRATCH}/catalyst-off"
mkdir -p "$CATALYST_DIR_OFF"
OUT_OFF="$(PATH="${STUB_OFF}:${PATH}" CATALYST_DIR="$CATALYST_DIR_OFF" \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    start_coordination
    echo "RC=$?"
  ' 2>&1)"

if grep -q 'RC=0' <<<"$OUT_OFF"; then pass "off-skip: start_coordination returns 0"; else failx "off-skip: start_coordination returns 0" "$OUT_OFF"; fi
if grep -qi 'inert' <<<"$OUT_OFF"; then pass "off-skip: prints an inert/skip breadcrumb"; else failx "off-skip: prints an inert/skip breadcrumb" "$OUT_OFF"; fi
if [[ ! -f "${CATALYST_DIR_OFF}/coordination-publish.pid" ]]; then pass "off-skip: writes NO PID file"; else failx "off-skip: writes NO PID file"; fi

# --- bun-missing: coordination_mode fails closed to off ⇒ clean skip, rc 0, no PID file ---
# Even with CATALYST_COORDINATION_MODE=shadow forced, a bun-less host cannot run the
# bun daemon, so coordination_mode returns off and start_coordination is a clean skip.
# This is the intended fail-closed collapse (plan Note under Tests First test 3).
MINIMAL_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
CATALYST_DIR_NOBUN="${SCRATCH}/catalyst-nobun"
mkdir -p "$CATALYST_DIR_NOBUN"
OUT_NOBUN="$(PATH="$MINIMAL_PATH" CATALYST_DIR="$CATALYST_DIR_NOBUN" CATALYST_COORDINATION_MODE=shadow \
  bash --noprofile --norc -c '
    source "'"${STACK}"'" 2>/dev/null || true
    start_coordination
    echo "RC=$?"
  ' 2>&1)"

if grep -q 'RC=0' <<<"$OUT_NOBUN"; then pass "bun-missing: non-fatal (clean skip, returns 0 via off-fallback)"; else failx "bun-missing: non-fatal (clean skip, returns 0 via off-fallback)" "$OUT_NOBUN"; fi
if [[ ! -f "${CATALYST_DIR_NOBUN}/coordination-publish.pid" ]]; then pass "bun-missing: writes NO PID file"; else failx "bun-missing: writes NO PID file"; fi

echo ""
echo "  ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
