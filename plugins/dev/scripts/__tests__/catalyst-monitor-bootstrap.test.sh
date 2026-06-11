#!/usr/bin/env bash
# CTL-841: catalyst-monitor `start` must NOT hard-fail when ~/catalyst/wt is missing.
#
# A missing wt/ dir is a fresh-host normal, not a fatal error — a daemon start
# script should mkdir -p its own runtime dirs and start, rather than dead-end a
# headless-host operator at an interactive Claude skill. bootstrap() previously
# pushed "Worktree directory missing" onto its fatal-errors list and returned 1,
# which aborted cmd_start BEFORE its own `mkdir -p "$CATALYST_DIR/wt"` could run —
# proving the auto-create was always intended but unreachable.
#
# These tests source catalyst-monitor.sh and call bootstrap() directly against a
# throwaway CATALYST_DIR. MONITOR_SERVER_SCRIPT is pointed at a stub file whose
# sibling node_modules/ exists, so the orch-monitor install/build block is skipped
# (the test stays hermetic and fast).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
MONITOR_SH="${REPO_ROOT}/plugins/dev/scripts/catalyst-monitor.sh"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

if [[ ! -f "$MONITOR_SH" ]]; then
  echo "FATAL: catalyst-monitor.sh missing: $MONITOR_SH" >&2
  exit 1
fi

# Build a hermetic sandbox: a CATALYST_DIR and a stub server-script dir whose
# node_modules/ already exists (so bootstrap skips the bun install/build block).
# Echoes the sandbox root on stdout.
make_sandbox() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/srv/node_modules"
  : > "$root/srv/server.ts"
  echo "$root"
}

echo "Test: bootstrap self-heals a missing wt/ dir and succeeds"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/catalyst" # CATALYST_DIR exists, but wt/ does NOT
RESULT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; rc=$?
    echo "rc=$rc wt=$([ -d "$CATALYST_DIR/wt" ] && echo yes || echo no)"
  '
)"
[[ "$RESULT" == *"rc=0"* ]] && pass "bootstrap returns 0 when wt/ is absent" \
  || fail "bootstrap should return 0 when wt/ is absent (got: $RESULT)"
[[ "$RESULT" == *"wt=yes"* ]] && pass "bootstrap creates \$CATALYST_DIR/wt when absent" \
  || fail "bootstrap should create \$CATALYST_DIR/wt (got: $RESULT)"
rm -rf "$ROOT"

echo ""
echo "Test: bootstrap stays idempotent when wt/ already exists"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/catalyst/wt" # both CATALYST_DIR and wt/ already present
RESULT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; rc=$?
    echo "rc=$rc wt=$([ -d "$CATALYST_DIR/wt" ] && echo yes || echo no)"
  '
)"
[[ "$RESULT" == *"rc=0"* && "$RESULT" == *"wt=yes"* ]] \
  && pass "bootstrap returns 0 and leaves an existing wt/ in place" \
  || fail "bootstrap should be idempotent when wt/ exists (got: $RESULT)"
rm -rf "$ROOT"

echo ""
echo "Test: a missing CATALYST_DIR itself stays genuinely fatal"
ROOT="$(make_sandbox)" # NOTE: $ROOT/catalyst intentionally NOT created
OUT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    out=$(bootstrap 2>&1); rc=$?
    echo "rc=$rc dir=$([ -d "$CATALYST_DIR" ] && echo yes || echo no) wt=$([ -d "$CATALYST_DIR/wt" ] && echo yes || echo no)"
    echo "$out"
  '
)"
[[ "$OUT" == *"rc=1"* ]] && pass "bootstrap still returns 1 when CATALYST_DIR is missing" \
  || fail "missing CATALYST_DIR must stay fatal (got: $OUT)"
[[ "$OUT" == *"Catalyst directory missing"* ]] \
  && pass "bootstrap still reports the missing-CATALYST_DIR error" \
  || fail "missing-CATALYST_DIR error message should persist (got: $OUT)"
# The wt self-heal must NOT manufacture a runtime dir under a missing parent.
[[ "$OUT" == *"dir=no"* && "$OUT" == *"wt=no"* ]] \
  && pass "wt self-heal does not run when CATALYST_DIR is absent" \
  || fail "wt self-heal must not create dirs under a missing CATALYST_DIR (got: $OUT)"
rm -rf "$ROOT"

echo ""
echo "Test: the self-heal mkdir replaced the hard-fail (source-level guard)"
if grep -q 'Worktree directory missing' "$MONITOR_SH"; then
  fail "catalyst-monitor.sh still hard-fails on missing wt/ ('Worktree directory missing' present)"
else
  pass "catalyst-monitor.sh no longer hard-fails on missing wt/"
fi
if grep -q 'mkdir -p "$CATALYST_DIR/wt"' "$MONITOR_SH"; then
  pass "catalyst-monitor.sh mkdir -p's its wt/ runtime dir"
else
  fail "catalyst-monitor.sh should mkdir -p \$CATALYST_DIR/wt"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-monitor-bootstrap: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
