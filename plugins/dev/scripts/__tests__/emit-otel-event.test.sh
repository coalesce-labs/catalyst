#!/usr/bin/env bash
# Tests for emit-otel-event.sh — the OTLP/HTTP log emitter used by
# catalyst-session.sh and catalyst-state.sh to send session.outcome events
# to the Claude Code OTel collector.
#
# Approach: stub `curl` on PATH, capture the URL + JSON payload into fixture
# files, then assert both. Silent-failure paths assert exit 0 regardless of
# curl stub exit code.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMIT_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/emit-otel-event.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t emit-otel-test-XXXXXX)"
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
# Records the URL and captured body to $SCRATCH/curl.log and $SCRATCH/curl.body.
# Exits with whatever $CURL_STUB_EXIT says (default 0).
setup_curl_stub() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  cat > "$stub_dir/curl" <<'STUB'
#!/usr/bin/env bash
# Record invocation: args and stdin (if any).
ARGS_FILE="${CURL_STUB_ARGS:-/tmp/curl-stub.args}"
BODY_FILE="${CURL_STUB_BODY:-/tmp/curl-stub.body}"
printf '%s\n' "$@" > "$ARGS_FILE"

# Extract -d payload if supplied as -d <value> or --data <value>.
body=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-d" || "$prev" == "--data" || "$prev" == "--data-raw" ]]; then
    body="$a"
    break
  fi
  prev="$a"
done
# Support -d@file by reading the file.
if [[ "$body" == @* ]]; then
  body=$(cat "${body:1}")
fi
printf '%s' "$body" > "$BODY_FILE"
exit "${CURL_STUB_EXIT:-0}"
STUB
  chmod +x "$stub_dir/curl"
}

if [[ ! -x "$EMIT_SCRIPT" ]]; then
  echo "FATAL: emit-otel-event.sh not found or not executable at $EMIT_SCRIPT" >&2
  exit 1
fi

# ─── Test 1: builds a valid OTLP log payload ────────────────────────────────
echo ""
echo "--- Test 1: OTLP log payload structure ---"
STUB_DIR="$SCRATCH/stub1"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4317"
export CURL_STUB_ARGS="$SCRATCH/args1"
export CURL_STUB_BODY="$SCRATCH/body1"
export CURL_STUB_EXIT=0

"$EMIT_SCRIPT" \
  --event "claude_code.session.outcome" \
  --outcome success \
  --session-id sess_abc \
  >/dev/null 2>&1
EXIT_CODE=$?

assert_eq "0" "$EXIT_CODE" "exit 0 on success"
[[ -f "$SCRATCH/body1" ]] && pass "curl stub received a body" || fail "no body captured"

BODY=$(cat "$SCRATCH/body1" 2>/dev/null || echo "")
# Validate JSON shape with jq
if echo "$BODY" | jq -e '.resourceLogs[0].scopeLogs[0].logRecords[0]' >/dev/null 2>&1; then
  pass "payload has valid OTLP structure"
else
  fail "payload is not valid OTLP shape: $BODY"
fi

assert_eq "claude-code" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].resource.attributes[]? | select(.key=="service.name") | .value.stringValue')" \
  "service.name=claude-code"

assert_eq "claude_code.session.outcome" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue')" \
  "body.stringValue is event name"

assert_eq "success" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[]? | select(.key=="outcome") | .value.stringValue')" \
  "outcome attribute"

assert_eq "sess_abc" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[]? | select(.key=="session_id") | .value.stringValue')" \
  "session_id attribute"

# ─── Test 2: linear.key resource attribute ──────────────────────────────────
echo ""
echo "--- Test 2: --linear-key sets resource attribute ---"
STUB_DIR="$SCRATCH/stub2"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args2"
export CURL_STUB_BODY="$SCRATCH/body2"

"$EMIT_SCRIPT" \
  --event "claude_code.session.outcome" \
  --outcome fail \
  --session-id sess_xyz \
  --linear-key CTL-157 \
  >/dev/null 2>&1

BODY=$(cat "$SCRATCH/body2")
assert_eq "CTL-157" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].resource.attributes[]? | select(.key=="linear.key") | .value.stringValue')" \
  "linear.key=CTL-157 in resource attributes"

# ─── Test 3: --reason attribute ─────────────────────────────────────────────
echo ""
echo "--- Test 3: --reason sets log attribute ---"
STUB_DIR="$SCRATCH/stub3"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export CURL_STUB_ARGS="$SCRATCH/args3"
export CURL_STUB_BODY="$SCRATCH/body3"

"$EMIT_SCRIPT" \
  --event "claude_code.session.outcome" \
  --outcome fail \
  --session-id s1 \
  --reason "quality gates failed" \
  >/dev/null 2>&1

BODY=$(cat "$SCRATCH/body3")
assert_eq "quality gates failed" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[]? | select(.key=="reason") | .value.stringValue')" \
  "reason attribute"

# ─── Test 4: silent no-op when OTEL_EXPORTER_OTLP_ENDPOINT unset ────────────
echo ""
echo "--- Test 4: silent no-op when OTLP endpoint unset ---"
STUB_DIR="$SCRATCH/stub4"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
unset OTEL_EXPORTER_OTLP_ENDPOINT
export CURL_STUB_ARGS="$SCRATCH/args4"
export CURL_STUB_BODY="$SCRATCH/body4"
# If curl DOES get called, the stub will exit 0 and create the file. We assert
# the file was NOT created.
rm -f "$SCRATCH/args4" "$SCRATCH/body4"
export CURL_STUB_EXIT=99  # would be visible if curl was invoked

OUT=$("$EMIT_SCRIPT" --event x --outcome success --session-id s1 2>&1)
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "exit 0 when endpoint unset"
if [[ ! -f "$SCRATCH/args4" ]]; then
  pass "curl not invoked when endpoint unset"
else
  fail "curl was invoked — stub args captured: $(cat "$SCRATCH/args4")"
fi
unset CURL_STUB_EXIT

# ─── Test 5: endpoint URL port-swap 4317 → 4318 and /v1/logs path ───────────
echo ""
echo "--- Test 5: gRPC port 4317 swapped to HTTP port 4318 ---"
STUB_DIR="$SCRATCH/stub5"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://100.65.193.30:4317"
export CURL_STUB_ARGS="$SCRATCH/args5"
export CURL_STUB_BODY="$SCRATCH/body5"

"$EMIT_SCRIPT" --event x --outcome success --session-id s1 >/dev/null 2>&1

ARGS=$(cat "$SCRATCH/args5")
assert_contains "$ARGS" "http://100.65.193.30:4318/v1/logs" "URL uses HTTP port 4318 and /v1/logs"

# ─── Test 6: curl failure does not fail the script ──────────────────────────
echo ""
echo "--- Test 6: curl 500 → script still exits 0 ---"
STUB_DIR="$SCRATCH/stub6"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4317"
export CURL_STUB_ARGS="$SCRATCH/args6"
export CURL_STUB_BODY="$SCRATCH/body6"
export CURL_STUB_EXIT=22  # curl --fail returns 22 on HTTP errors

"$EMIT_SCRIPT" --event x --outcome success --session-id s1 >/dev/null 2>&1
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "exit 0 despite curl failure"
unset CURL_STUB_EXIT

# ─── Test 7: missing required flags ─────────────────────────────────────────
echo ""
echo "--- Test 7: missing --outcome returns error ---"
STUB_DIR="$SCRATCH/stub7"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://x:4317"

OUT=$("$EMIT_SCRIPT" --event x --session-id s1 2>&1)
EXIT_CODE=$?
if [[ "$EXIT_CODE" != "0" ]]; then
  pass "non-zero exit when --outcome missing"
else
  fail "expected non-zero exit when --outcome missing"
fi
assert_contains "$OUT" "outcome" "error message mentions 'outcome'"

# ─── Test 8: extra --attr k=v pairs round-trip ──────────────────────────────
echo ""
echo "--- Test 8: --attr k=v pairs included in log attributes ---"
STUB_DIR="$SCRATCH/stub8"
setup_curl_stub "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://x:4317"
export CURL_STUB_ARGS="$SCRATCH/args8"
export CURL_STUB_BODY="$SCRATCH/body8"

"$EMIT_SCRIPT" \
  --event "claude_code.session.outcome" \
  --outcome success \
  --session-id s1 \
  --attr "foo=bar" \
  --attr "baz=qux" \
  >/dev/null 2>&1

BODY=$(cat "$SCRATCH/body8")
assert_eq "bar" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[]? | select(.key=="foo") | .value.stringValue')" \
  "custom attr foo=bar"
assert_eq "qux" \
  "$(echo "$BODY" | jq -r '.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[]? | select(.key=="baz") | .value.stringValue')" \
  "custom attr baz=qux"

# ─── Test 9: valid outcome enum values accepted ─────────────────────────────
echo ""
echo "--- Test 9: all four outcome enum values accepted ---"
for outcome in success fail timeout abandoned; do
  STUB_DIR="$SCRATCH/stub9_$outcome"
  setup_curl_stub "$STUB_DIR"
  export PATH="$STUB_DIR:$PATH"
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://x:4317"
  export CURL_STUB_ARGS="$SCRATCH/args9_$outcome"
  export CURL_STUB_BODY="$SCRATCH/body9_$outcome"
  "$EMIT_SCRIPT" --event x --outcome "$outcome" --session-id s >/dev/null 2>&1
  EXIT_CODE=$?
  assert_eq "0" "$EXIT_CODE" "outcome=$outcome accepted"
done

# ─── Test 10: invalid outcome rejected ──────────────────────────────────────
echo ""
echo "--- Test 10: invalid outcome value rejected ---"
OUT=$("$EMIT_SCRIPT" --event x --outcome bogus --session-id s 2>&1)
EXIT_CODE=$?
if [[ "$EXIT_CODE" != "0" ]]; then
  pass "non-zero exit on invalid outcome"
else
  fail "expected non-zero exit on outcome=bogus"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────"
echo "  Passed: $PASSES"
echo "  Failed: $FAILURES"
echo "─────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
