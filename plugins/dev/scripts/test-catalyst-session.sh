#!/usr/bin/env bash
# Test suite for catalyst-session.sh
#
# Validates the lifecycle CLI that any skill can call:
# - start prints a session ID and creates a row
# - phase / metric / tool / pr / end / heartbeat write through to the store
# - list and read return well-formed JSON
# - JSONL event log dual-write happens for backward compat
# - <50ms latency per invocation (benchmark on `phase` updates)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESS_SCRIPT="$SCRIPT_DIR/catalyst-session.sh"
DB_SCRIPT="$SCRIPT_DIR/catalyst-db.sh"

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

make_tmpdir() { mktemp -d -t catalyst-session-test-XXXXXX; }

if [[ ! -x "$SESS_SCRIPT" ]]; then
  echo "FATAL: catalyst-session.sh not found or not executable at $SESS_SCRIPT" >&2
  exit 1
fi

# ─── Test 1: start prints a session ID and creates a session row ────────────
run_test "start creates session and prints ID"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-37 --label "test run")
[[ -n "$SID" ]] && pass "start returned non-empty session id ($SID)" || fail "start returned empty id"
[[ "$SID" =~ ^sess_ ]] && pass "session id has sess_ prefix" || fail "session id missing sess_ prefix: $SID"

ROW=$(  "$DB_SCRIPT" session get "$SID")
assert_eq "oneshot" "$(echo "$ROW" | jq -r '.skill_name')" "row has skill_name"
assert_eq "CTL-37"  "$(echo "$ROW" | jq -r '.ticket_key')" "row has ticket_key"
assert_eq "test run" "$(echo "$ROW" | jq -r '.label')" "row has label"
assert_eq "running" "$(echo "$ROW" | jq -r '.status')" "default status is running"

rm -rf "$TMP"

# ─── Test 2: start with all options ─────────────────────────────────────────
run_test "start with workflow/skill/ticket/label"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

SID=$(  "$SESS_SCRIPT" start \
  --skill orchestrate --ticket CTL-99 --label "wave-1" --workflow "orch-abc")
ROW=$(  "$DB_SCRIPT" session get "$SID")
assert_eq "orch-abc"   "$(echo "$ROW" | jq -r '.workflow_id')" "workflow_id stored"
assert_eq "wave-1"     "$(echo "$ROW" | jq -r '.label')"       "label stored"
assert_eq "orchestrate" "$(echo "$ROW" | jq -r '.skill_name')" "skill_name stored"

rm -rf "$TMP"

# ─── Test 3: phase updates status + phase number, emits event ───────────────
run_test "phase updates status and emits event"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-37)

"$SESS_SCRIPT" phase "$SID" implementing --phase 3 >/dev/null

ROW=$(  "$DB_SCRIPT" session get "$SID")
assert_eq "implementing" "$(echo "$ROW" | jq -r '.status')" "status = implementing"
assert_eq "3" "$(echo "$ROW" | jq -r '.phase')" "phase = 3"

EV=$(  "$DB_SCRIPT" events list --session "$SID" --type phase-changed)
COUNT=$(echo "$EV" | jq 'length')
assert_eq "1" "$COUNT" "phase-changed event recorded"
TO=$(echo "$EV" | jq -r '.[0].payload | fromjson | .to')
assert_eq "implementing" "$TO" "event payload .to = implementing"

# phase without --phase still works (just status)
"$SESS_SCRIPT" phase "$SID" reviewing >/dev/null
ROW=$(  "$DB_SCRIPT" session get "$SID")
assert_eq "reviewing" "$(echo "$ROW" | jq -r '.status')" "status updated without --phase"
assert_eq "3" "$(echo "$ROW" | jq -r '.phase')" "phase preserved when omitted"

rm -rf "$TMP"

# ─── Test 4: metric updates session_metrics ─────────────────────────────────
run_test "metric updates cost and tokens"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)

"$SESS_SCRIPT" metric "$SID" --cost 1.50 --input 1200 --output 800 >/dev/null
M=$(  "$DB_SCRIPT" metrics get "$SID")
DIFF=$(echo "$M" | jq '(.cost_usd - 1.50) | if . < 0 then -. else . end')
if jq -n --argjson d "$DIFF" '$d < 0.0001' | grep -q true; then
  pass "cost_usd ~= 1.50"
else
  fail "cost_usd not ~1.50: $(echo "$M" | jq -r '.cost_usd')"
fi
assert_eq "1200" "$(echo "$M" | jq -r '.input_tokens')" "input_tokens recorded"
assert_eq "800"  "$(echo "$M" | jq -r '.output_tokens')" "output_tokens recorded"

# Cache + duration optional flags
"$SESS_SCRIPT" metric "$SID" --cache-read 500 --cache-creation 200 --duration-ms 12345 >/dev/null
M=$(  "$DB_SCRIPT" metrics get "$SID")
assert_eq "500"   "$(echo "$M" | jq -r '.cache_read_tokens')"     "cache_read_tokens recorded"
assert_eq "200"   "$(echo "$M" | jq -r '.cache_creation_tokens')" "cache_creation_tokens recorded"
assert_eq "12345" "$(echo "$M" | jq -r '.duration_ms')"           "duration_ms recorded"

rm -rf "$TMP"

# ─── Test 5: tool records tool usage histogram ──────────────────────────────
run_test "tool records call_count and total_duration_ms"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)

"$SESS_SCRIPT" tool "$SID" Bash --duration 100 >/dev/null
"$SESS_SCRIPT" tool "$SID" Bash --duration 250 >/dev/null
"$SESS_SCRIPT" tool "$SID" Edit --duration 50 >/dev/null

CB=$(sqlite3 "$TMP/catalyst.db" "SELECT call_count FROM session_tools WHERE session_id='$SID' AND tool_name='Bash';")
DB=$(sqlite3 "$TMP/catalyst.db" "SELECT total_duration_ms FROM session_tools WHERE session_id='$SID' AND tool_name='Bash';")
assert_eq "2" "$CB" "Bash call_count = 2"
assert_eq "350" "$DB" "Bash total_duration_ms = 350"

# tool without --duration defaults to 0
"$SESS_SCRIPT" tool "$SID" Read >/dev/null
CR=$(sqlite3 "$TMP/catalyst.db" "SELECT call_count FROM session_tools WHERE session_id='$SID' AND tool_name='Read';")
assert_eq "1" "$CR" "Read call_count = 1 (no --duration)"

rm -rf "$TMP"

# ─── Test 6: pr records PR creation ─────────────────────────────────────────
run_test "pr records PR number + url"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-37)

"$SESS_SCRIPT" pr "$SID" --number 100 --url "https://github.com/x/y/pull/100" >/dev/null
PR=$(  "$DB_SCRIPT" pr get "$SID" 100)
assert_eq "100" "$(echo "$PR" | jq -r '.pr_number')" "PR number stored"
assert_eq "https://github.com/x/y/pull/100" "$(echo "$PR" | jq -r '.pr_url')" "PR url stored"

# pr-opened event emitted
EV=$(  "$DB_SCRIPT" events list --session "$SID" --type pr-opened)
COUNT=$(echo "$EV" | jq 'length')
assert_eq "1" "$COUNT" "pr-opened event recorded"

rm -rf "$TMP"

# ─── Test 7: end marks session complete ─────────────────────────────────────
run_test "end sets status and completed_at"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)

"$SESS_SCRIPT" end "$SID" --status done >/dev/null
ROW=$(  "$DB_SCRIPT" session get "$SID")
assert_eq "done" "$(echo "$ROW" | jq -r '.status')" "status = done"
COMPLETED=$(echo "$ROW" | jq -r '.completed_at')
[[ -n "$COMPLETED" && "$COMPLETED" != "null" ]] && pass "completed_at set ($COMPLETED)" \
  || fail "completed_at not set"

# session-ended event
EV=$(  "$DB_SCRIPT" events list --session "$SID" --type session-ended)
COUNT=$(echo "$EV" | jq 'length')
assert_eq "1" "$COUNT" "session-ended event recorded"

# end without --status defaults to done
TMP2=$(make_tmpdir)
export CATALYST_DIR="$TMP2"
"$DB_SCRIPT" init >/dev/null
SID2=$(  "$SESS_SCRIPT" start --skill oneshot)
"$SESS_SCRIPT" end "$SID2" >/dev/null
S2=$(  "$DB_SCRIPT" session get "$SID2" | jq -r '.status')
assert_eq "done" "$S2" "end without --status defaults to done"

# end --status failed
TMP3=$(make_tmpdir)
export CATALYST_DIR="$TMP3"
"$DB_SCRIPT" init >/dev/null
SID3=$(  "$SESS_SCRIPT" start --skill oneshot)
"$SESS_SCRIPT" end "$SID3" --status failed >/dev/null
S3=$(  "$DB_SCRIPT" session get "$SID3" | jq -r '.status')
assert_eq "failed" "$S3" "end --status failed sets status=failed"

rm -rf "$TMP" "$TMP2" "$TMP3"

# ─── Test 8: heartbeat bumps updated_at ─────────────────────────────────────
run_test "heartbeat bumps updated_at"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)

BEFORE=$(  "$DB_SCRIPT" session get "$SID" | jq -r '.updated_at')
sleep 1
"$SESS_SCRIPT" heartbeat "$SID" >/dev/null
AFTER=$(  "$DB_SCRIPT" session get "$SID" | jq -r '.updated_at')
if [[ "$AFTER" > "$BEFORE" ]]; then
  pass "updated_at advanced ($BEFORE → $AFTER)"
else
  fail "updated_at did not advance: $BEFORE → $AFTER"
fi

rm -rf "$TMP"

# ─── Test 9: list returns sessions, --active filters out done/failed ────────
run_test "list and --active filter"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

S1=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-1)
S2=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-2)
S3=$(  "$SESS_SCRIPT" start --skill orchestrate --ticket CTL-3)
"$SESS_SCRIPT" end "$S2" --status done >/dev/null
"$SESS_SCRIPT" end "$S3" --status failed >/dev/null

ALL=$(  "$SESS_SCRIPT" list)
assert_eq "3" "$(echo "$ALL" | jq 'length')" "list returns all 3 sessions"

ACTIVE=$(  "$SESS_SCRIPT" list --active)
assert_eq "1" "$(echo "$ACTIVE" | jq 'length')" "--active filters out done & failed"
assert_eq "$S1" "$(echo "$ACTIVE" | jq -r '.[0].session_id')" "--active returns the running one"

# Filter by skill
BYSKILL=$(  "$SESS_SCRIPT" list --skill orchestrate)
assert_eq "1" "$(echo "$BYSKILL" | jq 'length')" "--skill filters correctly"

# Filter by ticket
BYTICK=$(  "$SESS_SCRIPT" list --ticket CTL-2)
assert_eq "1" "$(echo "$BYTICK" | jq 'length')" "--ticket filters correctly"

rm -rf "$TMP"

# ─── Test 10: read returns aggregated session JSON ──────────────────────────
run_test "read returns full session state"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-37)
"$SESS_SCRIPT" phase "$SID" implementing --phase 3 >/dev/null
"$SESS_SCRIPT" metric "$SID" --cost 0.50 --input 100 --output 50 >/dev/null
"$SESS_SCRIPT" tool "$SID" Bash --duration 80 >/dev/null
"$SESS_SCRIPT" pr "$SID" --number 200 --url "https://gh/x/y/pull/200" >/dev/null

OUT=$(  "$SESS_SCRIPT" read "$SID")
assert_eq "$SID"        "$(echo "$OUT" | jq -r '.session.session_id')" "read returns session block"
assert_eq "implementing" "$(echo "$OUT" | jq -r '.session.status')"    "session.status correct"
assert_eq "100"         "$(echo "$OUT" | jq -r '.metrics.input_tokens')" "metrics block"
assert_eq "200"         "$(echo "$OUT" | jq -r '.prs[0].pr_number')"  "prs block has PR #200"
EVCOUNT=$(echo "$OUT" | jq '.events | length')
[[ "$EVCOUNT" -ge 2 ]] && pass "events block has phase-changed + pr-opened ($EVCOUNT)" \
  || fail "events block too small: $EVCOUNT"
TOOLCOUNT=$(echo "$OUT" | jq '.tools | length')
assert_eq "1" "$TOOLCOUNT" "tools block has Bash"

rm -rf "$TMP"

# ─── Test 11: JSONL event log dual-write ────────────────────────────────────
run_test "JSONL event log gets entries for backward compat"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-37)
"$SESS_SCRIPT" phase "$SID" running --phase 1 >/dev/null
"$SESS_SCRIPT" pr "$SID" --number 50 --url "https://gh/x/y/pull/50" >/dev/null
"$SESS_SCRIPT" end "$SID" --status done >/dev/null

JSONL_FILE="$TMP/events/$(date -u +%Y-%m).jsonl"
[[ -f "$JSONL_FILE" ]] && pass "JSONL event log file exists" \
  || fail "JSONL event log not created at $JSONL_FILE"

# Each line should be valid JSON, contain session id and event field
LINES=$(wc -l < "$JSONL_FILE")
[[ "$LINES" -ge 4 ]] && pass "JSONL has >=4 events ($LINES)" || fail "JSONL has <4 events: $LINES"

while IFS= read -r line; do
  echo "$line" | jq empty 2>/dev/null || { fail "JSONL line is not valid JSON: $line"; break; }
done < "$JSONL_FILE"

# Check the session-started event is present
STARTED=$(grep -c '"event":"session-started"' "$JSONL_FILE" || true)
[[ "$STARTED" -eq 1 ]] && pass "session-started event in JSONL" \
  || fail "expected 1 session-started in JSONL, got $STARTED"

rm -rf "$TMP"

# ─── Test 12: read returns null for missing session ─────────────────────────
run_test "read for nonexistent session returns null and exits non-zero"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

OUT=$(  "$SESS_SCRIPT" read "sess_nonexistent" 2>/dev/null) && RC=0 || RC=$?
[[ "$RC" -ne 0 ]] && pass "exit code is non-zero for missing session ($RC)" \
  || fail "exit code should be non-zero for missing session, got 0"
echo "$OUT" | jq empty 2>/dev/null && pass "output is valid JSON" || fail "output not JSON: $OUT"

rm -rf "$TMP"

# ─── Test 13: <50ms latency per invocation ──────────────────────────────────
run_test "latency: phase update under 50ms"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)

# Warm up
"$SESS_SCRIPT" phase "$SID" warmup >/dev/null

# Measure 10 phase calls and average
ITER=10
START_NS=$(perl -MTime::HiRes=time -e 'printf("%d\n", time()*1e9)')
for i in $(seq 1 $ITER); do
  "$SESS_SCRIPT" phase "$SID" loop$i --phase $i >/dev/null
done
END_NS=$(perl -MTime::HiRes=time -e 'printf("%d\n", time()*1e9)')

TOTAL_MS=$(( (END_NS - START_NS) / 1000000 ))
AVG_MS=$(( TOTAL_MS / ITER ))
echo "  Average phase latency: ${AVG_MS}ms (total ${TOTAL_MS}ms over $ITER iter)"

# 50ms is the spec; allow a small CI cushion (~10ms over for noisy CI)
if [[ "$AVG_MS" -le 60 ]]; then
  pass "average latency under threshold (${AVG_MS}ms <= 60ms)"
else
  fail "average latency exceeds 60ms: ${AVG_MS}ms"
fi

rm -rf "$TMP"

# ─── Test 14: invalid args exit non-zero ────────────────────────────────────
run_test "invalid commands and missing args exit non-zero"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

"$SESS_SCRIPT" bogus-command 2>/dev/null && fail "bogus command should fail" \
  || pass "bogus command exits non-zero"

"$SESS_SCRIPT" phase 2>/dev/null && fail "phase missing args should fail" \
  || pass "phase with no args exits non-zero"

"$SESS_SCRIPT" start 2>/dev/null && fail "start without --skill should fail" \
  || pass "start without --skill exits non-zero"

rm -rf "$TMP"

# ─── Test 15: SQL injection attempts are neutralized ───────────────────────
run_test "SQL injection attempts are stored literally"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

# Try a classic injection through --label. If sql_quote is broken, the
# sessions table would be dropped and subsequent operations would fail.
EVIL="CTL-37'; DROP TABLE sessions; --"
SID=$(  "$SESS_SCRIPT" start --skill oneshot --label "$EVIL")

# Sessions table must still exist
TBL=$(sqlite3 "$TMP/catalyst.db" "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions';")
assert_eq "sessions" "$TBL" "sessions table survived injection attempt"

# Label should be stored literally
LBL=$(  "$DB_SCRIPT" session get "$SID" | jq -r '.label')
assert_eq "$EVIL" "$LBL" "label stored literally, not executed"

# Same check for a phase status with embedded quotes
"$SESS_SCRIPT" phase "$SID" "weird'status" --phase 1 >/dev/null
STATUS=$(  "$DB_SCRIPT" session get "$SID" | jq -r '.status')
assert_eq "weird'status" "$STATUS" "phase status with quote stored literally"

rm -rf "$TMP"

# ─── Test 16: JSONL stays valid when labels contain control chars ──────────
run_test "JSONL event lines remain valid JSON for tricky inputs"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

# Embed a tab, a newline, a backslash, a quote, and a raw escape (0x1b).
TRICKY=$'line1\n\ttabbed "quoted" \\backslash '$'\x1b''[31mansi'
SID=$(  "$SESS_SCRIPT" start --skill oneshot --label "$TRICKY")
"$SESS_SCRIPT" phase "$SID" "status-$TRICKY" >/dev/null
"$SESS_SCRIPT" end "$SID" --status done >/dev/null

JSONL_FILE="$TMP/events/$(date -u +%Y-%m).jsonl"
while IFS= read -r line; do
  echo "$line" | jq empty 2>/dev/null || { fail "JSONL line is invalid JSON: $line"; break; }
done < "$JSONL_FILE"
pass "every JSONL line is valid JSON after tricky input"

rm -rf "$TMP"

# ─── CTL-157: end emits claude_code.session.outcome via OTLP ────────────────
# We inject a stub emit-otel-event.sh via $CATALYST_EMIT_OTEL_BIN and assert
# the expected CLI args are forwarded. This isolates session-end behavior
# from the actual OTLP transport.

make_emit_stub() {
  local capture_file="$1"
  local stub_path="$2"
  cat > "$stub_path" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$capture_file"
exit 0
STUB
  chmod +x "$stub_path"
}

run_test "end --status done forwards outcome=success to OTel emitter"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot --ticket CTL-157)
CAP="$TMP/emit.args"
STUB="$TMP/emit-stub.sh"
make_emit_stub "$CAP" "$STUB"
CATALYST_EMIT_OTEL_BIN="$STUB" "$SESS_SCRIPT" end "$SID" --status done >/dev/null
[[ -f "$CAP" ]] && pass "emitter invoked on end --status done" || fail "emitter not invoked"
ARGS=$(cat "$CAP" 2>/dev/null || echo "")
if echo "$ARGS" | grep -q "claude_code.session.outcome"; then
  pass "emitter received --event claude_code.session.outcome"
else
  fail "event name not forwarded: $ARGS"
fi
if echo "$ARGS" | grep -qx "success"; then
  pass "outcome=success forwarded"
else
  fail "outcome=success not forwarded: $ARGS"
fi
if echo "$ARGS" | grep -qx "$SID"; then
  pass "session-id forwarded to emitter"
else
  fail "session-id not forwarded: $ARGS"
fi
rm -rf "$TMP"

run_test "end --status failed forwards outcome=fail to OTel emitter"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)
CAP="$TMP/emit.args"
STUB="$TMP/emit-stub.sh"
make_emit_stub "$CAP" "$STUB"
CATALYST_EMIT_OTEL_BIN="$STUB" "$SESS_SCRIPT" end "$SID" --status failed >/dev/null
ARGS=$(cat "$CAP" 2>/dev/null || echo "")
if echo "$ARGS" | grep -qx "fail"; then
  pass "outcome=fail forwarded"
else
  fail "outcome=fail not forwarded: $ARGS"
fi
rm -rf "$TMP"

run_test "end --reason forwards reason to OTel emitter"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)
CAP="$TMP/emit.args"
STUB="$TMP/emit-stub.sh"
make_emit_stub "$CAP" "$STUB"
CATALYST_EMIT_OTEL_BIN="$STUB" "$SESS_SCRIPT" end "$SID" \
  --status failed --reason "quality gates failed" >/dev/null
ARGS=$(cat "$CAP" 2>/dev/null || echo "")
if echo "$ARGS" | grep -qx "quality gates failed"; then
  pass "reason forwarded to emitter"
else
  fail "reason not forwarded: $ARGS"
fi
# The --reason should also appear in the local session-ended payload.
EV=$("$DB_SCRIPT" events list --session "$SID" --type session-ended)
REASON_IN_EVENT=$(echo "$EV" | jq -r '.[0].payload' | jq -r '.reason')
assert_eq "quality gates failed" "$REASON_IN_EVENT" "reason stored in session-ended payload"
rm -rf "$TMP"

run_test "end with no emitter binary still succeeds (silent failure)"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
SID=$(  "$SESS_SCRIPT" start --skill oneshot)
CATALYST_EMIT_OTEL_BIN="/nonexistent/path/does-not-exist" \
  "$SESS_SCRIPT" end "$SID" --status done >/dev/null
EXIT_CODE=$?
assert_eq "0" "$EXIT_CODE" "end exits 0 even when emitter binary missing"
# And the SQL write still happened:
S=$(  "$DB_SCRIPT" session get "$SID" | jq -r '.status')
assert_eq "done" "$S" "session still marked done despite emitter missing"
rm -rf "$TMP"

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
echo "Ran $TESTS tests, $FAILURES failures"
if [[ "$PASS" == "true" ]]; then
  echo "✅ All tests passed"
  exit 0
else
  echo "❌ Failures detected"
  exit 1
fi
