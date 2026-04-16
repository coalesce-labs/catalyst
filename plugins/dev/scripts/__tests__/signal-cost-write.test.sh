#!/usr/bin/env bash
# Shell tests for the orchestrator's signal-file cost write (CTL-88).
#
# The orchestrator's Phase 3 cost-parsing block (in plugins/dev/skills/orchestrate/SKILL.md)
# must mirror the parsed `USAGE` object into the worker's signal file as `cost`,
# so the dashboard (which reads signal files, not global state) can render
# per-worker cost columns.
#
# This test exercises the documented jq+atomic-rename pattern end-to-end against
# a real stream JSONL fixture and a real signal file. If the pattern in SKILL.md
# diverges from this test, the dashboard cost columns will silently regress.
#
# Run: bash plugins/dev/scripts/__tests__/signal-cost-write.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_FILE="${REPO_ROOT}/plugins/dev/skills/orchestrate/SKILL.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

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

# Build a minimal stream-json fixture containing one `result` event with usage.
# Mirrors the shape the Claude CLI emits with `--output-format stream-json --verbose`.
build_stream_fixture() {
  local out="$1"
  cat > "$out" <<'EOF'
{"type":"system","subtype":"init","session_id":"test-session"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"result","usage":{"input_tokens":12345,"output_tokens":6789,"cache_read_input_tokens":2222,"cache_creation_input_tokens":111},"total_cost_usd":0.4321,"num_turns":7,"duration_ms":42000,"duration_api_ms":15000,"modelUsage":{"claude-opus-4-7":{"costUSD":0.4321}}}
EOF
}

# Build a minimal signal file matching the required fields in the worker template.
build_signal_fixture() {
  local out="$1"
  cat > "$out" <<'EOF'
{
  "ticket": "TEST-1",
  "orchestrator": "orch-test",
  "workerName": "orch-test-TEST-1",
  "status": "shipping",
  "phase": 5,
  "startedAt": "2026-04-16T18:00:00Z",
  "updatedAt": "2026-04-16T18:30:00Z",
  "pid": 99999,
  "phaseTimestamps": {
    "researching": "2026-04-16T18:00:00Z",
    "shipping": "2026-04-16T18:30:00Z"
  },
  "pr": {
    "number": 42,
    "url": "https://github.com/test/test/pull/42",
    "ciStatus": "pending"
  }
}
EOF
}

# Reproduce the cost-parse + signal-write pattern that SKILL.md documents.
# This MUST stay in sync with plugins/dev/skills/orchestrate/SKILL.md
# (Phase 3 — Dispatch & monitor — cost-parsing block).
parse_and_write_cost() {
  local stream="$1" signal="$2"

  local result_line usage
  result_line=$(grep '"type":"result"' "$stream" | tail -1)
  [ -n "$result_line" ] || { echo "no result event in stream"; return 1; }

  usage=$(echo "$result_line" | jq -c '{
    inputTokens: .usage.input_tokens,
    outputTokens: .usage.output_tokens,
    cacheReadTokens: .usage.cache_read_input_tokens,
    cacheCreationTokens: .usage.cache_creation_input_tokens,
    costUSD: .total_cost_usd,
    numTurns: .num_turns,
    durationMs: .duration_ms,
    durationApiMs: .duration_api_ms,
    model: (.modelUsage | keys[0] // null)
  }' 2>/dev/null || echo 'null')

  [ "$usage" != "null" ] || { echo "usage parse failed"; return 1; }

  if [ -f "$signal" ]; then
    jq --argjson cost "$usage" '.cost = $cost' "$signal" \
      > "${signal}.tmp" && mv "${signal}.tmp" "$signal"
  fi
}

echo "signal-cost-write tests"

# ─── Test 1: parsed cost is written to signal file ───────────────────────────
STREAM="${SCRATCH}/stream.jsonl"
SIGNAL="${SCRATCH}/TEST-1.json"
build_stream_fixture "$STREAM"
build_signal_fixture "$SIGNAL"

parse_and_write_cost "$STREAM" "$SIGNAL"

run "writes cost.costUSD from total_cost_usd" \
  bash -c "[ \"\$(jq -r '.cost.costUSD' '$SIGNAL')\" = '0.4321' ]"
run "writes cost.inputTokens from usage.input_tokens" \
  bash -c "[ \"\$(jq -r '.cost.inputTokens' '$SIGNAL')\" = '12345' ]"
run "writes cost.outputTokens from usage.output_tokens" \
  bash -c "[ \"\$(jq -r '.cost.outputTokens' '$SIGNAL')\" = '6789' ]"
run "writes cost.cacheReadTokens from usage.cache_read_input_tokens" \
  bash -c "[ \"\$(jq -r '.cost.cacheReadTokens' '$SIGNAL')\" = '2222' ]"

# ─── Test 2: existing signal fields are preserved ────────────────────────────
run "preserves ticket field" \
  bash -c "[ \"\$(jq -r '.ticket' '$SIGNAL')\" = 'TEST-1' ]"
run "preserves status field" \
  bash -c "[ \"\$(jq -r '.status' '$SIGNAL')\" = 'shipping' ]"
run "preserves phase field" \
  bash -c "[ \"\$(jq -r '.phase' '$SIGNAL')\" = '5' ]"
run "preserves phaseTimestamps" \
  bash -c "[ \"\$(jq -r '.phaseTimestamps.shipping' '$SIGNAL')\" = '2026-04-16T18:30:00Z' ]"
run "preserves pr.number" \
  bash -c "[ \"\$(jq -r '.pr.number' '$SIGNAL')\" = '42' ]"

# ─── Test 3: no temp file remains after atomic write ─────────────────────────
run "no .tmp file leaks" \
  bash -c "[ ! -f '${SIGNAL}.tmp' ]"

# ─── Test 4: extra usage fields (numTurns, model, etc.) are also persisted ──
# Schema allows extras under .cost; storing them gives richer analytics for free.
run "writes cost.numTurns extra field" \
  bash -c "[ \"\$(jq -r '.cost.numTurns' '$SIGNAL')\" = '7' ]"
run "writes cost.model extra field" \
  bash -c "[ \"\$(jq -r '.cost.model' '$SIGNAL')\" = 'claude-opus-4-7' ]"

# ─── Test 5: missing signal file is a no-op (does not error) ─────────────────
STREAM2="${SCRATCH}/stream2.jsonl"
MISSING_SIGNAL="${SCRATCH}/missing.json"
build_stream_fixture "$STREAM2"

run "missing signal file is a no-op (no error)" \
  parse_and_write_cost "$STREAM2" "$MISSING_SIGNAL"
run "missing signal file is not created" \
  bash -c "[ ! -f '$MISSING_SIGNAL' ]"

# ─── Test 6: SKILL.md actually contains the documented pattern ───────────────
# Guards against the doc and this test silently drifting apart.
run "SKILL.md cost-parsing block references signal file write" \
  bash -c "grep -q 'jq --argjson cost' '$SKILL_FILE'"
run "SKILL.md uses .cost = \$cost assignment" \
  bash -c "grep -q '.cost = \$cost' '$SKILL_FILE'"
run "SKILL.md uses atomic tmp+rename for signal cost write" \
  bash -c "grep -A2 'jq --argjson cost' '$SKILL_FILE' | grep -q 'mv .*SIGNAL_FILE'"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
