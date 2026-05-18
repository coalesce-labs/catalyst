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

# ───────────────────────────────────────────────────────────────────────────────
# Phase-agent sweep loop tests (CTL-496)
# Verifies that --roll-usage also walks workers/<TICKET>/phase-<NAME>.json
# alongside the existing flat workers/<TICKET>.json layout.
# ───────────────────────────────────────────────────────────────────────────────

BG_JOBS_DIR="${SCRATCH}/claude-jobs"
mkdir -p "$BG_JOBS_DIR"
export CATALYST_BG_JOBS_DIR="$BG_JOBS_DIR"

build_phase_signal() {
  local out="$1" ticket="$2"; shift 2
  local bg_job_id="" catalyst_sid=""
  local phase_name
  phase_name="$(basename "$out" .json)"
  phase_name="${phase_name#phase-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --bg-job-id)            bg_job_id="$2"; shift 2 ;;
      --catalyst-session-id)  catalyst_sid="$2"; shift 2 ;;
      *) echo "build_phase_signal: unknown arg $1" >&2; return 1 ;;
    esac
  done
  mkdir -p "$(dirname "$out")"
  jq -n \
    --arg ticket "$ticket" \
    --arg phase "$phase_name" \
    --arg bg "$bg_job_id" \
    --arg sid "$catalyst_sid" \
    '{
      ticket: $ticket,
      phase: $phase,
      orchestrator: "orch-test",
      status: "running",
      startedAt: "2026-05-18T09:00:00Z",
      updatedAt: "2026-05-18T09:30:00Z"
    }
    | if $bg != "" then .bg_job_id = $bg else . end
    | if $sid != "" then .catalystSessionId = $sid else . end' > "$out"
}

build_fake_bg_state() {
  local bg_id="$1"; shift
  local session_id="" link_scan_path=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --session-id)     session_id="$2"; shift 2 ;;
      --link-scan-path) link_scan_path="$2"; shift 2 ;;
      *) echo "build_fake_bg_state: unknown arg $1" >&2; return 1 ;;
    esac
  done
  mkdir -p "${BG_JOBS_DIR}/${bg_id}"
  jq -n --arg sid "$session_id" --arg lsp "$link_scan_path" \
    '{state:"working", sessionId:$sid, linkScanPath:$lsp}' \
    > "${BG_JOBS_DIR}/${bg_id}/state.json"
}

build_phase_jsonl() {
  local out="$1"; shift
  local input=0 output=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --input)  input="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      *) echo "build_phase_jsonl: unknown arg $1" >&2; return 1 ;;
    esac
  done
  mkdir -p "$(dirname "$out")"
  jq -nc \
    --argjson input "$input" --argjson output "$output" \
    '{type:"assistant",
      message:{model:"claude-opus-4-7",stop_reason:"end_turn",
        usage:{input_tokens:$input,output_tokens:$output,
          cache_read_input_tokens:0,
          cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0}}}}' > "$out"
}

# ─── Test 10: sweep discovers per-phase signal files and rolls each ───────────
ORCH_DIR=$(setup_orch "orch-ph1")
mkdir -p "${ORCH_DIR}/workers/PH-1"
build_phase_signal "${ORCH_DIR}/workers/PH-1/phase-research.json" "PH-1" \
  --bg-job-id "bg-ph1a"
build_phase_signal "${ORCH_DIR}/workers/PH-1/phase-plan.json" "PH-1" \
  --bg-job-id "bg-ph1b"
build_fake_bg_state "bg-ph1a" --session-id "x1" \
  --link-scan-path "${SCRATCH}/ph1a.jsonl"
build_fake_bg_state "bg-ph1b" --session-id "x2" \
  --link-scan-path "${SCRATCH}/ph1b.jsonl"
build_phase_jsonl "${SCRATCH}/ph1a.jsonl" --input 1000 --output 500
build_phase_jsonl "${SCRATCH}/ph1b.jsonl" --input 2000 --output 1000

"$HELPER" --orch "orch-ph1" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null

run "phase sweep: phase-research signal.cost populated" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '${ORCH_DIR}/workers/PH-1/phase-research.json')\" = '1000' ]"
run "phase sweep: phase-plan signal.cost populated" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '${ORCH_DIR}/workers/PH-1/phase-plan.json')\" = '2000' ]"
run "phase sweep: state.workers[PH-1].usage.inputTokens == 3000 (sum across phases)" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-ph1\"].workers[\"PH-1\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '3000' ]"
run "phase sweep: .roll-usage.log records both phases" \
  bash -c "grep -q 'ticket=PH-1,phase=research.*wrote-cost' '${ORCH_DIR}/.roll-usage.log' && grep -q 'ticket=PH-1,phase=plan.*wrote-cost' '${ORCH_DIR}/.roll-usage.log'"

# ─── Test 11: sweep handles mixed layout (legacy flat + phase per-ticket) ─────
ORCH_DIR=$(setup_orch "orch-ph2")
# Legacy ticket with flat layout
build_stream_with_result "${ORCH_DIR}/workers/output/L-1-stream.jsonl" \
  "0.5" "5000" "500" "5" "10000"
build_signal "${ORCH_DIR}/workers/L-1.json" "L-1"
# Phase ticket
mkdir -p "${ORCH_DIR}/workers/PH-2"
build_phase_signal "${ORCH_DIR}/workers/PH-2/phase-triage.json" "PH-2" \
  --bg-job-id "bg-ph2"
build_fake_bg_state "bg-ph2" --session-id "y1" \
  --link-scan-path "${SCRATCH}/ph2.jsonl"
build_phase_jsonl "${SCRATCH}/ph2.jsonl" --input 500 --output 100

"$HELPER" --orch "orch-ph2" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null

run "mixed: legacy L-1 flat signal.cost populated" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '${ORCH_DIR}/workers/L-1.json')\" = '0.5' ]"
run "mixed: phase PH-2 signal.cost populated" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '${ORCH_DIR}/workers/PH-2/phase-triage.json')\" = '500' ]"

# ─── Test 12: phase sweep idempotent — re-running does not double-count ───────
COST_BEFORE=$(jq -r '.orchestrators["orch-ph2"].usage.costUSD' "$CATALYST_STATE_FILE")
"$HELPER" --orch "orch-ph2" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null
COST_AFTER=$(jq -r '.orchestrators["orch-ph2"].usage.costUSD' "$CATALYST_STATE_FILE")
run "phase sweep idempotent: state.usage.costUSD unchanged" \
  bash -c "[ \"$COST_BEFORE\" = \"$COST_AFTER\" ]"

# ─── Test 13: .dead-*.json sidecars are skipped ───────────────────────────────
# phase-agent-dispatch renames killed worker signals to phase-X.json.dead-*.json
# for archival. The sweep glob must not pick these up — re-rolling them after
# the live signal already booked the cost would double-count.
ORCH_DIR=$(setup_orch "orch-ph3")
mkdir -p "${ORCH_DIR}/workers/PH-3"
build_phase_signal "${ORCH_DIR}/workers/PH-3/phase-research.json" "PH-3" \
  --bg-job-id "bg-ph3"
build_fake_bg_state "bg-ph3" --session-id "z1" \
  --link-scan-path "${SCRATCH}/ph3.jsonl"
build_phase_jsonl "${SCRATCH}/ph3.jsonl" --input 1000 --output 500
# Create a .dead-*.json sidecar identical to the live signal
cp "${ORCH_DIR}/workers/PH-3/phase-research.json" \
   "${ORCH_DIR}/workers/PH-3/phase-research.json.dead-deadbeef.json"

"$HELPER" --orch "orch-ph3" --orch-dir "$ORCH_DIR" --roll-usage --stdout >/dev/null

run "dead sidecar: live phase-research processed" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '${ORCH_DIR}/workers/PH-3/phase-research.json')\" = '1000' ]"
run "dead sidecar: .dead-*.json NOT processed (cost stays null)" \
  bash -c "[ \"\$(jq -r '.cost // \"null\"' '${ORCH_DIR}/workers/PH-3/phase-research.json.dead-deadbeef.json')\" = 'null' ]"
run "dead sidecar: state.workers[PH-3].usage NOT double-counted" \
  bash -c "[ \"\$(jq -r '.orchestrators[\"orch-ph3\"].workers[\"PH-3\"].usage.inputTokens' '$CATALYST_STATE_FILE')\" = '1000' ]"

# ─── Test 14: no --roll-usage flag → phase signals untouched ──────────────────
ORCH_DIR=$(setup_orch "orch-ph4")
mkdir -p "${ORCH_DIR}/workers/PH-4"
build_phase_signal "${ORCH_DIR}/workers/PH-4/phase-research.json" "PH-4" \
  --bg-job-id "bg-ph4"
build_fake_bg_state "bg-ph4" --session-id "w1" \
  --link-scan-path "${SCRATCH}/ph4.jsonl"
build_phase_jsonl "${SCRATCH}/ph4.jsonl" --input 1000 --output 500

"$HELPER" --orch "orch-ph4" --orch-dir "$ORCH_DIR" --stdout >/dev/null

run "no --roll-usage: phase signal.cost stays null" \
  bash -c "[ \"\$(jq -r '.cost // \"null\"' '${ORCH_DIR}/workers/PH-4/phase-research.json')\" = 'null' ]"
run "no --roll-usage: no .roll-usage.log written" \
  bash -c "[ ! -f '${ORCH_DIR}/.roll-usage.log' ]"

unset CATALYST_BG_JOBS_DIR

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
