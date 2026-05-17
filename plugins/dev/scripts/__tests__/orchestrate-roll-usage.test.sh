#!/usr/bin/env bash
# Shell tests for orchestrate-roll-usage.sh (CTL-115).
#
# Verifies the helper that the orchestrator monitor pass invokes once per
# worker per cycle to roll the worker's final usage/cost from its stream
# file into:
#   1. the worker's signal file (.cost = USAGE)
#   2. state.json's per-worker entry (.workers[ticket].usage = USAGE)
#   3. state.json's orchestrator-level aggregate (.usage += USAGE)
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-roll-usage.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/orchestrate-roll-usage.sh"
STATE_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-state.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Isolate state.json so tests don't touch the user's real state.
export CATALYST_DIR="${SCRATCH}/catalyst"
export CATALYST_STATE_FILE="${CATALYST_DIR}/state.json"
mkdir -p "$CATALYST_DIR"

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

# Build a stream-json fixture with a single result event carrying the
# specified usage/cost values.
build_stream_with_result() {
  local out="$1" cost="$2" itok="$3" otok="$4" crd="$5" ccr="$6" turns="$7" dur="$8" durapi="$9"
  cat > "$out" <<EOF
{"type":"system","subtype":"init","session_id":"test-$(basename "$out")"}
{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}
{"type":"result","subtype":"success","usage":{"input_tokens":${itok},"output_tokens":${otok},"cache_read_input_tokens":${crd},"cache_creation_input_tokens":${ccr}},"total_cost_usd":${cost},"num_turns":${turns},"duration_ms":${dur},"duration_api_ms":${durapi},"modelUsage":{"claude-opus-4-7":{"costUSD":${cost}}}}
EOF
}

# Build a stream-json fixture with NO result event (worker died early).
build_stream_no_result() {
  local out="$1"
  cat > "$out" <<'EOF'
{"type":"system","subtype":"init","session_id":"dead-worker"}
{"type":"assistant","message":{"content":[{"type":"text","text":"about to crash"}]}}
EOF
}

build_signal() {
  local out="$1" ticket="$2"
  cat > "$out" <<EOF
{
  "ticket": "${ticket}",
  "orchestrator": "orch-test",
  "workerName": "orch-test-${ticket}",
  "status": "done",
  "phase": 6,
  "startedAt": "2026-04-23T12:00:00Z",
  "updatedAt": "2026-04-23T12:30:00Z",
  "phaseTimestamps": {
    "researching": "2026-04-23T12:00:00Z"
  },
  "pr": {
    "number": 100,
    "url": "https://github.com/test/test/pull/100"
  }
}
EOF
}

# Provision a fresh orch-dir + state.json with zeroed usage.
setup_orch() {
  local orch_id="$1"
  local orch_dir="${SCRATCH}/runs/${orch_id}"
  mkdir -p "${orch_dir}/workers/output"

  # Reset state.json to a known empty state for each scenario.
  rm -f "$CATALYST_STATE_FILE"
  "$STATE_SCRIPT" init >/dev/null
  "$STATE_SCRIPT" register "$orch_id" "$(jq -nc \
    '{id: "TEST", projectKey: "test", status: "active",
      startedAt: "2026-04-23T12:00:00Z",
      progress: {totalTickets: 0, completedTickets: 0, failedTickets: 0, inProgressTickets: 0, currentWave: 1, totalWaves: 1},
      usage: {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, numTurns: 0, durationMs: 0, durationApiMs: 0, model: null},
      workers: {}, attention: []}')" >/dev/null
  echo "$orch_dir"
}

# ───────────────────────────────────────────────────────────────────────────────
echo "orchestrate-roll-usage tests"
echo ""

# ─── Test 1: helper exists and is executable ──────────────────────────────────
run "helper script exists" bash -c "[ -f '$HELPER' ]"
run "helper script is executable" bash -c "[ -x '$HELPER' ]"

# ─── Test 2: parses single worker stream → signal.cost populated ──────────────
ORCH_DIR=$(setup_orch "orch-t2")
build_stream_with_result "${ORCH_DIR}/workers/output/T-1-stream.jsonl" \
  "1.5" "1000" "500" "200" "100" "10" "60000" "30000"
build_signal "${ORCH_DIR}/workers/T-1.json" "T-1"

"$HELPER" --orch "orch-t2" --ticket "T-1" --orch-dir "$ORCH_DIR"

run "signal.cost.costUSD populated" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/T-1.json')\" = '1.5' ]"
run "signal.cost.inputTokens populated" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '${ORCH_DIR}/workers/T-1.json')\" = '1000' ]"
run "signal.cost.outputTokens populated" \
  bash -c "[ \"\$(jq -r '.cost.outputTokens' '${ORCH_DIR}/workers/T-1.json')\" = '500' ]"
run "signal.cost.cacheReadTokens populated" \
  bash -c "[ \"\$(jq -r '.cost.cacheReadTokens' '${ORCH_DIR}/workers/T-1.json')\" = '200' ]"
run "signal.cost.cacheCreationTokens populated" \
  bash -c "[ \"\$(jq -r '.cost.cacheCreationTokens' '${ORCH_DIR}/workers/T-1.json')\" = '100' ]"
run "signal.cost.numTurns populated" \
  bash -c "[ \"\$(jq -r '.cost.numTurns' '${ORCH_DIR}/workers/T-1.json')\" = '10' ]"
run "signal.cost.durationMs populated" \
  bash -c "[ \"\$(jq -r '.cost.durationMs' '${ORCH_DIR}/workers/T-1.json')\" = '60000' ]"
run "signal.cost.model populated" \
  bash -c "[ \"\$(jq -r '.cost.model' '${ORCH_DIR}/workers/T-1.json')\" = 'claude-opus-4-7' ]"
run "preserves signal.ticket field" \
  bash -c "[ \"\$(jq -r '.ticket' '${ORCH_DIR}/workers/T-1.json')\" = 'T-1' ]"
run "preserves signal.pr.number field" \
  bash -c "[ \"\$(jq -r '.pr.number' '${ORCH_DIR}/workers/T-1.json')\" = '100' ]"

# ─── Test 3: per-worker state.workers[ticket].usage written ───────────────────
run "state.workers[T-1].usage.costUSD" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t2\"].workers[\"T-1\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '1.5' ]"
run "state.workers[T-1].usage.inputTokens" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t2\"].workers[\"T-1\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '1000' ]"

# ─── Test 4: orchestrator-level aggregate ─────────────────────────────────────
run "orch.usage.costUSD == 1.5 after one worker" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t2\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '1.5' ]"
run "orch.usage.inputTokens == 1000 after one worker" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t2\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '1000' ]"

# ─── Test 5: aggregates 3 worker streams → orch.usage equals sum ──────────────
ORCH_DIR=$(setup_orch "orch-t5")

build_stream_with_result "${ORCH_DIR}/workers/output/A-1-stream.jsonl" \
  "0.10" "1000" "100" "10" "1" "5" "10000" "5000"
build_signal "${ORCH_DIR}/workers/A-1.json" "A-1"

build_stream_with_result "${ORCH_DIR}/workers/output/A-2-stream.jsonl" \
  "0.50" "5000" "500" "50" "5" "10" "20000" "10000"
build_signal "${ORCH_DIR}/workers/A-2.json" "A-2"

build_stream_with_result "${ORCH_DIR}/workers/output/A-3-stream.jsonl" \
  "2.00" "20000" "2000" "200" "20" "20" "60000" "30000"
build_signal "${ORCH_DIR}/workers/A-3.json" "A-3"

"$HELPER" --orch "orch-t5" --ticket "A-1" --orch-dir "$ORCH_DIR"
"$HELPER" --orch "orch-t5" --ticket "A-2" --orch-dir "$ORCH_DIR"
"$HELPER" --orch "orch-t5" --ticket "A-3" --orch-dir "$ORCH_DIR"

run "orch.usage.costUSD == 2.60 (0.10+0.50+2.00)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '2.6' ]"
run "orch.usage.inputTokens == 26000 (1000+5000+20000)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '26000' ]"
run "orch.usage.outputTokens == 2600 (100+500+2000)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.outputTokens' '$CATALYST_STATE_FILE')\" = '2600' ]"
run "orch.usage.numTurns == 35 (5+10+20)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.numTurns' '$CATALYST_STATE_FILE')\" = '35' ]"
run "orch.usage.durationMs == 90000 (10000+20000+60000)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.durationMs' '$CATALYST_STATE_FILE')\" = '90000' ]"
run "orch.usage.cacheReadTokens == 260 (10+50+200)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.cacheReadTokens' '$CATALYST_STATE_FILE')\" = '260' ]"
run "orch.usage.cacheCreationTokens == 26 (1+5+20)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.cacheCreationTokens' '$CATALYST_STATE_FILE')\" = '26' ]"
run "orch.usage.durationApiMs == 45000 (5000+10000+30000)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.durationApiMs' '$CATALYST_STATE_FILE')\" = '45000' ]"

# ─── Test 6: idempotency — second invocation does not double-count ────────────
"$HELPER" --orch "orch-t5" --ticket "A-1" --orch-dir "$ORCH_DIR"
"$HELPER" --orch "orch-t5" --ticket "A-2" --orch-dir "$ORCH_DIR"
"$HELPER" --orch "orch-t5" --ticket "A-3" --orch-dir "$ORCH_DIR"

run "idempotent: orch.usage.costUSD still 2.60 after re-roll" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '2.6' ]"
run "idempotent: orch.usage.inputTokens still 26000" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t5\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '26000' ]"

# ─── Test 7: partial run — stream with no result event is no-op ───────────────
ORCH_DIR=$(setup_orch "orch-t7")
build_stream_no_result "${ORCH_DIR}/workers/output/D-1-stream.jsonl"
build_signal "${ORCH_DIR}/workers/D-1.json" "D-1"

"$HELPER" --orch "orch-t7" --ticket "D-1" --orch-dir "$ORCH_DIR"

run "no-result stream: orch.usage.costUSD stays 0" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t7\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '0' ]"
run "no-result stream: signal.cost stays null" \
  bash -c "[ \"\$(jq -r '.cost' '${ORCH_DIR}/workers/D-1.json')\" = 'null' ]"

# ─── Test 8: missing stream file is a no-op ───────────────────────────────────
ORCH_DIR=$(setup_orch "orch-t8")
build_signal "${ORCH_DIR}/workers/E-1.json" "E-1"
# Note: NO stream file created

run "missing stream: helper exits 0" \
  "$HELPER" --orch "orch-t8" --ticket "E-1" --orch-dir "$ORCH_DIR"
run "missing stream: orch.usage.costUSD stays 0" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t8\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '0' ]"

# ─── Test 9: missing signal file is a no-op ───────────────────────────────────
ORCH_DIR=$(setup_orch "orch-t9")
build_stream_with_result "${ORCH_DIR}/workers/output/F-1-stream.jsonl" \
  "0.99" "100" "10" "5" "1" "1" "1000" "500"
# Note: NO signal file created

run "missing signal: helper exits 0" \
  "$HELPER" --orch "orch-t9" --ticket "F-1" --orch-dir "$ORCH_DIR"
run "missing signal: orch.usage.costUSD stays 0" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t9\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '0' ]"

# ─── Test 10: concurrent invocations don't corrupt state ──────────────────────
ORCH_DIR=$(setup_orch "orch-t10")
for i in 1 2 3 4 5; do
  build_stream_with_result "${ORCH_DIR}/workers/output/C-${i}-stream.jsonl" \
    "1.00" "1000" "100" "10" "1" "1" "1000" "500"
  build_signal "${ORCH_DIR}/workers/C-${i}.json" "C-${i}"
done

# Fire 5 in parallel
"$HELPER" --orch "orch-t10" --ticket "C-1" --orch-dir "$ORCH_DIR" &
"$HELPER" --orch "orch-t10" --ticket "C-2" --orch-dir "$ORCH_DIR" &
"$HELPER" --orch "orch-t10" --ticket "C-3" --orch-dir "$ORCH_DIR" &
"$HELPER" --orch "orch-t10" --ticket "C-4" --orch-dir "$ORCH_DIR" &
"$HELPER" --orch "orch-t10" --ticket "C-5" --orch-dir "$ORCH_DIR" &
wait

run "concurrent: orch.usage.costUSD == 5.00" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t10\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '5' ]"
run "concurrent: orch.usage.inputTokens == 5000" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t10\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '5000' ]"

# ─── Test 11: missing required args exit non-zero ─────────────────────────────
run "missing --orch exits non-zero" \
  bash -c "! '$HELPER' --ticket 'T-1' 2>/dev/null"
run "missing --ticket exits non-zero" \
  bash -c "! '$HELPER' --orch 'foo' 2>/dev/null"
run "no args exits non-zero" \
  bash -c "! '$HELPER' 2>/dev/null"

# ─── Test 12: helper does not leak temp files ─────────────────────────────────
ORCH_DIR=$(setup_orch "orch-t12")
build_stream_with_result "${ORCH_DIR}/workers/output/T-1-stream.jsonl" \
  "0.5" "100" "10" "5" "1" "1" "1000" "500"
build_signal "${ORCH_DIR}/workers/T-1.json" "T-1"
"$HELPER" --orch "orch-t12" --ticket "T-1" --orch-dir "$ORCH_DIR"

run "no signal .tmp file leaks" \
  bash -c "[ ! -f '${ORCH_DIR}/workers/T-1.json.tmp' ]"
run "no state .tmp file leaks" \
  bash -c "[ ! -f '${CATALYST_STATE_FILE}.tmp' ]"

# ─── Test 13: --verbose emits action codes to stderr (CTL-233) ────────────────
# Helper currently silent on every exit branch. Verbose mode lets the orchestrator
# log roll-usage activity to a per-orch audit file so silent skips are auditable.
# Action codes capture each exit branch:
#   wrote-cost, already-rolled, signal-missing, stream-missing, no-result-yet

# Helper that captures stderr to a file so `set -e` doesn't abort on a non-zero
# exit and we can grep the captured output.
verbose_run() {
  local label="$1" tic="$2" odir="$3"
  local logf="${SCRATCH}/${label}.stderr"
  "$HELPER" --orch "$label" --ticket "$tic" --orch-dir "$odir" -v 2>"$logf" >/dev/null || true
  echo "$logf"
}

ORCH_DIR=$(setup_orch "orch-t13a")
build_stream_with_result "${ORCH_DIR}/workers/output/V-1-stream.jsonl" \
  "0.5" "100" "10" "5" "1" "1" "1000" "500"
build_signal "${ORCH_DIR}/workers/V-1.json" "V-1"

LOG=$(verbose_run "orch-t13a" "V-1" "$ORCH_DIR")
run "verbose: wrote-cost on successful roll" \
  bash -c "grep -q 'roll-usage\\[ticket=V-1\\]: wrote-cost' '$LOG'"

# Second invocation: should be no-op and emit "already-rolled"
LOG=$(verbose_run "orch-t13a" "V-1" "$ORCH_DIR")
run "verbose: already-rolled on second invocation" \
  bash -c "grep -q 'roll-usage\\[ticket=V-1\\]: already-rolled' '$LOG'"

# Stream missing
ORCH_DIR=$(setup_orch "orch-t13b")
build_signal "${ORCH_DIR}/workers/V-2.json" "V-2"
LOG=$(verbose_run "orch-t13b" "V-2" "$ORCH_DIR")
run "verbose: stream-missing when no stream file" \
  bash -c "grep -q 'roll-usage\\[ticket=V-2\\]: stream-missing' '$LOG'"

# Signal missing
ORCH_DIR=$(setup_orch "orch-t13c")
build_stream_with_result "${ORCH_DIR}/workers/output/V-3-stream.jsonl" \
  "0.5" "100" "10" "5" "1" "1" "1000" "500"
LOG=$(verbose_run "orch-t13c" "V-3" "$ORCH_DIR")
run "verbose: signal-missing when no signal file" \
  bash -c "grep -q 'roll-usage\\[ticket=V-3\\]: signal-missing' '$LOG'"

# No result event yet (worker still running)
ORCH_DIR=$(setup_orch "orch-t13d")
build_stream_no_result "${ORCH_DIR}/workers/output/V-4-stream.jsonl"
build_signal "${ORCH_DIR}/workers/V-4.json" "V-4"
LOG=$(verbose_run "orch-t13d" "V-4" "$ORCH_DIR")
run "verbose: no-result-yet when stream lacks result event" \
  bash -c "grep -q 'roll-usage\\[ticket=V-4\\]: no-result-yet' '$LOG'"

# ─── Test 14: silent by default (no -v) ───────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-t14")
build_stream_with_result "${ORCH_DIR}/workers/output/S-1-stream.jsonl" \
  "0.5" "100" "10" "5" "1" "1" "1000" "500"
build_signal "${ORCH_DIR}/workers/S-1.json" "S-1"
SILENT_LOG="${SCRATCH}/orch-t14.stderr"
"$HELPER" --orch "orch-t14" --ticket "S-1" --orch-dir "$ORCH_DIR" 2>"$SILENT_LOG" >/dev/null || true
run "silent by default: stderr empty on success" \
  bash -c "[ ! -s '$SILENT_LOG' ]"

# ─── Test 15: defensive — missing modelUsage in result event (CTL-233) ────────
# Older Claude CLI versions / error_during_execution results may lack modelUsage.
# Helper must not error on `keys[0]` against null.
build_stream_no_modelusage() {
  local out="$1" cost="$2" itok="$3" otok="$4"
  cat > "$out" <<EOF
{"type":"system","subtype":"init","session_id":"test"}
{"type":"result","subtype":"success","usage":{"input_tokens":${itok},"output_tokens":${otok},"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":${cost},"num_turns":1,"duration_ms":1000,"duration_api_ms":500}
EOF
}

ORCH_DIR=$(setup_orch "orch-t15")
build_stream_no_modelusage "${ORCH_DIR}/workers/output/M-1-stream.jsonl" "0.25" "500" "100"
build_signal "${ORCH_DIR}/workers/M-1.json" "M-1"

run "missing-modelUsage: helper exits 0" \
  "$HELPER" --orch "orch-t15" --ticket "M-1" --orch-dir "$ORCH_DIR"
run "missing-modelUsage: signal.cost.costUSD populated" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/M-1.json')\" = '0.25' ]"
run "missing-modelUsage: signal.cost.model is null" \
  bash -c "[ \"\$(jq -r '.cost.model' '${ORCH_DIR}/workers/M-1.json')\" = 'null' ]"
run "missing-modelUsage: orch.usage.costUSD updated" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-t15\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '0.25' ]"

# ─── Test 16: catalystSessionId in signal → session_metrics row populated (CTL-455) ─
# The bug: orchestrate-roll-usage writes cost to signal + state.json but never
# calls catalyst-session.sh metric, so the SQLite session_metrics table stays at
# all-zero values for every cost/token/duration column.
SESSION_SH="${REPO_ROOT}/plugins/dev/scripts/catalyst-session.sh"
CATALYST_DB="${CATALYST_DIR}/catalyst.db"
export CATALYST_DB_FILE="$CATALYST_DB"

# Bootstrap a minimal schema — just the two tables we exercise. Mirrors the
# columns in db-migrations/001_initial_schema.sql + 004_iteration_counts.sql.
init_test_db() {
  rm -f "$CATALYST_DB"
  sqlite3 "$CATALYST_DB" <<'SQL'
CREATE TABLE sessions (
  session_id        TEXT PRIMARY KEY,
  workflow_id       TEXT,
  ticket_key        TEXT,
  label             TEXT,
  skill_name        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running',
  phase             INTEGER NOT NULL DEFAULT 0,
  pid               INTEGER,
  started_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  cwd               TEXT,
  git_branch        TEXT,
  claude_session_id TEXT,
  last_context_pct  INTEGER
);
CREATE TABLE session_metrics (
  session_id            TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  cost_usd              REAL NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL,
  plan_iterations       INTEGER NOT NULL DEFAULT 0,
  fix_iterations        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE session_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      TEXT,
  ts           TEXT NOT NULL
);
SQL
}

# Insert a session row that mirrors what catalyst-session.sh start would create.
seed_session() {
  local sid="$1" ticket="$2"
  sqlite3 "$CATALYST_DB" "INSERT INTO sessions
    (session_id, ticket_key, skill_name, status, started_at, updated_at)
    VALUES ('${sid}', '${ticket}', 'oneshot', 'running',
            '2026-04-23T12:00:00Z', '2026-04-23T12:00:00Z');"
}

# Build a signal that includes a catalystSessionId field.
build_signal_with_sid() {
  local out="$1" ticket="$2" sid="$3"
  cat > "$out" <<EOF
{
  "ticket": "${ticket}",
  "orchestrator": "orch-test",
  "workerName": "orch-test-${ticket}",
  "status": "done",
  "phase": 6,
  "startedAt": "2026-04-23T12:00:00Z",
  "updatedAt": "2026-04-23T12:30:00Z",
  "catalystSessionId": "${sid}",
  "phaseTimestamps": { "researching": "2026-04-23T12:00:00Z" },
  "pr": { "number": 100, "url": "https://github.com/test/test/pull/100" }
}
EOF
}

ORCH_DIR=$(setup_orch "orch-t16")
init_test_db
SID_16="sess_t16_aaaa"
seed_session "$SID_16" "T-16"
build_stream_with_result "${ORCH_DIR}/workers/output/T-16-stream.jsonl" \
  "0.75" "1500" "300" "150" "75" "8" "45000" "20000"
build_signal_with_sid "${ORCH_DIR}/workers/T-16.json" "T-16" "$SID_16"

"$HELPER" --orch "orch-t16" --ticket "T-16" --orch-dir "$ORCH_DIR"

run "session_metrics.cost_usd populated from helper" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT cost_usd FROM session_metrics WHERE session_id='${SID_16}';\")\" = '0.75' ]"
run "session_metrics.input_tokens populated" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT input_tokens FROM session_metrics WHERE session_id='${SID_16}';\")\" = '1500' ]"
run "session_metrics.output_tokens populated" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT output_tokens FROM session_metrics WHERE session_id='${SID_16}';\")\" = '300' ]"
run "session_metrics.cache_read_tokens populated" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT cache_read_tokens FROM session_metrics WHERE session_id='${SID_16}';\")\" = '150' ]"
run "session_metrics.cache_creation_tokens populated" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT cache_creation_tokens FROM session_metrics WHERE session_id='${SID_16}';\")\" = '75' ]"
run "session_metrics.duration_ms populated" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT duration_ms FROM session_metrics WHERE session_id='${SID_16}';\")\" = '45000' ]"

# Idempotency: second invocation short-circuits on signal.cost != null so
# session_metrics values do not change.
"$HELPER" --orch "orch-t16" --ticket "T-16" --orch-dir "$ORCH_DIR"
run "idempotent: session_metrics.cost_usd still 0.75 after re-roll" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT cost_usd FROM session_metrics WHERE session_id='${SID_16}';\")\" = '0.75' ]"

# ─── Test 17: verbose 'wrote-metric' on success, 'metric-skipped' when no sid ─
ORCH_DIR=$(setup_orch "orch-t17")
init_test_db
SID_17="sess_t17_bbbb"
seed_session "$SID_17" "T-17"
build_stream_with_result "${ORCH_DIR}/workers/output/T-17-stream.jsonl" \
  "0.3" "100" "20" "5" "2" "1" "500" "200"
build_signal_with_sid "${ORCH_DIR}/workers/T-17.json" "T-17" "$SID_17"

LOG="${SCRATCH}/orch-t17.stderr"
"$HELPER" --orch "orch-t17" --ticket "T-17" --orch-dir "$ORCH_DIR" -v 2>"$LOG" >/dev/null || true
run "verbose: wrote-metric on successful metric write" \
  bash -c "grep -q 'roll-usage\\[ticket=T-17\\]: wrote-metric' '$LOG'"

# Now run a worker whose signal has no catalystSessionId AND no DB row.
ORCH_DIR=$(setup_orch "orch-t17b")
init_test_db
build_stream_with_result "${ORCH_DIR}/workers/output/T-17B-stream.jsonl" \
  "0.3" "100" "20" "5" "2" "1" "500" "200"
build_signal "${ORCH_DIR}/workers/T-17B.json" "T-17B"  # no catalystSessionId, no seeded session

LOG="${SCRATCH}/orch-t17b.stderr"
"$HELPER" --orch "orch-t17b" --ticket "T-17B" --orch-dir "$ORCH_DIR" -v 2>"$LOG" >/dev/null || true
run "verbose: metric-skipped when no session id resolvable" \
  bash -c "grep -q 'roll-usage\\[ticket=T-17B\\]: metric-skipped' '$LOG'"
run "metric-skipped: no session_metrics row created" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' 'SELECT COUNT(*) FROM session_metrics;')\" = '0' ]"

# ─── Test 18: DB-fallback path — signal lacks catalystSessionId, DB has match ─
ORCH_DIR=$(setup_orch "orch-t18")
init_test_db
SID_18="sess_t18_cccc"
seed_session "$SID_18" "T-18"
build_stream_with_result "${ORCH_DIR}/workers/output/T-18-stream.jsonl" \
  "1.25" "5000" "1000" "500" "250" "12" "75000" "30000"
build_signal "${ORCH_DIR}/workers/T-18.json" "T-18"  # no catalystSessionId in signal

"$HELPER" --orch "orch-t18" --ticket "T-18" --orch-dir "$ORCH_DIR"
run "DB-fallback: session_metrics.cost_usd populated via ticket lookup" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT cost_usd FROM session_metrics WHERE session_id='${SID_18}';\")\" = '1.25' ]"
run "DB-fallback: session_metrics.input_tokens populated via ticket lookup" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT input_tokens FROM session_metrics WHERE session_id='${SID_18}';\")\" = '5000' ]"
run "DB-fallback: session_metrics.duration_ms populated via ticket lookup" \
  bash -c "[ \"\$(sqlite3 '$CATALYST_DB' \"SELECT duration_ms FROM session_metrics WHERE session_id='${SID_18}';\")\" = '75000' ]"

# Reset env so subsequent (none here) tests don't inherit the override.
unset CATALYST_DB_FILE

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
