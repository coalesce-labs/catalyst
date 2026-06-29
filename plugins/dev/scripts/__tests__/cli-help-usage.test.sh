#!/usr/bin/env bash
# CLI -h/--help + bare-usage contract (CTL-1383).
# Run: bash plugins/dev/scripts/__tests__/cli-help-usage.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="${SCRIPT_DIR}/.."                              # plugins/dev/scripts
PMOPS_WC="${SCRIPTS}/../../pm-ops/scripts/workflow-context.sh"

FAILURES=0; PASSES=0
ok()   { PASSES=$((PASSES+1));  echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq()       { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
expect_ne()       { if [[ "$2" != "$3" ]]; then ok "$1"; else fail "$1" "expected != '$3'"; fi; }
expect_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else fail "$1" "'$2' lacks '$3'"; fi; }

# --- helper: assert the standard --help contract on a dispatcher ---
assert_help_contract() {           # <label> <tool-name-substr> <script> [args...]
  local label="$1" name="$2" script="$3"; shift 3
  local out rc
  out="$("$script" --help 2>/dev/null)"; rc=$?
  expect_eq    "$label: --help exits 0"            "0" "$rc"
  expect_contains "$label: --help names the tool"  "$out" "$name"
  expect_contains "$label: --help has a Usage block" "$out" "Usage:"
  out="$("$script" -h 2>/dev/null)"; rc=$?
  expect_eq    "$label: -h alias exits 0"          "0" "$rc"
  # bare → usage to stderr, non-zero
  out="$("$script" 2>&1 >/dev/null)"; rc=$?
  expect_ne    "$label: bare exits non-zero"       "0" "$rc"
  expect_contains "$label: bare prints usage to stderr" "$out" "Usage:"
  # unknown subcommand → non-zero + usage
  out="$("$script" no-such-cmd 2>&1 >/dev/null)"; rc=$?
  expect_ne    "$label: unknown exits non-zero"    "0" "$rc"
  expect_contains "$label: unknown prints usage"   "$out" "Usage:"
}

echo "catalyst-broker";          assert_help_contract "broker"   "catalyst-broker"   "${SCRIPTS}/catalyst-broker"
echo "catalyst-thoughts.sh";     assert_help_contract "thoughts" "catalyst-thoughts" "${SCRIPTS}/catalyst-thoughts.sh"
echo "workflow-context (dev)";   assert_help_contract "wc-dev"   "workflow-context"  "${SCRIPTS}/workflow-context.sh"
echo "workflow-context (pm-ops)";assert_help_contract "wc-pm"    "workflow-context"  "$PMOPS_WC"

# dev copy advertises set-orchestration; pm-ops copy must NOT
dev_help="$("${SCRIPTS}/workflow-context.sh" --help 2>/dev/null)"
pm_help="$("$PMOPS_WC" --help 2>/dev/null)"
expect_contains "wc-dev advertises set-orchestration" "$dev_help" "set-orchestration"
if [[ "$pm_help" == *"set-orchestration"* ]]; then
  fail "wc-pm omits set-orchestration" "pm-ops copy lists a subcommand it does not implement"
else ok "wc-pm omits set-orchestration"; fi

# "no work on --help": running --help in an empty cwd must not create .catalyst/
TMP="$(mktemp -d)"; ( cd "$TMP" && "${SCRIPTS}/workflow-context.sh" --help >/dev/null 2>&1 )
if [[ -e "$TMP/.catalyst" ]]; then fail "wc-dev --help does no work" ".catalyst created"; else ok "wc-dev --help does no work"; fi
rm -rf "$TMP"

# --- catalyst-why: -h/--help → stdout exit 0; bare → usage stderr exit 1 ---
echo "catalyst-why"
out="$("${SCRIPTS}/catalyst-why" --help 2>/dev/null)"; rc=$?
expect_eq "why: --help exits 0" "0" "$rc"
expect_contains "why: --help names the tool" "$out" "catalyst-why"
expect_contains "why: --help has Usage block" "$out" "Usage:"
out="$("${SCRIPTS}/catalyst-why" 2>&1 >/dev/null)"; rc=$?
expect_ne "why: bare exits non-zero" "0" "$rc"
expect_contains "why: bare prints usage to stderr" "$out" "Usage:"

# --- catalyst-otel-forward: -h/--help only (bare = daemon, NOT tested) ---
echo "catalyst-otel-forward"
out="$("${SCRIPTS}/catalyst-otel-forward" --help 2>/dev/null)"; rc=$?
expect_eq "otel: --help exits 0" "0" "$rc"
expect_contains "otel: --help names the tool" "$out" "catalyst-otel-forward"
expect_contains "otel: --help has Usage block" "$out" "Usage:"
out="$("${SCRIPTS}/catalyst-otel-forward" -h 2>/dev/null)"; rc=$?
expect_eq "otel: -h alias exits 0" "0" "$rc"

echo; echo "RESULTS: $PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
