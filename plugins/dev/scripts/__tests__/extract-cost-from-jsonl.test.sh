#!/usr/bin/env bash
# Shell tests for extract-cost-from-jsonl.sh (CTL-496).
#
# Verifies the pure-function JSONL extractor that reads a Claude bg-session
# conversation JSONL and emits a USAGE record matching the shape produced by
# orchestrate-roll-usage.sh for legacy stream-json `result` events. The
# extractor is the cost source for the phase-agent dispatch mode where the
# CLI does not write the stream-json `result` event (no --output-format flag).
#
# Run: bash plugins/dev/scripts/__tests__/extract-cost-from-jsonl.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/extract-cost-from-jsonl.sh"
PRICING="${REPO_ROOT}/plugins/dev/scripts/claude-pricing.json"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

JSONL="${SCRATCH}/sess.jsonl"

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

# Build a JSONL with N assistant events for one model, summing to the
# specified per-event totals. Cache creation is split into 5m and 1h buckets
# so callers can exercise the pricing split.
build_jsonl_single_model() {
  local out="$1"; shift
  local model="claude-opus-4-7" events=1 input=0 output=0 cache_read=0 cache_5m=0 cache_1h=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --model)              model="$2"; shift 2 ;;
      --assistant-events)   events="$2"; shift 2 ;;
      --input-tokens)       input="$2"; shift 2 ;;
      --output-tokens)      output="$2"; shift 2 ;;
      --cache-read)         cache_read="$2"; shift 2 ;;
      --cache-creation-5m)  cache_5m="$2"; shift 2 ;;
      --cache-creation-1h)  cache_1h="$2"; shift 2 ;;
      *) echo "build_jsonl_single_model: unknown arg $1" >&2; return 1 ;;
    esac
  done
  : > "$out"
  local i pi po pcr p5 p1
  # Distribute totals across events as evenly as the integer math allows;
  # the LAST event absorbs the remainder so the global sums match exactly.
  pi=$(( input / events ));      ri=$(( input - pi * (events-1) ))
  po=$(( output / events ));     ro=$(( output - po * (events-1) ))
  pcr=$(( cache_read / events )); rcr=$(( cache_read - pcr * (events-1) ))
  p5=$(( cache_5m / events ));   r5=$(( cache_5m - p5 * (events-1) ))
  p1=$(( cache_1h / events ));   r1=$(( cache_1h - p1 * (events-1) ))
  for (( i=1; i<=events; i++ )); do
    local ei eo ecr e5 e1
    if [ "$i" -lt "$events" ]; then
      ei=$pi; eo=$po; ecr=$pcr; e5=$p5; e1=$p1
    else
      ei=$ri; eo=$ro; ecr=$rcr; e5=$r5; e1=$r1
    fi
    jq -nc \
      --arg model "$model" \
      --argjson input "$ei" --argjson output "$eo" --argjson cache_read "$ecr" \
      --argjson cache_5m "$e5" --argjson cache_1h "$e1" \
      '{type:"assistant",
        message:{
          model:$model,
          stop_reason:"tool_use",
          usage:{
            input_tokens:$input,
            output_tokens:$output,
            cache_read_input_tokens:$cache_read,
            cache_creation:{
              ephemeral_5m_input_tokens:$cache_5m,
              ephemeral_1h_input_tokens:$cache_1h
            }
          }
        }
      }' >> "$out"
  done
}

# Build a JSONL with two models: opus and sonnet.
build_jsonl_multi_model() {
  local out="$1"; shift
  local opus_in=0 opus_out=0 sonnet_in=0 sonnet_out=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --opus-input)   opus_in="$2"; shift 2 ;;
      --opus-output)  opus_out="$2"; shift 2 ;;
      --sonnet-input) sonnet_in="$2"; shift 2 ;;
      --sonnet-output) sonnet_out="$2"; shift 2 ;;
      *) echo "build_jsonl_multi_model: unknown arg $1" >&2; return 1 ;;
    esac
  done
  : > "$out"
  jq -nc \
    --argjson input "$opus_in" --argjson output "$opus_out" \
    '{type:"assistant",
      message:{model:"claude-opus-4-7",stop_reason:"tool_use",
        usage:{input_tokens:$input,output_tokens:$output,
          cache_read_input_tokens:0,
          cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0}}}}' >> "$out"
  jq -nc \
    --argjson input "$sonnet_in" --argjson output "$sonnet_out" \
    '{type:"assistant",
      message:{model:"claude-sonnet-4-6",stop_reason:"tool_use",
        usage:{input_tokens:$input,output_tokens:$output,
          cache_read_input_tokens:0,
          cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0}}}}' >> "$out"
}

# Build a JSONL whose only assistant event splits cache creation across 5m+1h.
build_jsonl_cache_split() {
  local out="$1"; shift
  local cache_5m=0 cache_1h=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --cache-creation-5m) cache_5m="$2"; shift 2 ;;
      --cache-creation-1h) cache_1h="$2"; shift 2 ;;
      *) echo "build_jsonl_cache_split: unknown arg $1" >&2; return 1 ;;
    esac
  done
  build_jsonl_single_model "$out" --model claude-opus-4-7 --assistant-events 1 \
    --cache-creation-5m "$cache_5m" --cache-creation-1h "$cache_1h"
}

# Build a JSONL with N assistant events AND a single system.turn_duration
# event carrying the total duration in milliseconds.
build_jsonl_with_durations() {
  local out="$1"; shift
  local turns=1 total_ms=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --turns)    turns="$2"; shift 2 ;;
      --total-ms) total_ms="$2"; shift 2 ;;
      *) echo "build_jsonl_with_durations: unknown arg $1" >&2; return 1 ;;
    esac
  done
  build_jsonl_single_model "$out" --assistant-events "$turns" \
    --input-tokens 0 --output-tokens 0
  jq -nc --argjson ms "$total_ms" \
    '{type:"system",subtype:"turn_duration",durationMs:$ms}' >> "$out"
}

# Build a JSONL with N assistant events + N user events; the user events
# must NOT contribute to numTurns.
build_jsonl_with_turns() {
  local out="$1"; shift
  local assistant=1 user=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --assistant-events) assistant="$2"; shift 2 ;;
      --user-events)      user="$2"; shift 2 ;;
      *) echo "build_jsonl_with_turns: unknown arg $1" >&2; return 1 ;;
    esac
  done
  build_jsonl_single_model "$out" --assistant-events "$assistant" \
    --input-tokens 0 --output-tokens 0
  local i
  for (( i=1; i<=user; i++ )); do
    jq -nc '{type:"user",message:{role:"user",content:[{type:"text",text:"hi"}]}}' >> "$out"
  done
}

# Build a deterministic sub-agent JSONL alongside a parent at
# <parent-without-.jsonl>/subagents/agent-<id>.jsonl — the exact path the
# extractor derives for `--include-subagents` (research §deterministic path:
# strip .jsonl from the parent, then /subagents/*.jsonl). Reuses the parent
# builder so the line shape stays identical (CTL-666).
build_subagent_jsonl() {
  local parent="$1" id="$2"; shift 2
  local subdir="${parent%.jsonl}/subagents"
  mkdir -p "$subdir"
  build_jsonl_single_model "${subdir}/agent-${id}.jsonl" "$@"
}

# Build a JSONL with a single assistant event for an unknown (unpriced) model.
build_jsonl_unknown_model() {
  local out="$1"; shift
  local model="fictional-model-9" input=0 output=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --model)  model="$2"; shift 2 ;;
      --input)  input="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      *) echo "build_jsonl_unknown_model: unknown arg $1" >&2; return 1 ;;
    esac
  done
  build_jsonl_single_model "$out" --model "$model" --assistant-events 1 \
    --input-tokens "$input" --output-tokens "$output"
}

# ───────────────────────────────────────────────────────────────────────────────
echo "extract-cost-from-jsonl tests"
echo ""

# ─── Test 1: helper exists and is executable ──────────────────────────────────
run "extractor exists"        bash -c "[ -f '$HELPER' ]"
run "extractor is executable" bash -c "[ -x '$HELPER' ]"
run "pricing table exists"    bash -c "[ -f '$PRICING' ]"

# ─── Test 2: single-model JSONL → correct USAGE record ────────────────────────
build_jsonl_single_model "$JSONL" \
  --model claude-opus-4-7 \
  --assistant-events 3 \
  --input-tokens 1000 --output-tokens 500 \
  --cache-read 200 --cache-creation-5m 100 --cache-creation-1h 0
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING")
run "input_tokens summed" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '1000' ]"
run "output_tokens summed" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .outputTokens)\" = '500' ]"
run "cache_read summed" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .cacheReadTokens)\" = '200' ]"
run "cache_creation summed (5m+1h)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .cacheCreationTokens)\" = '100' ]"
run "model captured" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .model)\" = 'claude-opus-4-7' ]"
# cost = 1000*15/1e6 + 500*75/1e6 + 200*1.5/1e6 + 100*18.75/1e6
#      = 0.015 + 0.0375 + 0.0003 + 0.001875 = 0.054675
run "costUSD computed (opus, 5m cache-creation)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0.054675' ]"

# ─── Test 3: multi-model JSONL → cost is per-model sum ────────────────────────
build_jsonl_multi_model "$JSONL" \
  --opus-input 1000 --opus-output 500 \
  --sonnet-input 2000 --sonnet-output 1000
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING")
# opus  = 1000*15/1e6 + 500*75/1e6 = 0.015 + 0.0375 = 0.0525
# sonnet = 2000*3/1e6 + 1000*15/1e6 = 0.006 + 0.015 = 0.021
# total = 0.0735
run "multi-model costUSD (opus+sonnet)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0.0735' ]"
run "primary model is highest-cost (opus)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .model)\" = 'claude-opus-4-7' ]"

# ─── Test 4: cache_creation_5m vs cache_creation_1h split (different prices) ──
build_jsonl_cache_split "$JSONL" \
  --cache-creation-5m 100 --cache-creation-1h 100
# 100*18.75/1e6 + 100*30/1e6 = 0.001875 + 0.003 = 0.004875
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING")
run "cache 5m+1h pricing differentiated" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0.004875' ]"

# ─── Test 5: duration_ms is sum of system.turn_duration events ────────────────
build_jsonl_with_durations "$JSONL" --turns 3 --total-ms 45000
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING")
run "durationMs aggregated from system.turn_duration" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .durationMs)\" = '45000' ]"

# ─── Test 6: numTurns counts assistant events only ────────────────────────────
build_jsonl_with_turns "$JSONL" --assistant-events 5 --user-events 5
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING")
run "numTurns counts assistant events (not user)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .numTurns)\" = '5' ]"

# ─── Test 7: empty JSONL → zeroed USAGE record (not error) ────────────────────
: > "$JSONL"
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING")
run "empty JSONL costUSD=0" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0' ]"
run "empty JSONL model=null" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .model)\" = 'null' ]"
run "empty JSONL inputTokens=0" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '0' ]"

# ─── Test 8: missing JSONL file → exit 1, no stdout ───────────────────────────
run "missing JSONL exits non-zero" \
  bash -c "! '$HELPER' --jsonl /no/such/file --pricing '$PRICING' 2>/dev/null"

# ─── Test 9: missing pricing file → exit 1 ────────────────────────────────────
run "missing pricing exits non-zero" \
  bash -c "! '$HELPER' --jsonl '$JSONL' --pricing /no/such/pricing 2>/dev/null"

# ─── Test 10: unknown model → cost 0 for that model, tokens still counted ─────
build_jsonl_unknown_model "$JSONL" --model fictional-model-9 \
  --input 1000 --output 500
USAGE=$("$HELPER" --jsonl "$JSONL" --pricing "$PRICING" 2>/dev/null)
run "unknown model contributes 0 cost" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0' ]"
run "unknown model tokens still counted" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '1000' ]"

# ─── Test 11: real-world fixture → sane USAGE ─────────────────────────────────
# Synthesize a real-shape fixture rather than depending on a live JSONL path
# that may not exist when this test runs in CI. The real schema includes
# server_tool_use, iterations[], service_tier, etc.; the extractor must
# tolerate them.
FIXTURE="${SCRATCH}/real-shape.jsonl"
cat > "$FIXTURE" <<'EOF'
{"type":"agent-name","name":"main"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}
{"type":"assistant","message":{"model":"claude-opus-4-7","stop_reason":"tool_use","usage":{"input_tokens":5,"output_tokens":349,"cache_read_input_tokens":24482,"cache_creation_input_tokens":26173,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":26173},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","iterations":[]}}}
{"type":"assistant","message":{"model":"claude-opus-4-7","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":200,"cache_read_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":50,"ephemeral_1h_input_tokens":0}}}}
{"type":"system","subtype":"turn_duration","durationMs":1406556}
{"type":"system","subtype":"stop_hook_summary"}
EOF
USAGE=$("$HELPER" --jsonl "$FIXTURE" --pricing "$PRICING")
run "real fixture has positive cost" \
  bash -c "[ \"\$(echo '$USAGE' | jq '.costUSD > 0')\" = 'true' ]"
run "real fixture inputTokens summed" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '15' ]"
run "real fixture outputTokens summed" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .outputTokens)\" = '549' ]"
run "real fixture cacheReadTokens summed" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .cacheReadTokens)\" = '24582' ]"
run "real fixture cacheCreationTokens (5m + 1h)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .cacheCreationTokens)\" = '26223' ]"
run "real fixture model is opus" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .model)\" = 'claude-opus-4-7' ]"
run "real fixture durationMs from turn_duration" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .durationMs)\" = '1406556' ]"
run "real fixture numTurns counts only assistant" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .numTurns)\" = '2' ]"

# ─── Test 12: default path ignores sub-agents (signal.cost contract guard) ────
# A parent JSONL plus a sub-agent file with extra usage; WITHOUT the flag the
# sub-agent file must be invisible, so existing callers (orchestrate-roll-usage,
# which feeds signal.cost) keep byte-identical parent-only semantics.
SA_REGR="${SCRATCH}/sa-default/parent.jsonl"
mkdir -p "$(dirname "$SA_REGR")"
build_jsonl_single_model "$SA_REGR" --model claude-opus-4-7 --assistant-events 1 \
  --input-tokens 1000 --output-tokens 500
build_subagent_jsonl "$SA_REGR" x --model claude-opus-4-7 --assistant-events 1 \
  --input-tokens 4000 --output-tokens 2000
USAGE=$("$HELPER" --jsonl "$SA_REGR" --pricing "$PRICING")
run "default path ignores sub-agent file (inputTokens parent-only)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '1000' ]"
run "default path ignores sub-agent file (numTurns parent-only)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .numTurns)\" = '1' ]"
# parent cost = 1000*15/1e6 + 500*75/1e6 = 0.015 + 0.0375 = 0.0525
run "default path ignores sub-agent file (costUSD parent-only)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0.0525' ]"

# ─── Test 13: --include-subagents sums parent + sub-agent ─────────────────────
USAGE=$("$HELPER" --jsonl "$SA_REGR" --pricing "$PRICING" --include-subagents)
# input = 1000+4000 = 5000, output = 500+2000 = 2500
# cost = 5000*15/1e6 + 2500*75/1e6 = 0.075 + 0.1875 = 0.2625
run "include-subagents sums inputTokens (parent+sub)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '5000' ]"
run "include-subagents sums outputTokens (parent+sub)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .outputTokens)\" = '2500' ]"
run "include-subagents sums costUSD (parent+sub)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .costUSD)\" = '0.2625' ]"
run "include-subagents numTurns is combined assistant count" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .numTurns)\" = '2' ]"

# ─── Test 14: multiple sub-agent files all summed ────────────────────────────
SA_MULTI="${SCRATCH}/sa-multi/parent.jsonl"
mkdir -p "$(dirname "$SA_MULTI")"
build_jsonl_single_model "$SA_MULTI" --assistant-events 1 --input-tokens 1000 --output-tokens 0
build_subagent_jsonl "$SA_MULTI" a --assistant-events 1 --input-tokens 2000 --output-tokens 0
build_subagent_jsonl "$SA_MULTI" b --assistant-events 1 --input-tokens 3000 --output-tokens 0
USAGE=$("$HELPER" --jsonl "$SA_MULTI" --pricing "$PRICING" --include-subagents)
run "multiple sub-agent files summed (inputTokens 1000+2000+3000)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '6000' ]"
run "multiple sub-agent files summed (numTurns = 3)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .numTurns)\" = '3' ]"

# ─── Test 15: no subagents/ dir present + flag → parent-only, exit 0 ──────────
SA_NONE="${SCRATCH}/sa-none/parent.jsonl"
mkdir -p "$(dirname "$SA_NONE")"
build_jsonl_single_model "$SA_NONE" --assistant-events 1 --input-tokens 1000 --output-tokens 0
USAGE=$("$HELPER" --jsonl "$SA_NONE" --pricing "$PRICING" --include-subagents)
run "no subagents dir + flag → parent-only inputTokens" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '1000' ]"
run "no subagents dir + flag exits 0" \
  bash -c "'$HELPER' --jsonl '$SA_NONE' --pricing '$PRICING' --include-subagents >/dev/null"

# ─── Test 16: partially-written sub-agent line tolerated ──────────────────────
SA_TRUNC="${SCRATCH}/sa-trunc/parent.jsonl"
mkdir -p "$(dirname "$SA_TRUNC")"
build_jsonl_single_model "$SA_TRUNC" --assistant-events 1 --input-tokens 1000 --output-tokens 0
build_subagent_jsonl "$SA_TRUNC" trunc --assistant-events 1 --input-tokens 2000 --output-tokens 0
# Append a truncated/non-JSON fragment as the last line (no trailing newline).
printf '%s' '{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_to' \
  >> "${SA_TRUNC%.jsonl}/subagents/agent-trunc.jsonl"
USAGE=$("$HELPER" --jsonl "$SA_TRUNC" --pricing "$PRICING" --include-subagents)
# valid lines: parent 1000 + sub-agent 2000 = 3000; the truncated line dropped
run "partial sub-agent line tolerated (valid lines still summed = 3000)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '3000' ]"
run "partial sub-agent line tolerated (exit 0, no parse abort)" \
  bash -c "'$HELPER' --jsonl '$SA_TRUNC' --pricing '$PRICING' --include-subagents >/dev/null"

# ─── Test 17: durationMs still comes from the parent ──────────────────────────
# Sub-agent JSONLs carry no system.turn_duration events; the flag must not
# change durationMs (research §3 — sub-agent files carry zero duration).
SA_DUR="${SCRATCH}/sa-dur/parent.jsonl"
mkdir -p "$(dirname "$SA_DUR")"
build_jsonl_with_durations "$SA_DUR" --turns 2 --total-ms 30000
build_subagent_jsonl "$SA_DUR" d --assistant-events 1 --input-tokens 500 --output-tokens 0
USAGE=$("$HELPER" --jsonl "$SA_DUR" --pricing "$PRICING" --include-subagents)
run "durationMs unchanged by flag (parent-only turn_duration = 30000)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .durationMs)\" = '30000' ]"
run "durationMs case still folds sub-agent tokens (inputTokens = 500)" \
  bash -c "[ \"\$(echo '$USAGE' | jq -r .inputTokens)\" = '500' ]"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
