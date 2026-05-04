#!/usr/bin/env bash
# Shell tests for update-dashboard.sh (CTL-230).
#
# Verifies the renderer that the orchestrator monitor pass invokes once per
# cycle to write ${ORCH_DIR}/DASHBOARD.md from per-orch state.json + worker
# signal files + the events log.
#
# Run: bash plugins/dev/scripts/__tests__/update-dashboard.test.sh

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
mkdir -p "$CATALYST_DIR" "$CATALYST_DIR/events"

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

# Asserts that the rendered file (or string) contains a substring.
assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if grep -qF "$needle" <<<"$haystack"; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (missing: $needle)"
    echo "    haystack head:"
    head -20 <<<"$haystack" | sed 's/^/      /'
  fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if grep -qF "$needle" <<<"$haystack"; then
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (unexpectedly contains: $needle)"
  else
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  fi
}

# Provision an orch dir with state.json (per-orch metadata) and a stub global
# state.json entry for the same orch (for projectKey lookup).
setup_orch() {
  local orch_id="$1"
  local total_tickets="${2:-0}"
  local total_waves="${3:-1}"
  local current_wave="${4:-1}"
  local started_at="${5:-2026-05-04T20:00:00Z}"
  local base_branch="${6:-main}"
  local project_key="${7:-test-proj}"
  local orch_dir="${SCRATCH}/runs/${orch_id}"
  mkdir -p "${orch_dir}/workers/output"

  # Per-orch state.json — orchestrator metadata + waves array
  cat > "${orch_dir}/state.json" <<EOF
{
  "orchestrator": "${orch_id}",
  "startedAt": "${started_at}",
  "baseBranch": "${base_branch}",
  "totalTickets": ${total_tickets},
  "totalWaves": ${total_waves},
  "currentWave": ${current_wave},
  "worktreeBase": "${SCRATCH}/wt",
  "maxParallel": 3,
  "queue": {},
  "waves": []
}
EOF

  # Reset global state for projectKey lookup.
  rm -f "$CATALYST_STATE_FILE"
  "$STATE_SCRIPT" init >/dev/null
  "$STATE_SCRIPT" register "$orch_id" "$(jq -nc \
    --arg pk "$project_key" --arg sa "$started_at" --arg bb "$base_branch" \
    '{id: "TEST", projectKey: $pk, repository: "test/repo",
      baseBranch: $bb, status: "active", startedAt: $sa,
      progress: {totalTickets: 0, completedTickets: 0, failedTickets: 0, inProgressTickets: 0, currentWave: 1, totalWaves: 1},
      usage: {inputTokens: 0, outputTokens: 0, costUSD: 0},
      workers: {}, attention: []}')" >/dev/null

  echo "$orch_dir"
}

# Write a `waves` array onto an existing per-orch state.json.
set_waves_json() {
  local orch_dir="$1" waves_json="$2"
  jq --argjson w "$waves_json" '.waves = $w' "${orch_dir}/state.json" \
    > "${orch_dir}/state.json.tmp" && mv "${orch_dir}/state.json.tmp" "${orch_dir}/state.json"
}

# Build a worker signal file with sensible defaults; override JSON via $extra.
build_signal() {
  local out="$1" ticket="$2" wave="$3" status="$4" phase="$5" extra="${6:-{\}}"
  jq -n \
    --arg t "$ticket" --arg w "$wave" --arg s "$status" --arg p "$phase" \
    --argjson extra "$extra" \
    '{ticket: $t, orchestrator: "orch-test", wave: ($w|tonumber),
      workerName: ("orch-test-" + $t), label: ("oneshot " + $t),
      status: $s, phase: ($p|tonumber),
      startedAt: "2026-05-04T20:05:00Z",
      updatedAt: "2026-05-04T20:30:00Z",
      lastHeartbeat: "2026-05-04T20:30:00Z",
      worktreePath: ("/tmp/" + $t),
      pr: null, linearState: null,
      definitionOfDone: {
        testsWrittenFirst: false,
        unitTests: {exists: false, count: 0},
        apiTests: {exists: false, count: 0},
        functionalTests: {exists: false, count: 0},
        typeCheck: {passed: false},
        securityReview: {passed: false},
        codeReview: {passed: false},
        rewardHackingScan: {passed: false}
      },
      pid: null} * $extra' > "$out"
}

# Append events to the scratch events log.
append_events() {
  local events_file="${CATALYST_DIR}/events/$(date -u +%Y-%m).jsonl"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    echo "$line" >> "$events_file"
  done
}

# ───────────────────────────────────────────────────────────────────────────────
echo "update-dashboard tests"
echo ""

# ─── 1: helper exists and is executable ────────────────────────────────────────
run "helper script exists" bash -c "[ -f '$HELPER' ]"
run "helper script is executable" bash -c "[ -x '$HELPER' ]"
run "helper rejects missing --orch" bash -c "! '$HELPER' 2>/dev/null"

# ─── 2: header_renders ─────────────────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-h" 5 2 1 "2026-05-04T20:00:00Z" "main" "catalyst")
OUT=$("$HELPER" --orch "orch-h" --orch-dir "$ORCH_DIR" --stdout)
assert_contains "header has orchestrator name" "$OUT" "**Orchestrator:** orch-h"
assert_contains "header has started timestamp" "$OUT" "**Started:** 2026-05-04T20:00:00Z"
assert_contains "header has base branch" "$OUT" "**Base branch:** main"
assert_contains "header has totals line" "$OUT" "5 tickets | 2 waves | Max parallel: 3"
assert_contains "header has project name" "$OUT" "**Project:** catalyst"
assert_contains "current wave heading present" "$OUT" "## Current Wave: 1 of 2"
assert_not_contains "no literal placeholders in output" "$OUT" '${'

# ─── 3: current_wave_table_renders_workers ─────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-cw" 2 1 1)
build_signal "${ORCH_DIR}/workers/T-1.json" "T-1" "1" "researching" "1"
build_signal "${ORCH_DIR}/workers/T-2.json" "T-2" "1" "merging" "5" \
  '{"pr": {"number": 42, "url": "https://github.com/o/r/pull/42", "ciStatus": "passing", "prOpenedAt": "2026-05-04T20:10:00Z", "autoMergeArmedAt": "2026-05-04T20:11:00Z", "mergedAt": null}}'

OUT=$("$HELPER" --orch "orch-cw" --orch-dir "$ORCH_DIR" --stdout)
assert_contains "current wave row T-1 status researching" "$OUT" "T-1"
assert_contains "current wave row T-2 status merging" "$OUT" "T-2"
assert_contains "current wave row T-2 PR cell #42" "$OUT" "[#42]"
assert_contains "current wave row T-2 PR cell url" "$OUT" "https://github.com/o/r/pull/42"
assert_contains "current wave row T-2 prOpenedAt" "$OUT" "2026-05-04T20:10:00Z"
assert_contains "current wave row T-2 autoMergeArmedAt" "$OUT" "2026-05-04T20:11:00Z"
assert_contains "current wave row T-1 status text" "$OUT" "researching"
assert_contains "current wave row T-2 status text" "$OUT" "merging"

# ─── 4: definition_of_done_columns ─────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-dod" 1 1 1)
build_signal "${ORCH_DIR}/workers/D-1.json" "D-1" "1" "validating" "4" \
  '{"definitionOfDone": {"unitTests": {"exists": true, "count": 3}, "apiTests": {"exists": false, "count": 0}, "functionalTests": {"exists": false, "count": 0}, "typeCheck": {"passed": true}, "securityReview": {"passed": true}, "codeReview": {"passed": false}, "rewardHackingScan": {"passed": true}}}'

OUT=$("$HELPER" --orch "orch-dod" --orch-dir "$ORCH_DIR" --stdout)
# Find the table row for D-1 and verify the cells encode the DoD shape.
ROW=$(grep '^| D-1 ' <<<"$OUT" || true)
[ -n "$ROW" ] && PASSES=$((PASSES+1)) && echo "  PASS: D-1 has a row" || { FAILURES=$((FAILURES+1)); echo "  FAIL: D-1 has a row (no row found)"; }
assert_contains "DoD row contains unit count 3" "$ROW" "3"
# securityReview passed → ✓; codeReview failed → ✗
assert_contains "DoD row contains a tick mark for security" "$ROW" "✓"
assert_contains "DoD row contains a cross for failed review" "$ROW" "✗"

# ─── 5: completed_waves_section ────────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-cmp" 4 2 2)
set_waves_json "$ORCH_DIR" '[
  {"wave": 1, "status": "completed", "tickets": ["A-1", "A-2"], "completedAt": "2026-05-04T20:30:00Z"},
  {"wave": 2, "status": "active", "tickets": ["B-1", "B-2"]}
]'
build_signal "${ORCH_DIR}/workers/A-1.json" "A-1" "1" "done" "5" \
  '{"pr": {"number": 100, "url": "https://github.com/o/r/pull/100", "mergedAt": "2026-05-04T20:25:00Z", "ciStatus": "merged"}, "completedAt": "2026-05-04T20:25:00Z"}'
build_signal "${ORCH_DIR}/workers/A-2.json" "A-2" "1" "done" "5" \
  '{"pr": {"number": 101, "url": "https://github.com/o/r/pull/101", "mergedAt": "2026-05-04T20:28:00Z", "ciStatus": "merged"}, "completedAt": "2026-05-04T20:28:00Z"}'
build_signal "${ORCH_DIR}/workers/B-1.json" "B-1" "2" "implementing" "3"
build_signal "${ORCH_DIR}/workers/B-2.json" "B-2" "2" "researching" "1"

OUT=$("$HELPER" --orch "orch-cmp" --orch-dir "$ORCH_DIR" --stdout)
assert_contains "completed waves heading" "$OUT" "## Completed Waves"
assert_contains "wave 1 heading" "$OUT" "### Wave 1"
assert_contains "completed wave row A-1 PR" "$OUT" "[#100]"
assert_contains "completed wave row A-2 PR" "$OUT" "[#101]"
assert_contains "current wave heading is wave 2" "$OUT" "## Current Wave: 2 of 2"
assert_contains "current wave shows B-1" "$OUT" "B-1"
assert_contains "current wave shows B-2" "$OUT" "B-2"
# Completed-wave tickets must NOT appear in the current-wave table — that's the point.
# Look for A-1 between "## Current Wave" and the next "## " heading; should be absent.
CURRENT_BLOCK=$(awk '/^## Current Wave/{flag=1;next} /^## /{flag=0} flag' <<<"$OUT" || true)
assert_not_contains "current wave block does not contain completed worker A-1" "$CURRENT_BLOCK" "| A-1 "

# ─── 6: upcoming_waves_section ─────────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-up" 4 3 1)
set_waves_json "$ORCH_DIR" '[
  {"wave": 1, "status": "active", "tickets": ["W1-1"]},
  {"wave": 2, "status": "pending", "tickets": ["W2-1", "W2-2"], "dependsOn": [1]},
  {"wave": 3, "status": "pending", "tickets": ["W3-1"], "dependsOn": [2]}
]'
build_signal "${ORCH_DIR}/workers/W1-1.json" "W1-1" "1" "implementing" "3"

OUT=$("$HELPER" --orch "orch-up" --orch-dir "$ORCH_DIR" --stdout)
assert_contains "upcoming waves heading" "$OUT" "## Upcoming Waves"
assert_contains "wave 2 heading" "$OUT" "### Wave 2"
assert_contains "wave 2 depends-on note" "$OUT" "blocked on Wave 1"
assert_contains "wave 2 ticket W2-1" "$OUT" "W2-1"
assert_contains "wave 2 ticket W2-2" "$OUT" "W2-2"
assert_contains "wave 3 heading" "$OUT" "### Wave 3"
assert_contains "wave 3 depends-on note" "$OUT" "blocked on Wave 2"
assert_contains "wave 3 ticket W3-1" "$OUT" "W3-1"

# ─── 7: event_log_section (filters by orchestrator) ────────────────────────────
ORCH_DIR=$(setup_orch "orch-ev" 1 1 1)
build_signal "${ORCH_DIR}/workers/E-1.json" "E-1" "1" "researching" "1"
append_events <<EOF
{"ts":"2026-05-04T20:00:00Z","orchestrator":"orch-ev","worker":null,"event":"orchestrator-started","detail":{"tickets":["E-1"]}}
{"ts":"2026-05-04T20:05:00Z","orchestrator":"orch-ev","worker":"E-1","event":"worker-dispatched","detail":{"pid":1234}}
{"ts":"2026-05-04T20:10:00Z","orchestrator":"OTHER-ORCH","worker":"X-1","event":"worker-dispatched","detail":null}
{"ts":"2026-05-04T20:15:00Z","orchestrator":"orch-ev","worker":"E-1","event":"worker-status-change","detail":{"from":"researching","to":"planning"}}
EOF

OUT=$("$HELPER" --orch "orch-ev" --orch-dir "$ORCH_DIR" --stdout)
assert_contains "event log heading" "$OUT" "## Event Log"
assert_contains "event log includes own orch event" "$OUT" "orchestrator-started"
assert_contains "event log includes worker-dispatched" "$OUT" "worker-dispatched"
assert_contains "event log includes status-change" "$OUT" "worker-status-change"
assert_not_contains "event log excludes other orch" "$OUT" "OTHER-ORCH"
assert_not_contains "event log excludes other orch worker" "$OUT" "X-1"

# ─── 8: idempotent ─────────────────────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-idem" 2 1 1)
build_signal "${ORCH_DIR}/workers/I-1.json" "I-1" "1" "implementing" "3"
build_signal "${ORCH_DIR}/workers/I-2.json" "I-2" "1" "validating" "4"
"$HELPER" --orch "orch-idem" --orch-dir "$ORCH_DIR" >/dev/null
FIRST=$(cat "${ORCH_DIR}/DASHBOARD.md")
"$HELPER" --orch "orch-idem" --orch-dir "$ORCH_DIR" >/dev/null
SECOND=$(cat "${ORCH_DIR}/DASHBOARD.md")
if [ "$FIRST" = "$SECOND" ]; then
  PASSES=$((PASSES+1)); echo "  PASS: idempotent — two consecutive renders are byte-identical"
else
  FAILURES=$((FAILURES+1))
  echo "  FAIL: idempotent — output changed across re-runs"
  diff <(echo "$FIRST") <(echo "$SECOND") | head -20 | sed 's/^/      /'
fi

# ─── 9: handles_missing_pr ─────────────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-nopr" 1 1 1)
build_signal "${ORCH_DIR}/workers/N-1.json" "N-1" "1" "researching" "1"
run "renders cleanly with pr=null" \
  "$HELPER" --orch "orch-nopr" --orch-dir "$ORCH_DIR" --stdout

# ─── 10: handles_missing_workers_dir ───────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-empty" 0 1 1)
rm -rf "${ORCH_DIR}/workers"   # simulate Phase 2 init: state.json exists, no workers yet
run "renders with no workers/ dir" \
  "$HELPER" --orch "orch-empty" --orch-dir "$ORCH_DIR" --stdout

# ─── 11: deterministic_worker_order ────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-ord" 4 1 1)
# Create signal files in non-alphabetical order
build_signal "${ORCH_DIR}/workers/CTL-99.json"  "CTL-99"  "1" "researching" "1"
build_signal "${ORCH_DIR}/workers/CTL-1.json"   "CTL-1"   "1" "researching" "1"
build_signal "${ORCH_DIR}/workers/CTL-50.json"  "CTL-50"  "1" "researching" "1"
build_signal "${ORCH_DIR}/workers/CTL-12.json"  "CTL-12"  "1" "researching" "1"

OUT=$("$HELPER" --orch "orch-ord" --orch-dir "$ORCH_DIR" --stdout)
# Extract ticket-row order from current-wave table
ORDER=$(awk '/^## Current Wave/{flag=1;next} /^## /{flag=0} flag && /^\| CTL-/' <<<"$OUT" \
  | sed -E 's/^\| ([^ ]+) .*/\1/' | tr '\n' ' ')
EXPECTED="CTL-1 CTL-12 CTL-50 CTL-99 "
if [ "$ORDER" = "$EXPECTED" ]; then
  PASSES=$((PASSES+1)); echo "  PASS: workers sorted alphabetically (got: $ORDER)"
else
  FAILURES=$((FAILURES+1)); echo "  FAIL: worker order — expected '$EXPECTED' got '$ORDER'"
fi

# ─── 12: writes file atomically ────────────────────────────────────────────────
ORCH_DIR=$(setup_orch "orch-atom" 1 1 1)
build_signal "${ORCH_DIR}/workers/AT-1.json" "AT-1" "1" "implementing" "3"
"$HELPER" --orch "orch-atom" --orch-dir "$ORCH_DIR" >/dev/null
run "DASHBOARD.md exists after run" bash -c "[ -f '${ORCH_DIR}/DASHBOARD.md' ]"
run "DASHBOARD.md is non-empty" bash -c "[ -s '${ORCH_DIR}/DASHBOARD.md' ]"
run "no template placeholders left in file" \
  bash -c "! grep -qF '\${ORCH_NAME}' '${ORCH_DIR}/DASHBOARD.md'"

# ─── Report ────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "PASSED: ${PASSES}"
echo "FAILED: ${FAILURES}"
echo "============================================"
[ "$FAILURES" -eq 0 ]
