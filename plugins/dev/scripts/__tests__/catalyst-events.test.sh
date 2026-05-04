#!/usr/bin/env bash
# Shell tests for catalyst-events.
# Run: bash plugins/dev/scripts/__tests__/catalyst-events.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EVENTS="${REPO_ROOT}/plugins/dev/scripts/catalyst-events"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
export CATALYST_DIR="$SCRATCH"
export CATALYST_EVENTS_DIR="$SCRATCH/events"
EVENTS_FILE="$CATALYST_EVENTS_DIR/$(date -u +%Y-%m).jsonl"
trap 'rm -rf "$SCRATCH"' EXIT

mkdir -p "$CATALYST_EVENTS_DIR"

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

expect_exit() {
  local expected="$1"; shift
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  if [ "$rc" = "$expected" ]; then
    return 0
  else
    echo "    expected rc=$expected got rc=$rc"
    sed 's/^/    /' "${SCRATCH}/out"
    return 1
  fi
}

reset_events() {
  rm -rf "$CATALYST_EVENTS_DIR"
  mkdir -p "$CATALYST_EVENTS_DIR"
  : > "$EVENTS_FILE"
}

write_event() {
  echo "$1" >> "$EVENTS_FILE"
}

echo "catalyst-events tests"

# ── 1. help exits 0 ─────────────────────────────────────────────────────────
run "help exits 0 and prints usage" bash -c "
  out=\$($EVENTS help 2>&1)
  echo \"\$out\" | grep -q 'tail and wait-for'
"

# ── 2. unknown subcommand exits 2 ───────────────────────────────────────────
run "unknown subcommand exits 2" expect_exit 2 "$EVENTS" bogus-cmd

# ── 3. wait-for usage error on non-numeric timeout ──────────────────────────
run "wait-for non-numeric --timeout exits 2" expect_exit 2 "$EVENTS" wait-for --timeout banana

# ── 4. wait-for times out cleanly when no event arrives ─────────────────────
reset_events
run "wait-for times out with exit 1" expect_exit 1 "$EVENTS" wait-for --timeout 2

# ── 5. wait-for blocks then unblocks on matching line ───────────────────────
reset_events
(
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:00Z","event":"worker-status-terminal","worker":"X","detail":null}'
) &
EMITTER_PID=$!

START=$(date +%s)
OUT=$("$EVENTS" wait-for --timeout 5 --filter '.event == "worker-status-terminal"')
RC=$?
END=$(date +%s)
ELAPSED=$((END - START))

wait "$EMITTER_PID" 2>/dev/null || true

run "wait-for exits 0 when match arrives" bash -c "[ '$RC' = '0' ]"
run "wait-for prints the matching line" bash -c "
  echo '$OUT' | grep -q 'worker-status-terminal'
"
run "wait-for completes in <5s when event arrives early" bash -c "[ '$ELAPSED' -lt 5 ]"

# ── 6. wait-for filter excludes non-matching lines ──────────────────────────
reset_events
(
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:01Z","event":"heartbeat","detail":null}'
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:02Z","event":"target-event","detail":null}'
) &
EMITTER_PID=$!

OUT=$("$EVENTS" wait-for --timeout 8 --filter '.event == "target-event"')
RC=$?
wait "$EMITTER_PID" 2>/dev/null || true

run "wait-for skips non-matching lines and returns the target" bash -c "
  [ '$RC' = '0' ] && echo '$OUT' | grep -q 'target-event' && ! echo '$OUT' | grep -q 'heartbeat'
"

# ── 7. wait-for handles v2 envelope (with .source / .scope) ─────────────────
reset_events
(
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:00Z","id":"evt_x","schemaVersion":2,"source":"github.webhook","event":"github.pr.merged","scope":{"repo":"a/b","pr":42},"detail":{},"orchestrator":null,"worker":null}'
) &
EMITTER_PID=$!

OUT=$("$EVENTS" wait-for --timeout 5 --filter '.event == "github.pr.merged" and .scope.pr == 42')
RC=$?
wait "$EMITTER_PID" 2>/dev/null || true

run "wait-for matches v2 envelope by .scope.pr" bash -c "
  [ '$RC' = '0' ] && echo '$OUT' | grep -q 'github.pr.merged'
"

# ── 8. wait-for ignores HISTORICAL lines (seek to EOF) ──────────────────────
reset_events
write_event '{"ts":"2026-05-03T00:00:00Z","event":"historical-event","detail":null}'
sleep 0.5  # ensure historical line exists before wait-for opens

# wait-for should NOT match the historical line — it should time out (rc=1).
run "wait-for seeks to EOF and ignores historical lines" \
  expect_exit 1 "$EVENTS" wait-for --timeout 2 --filter '.event == "historical-event"'

# ── 9. wait-for survives missing events file (file appears later) ───────────
reset_events
rm -f "$EVENTS_FILE"
(
  sleep 1
  mkdir -p "$(dirname "$EVENTS_FILE")"
  echo '{"ts":"2026-05-03T00:00:00Z","event":"appeared","detail":null}' > "$EVENTS_FILE"
) &
EMITTER_PID=$!

OUT=$("$EVENTS" wait-for --timeout 5 --filter '.event == "appeared"')
RC=$?
wait "$EMITTER_PID" 2>/dev/null || true

run "wait-for handles file appearing after start" bash -c "
  [ '$RC' = '0' ] && echo '$OUT' | grep -q 'appeared'
"

# ── 10. tail emits new lines (run with timeout, kill cleanly) ───────────────
reset_events
(
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:00Z","event":"new-line-1","detail":null}'
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:01Z","event":"new-line-2","detail":null}'
  sleep 1
) &

# Capture tail output for a few seconds, then kill.
TAIL_OUT=$(timeout 4 "$EVENTS" tail --filter '.event | startswith("new-line")' 2>/dev/null || true)

run "tail emits matching new lines" bash -c "
  echo '$TAIL_OUT' | grep -q 'new-line-1' && echo '$TAIL_OUT' | grep -q 'new-line-2'
"

# ── 11. tail does NOT emit historical lines ─────────────────────────────────
reset_events
write_event '{"ts":"2026-05-03T00:00:00Z","event":"old-line","detail":null}'
write_event '{"ts":"2026-05-03T00:00:01Z","event":"older-line","detail":null}'
sleep 0.5

(
  sleep 1
  write_event '{"ts":"2026-05-03T00:00:02Z","event":"new-line","detail":null}'
  sleep 1
) &

# Filter passes any event that starts with "old", "older", or "new" — wrap each
# `.event | startswith()` in parens so jq parses precedence correctly.
TAIL_OUT=$(timeout 4 "$EVENTS" tail --filter '(.event | startswith("o")) or (.event | startswith("n"))' 2>/dev/null || true)

run "tail seeks to EOF, ignoring historical lines" bash -c "
  echo '$TAIL_OUT' | grep -q 'new-line' && ! echo '$TAIL_OUT' | grep -q 'old-line'
"

# ── 12. tail with --since-line emits backlog from N onward ──────────────────
reset_events
write_event '{"ts":"2026-05-03T00:00:00Z","event":"line-1","detail":null}'
write_event '{"ts":"2026-05-03T00:00:01Z","event":"line-2","detail":null}'
write_event '{"ts":"2026-05-03T00:00:02Z","event":"line-3","detail":null}'

# Tail with --since-line 1 should emit lines 2 and 3 (and then keep watching).
TAIL_OUT=$(timeout 2 "$EVENTS" tail --since-line 1 2>/dev/null || true)

run "tail --since-line 1 emits backlog from line 2 onward" bash -c "
  ! echo '$TAIL_OUT' | grep -q 'line-1' && echo '$TAIL_OUT' | grep -q 'line-2' && echo '$TAIL_OUT' | grep -q 'line-3'
"

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
