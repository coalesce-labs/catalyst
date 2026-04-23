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

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
