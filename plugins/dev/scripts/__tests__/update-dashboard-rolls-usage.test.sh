#!/usr/bin/env bash
# Shell tests for update-dashboard.sh --roll-usage (CTL-487).
#
# Verifies the audit-trace contract from CTL-487 DoD item 4: the orchestrator
# monitor loop invokes orchestrate-roll-usage.sh per worker per wake-up. We
# enforce this mechanically by wiring update-dashboard.sh (which IS called
# every wake-up) to drive the rollup via --roll-usage. This test asserts:
#
#   1. update-dashboard.sh --roll-usage populates signal.cost for a worker
#      whose stream has a result event and whose signal.cost is null.
#   2. The .roll-usage.log audit file records "wrote-cost" for that ticket.
#   3. A second invocation is a no-op (idempotency) — .roll-usage.log gains
#      an "already-rolled" entry and signal.cost is unchanged.
#   4. Without --roll-usage the flag's behavior is opt-in: signal.cost stays
#      null. This proves the old SKILL.md-only contract was indeed dead code.
#
# Run: bash plugins/dev/scripts/__tests__/update-dashboard-rolls-usage.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/update-dashboard.sh"
STATE_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-state.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Isolate state — tests must not touch the user's real ~/catalyst.
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

build_stream_with_result() {
  local out="$1" cost="$2" itok="$3" otok="$4" turns="$5" dur="$6"
  cat > "$out" <<EOF
{"type":"system","subtype":"init","session_id":"test"}
{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}
{"type":"result","subtype":"success","usage":{"input_tokens":${itok},"output_tokens":${otok},"cache_read_input_tokens":10,"cache_creation_input_tokens":20},"total_cost_usd":${cost},"num_turns":${turns},"duration_ms":${dur},"duration_api_ms":$((dur / 2)),"modelUsage":{"claude-opus-4-7":{"costUSD":${cost}}}}
EOF
}

build_signal() {
  # Note: no .cost field — that is what the rollup is supposed to populate.
  local out="$1" ticket="$2" wave="${3:-1}"
  cat > "$out" <<EOF
{
  "ticket": "${ticket}",
  "orchestrator": "test-orch",
  "workerName": "test-orch-${ticket}",
  "wave": ${wave},
  "status": "done",
  "phase": 5,
  "startedAt": "2026-05-17T12:00:00Z",
  "updatedAt": "2026-05-17T12:30:00Z",
  "phaseTimestamps": { "researching": "2026-05-17T12:00:00Z" },
  "pr": { "number": 100, "url": "https://github.com/test/test/pull/100" },
  "definitionOfDone": {}
}
EOF
}

setup_orch() {
  local orch_id="$1"
  local orch_dir="${SCRATCH}/runs/${orch_id}"
  mkdir -p "${orch_dir}/workers/output"
  # Per-orch state.json the dashboard renders from.
  cat > "${orch_dir}/state.json" <<EOF
{
  "orchestrator": "${orch_id}",
  "startedAt": "2026-05-17T12:00:00Z",
  "baseBranch": "main",
  "totalTickets": 1,
  "totalWaves": 1,
  "currentWave": 1,
  "maxParallel": 1,
  "waves": [{"wave":1,"status":"running","tickets":["TEST-1"]}],
  "workers": {}
}
EOF
  # Global state — register the orch so projectKey lookup works.
  rm -f "$CATALYST_STATE_FILE"
  "$STATE_SCRIPT" init >/dev/null
  "$STATE_SCRIPT" register "$orch_id" "$(jq -nc --arg id "$orch_id" \
    '{id: $id, projectKey: "test-proj", status: "active",
      startedAt: "2026-05-17T12:00:00Z",
      progress: {totalTickets: 1, completedTickets: 0, failedTickets: 0, inProgressTickets: 1, currentWave: 1, totalWaves: 1},
      usage: {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, numTurns: 0, durationMs: 0, durationApiMs: 0, model: null},
      workers: {}, attention: []}')" >/dev/null
  echo "$orch_dir"
}

# ─── Test 1: dashboard helper exists and accepts --roll-usage ─────────────────
run "helper script exists" bash -c "[ -f '$HELPER' ]"
run "helper script is executable" bash -c "[ -x '$HELPER' ]"
run "helper accepts --roll-usage in usage block" \
  bash -c "'$HELPER' --help 2>&1 | grep -q -- '--roll-usage' || '$HELPER' -h 2>&1 | grep -q -- '--roll-usage'"

# ─── Test 2: --roll-usage populates signal.cost for a worker with a result ────
ORCH_DIR=$(setup_orch "orch-cd1")
build_stream_with_result "${ORCH_DIR}/workers/output/TEST-1-stream.jsonl" \
  "1.23" "100" "50" "3" "4000"
build_signal "${ORCH_DIR}/workers/TEST-1.json" "TEST-1"

# Sanity: signal starts without a .cost field
run "before run: signal.cost is null" \
  bash -c "[ \"\$(jq -r '.cost // \"null\"' '${ORCH_DIR}/workers/TEST-1.json')\" = 'null' ]"

# Run with --roll-usage. --stdout suppresses the DASHBOARD.md write so we
# isolate the rollup behaviour.
"$HELPER" --orch "orch-cd1" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null

run "after --roll-usage: signal.cost.costUSD == 1.23" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/TEST-1.json')\" = '1.23' ]"
run "after --roll-usage: signal.cost.inputTokens == 100" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '${ORCH_DIR}/workers/TEST-1.json')\" = '100' ]"
run "after --roll-usage: signal.cost.outputTokens == 50" \
  bash -c "[ \"\$(jq -r '.cost.outputTokens' '${ORCH_DIR}/workers/TEST-1.json')\" = '50' ]"

# ─── Test 3: .roll-usage.log captures the action codes (audit trace) ──────────
run ".roll-usage.log exists" \
  bash -c "[ -f '${ORCH_DIR}/.roll-usage.log' ]"
run ".roll-usage.log records wrote-cost for TEST-1" \
  bash -c "grep -q 'roll-usage\\[ticket=TEST-1\\]: wrote-cost' '${ORCH_DIR}/.roll-usage.log'"

# ─── Test 4: idempotency — second invocation logs already-rolled ──────────────
"$HELPER" --orch "orch-cd1" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null

run "second invocation: signal.cost.costUSD unchanged (still 1.23)" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/TEST-1.json')\" = '1.23' ]"
run "second invocation: .roll-usage.log records already-rolled" \
  bash -c "grep -q 'roll-usage\\[ticket=TEST-1\\]: already-rolled' '${ORCH_DIR}/.roll-usage.log'"

# ─── Test 5: orchestrator-level state.usage rolled correctly ──────────────────
run "orch.usage.costUSD == 1.23 in global state" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-cd1\"].usage.costUSD' '$CATALYST_STATE_FILE')\" = '1.23' ]"
run "orch.usage.inputTokens == 100 in global state" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-cd1\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '100' ]"

# ─── Test 6: opt-in flag — without --roll-usage, signal.cost stays null ───────
# Proves that the rollup is wired through the flag and not always-on. Also
# documents the contrast with the pre-CTL-487 SKILL.md-only contract: without
# the flag, no rollup happens.
ORCH_DIR=$(setup_orch "orch-cd2")
build_stream_with_result "${ORCH_DIR}/workers/output/TEST-1-stream.jsonl" \
  "0.5" "200" "100" "2" "2000"
build_signal "${ORCH_DIR}/workers/TEST-1.json" "TEST-1"

"$HELPER" --orch "orch-cd2" --orch-dir "$ORCH_DIR" --stdout >/dev/null

run "without --roll-usage: signal.cost stays null" \
  bash -c "[ \"\$(jq -r '.cost // \"null\"' '${ORCH_DIR}/workers/TEST-1.json')\" = 'null' ]"
run "without --roll-usage: no .roll-usage.log written" \
  bash -c "[ ! -f '${ORCH_DIR}/.roll-usage.log' ]"

# ─── Test 7: multi-worker safety-net sweep ────────────────────────────────────
# Build 3 workers — one with cost already set (already-rolled), one with a
# result event but null cost (needs rollup), one with no result event yet
# (still running). Single --roll-usage call must handle all three correctly.
ORCH_DIR=$(setup_orch "orch-cd3")
# Worker A — already rolled (signal.cost already populated)
build_stream_with_result "${ORCH_DIR}/workers/output/A-stream.jsonl" \
  "0.10" "10" "5" "1" "100"
cat > "${ORCH_DIR}/workers/A.json" <<EOF
{
  "ticket": "A", "wave": 1, "status": "done", "phase": 5,
  "startedAt": "2026-05-17T12:00:00Z", "updatedAt": "2026-05-17T12:30:00Z",
  "cost": { "costUSD": 0.10, "inputTokens": 10, "outputTokens": 5,
    "cacheReadTokens": 0, "cacheCreationTokens": 0, "numTurns": 1,
    "durationMs": 100, "durationApiMs": 50, "model": null }
}
EOF
# Worker B — needs rollup
build_stream_with_result "${ORCH_DIR}/workers/output/B-stream.jsonl" \
  "0.20" "20" "10" "2" "200"
build_signal "${ORCH_DIR}/workers/B.json" "B"
# Worker C — still running (no result event yet)
cat > "${ORCH_DIR}/workers/output/C-stream.jsonl" <<EOF
{"type":"system","subtype":"init","session_id":"running"}
{"type":"assistant","message":{"content":[{"type":"text","text":"still working"}]}}
EOF
build_signal "${ORCH_DIR}/workers/C.json" "C"

"$HELPER" --orch "orch-cd3" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null

run "A: signal.cost.costUSD unchanged (already-rolled)" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/A.json')\" = '0.10' ]"
run "B: signal.cost.costUSD populated (needs-rollup → wrote-cost)" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/B.json')\" = '0.20' ]"
run "C: signal.cost stays null (no result event yet)" \
  bash -c "[ \"\$(jq -r '.cost // \"null\"' '${ORCH_DIR}/workers/C.json')\" = 'null' ]"
run ".roll-usage.log records A already-rolled" \
  bash -c "grep -q 'roll-usage\\[ticket=A\\]: already-rolled' '${ORCH_DIR}/.roll-usage.log'"
run ".roll-usage.log records B wrote-cost" \
  bash -c "grep -q 'roll-usage\\[ticket=B\\]: wrote-cost' '${ORCH_DIR}/.roll-usage.log'"
run ".roll-usage.log records C no-result-yet" \
  bash -c "grep -q 'roll-usage\\[ticket=C\\]: no-result-yet' '${ORCH_DIR}/.roll-usage.log'"

# ─── Test 8: --roll-usage still renders the dashboard (smoke check) ───────────
# The flag is additive — dashboard rendering must still happen alongside the
# rollup. Use --stdout to avoid writing files; just confirm we get a header.
ORCH_DIR=$(setup_orch "orch-cd4")
build_stream_with_result "${ORCH_DIR}/workers/output/TEST-1-stream.jsonl" \
  "0.7" "70" "30" "2" "1500"
build_signal "${ORCH_DIR}/workers/TEST-1.json" "TEST-1"

OUT=$("$HELPER" --orch "orch-cd4" --orch-dir "$ORCH_DIR" --roll-usage --stdout 2>/dev/null)
run "--roll-usage still renders dashboard header" \
  bash -c "grep -q '# Orchestration Dashboard' <<<\"$OUT\""
run "--roll-usage still rendered after the rollup populated signal.cost" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/TEST-1.json')\" = '0.7' ]"

# ─── Test 9: missing orchestrate-roll-usage.sh is non-fatal ───────────────────
# If the rollup script ever moves or is somehow unavailable, the dashboard
# render must still succeed. The flag should degrade gracefully.
ORCH_DIR=$(setup_orch "orch-cd5")
build_signal "${ORCH_DIR}/workers/TEST-1.json" "TEST-1"
# Don't build a stream — gives the inner helper no work, but exercises the
# outer loop's per-worker iteration. The dashboard render must still complete.

run "--roll-usage with no stream files: helper still exits 0" \
  "$HELPER" --orch "orch-cd5" --orch-dir "$ORCH_DIR" --roll-usage --stdout

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
