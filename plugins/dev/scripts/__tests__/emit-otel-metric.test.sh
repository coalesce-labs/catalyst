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

# ─── Test 6: silent no-op when endpoint unset and config has no endpoint ────
# CTL-1008 Phase 3: uses an isolated HOME with an empty observability config
# so the config-fallback path also finds nothing → script is still a no-op.
echo ""
echo "--- Test 6: silent no-op when endpoint unset and config has no endpoint ---"
STUB_DIR_6="$SCRATCH/stub6"
setup_curl_stub "$STUB_DIR_6"
CONFIG_DIR_6="$SCRATCH/config6"
mkdir -p "$CONFIG_DIR_6/.config/catalyst"
printf '{"catalyst":{"observability":{}}}\n' \
  > "$CONFIG_DIR_6/.config/catalyst/config-catalyst-workspace.json"
export PATH="$STUB_DIR_6:$PATH"
unset OTEL_EXPORTER_OTLP_ENDPOINT
REAL_HOME_6="$HOME"
export HOME="$CONFIG_DIR_6"
export CURL_STUB_ARGS="$SCRATCH/args6"
export CURL_STUB_BODY="$SCRATCH/body6"
rm -f "$SCRATCH/args6" "$SCRATCH/body6"
export CURL_STUB_EXIT=99

"$EMIT_SCRIPT" iteration_count --kind plan --count 1 >/dev/null 2>&1
EXIT_CODE_6=$?
export HOME="$REAL_HOME_6"
assert_eq "0" "$EXIT_CODE_6" "exit 0 when endpoint unset and config empty"
if [[ ! -f "$SCRATCH/args6" ]]; then
  pass "curl not invoked when endpoint unset and config empty"
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

# ─── Test 8 (CTL-1008 Phase 3): config fallback when OTEL_EXPORTER_OTLP_ENDPOINT unset ─────
echo ""
echo "--- Test 8 (CTL-1008): config fallback — endpoint from workspace config ---"
STUB_DIR_8="$SCRATCH/stub8"
setup_curl_stub "$STUB_DIR_8"
# Write a minimal workspace config with the OTLP endpoint
CONFIG_DIR_8="$SCRATCH/config8"
mkdir -p "$CONFIG_DIR_8"
cat > "$CONFIG_DIR_8/config-catalyst-workspace.json" <<'CFGEOF'
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "otlp": {
          "endpoint": "http://100.65.193.30:4317"
        }
      }
    }
  }
}
CFGEOF
export PATH="$STUB_DIR_8:$PATH"
unset OTEL_EXPORTER_OTLP_ENDPOINT
# Override HOME so the script reads our fixture config
REAL_HOME="$HOME"
export HOME="$CONFIG_DIR_8"
mkdir -p "$HOME/.config/catalyst"
cp "$CONFIG_DIR_8/config-catalyst-workspace.json" "$HOME/.config/catalyst/config-catalyst-workspace.json"
export CURL_STUB_ARGS="$SCRATCH/args8"
export CURL_STUB_BODY="$SCRATCH/body8"
rm -f "$SCRATCH/args8" "$SCRATCH/body8"

"$EMIT_SCRIPT" iteration_count --kind plan --count 1 >/dev/null 2>&1
EXIT_CODE_8=$?
export HOME="$REAL_HOME"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4317"
assert_eq "0" "$EXIT_CODE_8" "config fallback: exit 0"
if [[ -f "$SCRATCH/args8" ]]; then
  CAPTURED_URL_8="$(grep -o 'http://[^ ]*' "$SCRATCH/args8" | head -1)"
  assert_contains "$CAPTURED_URL_8" "100.65.193.30" "config fallback: POSTed to config endpoint"
  assert_contains "$CAPTURED_URL_8" "4318" "config fallback: port 4317→4318 swap applied"
else
  fail "config fallback: curl not invoked — endpoint not resolved from config"
fi

# ─── Test 9 (CTL-1008 Phase 3): still silent no-op when neither env nor config has endpoint ─
echo ""
echo "--- Test 9 (CTL-1008): silent no-op when neither env nor config has endpoint ---"
STUB_DIR_9="$SCRATCH/stub9"
setup_curl_stub "$STUB_DIR_9"
CONFIG_DIR_9="$SCRATCH/config9"
mkdir -p "$CONFIG_DIR_9/.config/catalyst"
# Write a config without any OTLP endpoint
cat > "$CONFIG_DIR_9/.config/catalyst/config-catalyst-workspace.json" <<'CFGEOF'
{
  "catalyst": {
    "observability": {}
  }
}
CFGEOF
export PATH="$STUB_DIR_9:$PATH"
unset OTEL_EXPORTER_OTLP_ENDPOINT
REAL_HOME_9="$HOME"
export HOME="$CONFIG_DIR_9"
export CURL_STUB_ARGS="$SCRATCH/args9"
export CURL_STUB_BODY="$SCRATCH/body9"
rm -f "$SCRATCH/args9" "$SCRATCH/body9"
export CURL_STUB_EXIT=99

"$EMIT_SCRIPT" iteration_count --kind plan --count 1 >/dev/null 2>&1
EXIT_CODE_9=$?
export HOME="$REAL_HOME_9"
unset CURL_STUB_EXIT
export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4317"
assert_eq "0" "$EXIT_CODE_9" "no endpoint: exit 0 (silent no-op)"
if [[ ! -f "$SCRATCH/args9" ]]; then
  pass "no endpoint: curl not invoked"
else
  fail "no endpoint: curl was invoked unexpectedly"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────"
echo "  Passed: $PASSES"
echo "  Failed: $FAILURES"
echo "─────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
