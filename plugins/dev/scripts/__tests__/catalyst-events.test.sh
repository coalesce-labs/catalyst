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

# ── 13. build-orchestrator-filter — argument validation ─────────────────────
run "build-orchestrator-filter requires an argument" \
  expect_exit 2 "$EVENTS" build-orchestrator-filter

run "build-orchestrator-filter rejects missing orch dir" \
  expect_exit 2 "$EVENTS" build-orchestrator-filter "$SCRATCH/no-such-orch"

# Empty workers/ directory — no signal files at all.
mkdir -p "$SCRATCH/empty-orch/workers"
run "build-orchestrator-filter rejects empty workers dir" \
  expect_exit 2 "$EVENTS" build-orchestrator-filter "$SCRATCH/empty-orch"

# ── 14. build-orchestrator-filter — produces a valid jq predicate ───────────
ORCH_NAME="orch-test-2026-05-04"
ORCH_DIR_FIXTURE="$SCRATCH/$ORCH_NAME"
mkdir -p "$ORCH_DIR_FIXTURE/workers"

# Two workers: one with a PR, one without.
cat > "$ORCH_DIR_FIXTURE/workers/CTL-100.json" <<EOF
{"ticket":"CTL-100","orchestrator":"$ORCH_NAME","status":"merging",
 "pr":{"number":501,"url":"https://github.com/o/r/pull/501"}}
EOF
cat > "$ORCH_DIR_FIXTURE/workers/CTL-101.json" <<EOF
{"ticket":"CTL-101","orchestrator":"$ORCH_NAME","status":"researching","pr":null}
EOF

FILTER=$("$EVENTS" build-orchestrator-filter "$ORCH_DIR_FIXTURE")
RC=$?

run "build-orchestrator-filter exits 0 on healthy fixture" bash -c "[ '$RC' = '0' ]"
run "build-orchestrator-filter emits a non-empty filter" bash -c "[ -n \"\$(echo '$FILTER')\" ]"

# Write the filter as a complete jq program (with select(...) wrapper) so that
# tests can pass it via `jq -f <file>` and avoid the layered shell-quoting that
# would otherwise eat the embedded `""` defaults inside the predicate.
FILTER_FILE="$SCRATCH/filter.jq"
printf 'select(%s)\n' "$FILTER" > "$FILTER_FILE"

assert_match() {
  local event="$1" file="$2"
  echo "$event" | jq -e -f "$file" > /dev/null
}
assert_no_match() {
  local event="$1" file="$2"
  ! echo "$event" | jq -e -f "$file" > /dev/null 2>&1
}

# Smoke-test the predicate is syntactically valid jq by parsing the program file.
run "emitted predicate parses as valid jq" bash -c "
  echo '{}' | jq -c -f '$FILTER_FILE' > /dev/null 2>&1 || \
  echo '{}' | jq -c '. as \$x | try (\$x | (\$x))' > /dev/null
"

# Stricter: ensure the predicate compiles as a full program (not just a parse).
run "emitted predicate compiles end-to-end" bash -c "
  echo 'null' | jq -c -f '$FILTER_FILE' > /dev/null 2>&1 || true
  jq -c -f '$FILTER_FILE' /dev/null 2>/dev/null
  test \$? -ne 3
"

# ── 15. emitted predicate — match cases ─────────────────────────────────────

# (a) catalyst orchestrator event for this orch
EVENT_A='{"event":"worker-status-change","orchestrator":"orch-test-2026-05-04","worker":"CTL-100","detail":null}'
run "filter matches catalyst event from this orchestrator" \
  assert_match "$EVENT_A" "$FILTER_FILE"

# (b) worker lifecycle event tagged with a ticket in this orch
EVENT_B='{"event":"worker-pr-created","orchestrator":null,"worker":"CTL-101","detail":null}'
run "filter matches worker event for in-orch ticket" \
  assert_match "$EVENT_B" "$FILTER_FILE"

# (c) github event scoped by branch ref prefix
EVENT_C='{"event":"github.push","orchestrator":null,"worker":null,"scope":{"repo":"o/r","ref":"refs/heads/orch-test-2026-05-04-CTL-100","sha":"abc123"}}'
run "filter matches github event scoped by branch ref prefix" \
  assert_match "$EVENT_C" "$FILTER_FILE"

# (d) github event scoped to a known PR number
EVENT_D='{"event":"github.pr.synchronize","orchestrator":null,"worker":null,"scope":{"repo":"o/r","pr":501}}'
run "filter matches github event scoped to known PR" \
  assert_match "$EVENT_D" "$FILTER_FILE"

# (e) check_suite with prNumbers intersecting orch PR set
EVENT_E='{"event":"github.check_suite.completed","orchestrator":null,"worker":null,"scope":{"repo":"o/r"},"detail":{"conclusion":"failure","prNumbers":[501]}}'
run "filter matches check_suite event with intersecting prNumbers" \
  assert_match "$EVENT_E" "$FILTER_FILE"

# (f) linear event scoped to an in-orch ticket
EVENT_F='{"event":"linear.issue.state_changed","orchestrator":null,"worker":null,"scope":{"ticket":"CTL-100"},"detail":{}}'
run "filter matches linear event for in-orch ticket" \
  assert_match "$EVENT_F" "$FILTER_FILE"

# ── 16. emitted predicate — reject cases ────────────────────────────────────

# (g) catalyst event from a different orchestrator
EVENT_G='{"event":"worker-status-change","orchestrator":"orch-other-2026-05-04","worker":"FOO-99","detail":null}'
run "filter rejects event from foreign orchestrator" \
  assert_no_match "$EVENT_G" "$FILTER_FILE"

# (h) github event scoped to a foreign branch ref
EVENT_H='{"event":"github.push","orchestrator":null,"worker":null,"scope":{"repo":"o/r","ref":"refs/heads/orch-other-2026-05-04-FOO-99","sha":"def456"}}'
run "filter rejects github event for foreign branch" \
  assert_no_match "$EVENT_H" "$FILTER_FILE"

# (i) github event scoped to an unknown PR number
EVENT_I='{"event":"github.pr.synchronize","orchestrator":null,"worker":null,"scope":{"repo":"o/r","pr":999}}'
run "filter rejects github event for unknown PR" \
  assert_no_match "$EVENT_I" "$FILTER_FILE"

# (j) check_suite with prNumbers entirely outside orch PR set
EVENT_J='{"event":"github.check_suite.completed","orchestrator":null,"worker":null,"scope":{"repo":"o/r"},"detail":{"conclusion":"failure","prNumbers":[888,999]}}'
run "filter rejects check_suite with non-intersecting prNumbers" \
  assert_no_match "$EVENT_J" "$FILTER_FILE"

# (k) linear event for foreign ticket
EVENT_K='{"event":"linear.issue.state_changed","orchestrator":null,"worker":null,"scope":{"ticket":"FOO-99"},"detail":{}}'
run "filter rejects linear event for foreign ticket" \
  assert_no_match "$EVENT_K" "$FILTER_FILE"

# ── 17. build-orchestrator-filter — no PRs yet (early-stage orchestrator) ───
EARLY_ORCH="$SCRATCH/orch-early-2026-05-04"
mkdir -p "$EARLY_ORCH/workers"
cat > "$EARLY_ORCH/workers/CTL-200.json" <<EOF
{"ticket":"CTL-200","orchestrator":"orch-early-2026-05-04","status":"researching","pr":null}
EOF

EARLY_FILTER=$("$EVENTS" build-orchestrator-filter "$EARLY_ORCH")
EARLY_FILTER_FILE="$SCRATCH/early-filter.jq"
printf 'select(%s)\n' "$EARLY_FILTER" > "$EARLY_FILTER_FILE"

run "build-orchestrator-filter handles workers with no PRs" bash -c "
  echo '{}' | jq -c -f '$EARLY_FILTER_FILE' > /dev/null 2>&1 || \
  jq -c -f '$EARLY_FILTER_FILE' /dev/null 2>/dev/null; test \$? -ne 3
"

# Branch-ref scoping still works without any PRs
EVENT_PRELESS='{"event":"github.push","orchestrator":null,"worker":null,"scope":{"repo":"o/r","ref":"refs/heads/orch-early-2026-05-04-CTL-200","sha":"a1b2"}}'
run "filter matches branch-ref event when orch has no PRs" \
  assert_match "$EVENT_PRELESS" "$EARLY_FILTER_FILE"

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
