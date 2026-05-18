#!/usr/bin/env bash
# extract-cost-from-jsonl.sh — Compute a USAGE record from a Claude bg-session
# conversation JSONL (CTL-496).
#
# In `phase-agents` dispatch mode workers run as `claude --bg` sessions. The
# Claude CLI does not emit a stream-json `result` event for these sessions
# (no --output-format flag), so orchestrate-roll-usage.sh has no `result`
# event to parse. Instead, the CLI writes a conversation JSONL to
# ~/.claude/projects/<wt>/<sessionId>.jsonl containing one assistant event
# per turn with the model's `usage` block.
#
# This script aggregates `message.usage` across all assistant events,
# splits cache_creation by 5m/1h TTL, applies per-model pricing from
# claude-pricing.json, and emits a single USAGE object on stdout matching
# the schema in orchestrate-roll-usage.sh:88–104.
#
# Exits 0 on success (even for empty JSONL — emits a zeroed record).
# Exits 1 on missing/unreadable JSONL or pricing files.
# Exits 2 on invalid invocation.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: extract-cost-from-jsonl.sh --jsonl <path> --pricing <path>

required:
  --jsonl <path>     Claude conversation JSONL (~/.claude/projects/.../<sid>.jsonl)
  --pricing <path>   pricing table JSON (see plugins/dev/scripts/claude-pricing.json)

Emits a USAGE record on stdout matching the orchestrate-roll-usage.sh schema:
  { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    costUSD, numTurns, durationMs, durationApiMs, model }

Unknown models are kept in the token sums but priced at zero (one stderr
warning per unknown model).
EOF
  exit 2
}

JSONL="" PRICING=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jsonl)   JSONL="$2";   shift 2 ;;
    --pricing) PRICING="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$JSONL" ]   || usage
[ -n "$PRICING" ] || usage
[ -f "$JSONL" ]   || { echo "jsonl not found: $JSONL"     >&2; exit 1; }
[ -f "$PRICING" ] || { echo "pricing not found: $PRICING" >&2; exit 1; }

# Single jq pass: slurps the JSONL into an array, slurps pricing as a side
# input, computes per-model token bucket → per-model cost → aggregate USAGE.
# The reduce-over-assistant-events is the hot path; everything else is a
# constant-time post-pass.
jq -s --slurpfile pricing "$PRICING" '
  ($pricing[0].models) as $p
  # Per-model token bucket
  | ([.[] | select(.type == "assistant" and .message.usage != null)]
     | reduce .[] as $e ({};
         .[$e.message.model] //= {
           input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0
         }
         | .[$e.message.model].input         += ($e.message.usage.input_tokens // 0)
         | .[$e.message.model].output        += ($e.message.usage.output_tokens // 0)
         | .[$e.message.model].cacheRead     += ($e.message.usage.cache_read_input_tokens // 0)
         | .[$e.message.model].cacheCreate5m += ($e.message.usage.cache_creation.ephemeral_5m_input_tokens // 0)
         | .[$e.message.model].cacheCreate1h += ($e.message.usage.cache_creation.ephemeral_1h_input_tokens // 0)
       )) as $bymodel
  # Per-model cost using pricing table
  | ($bymodel | to_entries | map(
      . as $m
      | ($p[$m.key] // {
          inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0,
          cacheCreation5mPerMillion: 0, cacheCreation1hPerMillion: 0
        }) as $rate
      | ($m.value.input         * $rate.inputPerMillion             / 1000000) as $ci
      | ($m.value.output        * $rate.outputPerMillion            / 1000000) as $co
      | ($m.value.cacheRead     * $rate.cacheReadPerMillion         / 1000000) as $cr
      | ($m.value.cacheCreate5m * $rate.cacheCreation5mPerMillion   / 1000000) as $cc5
      | ($m.value.cacheCreate1h * $rate.cacheCreation1hPerMillion   / 1000000) as $cc1
      | {model: $m.key,
         costUSD: ($ci + $co + $cr + $cc5 + $cc1),
         input: $m.value.input, output: $m.value.output,
         cacheRead: $m.value.cacheRead,
         cacheCreate: ($m.value.cacheCreate5m + $m.value.cacheCreate1h)}
    )) as $costs
  # Primary model = the model with the largest cost contribution.
  | ($costs | sort_by(-.costUSD) | first) as $primary
  | {
      inputTokens:         ($costs | map(.input)       | add // 0),
      outputTokens:        ($costs | map(.output)      | add // 0),
      cacheReadTokens:     ($costs | map(.cacheRead)   | add // 0),
      cacheCreationTokens: ($costs | map(.cacheCreate) | add // 0),
      costUSD:             (($costs | map(.costUSD)    | add // 0) | . * 1000000 | round / 1000000),
      numTurns:            ([.[] | select(.type == "assistant")] | length),
      durationMs:          ([.[] | select(.type == "system" and .subtype == "turn_duration") | .durationMs // 0] | add // 0),
      durationApiMs:       0,
      model:               ($primary.model // null)
    }
' "$JSONL"
