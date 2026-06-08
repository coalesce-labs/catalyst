#!/usr/bin/env bash
# Shell tests for catalyst-execution-core register verb (CTL-854).
# Run: bash plugins/dev/scripts/__tests__/catalyst-execution-core-register.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-execution-core"
REGISTRY_MJS="${REPO_ROOT}/plugins/dev/scripts/execution-core/registry.mjs"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Resolve bun/node — mirrors catalyst-execution-core's resolve_runtime
RUNTIME=""
if command -v bun &>/dev/null; then RUNTIME="bun"; elif command -v node &>/dev/null; then RUNTIME="node"; else
  echo "SKIP: neither bun nor node found" && exit 0
fi

registry_list() {
  # Use NO_COLOR=1 to suppress ANSI escape codes from bun's colorized output.
  CATALYST_DIR="$1" NO_COLOR=1 "$RUNTIME" "$REGISTRY_MJS" list 2>/dev/null
}

# 1. register --team TST --repo-root creates a well-formed entry
echo "test 1: register --team + --repo-root creates a well-formed entry"
TDIR="$(mktemp -d)"
TMPREPO="$(mktemp -d)"
if CATALYST_DIR="$TDIR" "$SCRIPT" register --team TST --repo-root "$TMPREPO" >/dev/null 2>&1; then
  TEAM="$(registry_list "$TDIR" | jq -r '.[0].team')"
  ROOT="$(registry_list "$TDIR" | jq -r '.[0].repoRoot')"
  if [ "$TEAM" = "TST" ] && [ "$ROOT" = "$TMPREPO" ]; then
    pass "register writes team=TST repoRoot=$TMPREPO"
  else
    fail "register writes entry" "team=$TEAM root=$ROOT expected TST / $TMPREPO"
  fi
else
  fail "register exits 0"
fi
rm -rf "$TDIR" "$TMPREPO"

# 2. register without --repo-root resolves from current git repo
echo "test 2: register without --repo-root resolves repoRoot from current git repo"
TDIR="$(mktemp -d)"
GIT_TOPLEVEL="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$GIT_TOPLEVEL" ]; then
  if (cd "$REPO_ROOT" && CATALYST_DIR="$TDIR" "$SCRIPT" register --team TST >/dev/null 2>&1); then
    ROOT="$(registry_list "$TDIR" | jq -r '.[0].repoRoot')"
    if [ "$ROOT" = "$GIT_TOPLEVEL" ]; then
      pass "register resolves repoRoot from current git repo"
    else
      fail "register resolves repoRoot" "got=$ROOT expected=$GIT_TOPLEVEL"
    fi
  else
    fail "register without --repo-root exits 0"
  fi
else
  echo "  SKIP test 2: not in a git repo"
  PASSES=$((PASSES + 1))
fi
rm -rf "$TDIR"

# 3. register --eligible-query round-trips the query
echo "test 3: register --eligible-query round-trips the query JSON"
TDIR="$(mktemp -d)"
TMPREPO="$(mktemp -d)"
EQ='{"status":"Todo"}'
if CATALYST_DIR="$TDIR" "$SCRIPT" register --team TST --repo-root "$TMPREPO" --eligible-query "$EQ" >/dev/null 2>&1; then
  STATUS="$(registry_list "$TDIR" | jq -r '.[0].eligibleQuery.status')"
  if [ "$STATUS" = "Todo" ]; then
    pass "register round-trips eligible-query"
  else
    fail "register round-trips eligible-query" "eligibleQuery.status=$STATUS expected Todo"
  fi
else
  fail "register --eligible-query exits 0"
fi
rm -rf "$TDIR" "$TMPREPO"

# 4. register with no --team and no resolvable team → non-zero exit + stderr message
echo "test 4: register with no --team fails loudly"
TDIR="$(mktemp -d)"
TMPREPO="$(mktemp -d)"
ERR_OUT="$(mktemp)"
if CATALYST_DIR="$TDIR" "$SCRIPT" register --repo-root "$TMPREPO" >"$ERR_OUT" 2>&1; then
  fail "register without --team should exit non-zero"
else
  if grep -qi "team" "$ERR_OUT"; then
    pass "register without --team fails with error mentioning --team"
  else
    fail "register without --team error mentions --team" "stderr: $(cat "$ERR_OUT")"
  fi
fi
rm -rf "$TDIR" "$TMPREPO" "$ERR_OUT"

# 5. register is idempotent — re-running replaces in place, no duplicate
echo "test 5: register is idempotent (no duplicate)"
TDIR="$(mktemp -d)"
TMPREPO="$(mktemp -d)"
CATALYST_DIR="$TDIR" "$SCRIPT" register --team TST --repo-root "$TMPREPO" >/dev/null 2>&1 || true
CATALYST_DIR="$TDIR" "$SCRIPT" register --team TST --repo-root "$TMPREPO" >/dev/null 2>&1 || true
COUNT="$(registry_list "$TDIR" | jq 'length')"
if [ "$COUNT" = "1" ]; then
  pass "register is idempotent (1 entry, no duplicate)"
else
  fail "register idempotent" "count=$COUNT expected 1"
fi
rm -rf "$TDIR" "$TMPREPO"

# 6. Sourcing the script (source-safety guard) does NOT invoke cmd_register
echo "test 6: sourcing the script does not dispatch register"
TDIR="$(mktemp -d)"
# If sourcing triggered cmd_register, it would write to CATALYST_DIR registry.
CATALYST_DIR="$TDIR" bash -c "source '$SCRIPT'" 2>/dev/null || true
if [ ! -f "$TDIR/execution-core/registry.json" ]; then
  pass "sourcing does not dispatch register"
else
  fail "sourcing dispatches register (guard broken)"
fi
rm -rf "$TDIR"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ] && exit 0 || exit 1
