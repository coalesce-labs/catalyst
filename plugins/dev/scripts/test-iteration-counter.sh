#!/usr/bin/env bash
# Test suite for iteration_count tracking (CTL-158).
#
# Validates:
#   - 004_iteration_counts.sql migration adds plan_iterations + fix_iterations
#   - `catalyst-session.sh iteration <sid> --kind plan|fix [--by N]` increments
#     the matching column and emits a `phase-iteration` event
#   - Invalid --kind is rejected
#   - cmd_end calls emit-otel-metric.sh with the final counts
#   - emit-otel-metric.sh is a silent no-op when OTEL_EXPORTER_OTLP_ENDPOINT
#     is unset, and POSTs a valid OTLP/HTTP metric payload when it is set

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESS_SCRIPT="$SCRIPT_DIR/catalyst-session.sh"
DB_SCRIPT="$SCRIPT_DIR/catalyst-db.sh"
EMIT_SCRIPT="$SCRIPT_DIR/emit-otel-metric.sh"

PASS=true
TESTS=0
FAILURES=0

fail() { echo "  FAIL: $1"; PASS=false; FAILURES=$((FAILURES + 1)); }
pass() { echo "  PASS: $1"; }
run_test() { TESTS=$((TESTS + 1)); echo ""; echo "--- Test $TESTS: $1 ---"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label ($actual)"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

make_tmpdir() { mktemp -d -t catalyst-iter-test-XXXXXX; }

if [[ ! -x "$SESS_SCRIPT" ]]; then
  echo "FATAL: catalyst-session.sh not found at $SESS_SCRIPT" >&2; exit 1
fi
if [[ ! -x "$EMIT_SCRIPT" ]]; then
  echo "FATAL: emit-otel-metric.sh not found at $EMIT_SCRIPT" >&2; exit 1
fi

# ─── Test 1: migration adds plan_iterations + fix_iterations ────────────────
run_test "004 migration adds iteration columns"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

COLS=$(sqlite3 "$TMP/catalyst.db" "PRAGMA table_info(session_metrics);" | awk -F'|' '{print $2}' | sort)
echo "$COLS" | grep -qx plan_iterations && pass "plan_iterations column exists" \
  || fail "plan_iterations column missing"
echo "$COLS" | grep -qx fix_iterations && pass "fix_iterations column exists" \
  || fail "fix_iterations column missing"

rm -rf "$TMP"

# ─── Test 2: iteration --kind plan increments lazily ────────────────────────
run_test "iteration --kind plan increments from 0"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-158)

"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null

V=$(sqlite3 "$TMP/catalyst.db" "SELECT plan_iterations FROM session_metrics WHERE session_id='$SID';")
assert_eq "3" "$V" "plan_iterations == 3 after 3 bumps"

V=$(sqlite3 "$TMP/catalyst.db" "SELECT fix_iterations FROM session_metrics WHERE session_id='$SID';")
assert_eq "0" "$V" "fix_iterations untouched"

rm -rf "$TMP"

# ─── Test 3: iteration --kind fix increments independently ──────────────────
run_test "iteration --kind fix increments independently"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-158)

"$SESS_SCRIPT" iteration "$SID" --kind fix >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind fix >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null

V=$(sqlite3 "$TMP/catalyst.db" "SELECT fix_iterations  FROM session_metrics WHERE session_id='$SID';")
assert_eq "2" "$V" "fix_iterations == 2"
V=$(sqlite3 "$TMP/catalyst.db" "SELECT plan_iterations FROM session_metrics WHERE session_id='$SID';")
assert_eq "1" "$V" "plan_iterations == 1"

rm -rf "$TMP"

# ─── Test 4: iteration --by N increments by N ───────────────────────────────
run_test "iteration --by N increments by N"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-158)

"$SESS_SCRIPT" iteration "$SID" --kind fix --by 5 >/dev/null
V=$(sqlite3 "$TMP/catalyst.db" "SELECT fix_iterations FROM session_metrics WHERE session_id='$SID';")
assert_eq "5" "$V" "fix_iterations == 5 after --by 5"

"$SESS_SCRIPT" iteration "$SID" --kind fix --by 3 >/dev/null
V=$(sqlite3 "$TMP/catalyst.db" "SELECT fix_iterations FROM session_metrics WHERE session_id='$SID';")
assert_eq "8" "$V" "fix_iterations == 8 after +3"

rm -rf "$TMP"

# ─── Test 5: invalid --kind rejected ────────────────────────────────────────
run_test "invalid --kind rejected with exit 1"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-158)

if "$SESS_SCRIPT" iteration "$SID" --kind banana >/dev/null 2>&1; then
  fail "iteration --kind banana should have failed"
else
  pass "iteration --kind banana exited non-zero"
fi

if "$SESS_SCRIPT" iteration "$SID" >/dev/null 2>&1; then
  fail "iteration without --kind should have failed"
else
  pass "iteration without --kind exited non-zero"
fi

rm -rf "$TMP"

# ─── Test 6: phase-iteration event emitted with correct payload ─────────────
run_test "phase-iteration event emitted with correct payload"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-158)

"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind fix  >/dev/null

EV=$("$DB_SCRIPT" events list --session "$SID" --type phase-iteration)
COUNT=$(echo "$EV" | jq 'length')
assert_eq "3" "$COUNT" "3 phase-iteration events emitted"

# Latest plan event should have count==2
PLAN_LAST=$(echo "$EV" | jq '[.[] | select((.payload|fromjson).kind == "plan")] | last')
assert_eq "plan" "$(echo "$PLAN_LAST" | jq -r '.payload | fromjson | .kind')" "plan event kind"
assert_eq "2"    "$(echo "$PLAN_LAST" | jq -r '.payload | fromjson | .count')" "plan event count == 2"

# The fix event should have count==1
FIX_EV=$(echo "$EV" | jq '[.[] | select((.payload|fromjson).kind == "fix")] | last')
assert_eq "1" "$(echo "$FIX_EV" | jq -r '.payload | fromjson | .count')" "fix event count == 1"

rm -rf "$TMP"

# ─── Test 7: cmd_end calls emit-otel-metric.sh with final counts ────────────
run_test "cmd_end invokes emit-otel-metric.sh with plan+fix counts"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-158)

"$SESS_SCRIPT" iteration "$SID" --kind plan >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind fix  >/dev/null
"$SESS_SCRIPT" iteration "$SID" --kind fix  >/dev/null

# Shadow the real emit-otel-metric.sh with a stub that captures args.
STUB_DIR=$(mktemp -d)
cat > "$STUB_DIR/emit-otel-metric.sh" <<'STUB'
#!/usr/bin/env bash
echo "$@" >> "$CAPTURE_FILE"
STUB
chmod +x "$STUB_DIR/emit-otel-metric.sh"
export CAPTURE_FILE="$TMP/emit-args.log"

# cmd_end resolves emit-otel-metric.sh relative to its own SCRIPT_DIR, so the
# only reliable way to inject a stub is to override via CATALYST_EMIT_METRIC env.
# The implementation reads CATALYST_EMIT_METRIC if set.
CATALYST_EMIT_METRIC="$STUB_DIR/emit-otel-metric.sh" \
  "$SESS_SCRIPT" end "$SID" --status done >/dev/null

[[ -f "$CAPTURE_FILE" ]] || { fail "emit stub was not invoked"; rm -rf "$TMP" "$STUB_DIR"; :; }
LINES=$(wc -l < "$CAPTURE_FILE" | tr -d ' ')
assert_eq "2" "$LINES" "emit-otel-metric.sh called twice (plan + fix)"

grep -q -- "--kind plan"  "$CAPTURE_FILE" && pass "plan emit observed"   || fail "plan emit missing"
grep -q -- "--kind fix"   "$CAPTURE_FILE" && pass "fix emit observed"    || fail "fix emit missing"
grep -q -- "--count 1"    "$CAPTURE_FILE" && pass "plan count==1 observed" || fail "plan count==1 missing"
grep -q -- "--count 2"    "$CAPTURE_FILE" && pass "fix count==2 observed"  || fail "fix count==2 missing"
grep -q -- "--linear-key CTL-158" "$CAPTURE_FILE" && pass "linear-key flag observed" \
  || fail "linear-key flag missing"

rm -rf "$TMP" "$STUB_DIR"

# ─── Test 8: emit-otel-metric.sh is a silent no-op without endpoint ─────────
run_test "emit-otel-metric.sh no-op when OTEL endpoint unset"
unset OTEL_EXPORTER_OTLP_ENDPOINT
OUT=$("$EMIT_SCRIPT" iteration_count --kind plan --count 3 --linear-key CTL-1 2>&1)
RC=$?
assert_eq "0" "$RC" "exit code 0 on unset endpoint"
[[ -z "$OUT" ]] && pass "no stdout/stderr produced" || fail "unexpected output: $OUT"

# ─── Test 9: emit-otel-metric.sh POSTs OTLP/HTTP to /v1/metrics ─────────────
run_test "emit-otel-metric.sh POSTs valid OTLP/HTTP payload"
TMP=$(make_tmpdir)
STUB_DIR=$(mktemp -d)
# Shadow curl with a stub that captures all args + stdin.
cat > "$STUB_DIR/curl" <<'STUB'
#!/usr/bin/env bash
echo "ARGS:$@" > "$CAPTURE_FILE"
# The emitter passes payload via --data @- on stdin.
cat >> "$CAPTURE_FILE"
STUB
chmod +x "$STUB_DIR/curl"
export CAPTURE_FILE="$TMP/curl.log"
export PATH="$STUB_DIR:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4317"

"$EMIT_SCRIPT" iteration_count --kind fix --count 7 --linear-key CTL-158 --start-ns 1700000000000000000 >/dev/null

[[ -f "$CAPTURE_FILE" ]] || fail "curl stub was not invoked"
grep -q "4318/v1/metrics" "$CAPTURE_FILE" && pass "posted to /v1/metrics (port 4318)" \
  || fail "wrong URL / port — saw: $(grep ARGS: "$CAPTURE_FILE")"

# Extract the JSON body (everything after the "ARGS:" line)
BODY=$(sed -n '2,$p' "$CAPTURE_FILE")
if echo "$BODY" | jq . >/dev/null 2>&1; then
  pass "payload is valid JSON"
else
  fail "payload is not valid JSON: $BODY"
fi
echo "$BODY" | jq -e '.resourceMetrics[0].scopeMetrics[0].metrics[0].name == "iteration_count"' >/dev/null \
  && pass "metric name is iteration_count" \
  || fail "metric name wrong"
echo "$BODY" | jq -e '.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt == "7"' >/dev/null \
  && pass "data point asInt == '7'" \
  || fail "data point value wrong"
echo "$BODY" | jq -e '.resourceMetrics[0].resource.attributes[] | select(.key=="linear.key") | .value.stringValue == "CTL-158"' >/dev/null \
  && pass "resource has linear.key attribute" \
  || fail "linear.key resource attribute missing"
echo "$BODY" | jq -e '.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes[] | select(.key=="kind") | .value.stringValue == "fix"' >/dev/null \
  && pass "data point has kind=fix" \
  || fail "kind attribute missing"
echo "$BODY" | jq -e '.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.isMonotonic == true' >/dev/null \
  && pass "counter isMonotonic = true" \
  || fail "isMonotonic flag wrong"
echo "$BODY" | jq -e '.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality == 2' >/dev/null \
  && pass "aggregationTemporality = 2 (CUMULATIVE)" \
  || fail "aggregationTemporality wrong"

rm -rf "$TMP" "$STUB_DIR"
unset OTEL_EXPORTER_OTLP_ENDPOINT

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "Tests: $TESTS, Failures: $FAILURES"
$PASS && { echo "RESULT: ALL PASS"; exit 0; } || { echo "RESULT: FAILURES"; exit 1; }
