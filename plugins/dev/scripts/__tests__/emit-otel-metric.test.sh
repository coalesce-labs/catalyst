#!/usr/bin/env bash
# Tests for emit-otel-metric.sh — the OTLP/HTTP metric emitter used by
# catalyst-session.sh to flush per-session counters.
#
# Approach: stub `curl` on PATH, capture the URL + JSON payload from stdin
# (script uses `printf '%s' "$PAYLOAD" | curl ... --data @-`), then assert
# both. Silent-failure paths assert exit 0 regardless of curl stub exit code.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMIT_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/emit-otel-metric.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t emit-otel-metric-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label — '$needle' not found in '$haystack'"
  fi
}

# ─── curl stub ──────────────────────────────────────────────────────────────
# Records args to $CURL_STUB_ARGS and payload (from stdin via --data @-)
# to $CURL_STUB_BODY. Exits with $CURL_STUB_EXIT (default 0).
setup_curl_stub() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/curl" <<'STUB'
#!/usr/bin/env bash
ARGS_FILE="${CURL_STUB_ARGS:-/tmp/curl-stub.args}"
BODY_FILE="${CURL_STUB_BODY:-/tmp/curl-stub.body}"
printf '%s\n' "$@" > "$ARGS_FILE"

# Extract body from -d / --data / --data @- (stdin).
body=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-d" || "$prev" == "--data" || "$prev" == "--data-raw" ]]; then
    body="$a"
    break
  fi
  prev="$a"
done
# @- means read from stdin; @<file> means read from that file.
if [[ "$body" == @* ]]; then
  body=$(cat "${body:1}")
fi
printf '%s' "$body" > "$BODY_FILE"
exit "${CURL_STUB_EXIT:-0}"
STUB
  chmod +x "$stub_dir/curl"
}

if [[ ! -x "$EMIT_SCRIPT" ]]; then
  echo "FATAL: emit-otel-metric.sh not found or not executable at $EMIT_SCRIPT" >&2
  exit 1
fi

# ─── Test 1: baseline payload structure ─────────────────────────────────────
echo ""
echo "--- Test 1: baseline OTLP metric payload structure ---"
STUB_DIR_1="$SCRATCH/stub1"
setup_curl_stub "$STUB_DIR_1"
export PATH="$STUB_DIR_1:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4317"
export CURL_STUB_ARGS="$SCRATCH/args1"
export CURL_STUB_BODY="$SCRATCH/body1"
unset CURL_STUB_EXIT

"$EMIT_SCRIPT" iteration_count \
  --kind plan \
  --count 5 \
  --linear-key CTL-1 \
  >/dev/null 2>&1
EXIT_CODE=$?

assert_eq "0" "$EXIT_CODE" "exit 0 on success"
[[ -f "$SCRATCH/body1" ]] && pass "curl stub received a body" || fail "no body captured"

BODY_1=$(cat "$SCRATCH/body1" 2>/dev/null || echo "")
if echo "$BODY_1" | jq -e '.resourceMetrics[0].scopeMetrics[0].metrics[0]' >/dev/null 2>&1; then
  pass "payload has valid OTLP metric structure"
else
  fail "payload is not valid OTLP metric shape: $BODY_1"
fi

assert_eq "iteration_count" \
  "$(echo "$BODY_1" | jq -r '.resourceMetrics[0].scopeMetrics[0].metrics[0].name')" \
  "metric name is iteration_count"

assert_eq "claude-code" \
  "$(echo "$BODY_1" | jq -r '.resourceMetrics[0].resource.attributes[] | select(.key=="service.name") | .value.stringValue')" \
  "service.name=claude-code in resource attributes"

assert_eq "plan" \
  "$(echo "$BODY_1" | jq -r '.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes[] | select(.key=="kind") | .value.stringValue')" \
  "kind=plan in data point attributes"

assert_eq "5" \
  "$(echo "$BODY_1" | jq -r '.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt')" \
  "asInt==5"

# ─── Test 2: --linear-key → resource attribute (regression guard) ────────────
echo ""
echo "--- Test 2: --linear-key sets resource attribute ---"
STUB_DIR_2="$SCRATCH/stub2"
setup_curl_stub "$STUB_DIR_2"
export PATH="$STUB_DIR_2:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args2"
export CURL_STUB_BODY="$SCRATCH/body2"

"$EMIT_SCRIPT" iteration_count \
  --kind plan \
  --count 1 \
  --linear-key CTL-1 \
  >/dev/null 2>&1

BODY_2=$(cat "$SCRATCH/body2")
assert_eq "CTL-1" \
  "$(echo "$BODY_2" | jq -r '.resourceMetrics[0].resource.attributes[] | select(.key=="linear.key") | .value.stringValue')" \
  "linear.key==CTL-1 in resource attributes"

# ─── Test 3: omitting --resource-attr is byte-identical ─────────────────────
echo ""
echo "--- Test 3: omitting --resource-attr yields byte-identical resource array ---"
STUB_DIR_3="$SCRATCH/stub3"
setup_curl_stub "$STUB_DIR_3"
export PATH="$STUB_DIR_3:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args3"
export CURL_STUB_BODY="$SCRATCH/body3"

"$EMIT_SCRIPT" iteration_count \
  --kind fix \
  --count 2 \
  --linear-key CTL-1 \
  >/dev/null 2>&1

BODY_3=$(cat "$SCRATCH/body3")
EXPECTED_RES_3='[{"key":"service.name","value":{"stringValue":"claude-code"}},{"key":"linear.key","value":{"stringValue":"CTL-1"}}]'
ACTUAL_RES_3="$(echo "$BODY_3" | jq -c '.resourceMetrics[0].resource.attributes')"
assert_eq "$EXPECTED_RES_3" "$ACTUAL_RES_3" "omitting --resource-attr: resource array is byte-identical"

# ─── Test 4: --resource-attr string appended after existing entries ──────────
echo ""
echo "--- Test 4: --resource-attr string appended after existing entries ---"
STUB_DIR_4="$SCRATCH/stub4"
setup_curl_stub "$STUB_DIR_4"
export PATH="$STUB_DIR_4:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args4"
export CURL_STUB_BODY="$SCRATCH/body4"

"$EMIT_SCRIPT" iteration_count \
  --kind plan \
  --count 1 \
  --linear-key CTL-1 \
  --resource-attr "project=catalyst" \
  >/dev/null 2>&1

BODY_4=$(cat "$SCRATCH/body4")
assert_eq "catalyst" \
  "$(echo "$BODY_4" | jq -r '.resourceMetrics[0].resource.attributes[] | select(.key=="project") | .value.stringValue')" \
  "--resource-attr project=catalyst present"

# ─── Test 5: integer --resource-attr → intValue ─────────────────────────────
echo ""
echo "--- Test 5: integer --resource-attr emits intValue ---"
STUB_DIR_5="$SCRATCH/stub5"
setup_curl_stub "$STUB_DIR_5"
export PATH="$STUB_DIR_5:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args5"
export CURL_STUB_BODY="$SCRATCH/body5"

"$EMIT_SCRIPT" iteration_count \
  --kind plan \
  --count 1 \
  --linear-key CTL-1 \
  --resource-attr "revive_count=4" \
  >/dev/null 2>&1

BODY_5=$(cat "$SCRATCH/body5")
assert_eq "4" \
  "$(echo "$BODY_5" | jq -r '.resourceMetrics[0].resource.attributes[] | select(.key=="revive_count") | .value.intValue')" \
  "integer --resource-attr: intValue==4"
assert_eq "null" \
  "$(echo "$BODY_5" | jq -r '.resourceMetrics[0].resource.attributes[] | select(.key=="revive_count") | .value.stringValue // "null"')" \
  "integer --resource-attr: stringValue is absent"

# ─── Test 6: silent no-op when OTEL_EXPORTER_OTLP_ENDPOINT unset ────────────
echo ""
echo "--- Test 6: silent no-op when endpoint unset ---"
STUB_DIR_6="$SCRATCH/stub6"
setup_curl_stub "$STUB_DIR_6"
export PATH="$STUB_DIR_6:$PATH"
unset OTEL_EXPORTER_OTLP_ENDPOINT
export CURL_STUB_ARGS="$SCRATCH/args6"
export CURL_STUB_BODY="$SCRATCH/body6"
rm -f "$SCRATCH/args6" "$SCRATCH/body6"
export CURL_STUB_EXIT=99

"$EMIT_SCRIPT" iteration_count --kind plan --count 1 >/dev/null 2>&1
EXIT_CODE_6=$?
assert_eq "0" "$EXIT_CODE_6" "exit 0 when endpoint unset"
if [[ ! -f "$SCRATCH/args6" ]]; then
  pass "curl not invoked when endpoint unset"
else
  fail "curl was invoked — stub args captured: $(cat "$SCRATCH/args6")"
fi
unset CURL_STUB_EXIT
export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4317"

# ─── Test 7: unknown flag is silent no-op ───────────────────────────────────
echo ""
echo "--- Test 7: unknown flag is silent no-op (die_silent contract) ---"
STUB_DIR_7="$SCRATCH/stub7"
setup_curl_stub "$STUB_DIR_7"
export PATH="$STUB_DIR_7:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args7"
export CURL_STUB_BODY="$SCRATCH/body7"
rm -f "$SCRATCH/args7" "$SCRATCH/body7"

"$EMIT_SCRIPT" iteration_count --kind plan --count 1 --bogus x >/dev/null 2>&1
EXIT_CODE_7=$?
assert_eq "0" "$EXIT_CODE_7" "unknown flag: exit 0 (silent no-op)"
if [[ ! -f "$SCRATCH/args7" ]]; then
  pass "unknown flag: curl not invoked"
else
  fail "unknown flag: curl was unexpectedly invoked"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────"
echo "  Passed: $PASSES"
echo "  Failed: $FAILURES"
echo "─────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
