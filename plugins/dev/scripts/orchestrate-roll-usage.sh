#!/usr/bin/env bash
# orchestrate-roll-usage.sh — Roll a worker's final usage/cost into orch state.
#
# Two modes, selected by the presence of --phase:
#
# (a) Legacy (no --phase) — for `oneshot-legacy` dispatch mode. Reads the
#     worker's stream-json output (workers/output/<T>-stream.jsonl), extracts
#     the final `result` event's usage/cost fields, and writes them to:
#       1. the worker's signal file              (.cost = USAGE)
#       2. state.json's per-worker entry         (.workers[ticket].usage = USAGE)
#       3. state.json's orchestrator-level total (.usage += USAGE)
#       4. session_metrics SQLite mirror via catalyst-session.sh metric
#
# (b) Phase (--phase <name>) — for `phase-agents` dispatch mode (CTL-496).
#     `claude --bg` workers do not write a stream-json result event (no
#     --output-format flag), so we source USAGE from the conversation JSONL
#     that the Claude CLI writes to ~/.claude/projects/<wt>/<sid>.jsonl
#     instead. The path is resolved via:
#       <jobsDir>/<bg_job_id>/state.json -> .linkScanPath
#     where <jobsDir> defaults to $HOME/.claude/jobs (overridable via
#     CATALYST_BG_JOBS_DIR for tests). The USAGE record is computed by
#     extract-cost-from-jsonl.sh against the resolved JSONL.
#
#     The four downstream writes are reused unchanged — only the USAGE
#     source differs. One per-phase signal lives at
#     ${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json. The per-worker
#     state.workers[ticket].usage aggregates across phases (+= not =) so
#     state.workers[T].usage.costUSD == sum(phase.cost.costUSD) for that
#     ticket.
#
# Idempotent in both modes: signal.cost being non-null is the marker that
# this signal has already been rolled. Safe to invoke per worker per phase
# per monitor cycle — does work exactly once per signal, when its
# upstream source first becomes available.
#
# No-op (exits 0) when:
#   - signal file missing                            (signal-missing)
#   - [legacy] stream file missing                   (stream-missing)
#   - [legacy] stream has no `result` event yet      (no-result-yet)
#   - [phase]  bg state.json missing                 (bg-state-missing)
#   - [phase]  resolved JSONL missing                (jsonl-missing)
#   - [phase]  extract returned zero cost (still running, retry next sweep)
#                                                    (zero-cost-retry)
#   - signal.cost already populated                  (already-rolled)
#
# Exits non-zero only on truly broken input (missing required args).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_SCRIPT="${SCRIPT_DIR}/catalyst-state.sh"
EXTRACTOR="${SCRIPT_DIR}/extract-cost-from-jsonl.sh"
PRICING="${SCRIPT_DIR}/claude-pricing.json"

usage() {
  cat >&2 <<'EOF'
usage: orchestrate-roll-usage.sh --orch <id> --ticket <id>
                                 [--phase <name>] [--orch-dir <dir>] [-v]

required:
  --orch <id>        orchestrator id (e.g. o-ctl-115-116)
  --ticket <id>      worker ticket id (e.g. CTL-115)

optional:
  --phase <name>     activate phase-agent mode (CTL-496). Reads per-phase
                     signal at <orch-dir>/workers/<ticket>/phase-<name>.json
                     and sources USAGE from the bg session JSONL via
                     extract-cost-from-jsonl.sh. state.workers[ticket].usage
                     aggregates across phases (+= not =).
  --orch-dir <dir>   override default ~/catalyst/runs/<orch>/
  -v, --verbose      log one-line action codes to stderr (CTL-233):
                       legacy:  wrote-cost, already-rolled, signal-missing,
                                stream-missing, no-result-yet, extract-failed,
                                wrote-metric, metric-skipped, metric-write-failed
                       phase:   wrote-cost, already-rolled, signal-missing,
                                bg-state-missing, jsonl-missing, zero-cost-retry,
                                extract-failed, wrote-metric, metric-skipped,
                                metric-write-failed

env:
  CATALYST_BG_JOBS_DIR   override <jobsDir> base for phase mode (default
                         $HOME/.claude/jobs).
  CATALYST_DB_FILE       override SQLite db path (default ~/catalyst/catalyst.db).

Idempotent: no-op when signal.cost is already populated. Safe to invoke
per worker per (phase) per monitor cycle.
EOF
  exit 2
}

ORCH_ID="" TICKET_ID="" ORCH_DIR="" VERBOSE=0 PHASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --orch)        ORCH_ID="$2"; shift 2 ;;
    --ticket)      TICKET_ID="$2"; shift 2 ;;
    --orch-dir)    ORCH_DIR="$2"; shift 2 ;;
    --phase)       PHASE="$2"; shift 2 ;;
    -v|--verbose)  VERBOSE=1; shift ;;
    -h|--help)     usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$ORCH_ID" ]   || usage
[ -n "$TICKET_ID" ] || usage
[ -n "$ORCH_DIR" ]  || ORCH_DIR="${HOME}/catalyst/runs/${ORCH_ID}"

# Silent by default — orchestrator scan calls per worker per cycle and we don't
# want to spam stdout. With -v, emit one action code per invocation so the
# orchestrator can capture stderr to a per-orch audit file (CTL-233).
log_action() {
  [ "$VERBOSE" = "1" ] || return 0
  if [ -n "$PHASE" ]; then
    echo "roll-usage[ticket=${TICKET_ID},phase=${PHASE}]: $1" >&2
  else
    echo "roll-usage[ticket=${TICKET_ID}]: $1" >&2
  fi
}

# ─── Resolve signal + USAGE source ────────────────────────────────────────────

if [ -n "$PHASE" ]; then
  SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET_ID}/phase-${PHASE}.json"
else
  SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET_ID}.json"
  STREAM_FILE="${ORCH_DIR}/workers/output/${TICKET_ID}-stream.jsonl"
fi

# Common no-op gates.
[ -f "$SIGNAL_FILE" ] || { log_action "signal-missing"; exit 0; }
EXISTING=$(jq -r '.cost // "null"' "$SIGNAL_FILE")
[ "$EXISTING" = "null" ] || { log_action "already-rolled"; exit 0; }

USAGE=""
if [ -n "$PHASE" ]; then
  # Phase mode: resolve bg state.json -> linkScanPath -> JSONL -> extractor.
  BG_JOB_ID=$(jq -r '.bg_job_id // empty' "$SIGNAL_FILE")
  [ -n "$BG_JOB_ID" ] || { log_action "bg-state-missing"; exit 0; }

  BG_JOBS_DIR="${CATALYST_BG_JOBS_DIR:-${HOME}/.claude/jobs}"
  BG_STATE="${BG_JOBS_DIR}/${BG_JOB_ID}/state.json"
  [ -f "$BG_STATE" ] || { log_action "bg-state-missing"; exit 0; }

  JSONL=$(jq -r '.linkScanPath // empty' "$BG_STATE")
  [ -n "$JSONL" ] && [ -f "$JSONL" ] || { log_action "jsonl-missing"; exit 0; }

  [ -x "$EXTRACTOR" ] && [ -f "$PRICING" ] \
    || { log_action "extract-failed"; exit 0; }

  USAGE=$("$EXTRACTOR" --jsonl "$JSONL" --pricing "$PRICING" 2>/dev/null || echo "")
  [ -n "$USAGE" ] || { log_action "extract-failed"; exit 0; }

  # Zero-cost guard: an empty / not-yet-flushed JSONL legitimately produces a
  # zeroed USAGE record. Don't poison signal.cost with zeros — next sweep can
  # retry. (For a truly costless phase like phase-monitor-deploy, the signal
  # never reaches this script in the first place because no catalyst-session
  # was started.)
  COSTUSD=$(echo "$USAGE" | jq -r '.costUSD')
  if [ "$COSTUSD" = "0" ] || [ "$COSTUSD" = "0.0" ]; then
    log_action "zero-cost-retry"; exit 0
  fi
else
  # Legacy mode: extract the final result event from the stream.
  [ -f "$STREAM_FILE" ] || { log_action "stream-missing"; exit 0; }

  RESULT_LINE=$(grep '"type":"result"' "$STREAM_FILE" | tail -1 || true)
  [ -n "$RESULT_LINE" ] || { log_action "no-result-yet"; exit 0; }

  # Defensive on `.modelUsage`: older Claude CLI versions or error-during-execution
  # results may omit it. `null | keys[0]` errors with "null has no keys", so coalesce
  # to {} first.
  USAGE=$(echo "$RESULT_LINE" | jq -c '{
    inputTokens:         (.usage.input_tokens // 0),
    outputTokens:        (.usage.output_tokens // 0),
    cacheReadTokens:     (.usage.cache_read_input_tokens // 0),
    cacheCreationTokens: (.usage.cache_creation_input_tokens // 0),
    costUSD:             (.total_cost_usd // 0),
    numTurns:            (.num_turns // 0),
    durationMs:          (.duration_ms // 0),
    durationApiMs:       (.duration_api_ms // 0),
    model:               ((.modelUsage // {}) | keys[0] // null)
  }' 2>/dev/null || echo 'null')

  [ "$USAGE" != "null" ] || { log_action "extract-failed"; exit 0; }
fi

# ─── Common writes ────────────────────────────────────────────────────────────

# 1. Mirror to signal file (atomic tmp+rename). Dashboard reads signal files,
#    not state.json, for per-worker cost columns.
jq --argjson cost "$USAGE" '.cost = $cost' "$SIGNAL_FILE" \
  > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"

# 2. Per-worker entry in global state. Legacy mode overwrites (one worker per
#    ticket per run). Phase mode aggregates so state.workers[T].usage is the
#    sum across all this ticket's phases.
if [ -n "$PHASE" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    '.usage.inputTokens         = ((.usage.inputTokens // 0)         + $u.inputTokens)
     | .usage.outputTokens        = ((.usage.outputTokens // 0)        + $u.outputTokens)
     | .usage.cacheReadTokens     = ((.usage.cacheReadTokens // 0)     + $u.cacheReadTokens)
     | .usage.cacheCreationTokens = ((.usage.cacheCreationTokens // 0) + $u.cacheCreationTokens)
     | .usage.costUSD             = ((.usage.costUSD // 0)             + $u.costUSD)
     | .usage.numTurns            = ((.usage.numTurns // 0)            + $u.numTurns)
     | .usage.durationMs          = ((.usage.durationMs // 0)          + $u.durationMs)
     | .usage.durationApiMs       = ((.usage.durationApiMs // 0)       + ($u.durationApiMs // 0))
     | .usage.model               = $u.model' \
    --argjson u "$USAGE" >/dev/null
else
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    '.usage = $u' --argjson u "$USAGE" >/dev/null
fi

# 3. Orchestrator-level aggregate.
"$STATE_SCRIPT" update "$ORCH_ID" \
  '.usage.inputTokens         += $u.inputTokens
   | .usage.outputTokens        += $u.outputTokens
   | .usage.cacheReadTokens     += $u.cacheReadTokens
   | .usage.cacheCreationTokens += $u.cacheCreationTokens
   | .usage.costUSD             += $u.costUSD
   | .usage.numTurns            += $u.numTurns
   | .usage.durationMs          += $u.durationMs
   | .usage.durationApiMs       += ($u.durationApiMs // 0)' \
  --argjson u "$USAGE" >/dev/null

log_action "wrote-cost"

# 4. Mirror cost/tokens/duration into session_metrics via catalyst-session.sh,
#    so `catalyst-session history|stats|compare` see the real values instead
#    of zeros (CTL-455). Idempotency: gated by the `signal.cost != null` check
#    at the top of this script, so this block only runs on the same invocation
#    that writes signal.cost.
SESSION_SH="${SCRIPT_DIR}/catalyst-session.sh"
CATALYST_SID="$(jq -r '.catalystSessionId // ""' "$SIGNAL_FILE")"

if [ -z "$CATALYST_SID" ]; then
  # DB fallback: most-recent session for this ticket. In phase mode also
  # filter by skill_name so phase-X cost only mirrors into the phase-X
  # session_metrics row.
  CATALYST_DB="${CATALYST_DB_FILE:-${HOME}/catalyst/catalyst.db}"
  if [ -f "$CATALYST_DB" ]; then
    if [ -n "$PHASE" ]; then
      CATALYST_SID=$(sqlite3 "$CATALYST_DB" \
        "SELECT session_id FROM sessions
         WHERE ticket_key = '${TICKET_ID//\'/\'\'}'
           AND skill_name = 'phase-${PHASE//\'/\'\'}'
         ORDER BY started_at DESC LIMIT 1;" 2>/dev/null || true)
    else
      CATALYST_SID=$(sqlite3 "$CATALYST_DB" \
        "SELECT session_id FROM sessions
         WHERE ticket_key = '${TICKET_ID//\'/\'\'}'
         ORDER BY started_at DESC LIMIT 1;" 2>/dev/null || true)
    fi
  fi
fi

if [ -n "$CATALYST_SID" ] && [ -x "$SESSION_SH" ]; then
  COST=$(echo "$USAGE" | jq -r '.costUSD')
  ITOK=$(echo "$USAGE" | jq -r '.inputTokens')
  OTOK=$(echo "$USAGE" | jq -r '.outputTokens')
  CRD=$( echo "$USAGE" | jq -r '.cacheReadTokens')
  CCR=$( echo "$USAGE" | jq -r '.cacheCreationTokens')
  DUR=$( echo "$USAGE" | jq -r '.durationMs')
  if "$SESSION_SH" metric "$CATALYST_SID" \
       --cost "$COST" --input "$ITOK" --output "$OTOK" \
       --cache-read "$CRD" --cache-creation "$CCR" --duration-ms "$DUR" \
       >/dev/null 2>&1; then
    log_action "wrote-metric"
  else
    log_action "metric-write-failed"
  fi
else
  log_action "metric-skipped"
fi
