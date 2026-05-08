#!/usr/bin/env bash
# Tests for emit-worker-status-change.sh (CTL-229).
#
# Covers severity classification (terminal vs info), coalesce-window batching
# of routine info events, immediate-emit semantics for terminal events with
# pending-queue flush, and PR enrichment for PR-bearing terminal transitions.
#
# Run: bash plugins/dev/scripts/__tests__/emit-worker-status-change.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMITTER="${REPO_ROOT}/plugins/dev/scripts/emit-worker-status-change.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Isolate catalyst dirs so tests don't touch the user's real state.
export CATALYST_DIR="${SCRATCH}/catalyst"
EVENTS_DIR="${CATALYST_DIR}/events"
# catalyst-state.sh writes to ${CATALYST_DIR}/events/YYYY-MM.jsonl; resolve once
# so tests can read the same path.
EVENTS_FILE="${EVENTS_DIR}/$(date -u +%Y-%m).jsonl"
mkdir -p "$EVENTS_DIR"
: > "$EVENTS_FILE"

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

reset_state() {
  rm -rf "$EVENTS_DIR" "${CATALYST_DIR}/coalesce"
  mkdir -p "$EVENTS_DIR"
  : > "$EVENTS_FILE"
}

build_signal() {
  # build a signal file with optional pr block
  local out="$1" ticket="$2" pr_number="${3:-}" pr_url="${4:-}"
  if [ -n "$pr_number" ]; then
    cat > "$out" <<EOF
{
  "ticket": "${ticket}",
  "status": "merging",
  "pr": {
    "number": ${pr_number},
    "url": "${pr_url}"
  }
}
EOF
  else
    cat > "$out" <<EOF
{
  "ticket": "${ticket}",
  "status": "implementing",
  "pr": null
}
EOF
  fi
}

count_events() {
  wc -l < "$EVENTS_FILE" | tr -d ' '
}

last_event() {
  tail -n 1 "$EVENTS_FILE"
}

echo "emit-worker-status-change tests"

# ── 1. classify subcommand ─────────────────────────────────────────────────
run "classify pr-created -> terminal" bash -c "
  out=\$('$EMITTER' classify pr-created)
  [ \"\$out\" = 'terminal' ]
"
run "classify merging -> terminal" bash -c "
  out=\$('$EMITTER' classify merging)
  [ \"\$out\" = 'terminal' ]
"
run "classify done -> terminal" bash -c "
  out=\$('$EMITTER' classify done)
  [ \"\$out\" = 'terminal' ]
"
run "classify failed -> terminal" bash -c "
  out=\$('$EMITTER' classify failed)
  [ \"\$out\" = 'terminal' ]
"
run "classify stalled -> terminal" bash -c "
  out=\$('$EMITTER' classify stalled)
  [ \"\$out\" = 'terminal' ]
"
run "classify deploy-failed -> terminal" bash -c "
  out=\$('$EMITTER' classify deploy-failed)
  [ \"\$out\" = 'terminal' ]
"
run "classify researching -> info" bash -c "
  out=\$('$EMITTER' classify researching)
  [ \"\$out\" = 'info' ]
"
run "classify planning -> info" bash -c "
  out=\$('$EMITTER' classify planning)
  [ \"\$out\" = 'info' ]
"
run "classify implementing -> info" bash -c "
  out=\$('$EMITTER' classify implementing)
  [ \"\$out\" = 'info' ]
"
run "classify validating -> info" bash -c "
  out=\$('$EMITTER' classify validating)
  [ \"\$out\" = 'info' ]
"
run "classify shipping -> info" bash -c "
  out=\$('$EMITTER' classify shipping)
  [ \"\$out\" = 'info' ]
"

# ── 2. Single info emit does NOT write to event log ────────────────────────
reset_state
"$EMITTER" emit --orch orch-a --ticket CTL-100 --from researching --to planning > /dev/null
run "single info emit writes 0 events" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '0' ]"
run "single info emit writes coalesce queue" bash -c "
  test -f '$CATALYST_DIR/coalesce/orch-a.json' && \
    jq -e '.changes | length == 1' '$CATALYST_DIR/coalesce/orch-a.json' >/dev/null
"

# ── 3. 5 info emits in window, then flush -> 1 coalesced event ─────────────
reset_state
for i in 1 2 3 4 5; do
  "$EMITTER" emit --orch orch-b --ticket "CTL-${i}00" --from researching --to planning --coalesce-window 60 > /dev/null
done
"$EMITTER" flush --orch orch-b > /dev/null
run "5 info emits + flush = 1 event in log" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ]"
run "coalesced event has 5 changes" bash -c "
  jq -e '.body.payload.changes | length == 5' '$EVENTS_FILE' >/dev/null
"
run "coalesced event has topic worker-phase-advanced" bash -c "
  jq -e '.attributes.\"event.name\" == \"orchestrator.worker.phase_advanced\"' '$EVENTS_FILE' >/dev/null
"
run "coalesced event has worker:null" bash -c "
  jq -e '(.attributes.\"catalyst.worker.ticket\" // null) == null' '$EVENTS_FILE' >/dev/null
"
run "coalesced event has orchestrator field" bash -c "
  jq -e '.attributes.\"catalyst.orchestrator.id\" == \"orch-b\"' '$EVENTS_FILE' >/dev/null
"
run "coalesced changes carry per-worker ids" bash -c "
  jq -e '[.body.payload.changes[].worker] == [\"CTL-100\",\"CTL-200\",\"CTL-300\",\"CTL-400\",\"CTL-500\"]' '$EVENTS_FILE' >/dev/null
"

# ── 4. Stale queue auto-flushed on next emit ───────────────────────────────
reset_state
"$EMITTER" emit --orch orch-c --ticket CTL-100 --from researching --to planning --coalesce-window 1 > /dev/null
sleep 2
"$EMITTER" emit --orch orch-c --ticket CTL-200 --from researching --to planning --coalesce-window 1 > /dev/null
run "stale queue flushed on next emit -> 1 event" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ]"
run "auto-flushed event has only 1 (stale) change" bash -c "
  jq -e '.body.payload.changes | length == 1' '$EVENTS_FILE' >/dev/null
"
run "auto-flushed change is the FIRST one" bash -c "
  jq -e '.body.payload.changes[0].worker == \"CTL-100\"' '$EVENTS_FILE' >/dev/null
"

# ── 5. Terminal during coalesce window flushes pending + emits terminal ────
reset_state
"$EMITTER" emit --orch orch-d --ticket CTL-100 --from researching --to planning --coalesce-window 60 > /dev/null
"$EMITTER" emit --orch orch-d --ticket CTL-200 --from planning --to implementing --coalesce-window 60 > /dev/null
"$EMITTER" emit --orch orch-d --ticket CTL-300 --from implementing --to merging --coalesce-window 60 > /dev/null
run "terminal during window -> 2 events (coalesced + terminal)" bash -c "
  [ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '2' ]
"
run "first event is coalesced phase-advanced with 2 changes" bash -c "
  head -n 1 '$EVENTS_FILE' | jq -e '.attributes.\"event.name\" == \"orchestrator.worker.phase_advanced\" and (.body.payload.changes | length == 2)' >/dev/null
"
run "second event is worker-status-terminal" bash -c "
  tail -n 1 '$EVENTS_FILE' | jq -e '.attributes.\"event.name\" == \"orchestrator.worker.status_terminal\"' >/dev/null
"
run "terminal event identifies worker CTL-300" bash -c "
  tail -n 1 '$EVENTS_FILE' | jq -e '.attributes.\"catalyst.worker.ticket\" == \"CTL-300\"' >/dev/null
"
run "terminal event has detail.from and detail.to" bash -c "
  tail -n 1 '$EVENTS_FILE' | jq -e '.body.payload.from == \"implementing\" and .body.payload.to == \"merging\"' >/dev/null
"

# ── 6. PR-bearing terminal with signal file -> .body.payload.pr populated ────────
reset_state
SIGNAL="${SCRATCH}/signal-pr.json"
build_signal "$SIGNAL" CTL-400 4242 "https://github.com/test/test/pull/4242"
"$EMITTER" emit --orch orch-e --ticket CTL-400 --from shipping --to pr-created --signal-file "$SIGNAL" > /dev/null
run "pr-created with signal -> 1 event" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ]"
run "pr-created event has .body.payload.pr.number" bash -c "
  jq -e '.body.payload.pr.number == 4242' '$EVENTS_FILE' >/dev/null
"
run "pr-created event has .body.payload.pr.url" bash -c "
  jq -e '.body.payload.pr.url == \"https://github.com/test/test/pull/4242\"' '$EVENTS_FILE' >/dev/null
"

# ── 7. PR-bearing terminal WITHOUT signal file -> .body.payload.pr omitted, no error
reset_state
"$EMITTER" emit --orch orch-f --ticket CTL-500 --from shipping --to merging > "${SCRATCH}/out" 2>&1
RC=$?
run "merging without signal returns 0" bash -c "[ '$RC' = '0' ]"
run "merging without signal -> .body.payload.pr absent" bash -c "
  jq -e '.detail | (.pr // null) == null' '$EVENTS_FILE' >/dev/null
"

# ── 8. Non-PR terminal (failed/stalled) -> .body.payload.pr omitted ──────────────
reset_state
SIGNAL="${SCRATCH}/signal-pr.json"
build_signal "$SIGNAL" CTL-600 5050 "https://github.com/test/test/pull/5050"
"$EMITTER" emit --orch orch-g --ticket CTL-600 --from implementing --to failed --signal-file "$SIGNAL" > /dev/null
run "failed -> 1 event" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ]"
run "failed -> .body.payload.pr absent (even with signal carrying pr)" bash -c "
  jq -e '.detail | (.pr // null) == null' '$EVENTS_FILE' >/dev/null
"

reset_state
"$EMITTER" emit --orch orch-h --ticket CTL-700 --from validating --to stalled --signal-file "$SIGNAL" > /dev/null
run "stalled -> .body.payload.pr absent" bash -c "
  jq -e '.detail | (.pr // null) == null' '$EVENTS_FILE' >/dev/null
"

# ── 9. Explicit flush with empty queue is no-op ────────────────────────────
reset_state
"$EMITTER" flush --orch orch-i > /dev/null
run "flush of empty/missing queue writes 0 events" bash -c "
  [ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '0' ]
"

# ── 10. Explicit flush with non-empty queue emits + clears queue ───────────
reset_state
"$EMITTER" emit --orch orch-j --ticket CTL-800 --from researching --to planning > /dev/null
"$EMITTER" emit --orch orch-j --ticket CTL-900 --from planning --to implementing > /dev/null
"$EMITTER" flush --orch orch-j > /dev/null
run "flush -> 1 event" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ]"
run "flush -> 2 changes in coalesced event" bash -c "
  jq -e '.body.payload.changes | length == 2' '$EVENTS_FILE' >/dev/null
"
"$EMITTER" flush --orch orch-j > /dev/null
run "second flush is no-op (queue cleared)" bash -c "[ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ]"

# ── 11. coalesced event respects --coalesce-window flag (recorded in detail)
reset_state
"$EMITTER" emit --orch orch-k --ticket CTL-1000 --from researching --to planning --coalesce-window 120 > /dev/null
"$EMITTER" flush --orch orch-k > /dev/null
run "coalesced event records windowSec from --coalesce-window" bash -c "
  jq -e '.body.payload.windowSec == 120' '$EVENTS_FILE' >/dev/null
"

# ── 12. Different orchestrators have independent queues ────────────────────
reset_state
"$EMITTER" emit --orch orch-l --ticket CTL-1100 --from researching --to planning > /dev/null
"$EMITTER" emit --orch orch-m --ticket CTL-1200 --from researching --to planning > /dev/null
"$EMITTER" flush --orch orch-l > /dev/null
run "flushing orch-l does not flush orch-m" bash -c "
  [ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '1' ] && \
    test -f '$CATALYST_DIR/coalesce/orch-m.json'
"
"$EMITTER" flush --orch orch-m > /dev/null
run "flushing orch-m emits second independent event" bash -c "
  [ \"\$(wc -l < '$EVENTS_FILE' | tr -d ' ')\" = '2' ]
"

# ── 13. PR-bearing 'done' terminal pulls pr from signal ────────────────────
reset_state
SIGNAL="${SCRATCH}/signal-done.json"
build_signal "$SIGNAL" CTL-1300 6060 "https://github.com/test/test/pull/6060"
"$EMITTER" emit --orch orch-n --ticket CTL-1300 --from merging --to done --signal-file "$SIGNAL" > /dev/null
run "done with signal -> .body.payload.pr populated" bash -c "
  jq -e '.body.payload.pr.number == 6060 and .body.payload.pr.url == \"https://github.com/test/test/pull/6060\"' '$EVENTS_FILE' >/dev/null
"

# ── 14. CATALYST_COALESCE_WINDOW_SEC env var honored ───────────────────────
reset_state
CATALYST_COALESCE_WINDOW_SEC=99 "$EMITTER" emit --orch orch-o --ticket CTL-1400 --from researching --to planning > /dev/null
"$EMITTER" flush --orch orch-o > /dev/null
run "env var CATALYST_COALESCE_WINDOW_SEC respected" bash -c "
  jq -e '.body.payload.windowSec == 99' '$EVENTS_FILE' >/dev/null
"

# ── 15. emit returns nonzero on missing required args ──────────────────────
"$EMITTER" emit --orch orch-x --ticket CTL-X --from a > "${SCRATCH}/out" 2>&1
RC=$?
run "emit without --to returns nonzero" bash -c "[ '$RC' != '0' ]"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" = "0" ]
