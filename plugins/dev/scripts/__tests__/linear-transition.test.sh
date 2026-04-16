#!/usr/bin/env bash
# Shell tests for linear-transition (CTL-69).
#
# The orchestrator and workers both need a single source of truth for
# transitioning Linear ticket state when a PR merges, a ticket is canceled
# for zero-scope, etc. This helper reads `.catalyst/config.json` stateMap,
# is idempotent, and handles edge cases (subsumed/zero-diff → canceled).
#
# Run: bash plugins/dev/scripts/__tests__/linear-transition.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TRANSITION="${REPO_ROOT}/plugins/dev/scripts/linear-transition.sh"

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

expect_contains() {
  local file="$1" needle="$2"
  grep -qF "$needle" "$file"
}

# Build a config.json with a given stateMap. Writes under $1 (directory).
build_config() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test",
    "linear": {
      "teamKey": "TST",
      "stateMap": {
        "backlog": "Backlog",
        "todo": "Todo",
        "research": "In Progress",
        "planning": "In Progress",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done",
        "canceled": "Canceled",
        "duplicate": "Duplicate"
      }
    }
  }
}
EOF
}

# Install a fake `linearis` on PATH that records calls and returns a canned
# issue state. Controlled by env vars:
#   FAKE_LINEARIS_STATE      - state to report for `issues read`
#   FAKE_LINEARIS_LOG        - path where commands get appended
#   FAKE_LINEARIS_UPDATE_EXIT - exit code for `issues update` (default 0)
install_fake_linearis() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/linearis" <<'EOF'
#!/usr/bin/env bash
# Record the full invocation for test assertions.
echo "linearis $*" >> "${FAKE_LINEARIS_LOG:-/dev/null}"

if [ "$1" = "issues" ] && [ "$2" = "read" ]; then
  STATE="${FAKE_LINEARIS_STATE:-In Review}"
  cat <<JSON
{"identifier":"${3:-TST-1}","title":"Fake","state":{"name":"${STATE}"}}
JSON
  exit 0
fi

if [ "$1" = "issues" ] && [ "$2" = "update" ]; then
  exit "${FAKE_LINEARIS_UPDATE_EXIT:-0}"
fi

exit 0
EOF
  chmod +x "${bin_dir}/linearis"
}

[ -x "$TRANSITION" ] || { echo "SKIP: $TRANSITION not present yet (expected during TDD)"; }

echo "linear-transition tests"

# ─── Test 1: reads target state from config stateMap.done ──────────────────
WORK1="${SCRATCH}/t1"
BIN1="${SCRATCH}/t1/bin"
LOG1="${SCRATCH}/t1/log"
build_config "$WORK1"
install_fake_linearis "$BIN1"
touch "$LOG1"

run "done transition uses stateMap.done from config" \
  bash -c "FAKE_LINEARIS_LOG='$LOG1' PATH='$BIN1:$PATH' \
    '$TRANSITION' --ticket TST-1 --transition done --config '$WORK1/.catalyst/config.json'"

run "recorded update call with correct ticket and status" \
  expect_contains "$LOG1" "linearis issues update TST-1 --status Done"

# ─── Test 2: canceled transition uses stateMap.canceled ────────────────────
WORK2="${SCRATCH}/t2"
BIN2="${SCRATCH}/t2/bin"
LOG2="${SCRATCH}/t2/log"
build_config "$WORK2"
install_fake_linearis "$BIN2"
touch "$LOG2"

run "canceled transition uses stateMap.canceled from config" \
  bash -c "FAKE_LINEARIS_LOG='$LOG2' PATH='$BIN2:$PATH' \
    '$TRANSITION' --ticket TST-2 --transition canceled --config '$WORK2/.catalyst/config.json'"

run "canceled update call recorded with correct status" \
  expect_contains "$LOG2" "linearis issues update TST-2 --status Canceled"

# ─── Test 3: --state overrides config (explicit state name) ────────────────
WORK3="${SCRATCH}/t3"
BIN3="${SCRATCH}/t3/bin"
LOG3="${SCRATCH}/t3/log"
build_config "$WORK3"
install_fake_linearis "$BIN3"
touch "$LOG3"

run "explicit --state overrides config stateMap" \
  bash -c "FAKE_LINEARIS_LOG='$LOG3' PATH='$BIN3:$PATH' \
    '$TRANSITION' --ticket TST-3 --state 'Shipped' --config '$WORK3/.catalyst/config.json'"

run "explicit state passed to linearis" \
  expect_contains "$LOG3" "linearis issues update TST-3 --status Shipped"

# ─── Test 4: idempotent — no-op when already in target state ───────────────
WORK4="${SCRATCH}/t4"
BIN4="${SCRATCH}/t4/bin"
LOG4="${SCRATCH}/t4/log"
build_config "$WORK4"
install_fake_linearis "$BIN4"
touch "$LOG4"

run "idempotent: skips update when state matches" \
  bash -c "FAKE_LINEARIS_STATE='Done' FAKE_LINEARIS_LOG='$LOG4' PATH='$BIN4:$PATH' \
    '$TRANSITION' --ticket TST-4 --transition done --config '$WORK4/.catalyst/config.json'"

run "idempotent: no update call recorded when already Done" \
  bash -c "! grep -q 'issues update' '$LOG4'"

run "idempotent: read call IS recorded (check was performed)" \
  expect_contains "$LOG4" "linearis issues read TST-4"

# ─── Test 5: --force bypasses idempotency check ────────────────────────────
WORK5="${SCRATCH}/t5"
BIN5="${SCRATCH}/t5/bin"
LOG5="${SCRATCH}/t5/log"
build_config "$WORK5"
install_fake_linearis "$BIN5"
touch "$LOG5"

run "--force bypasses idempotency check" \
  bash -c "FAKE_LINEARIS_STATE='Done' FAKE_LINEARIS_LOG='$LOG5' PATH='$BIN5:$PATH' \
    '$TRANSITION' --ticket TST-5 --transition done --force --config '$WORK5/.catalyst/config.json'"

run "--force: update call IS recorded even when state matches" \
  expect_contains "$LOG5" "linearis issues update TST-5 --status Done"

# ─── Test 6: defaults — when --config omitted, falls back to sensible name ─
# Skip this test when no CWD config is available. The script should find
# .catalyst/config.json in CWD or walk up.
WORK6="${SCRATCH}/t6"
BIN6="${SCRATCH}/t6/bin"
LOG6="${SCRATCH}/t6/log"
build_config "$WORK6"
install_fake_linearis "$BIN6"
touch "$LOG6"

run "auto-discovers config from CWD" \
  bash -c "cd '$WORK6' && FAKE_LINEARIS_LOG='$LOG6' PATH='$BIN6:$PATH' \
    '$TRANSITION' --ticket TST-6 --transition done"

run "auto-discover: recorded correct status for ticket" \
  expect_contains "$LOG6" "linearis issues update TST-6 --status Done"

# ─── Test 7: sensible defaults when state missing from config ──────────────
WORK7="${SCRATCH}/t7"
BIN7="${SCRATCH}/t7/bin"
LOG7="${SCRATCH}/t7/log"
mkdir -p "${WORK7}/.catalyst"
cat > "${WORK7}/.catalyst/config.json" <<'EOF'
{"catalyst":{"linear":{}}}
EOF
install_fake_linearis "$BIN7"
touch "$LOG7"

run "falls back to default 'Done' when stateMap.done missing" \
  bash -c "FAKE_LINEARIS_LOG='$LOG7' PATH='$BIN7:$PATH' \
    '$TRANSITION' --ticket TST-7 --transition done --config '$WORK7/.catalyst/config.json'"

run "default Done used when config has no stateMap" \
  expect_contains "$LOG7" "linearis issues update TST-7 --status Done"

# ─── Test 8: missing linearis CLI → exits 0 with warning (skip silently) ──
WORK8="${SCRATCH}/t8"
BIN8="${SCRATCH}/t8/bin-empty"
build_config "$WORK8"
mkdir -p "$BIN8"

# Replace PATH with only the empty directory PLUS /usr/bin & /bin so basic
# utilities (jq, bash, grep) remain available but `linearis` is missing.
run "missing linearis: exits 0 (graceful skip)" \
  bash -c "PATH='$BIN8:/usr/bin:/bin' '$TRANSITION' --ticket TST-8 --transition done --config '$WORK8/.catalyst/config.json'"

# ─── Test 9: dry-run reports but doesn't invoke update ─────────────────────
WORK9="${SCRATCH}/t9"
BIN9="${SCRATCH}/t9/bin"
LOG9="${SCRATCH}/t9/log"
build_config "$WORK9"
install_fake_linearis "$BIN9"
touch "$LOG9"

run "--dry-run exits 0" \
  bash -c "FAKE_LINEARIS_LOG='$LOG9' PATH='$BIN9:$PATH' \
    '$TRANSITION' --ticket TST-9 --transition done --dry-run --config '$WORK9/.catalyst/config.json'"

run "--dry-run: no update call was made" \
  bash -c "! grep -q 'issues update' '$LOG9'"

# ─── Test 10: JSON output on success ───────────────────────────────────────
WORK10="${SCRATCH}/t10"
BIN10="${SCRATCH}/t10/bin"
LOG10="${SCRATCH}/t10/log"
OUT10="${SCRATCH}/t10/stdout"
build_config "$WORK10"
install_fake_linearis "$BIN10"
touch "$LOG10"

FAKE_LINEARIS_LOG="$LOG10" PATH="$BIN10:$PATH" \
  "$TRANSITION" --ticket TST-10 --transition done --json \
    --config "$WORK10/.catalyst/config.json" > "$OUT10" 2>&1 || true

run "--json output contains ticket" \
  bash -c "jq -e '.ticket == \"TST-10\"' '$OUT10'"
run "--json output contains target state" \
  bash -c "jq -e '.targetState == \"Done\"' '$OUT10'"
run "--json output contains action" \
  bash -c "jq -e '.action == \"transitioned\" or .action == \"skipped\" or .action == \"dry-run\"' '$OUT10'"

# ─── Test 11: missing --ticket fails with clear error ──────────────────────
run "missing --ticket fails non-zero" \
  bash -c "! '$TRANSITION' --transition done 2>/dev/null"

# ─── Test 12: both --transition and --state given → --state wins ──────────
WORK12="${SCRATCH}/t12"
BIN12="${SCRATCH}/t12/bin"
LOG12="${SCRATCH}/t12/log"
build_config "$WORK12"
install_fake_linearis "$BIN12"
touch "$LOG12"

run "--state takes precedence over --transition" \
  bash -c "FAKE_LINEARIS_LOG='$LOG12' PATH='$BIN12:$PATH' \
    '$TRANSITION' --ticket TST-12 --transition done --state 'Manual Override' --config '$WORK12/.catalyst/config.json'"

run "manual override state was used" \
  expect_contains "$LOG12" "linearis issues update TST-12 --status Manual Override"

# ─── Test 13: transitions with spaces in state name are quoted correctly ──
WORK13="${SCRATCH}/t13"
BIN13="${SCRATCH}/t13/bin"
LOG13="${SCRATCH}/t13/log"
build_config "$WORK13"
install_fake_linearis "$BIN13"
touch "$LOG13"

run "state names with spaces passed through correctly" \
  bash -c "FAKE_LINEARIS_STATE='Backlog' FAKE_LINEARIS_LOG='$LOG13' PATH='$BIN13:$PATH' \
    '$TRANSITION' --ticket TST-13 --transition inReview --config '$WORK13/.catalyst/config.json'"

run "multi-word state name preserved" \
  expect_contains "$LOG13" "linearis issues update TST-13 --status In Review"

# ─── Test 14: orchestrate SKILL.md references the helper (no drift) ───────
ORCH_SKILL="${REPO_ROOT}/plugins/dev/skills/orchestrate/SKILL.md"
run "orchestrate SKILL.md references linear-transition.sh" \
  bash -c "grep -q 'linear-transition.sh' '$ORCH_SKILL'"
run "orchestrate SKILL.md documents --state-on-merge flag" \
  bash -c "grep -q 'state-on-merge' '$ORCH_SKILL'"

# ─── Test 15: oneshot SKILL.md references the helper ──────────────────────
ONESHOT_SKILL="${REPO_ROOT}/plugins/dev/skills/oneshot/SKILL.md"
run "oneshot SKILL.md references linear-transition.sh" \
  bash -c "grep -q 'linear-transition.sh' '$ONESHOT_SKILL'"

# ─── Test 16: merge-pr SKILL.md uses the helper ───────────────────────────
MERGE_SKILL="${REPO_ROOT}/plugins/dev/skills/merge-pr/SKILL.md"
run "merge-pr SKILL.md uses linear-transition.sh" \
  bash -c "grep -q 'linear-transition.sh' '$MERGE_SKILL'"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
