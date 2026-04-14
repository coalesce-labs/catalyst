#!/usr/bin/env bash
# Test suite for catalyst-db.sh
#
# Validates:
# - init creates the DB, schema_migrations table, and enables WAL mode
# - Migrations are applied once and tracked by version (idempotent)
# - Sessions CRUD (create, update, get, list)
# - Event append and query
# - Metrics upsert
# - Tool usage increments
# - PR upsert (create + update)
# - Concurrent readers while a writer holds the DB (WAL)
# - Foreign-key cascade on session delete

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_SCRIPT="$SCRIPT_DIR/catalyst-db.sh"

PASS=true
TESTS=0
FAILURES=0

fail() { echo "  FAIL: $1"; PASS=false; FAILURES=$((FAILURES + 1)); }
pass() { echo "  PASS: $1"; }
run_test() { TESTS=$((TESTS + 1)); echo ""; echo "--- Test $TESTS: $1 ---"; }

# Isolated per-test DB dir
make_tmpdir() {
  mktemp -d -t catalyst-db-test-XXXXXX
}

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label ($actual)"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# Guard against accidentally running without the implementation in place
if [[ ! -x "$DB_SCRIPT" ]]; then
  echo "FATAL: catalyst-db.sh not found or not executable at $DB_SCRIPT" >&2
  exit 1
fi

# ─── Test 1: init creates DB, applies migrations, enables WAL ───────────────
run_test "init creates DB and enables WAL mode"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
DB_PATH="$TMP/catalyst.db"

"$DB_SCRIPT" init >/dev/null

[[ -f "$DB_PATH" ]] && pass "DB file exists" || fail "DB file missing at $DB_PATH"

JOURNAL=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode;")
assert_eq "wal" "$JOURNAL" "journal_mode is WAL"

# foreign_keys is a per-connection pragma. Verify the script enables it on
# its own connections (rather than a bare `sqlite3` reopen which defaults to 0).
FK=$(  "$DB_SCRIPT" exec "PRAGMA foreign_keys;")
assert_eq "1" "$FK" "foreign_keys enabled on script connection"

APPLIED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM schema_migrations;")
[[ "$APPLIED" -ge 1 ]] && pass "at least one migration applied ($APPLIED)" || fail "no migrations applied"

# Verify all expected tables exist
for tbl in sessions session_events session_metrics session_tools session_prs schema_migrations; do
  FOUND=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='$tbl';")
  assert_eq "$tbl" "$FOUND" "table $tbl exists"
done

rm -rf "$TMP"

# ─── Test 2: migrate is idempotent ──────────────────────────────────────────
run_test "migrate is idempotent"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
DB_PATH="$TMP/catalyst.db"

"$DB_SCRIPT" init >/dev/null
FIRST=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM schema_migrations;")
"$DB_SCRIPT" migrate >/dev/null
SECOND=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM schema_migrations;")
assert_eq "$FIRST" "$SECOND" "migrate a second time does not re-apply"

rm -rf "$TMP"

# ─── Test 3: session create / get / update / list ───────────────────────────
run_test "session CRUD"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

"$DB_SCRIPT" session create sess-1 \
  --ticket CTL-36 --workflow orch-1 --label "test session" --skill oneshot --pid 12345 \
  >/dev/null

GOT=$(  "$DB_SCRIPT" session get sess-1)
TID=$(echo "$GOT" | jq -r '.ticket_key')
assert_eq "CTL-36" "$TID" "get returns ticket_key"
WID=$(echo "$GOT" | jq -r '.workflow_id')
assert_eq "orch-1" "$WID" "get returns workflow_id"
STATUS=$(echo "$GOT" | jq -r '.status')
assert_eq "dispatched" "$STATUS" "default status is dispatched"

"$DB_SCRIPT" session update sess-1 status=implementing phase=3 >/dev/null
GOT=$(  "$DB_SCRIPT" session get sess-1)
assert_eq "implementing" "$(echo "$GOT" | jq -r '.status')" "update changed status"
assert_eq "3" "$(echo "$GOT" | jq -r '.phase')" "update changed phase"

# updated_at should be newer than started_at after update
STARTED=$(echo "$GOT" | jq -r '.started_at')
UPDATED=$(echo "$GOT" | jq -r '.updated_at')
if [[ "$UPDATED" > "$STARTED" || "$UPDATED" == "$STARTED" ]]; then
  pass "updated_at >= started_at"
else
  fail "updated_at ($UPDATED) is earlier than started_at ($STARTED)"
fi

# list
"$DB_SCRIPT" session create sess-2 --ticket CTL-99 >/dev/null
LIST=$(  "$DB_SCRIPT" session list)
COUNT=$(echo "$LIST" | jq 'length')
assert_eq "2" "$COUNT" "list returns both sessions"

# Filter by ticket
FILTERED=$(  "$DB_SCRIPT" session list --ticket CTL-36)
FCOUNT=$(echo "$FILTERED" | jq 'length')
assert_eq "1" "$FCOUNT" "list --ticket filters correctly"

# Filter by status
FILTERED=$(  "$DB_SCRIPT" session list --status implementing)
FCOUNT=$(echo "$FILTERED" | jq 'length')
assert_eq "1" "$FCOUNT" "list --status filters correctly"

rm -rf "$TMP"

# ─── Test 4: events append + query ──────────────────────────────────────────
run_test "events append and query"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
"$DB_SCRIPT" session create sess-1 --ticket CTL-36 >/dev/null

"$DB_SCRIPT" event append sess-1 phase-started '{"phase":3,"name":"implementing"}' >/dev/null
"$DB_SCRIPT" event append sess-1 phase-completed '{"phase":3}' >/dev/null
"$DB_SCRIPT" event append sess-1 pr-opened '{"pr":42}' >/dev/null

ALL=$(  "$DB_SCRIPT" events list --session sess-1)
COUNT=$(echo "$ALL" | jq 'length')
assert_eq "3" "$COUNT" "three events appended"

# Query by type
BY_TYPE=$(  "$DB_SCRIPT" events list --type pr-opened)
COUNT=$(echo "$BY_TYPE" | jq 'length')
assert_eq "1" "$COUNT" "filter by event type"
PR=$(echo "$BY_TYPE" | jq -r '.[0].payload | fromjson | .pr')
assert_eq "42" "$PR" "payload round-trips as JSON"

# --last limits results
LAST=$(  "$DB_SCRIPT" events list --session sess-1 --last 1)
LC=$(echo "$LAST" | jq 'length')
assert_eq "1" "$LC" "--last limits count"
TYPE=$(echo "$LAST" | jq -r '.[0].event_type')
assert_eq "pr-opened" "$TYPE" "--last returns most recent"

rm -rf "$TMP"

# ─── Test 5: metrics upsert ─────────────────────────────────────────────────
run_test "metrics upsert"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
"$DB_SCRIPT" session create sess-1 --ticket CTL-36 >/dev/null

"$DB_SCRIPT" metrics update sess-1 cost_usd=1.23 input_tokens=1000 output_tokens=500 >/dev/null
M=$(  "$DB_SCRIPT" metrics get sess-1)
# cost_usd is REAL (IEEE-754) — compare numerically, not as string.
DIFF=$(echo "$M" | jq '(.cost_usd - 1.23) | if . < 0 then -. else . end')
if jq -n --argjson d "$DIFF" '$d < 0.0001' | grep -q true; then
  pass "cost_usd stored (~1.23)"
else
  fail "cost_usd not within tolerance of 1.23: $(echo "$M" | jq -r '.cost_usd')"
fi
assert_eq "1000" "$(echo "$M" | jq -r '.input_tokens')" "input_tokens stored"

# Second update should replace, not duplicate
"$DB_SCRIPT" metrics update sess-1 cost_usd=2.50 output_tokens=800 >/dev/null
M=$(  "$DB_SCRIPT" metrics get sess-1)
DIFF=$(echo "$M" | jq '(.cost_usd - 2.5) | if . < 0 then -. else . end')
if jq -n --argjson d "$DIFF" '$d < 0.0001' | grep -q true; then
  pass "cost_usd replaced on second upsert (~2.5)"
else
  fail "cost_usd did not replace: $(echo "$M" | jq -r '.cost_usd')"
fi
assert_eq "800" "$(echo "$M" | jq -r '.output_tokens')" "output_tokens replaced"
# input_tokens preserved from first write
assert_eq "1000" "$(echo "$M" | jq -r '.input_tokens')" "input_tokens preserved when not re-specified"

# Exactly one row per session
ROWS=$(sqlite3 "$TMP/catalyst.db" "SELECT COUNT(*) FROM session_metrics WHERE session_id='sess-1';")
assert_eq "1" "$ROWS" "metrics has exactly one row per session"

rm -rf "$TMP"

# ─── Test 6: tool record increments ─────────────────────────────────────────
run_test "tool record increments counter"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
"$DB_SCRIPT" session create sess-1 --ticket CTL-36 >/dev/null

"$DB_SCRIPT" tool record sess-1 Bash --duration 150 >/dev/null
"$DB_SCRIPT" tool record sess-1 Bash --duration 200 >/dev/null
"$DB_SCRIPT" tool record sess-1 Bash --duration 50 >/dev/null
"$DB_SCRIPT" tool record sess-1 Edit --duration 30 >/dev/null

COUNT_BASH=$(sqlite3 "$TMP/catalyst.db" "SELECT call_count FROM session_tools WHERE session_id='sess-1' AND tool_name='Bash';")
assert_eq "3" "$COUNT_BASH" "Bash call_count = 3"

DUR_BASH=$(sqlite3 "$TMP/catalyst.db" "SELECT total_duration_ms FROM session_tools WHERE session_id='sess-1' AND tool_name='Bash';")
assert_eq "400" "$DUR_BASH" "Bash total_duration_ms = 400"

COUNT_EDIT=$(sqlite3 "$TMP/catalyst.db" "SELECT call_count FROM session_tools WHERE session_id='sess-1' AND tool_name='Edit';")
assert_eq "1" "$COUNT_EDIT" "Edit call_count = 1"

rm -rf "$TMP"

# ─── Test 7: PR upsert ──────────────────────────────────────────────────────
run_test "PR upsert (create and update)"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
"$DB_SCRIPT" session create sess-1 --ticket CTL-36 >/dev/null

"$DB_SCRIPT" pr upsert sess-1 42 --url "https://github.com/x/y/pull/42" \
  --ci pending --opened "2026-04-14T12:00:00Z" >/dev/null

PR=$(  "$DB_SCRIPT" pr get sess-1 42)
assert_eq "pending" "$(echo "$PR" | jq -r '.ci_status')" "PR ci_status pending"
assert_eq "42" "$(echo "$PR" | jq -r '.pr_number')" "PR number stored"

"$DB_SCRIPT" pr upsert sess-1 42 --ci merged --merged "2026-04-14T13:00:00Z" >/dev/null
PR=$(  "$DB_SCRIPT" pr get sess-1 42)
assert_eq "merged" "$(echo "$PR" | jq -r '.ci_status')" "PR ci_status updated to merged"
assert_eq "2026-04-14T13:00:00Z" "$(echo "$PR" | jq -r '.merged_at')" "merged_at set"
# URL preserved from first write
assert_eq "https://github.com/x/y/pull/42" "$(echo "$PR" | jq -r '.pr_url')" "pr_url preserved"

rm -rf "$TMP"

# ─── Test 8: WAL mode allows concurrent readers while writer is active ─────
run_test "WAL allows concurrent readers during write"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
"$DB_SCRIPT" session create sess-wal --ticket CTL-36 >/dev/null

# Start a long-ish writer in the background that holds a write transaction
(
  sqlite3 "$TMP/catalyst.db" <<SQL
BEGIN IMMEDIATE;
UPDATE sessions SET phase = 1 WHERE session_id = 'sess-wal';
SELECT 1;
-- hold for a moment before committing
SELECT sqlite_version();
COMMIT;
SQL
) &
WRITER_PID=$!

# Reader should succeed immediately (WAL) even while writer is working
sleep 0.1
READ_RESULT=$(sqlite3 "$TMP/catalyst.db" "SELECT session_id FROM sessions WHERE session_id='sess-wal';")
assert_eq "sess-wal" "$READ_RESULT" "reader sees row while writer is active"

wait $WRITER_PID
rm -rf "$TMP"

# ─── Test 9: cascade delete ─────────────────────────────────────────────────
run_test "deleting a session cascades to events, metrics, tools, prs"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
"$DB_SCRIPT" session create sess-del --ticket CTL-36 >/dev/null
"$DB_SCRIPT" event append sess-del test '{}' >/dev/null
"$DB_SCRIPT" metrics update sess-del cost_usd=1 >/dev/null
"$DB_SCRIPT" tool record sess-del Bash >/dev/null
"$DB_SCRIPT" pr upsert sess-del 1 --url x --ci pending >/dev/null

sqlite3 "$TMP/catalyst.db" "PRAGMA foreign_keys = ON; DELETE FROM sessions WHERE session_id='sess-del';"

for tbl in session_events session_metrics session_tools session_prs; do
  N=$(sqlite3 "$TMP/catalyst.db" "SELECT COUNT(*) FROM $tbl WHERE session_id='sess-del';")
  assert_eq "0" "$N" "$tbl cleaned up on cascade"
done

rm -rf "$TMP"

# ─── Test 10: exec runs arbitrary SQL ───────────────────────────────────────
run_test "exec runs arbitrary SQL against the DB"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null
OUT=$(  "$DB_SCRIPT" exec "SELECT COUNT(*) FROM sessions;")
assert_eq "0" "$OUT" "empty session count via exec"

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
