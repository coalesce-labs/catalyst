#!/usr/bin/env bash
# Shell tests for orchestrate-bulk-close (CTL-69).
#
# The bulk-close helper retroactively transitions Linear tickets for all
# workers in an orchestration run. It inspects each worker signal + (when
# possible) the PR's merge state and diff size to decide between:
#   - `done`     → PR merged with non-empty diff
#   - `canceled` → PR merged with zero diff (subsumed), OR no PR/no commits
#   - skip       → worker still in progress, or explicit exclusion
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-bulk-close.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
BULK_CLOSE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-bulk-close"

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

# ─── Shared fixture builders ───────────────────────────────────────────────

build_config() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "linear": {
      "teamKey": "TST",
      "stateMap": {
        "done": "Done",
        "canceled": "Canceled",
        "inReview": "In Review"
      }
    }
  }
}
EOF
}

build_orch_dir() {
  local dir="$1"
  mkdir -p "${dir}/workers"
}

write_signal() {
  local orch_dir="$1" ticket="$2" status="$3" pr_json="$4"
  cat > "${orch_dir}/workers/${ticket}.json" <<EOF
{
  "ticket": "${ticket}",
  "orchestrator": "test-orch",
  "workerName": "test-orch-${ticket}",
  "status": "${status}",
  "phase": 5,
  "startedAt": "2026-04-16T18:00:00Z",
  "updatedAt": "2026-04-16T18:30:00Z",
  "pr": ${pr_json}
}
EOF
}

# Install a fake gh (PR state + diff) and linearis (record + state reporting).
install_fakes() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"

  cat > "${bin_dir}/gh" <<'EOF'
#!/usr/bin/env bash
# Minimal gh fake. Supports:
#   gh pr view <N> --json state,mergedAt,additions,deletions
# Controlled by env vars per PR number:
#   FAKE_PR_<N>_STATE       (MERGED|OPEN|CLOSED)
#   FAKE_PR_<N>_MERGED_AT   (ISO string or empty)
#   FAKE_PR_<N>_ADDITIONS   (int, default 0)
#   FAKE_PR_<N>_DELETIONS   (int, default 0)
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  PR_NUM="$3"
  varname_state="FAKE_PR_${PR_NUM}_STATE"
  varname_merged="FAKE_PR_${PR_NUM}_MERGED_AT"
  varname_add="FAKE_PR_${PR_NUM}_ADDITIONS"
  varname_del="FAKE_PR_${PR_NUM}_DELETIONS"
  STATE="${!varname_state:-OPEN}"
  MERGED="${!varname_merged:-}"
  ADD="${!varname_add:-0}"
  DEL="${!varname_del:-0}"
  printf '{"state":"%s","mergedAt":"%s","additions":%s,"deletions":%s}\n' \
    "$STATE" "$MERGED" "$ADD" "$DEL"
  exit 0
fi
exit 0
EOF
  chmod +x "${bin_dir}/gh"

  cat > "${bin_dir}/linearis" <<'EOF'
#!/usr/bin/env bash
echo "linearis $*" >> "${FAKE_LINEARIS_LOG:-/dev/null}"
if [ "$1" = "issues" ] && [ "$2" = "read" ]; then
  # Return a deterministic "In Review" state so the idempotency check
  # always falls through to an update call.
  echo '{"identifier":"'"${3}"'","title":"Fake","state":{"name":"In Review"}}'
  exit 0
fi
exit 0
EOF
  chmod +x "${bin_dir}/linearis"
}

[ -x "$BULK_CLOSE" ] || echo "NOTE: $BULK_CLOSE not present yet (TDD mode)"

echo "orchestrate-bulk-close tests"

# ─── Test 1: merged PR with diff → done ────────────────────────────────────
T1="${SCRATCH}/t1"
BIN1="${SCRATCH}/t1/bin"
LOG1="${SCRATCH}/t1/log"
build_config "$T1"
build_orch_dir "$T1/orch"
install_fakes "$BIN1"
touch "$LOG1"

write_signal "$T1/orch" "TST-1" "done" \
  '{"number":101,"url":"https://github.com/o/r/pull/101","mergedAt":"2026-04-16T19:00:00Z"}'

run "merged PR with diff: transitions to Done" \
  bash -c "FAKE_PR_101_STATE=MERGED FAKE_PR_101_MERGED_AT=2026-04-16T19:00:00Z \
    FAKE_PR_101_ADDITIONS=50 FAKE_PR_101_DELETIONS=10 \
    FAKE_LINEARIS_LOG='$LOG1' PATH='$BIN1:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T1/orch' --config '$T1/.catalyst/config.json'"

run "done transition recorded for TST-1" \
  expect_contains "$LOG1" "linearis issues update TST-1 --status Done"

# ─── Test 2: merged PR with ZERO diff → canceled (subsumed) ────────────────
T2="${SCRATCH}/t2"
BIN2="${SCRATCH}/t2/bin"
LOG2="${SCRATCH}/t2/log"
build_config "$T2"
build_orch_dir "$T2/orch"
install_fakes "$BIN2"
touch "$LOG2"

write_signal "$T2/orch" "TST-2" "done" \
  '{"number":102,"url":"https://github.com/o/r/pull/102","mergedAt":"2026-04-16T19:00:00Z"}'

run "zero-diff PR: transitions to Canceled (subsumed)" \
  bash -c "FAKE_PR_102_STATE=MERGED FAKE_PR_102_MERGED_AT=2026-04-16T19:00:00Z \
    FAKE_PR_102_ADDITIONS=0 FAKE_PR_102_DELETIONS=0 \
    FAKE_LINEARIS_LOG='$LOG2' PATH='$BIN2:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T2/orch' --config '$T2/.catalyst/config.json'"

run "canceled transition recorded for zero-diff TST-2" \
  expect_contains "$LOG2" "linearis issues update TST-2 --status Canceled"

# ─── Test 3: no PR, worker done → canceled (zero-scope) ────────────────────
T3="${SCRATCH}/t3"
BIN3="${SCRATCH}/t3/bin"
LOG3="${SCRATCH}/t3/log"
build_config "$T3"
build_orch_dir "$T3/orch"
install_fakes "$BIN3"
touch "$LOG3"

write_signal "$T3/orch" "TST-3" "done" "null"

run "no-PR worker at done: transitions to Canceled (zero-scope)" \
  bash -c "FAKE_LINEARIS_LOG='$LOG3' PATH='$BIN3:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T3/orch' --config '$T3/.catalyst/config.json'"

run "canceled transition recorded for no-PR TST-3" \
  expect_contains "$LOG3" "linearis issues update TST-3 --status Canceled"

# ─── Test 4: worker still in progress → skip (no transition) ───────────────
T4="${SCRATCH}/t4"
BIN4="${SCRATCH}/t4/bin"
LOG4="${SCRATCH}/t4/log"
build_config "$T4"
build_orch_dir "$T4/orch"
install_fakes "$BIN4"
touch "$LOG4"

write_signal "$T4/orch" "TST-4" "implementing" "null"

run "in-progress worker: no transition called" \
  bash -c "FAKE_LINEARIS_LOG='$LOG4' PATH='$BIN4:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T4/orch' --config '$T4/.catalyst/config.json'"

run "in-progress worker: no update call was made" \
  bash -c "! grep -q 'issues update' '$LOG4'"

# ─── Test 5: dry-run exits 0 and invokes no updates ────────────────────────
T5="${SCRATCH}/t5"
BIN5="${SCRATCH}/t5/bin"
LOG5="${SCRATCH}/t5/log"
build_config "$T5"
build_orch_dir "$T5/orch"
install_fakes "$BIN5"
touch "$LOG5"

write_signal "$T5/orch" "TST-5" "done" \
  '{"number":105,"url":"https://github.com/o/r/pull/105","mergedAt":"2026-04-16T19:00:00Z"}'

run "--dry-run exits 0" \
  bash -c "FAKE_PR_105_STATE=MERGED FAKE_PR_105_ADDITIONS=100 \
    FAKE_LINEARIS_LOG='$LOG5' PATH='$BIN5:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T5/orch' --config '$T5/.catalyst/config.json' --dry-run"

run "--dry-run makes no update calls" \
  bash -c "! grep -q 'issues update' '$LOG5'"

# ─── Test 6: handles multiple workers in one run ───────────────────────────
T6="${SCRATCH}/t6"
BIN6="${SCRATCH}/t6/bin"
LOG6="${SCRATCH}/t6/log"
build_config "$T6"
build_orch_dir "$T6/orch"
install_fakes "$BIN6"
touch "$LOG6"

write_signal "$T6/orch" "TST-6a" "done" \
  '{"number":106,"url":"https://github.com/o/r/pull/106","mergedAt":"2026-04-16T19:00:00Z"}'
write_signal "$T6/orch" "TST-6b" "done" \
  '{"number":107,"url":"https://github.com/o/r/pull/107","mergedAt":"2026-04-16T19:00:00Z"}'
write_signal "$T6/orch" "TST-6c" "implementing" "null"

run "processes multiple workers in one run" \
  bash -c "FAKE_PR_106_STATE=MERGED FAKE_PR_106_ADDITIONS=42 \
    FAKE_PR_107_STATE=MERGED FAKE_PR_107_ADDITIONS=0 FAKE_PR_107_DELETIONS=0 \
    FAKE_LINEARIS_LOG='$LOG6' PATH='$BIN6:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T6/orch' --config '$T6/.catalyst/config.json'"

run "6a (merged with diff) got Done" \
  expect_contains "$LOG6" "linearis issues update TST-6a --status Done"
run "6b (zero-diff) got Canceled" \
  expect_contains "$LOG6" "linearis issues update TST-6b --status Canceled"
run "6c (in-progress) got no transition" \
  bash -c "! grep -q 'update TST-6c' '$LOG6'"

# ─── Test 7: ignores non-worker JSON files in workers/ ─────────────────────
T7="${SCRATCH}/t7"
BIN7="${SCRATCH}/t7/bin"
LOG7="${SCRATCH}/t7/log"
build_config "$T7"
build_orch_dir "$T7/orch"
install_fakes "$BIN7"
touch "$LOG7"

# Valid worker signal
write_signal "$T7/orch" "TST-7" "done" \
  '{"number":108,"url":"https://github.com/o/r/pull/108"}'
# Non-worker file (e.g., dispatch-fixup helpers)
echo '{"not_a_worker":true}' > "$T7/orch/workers/fixup-meta.json"

run "skips JSON files without .ticket field" \
  bash -c "FAKE_PR_108_STATE=MERGED FAKE_PR_108_ADDITIONS=10 \
    FAKE_LINEARIS_LOG='$LOG7' PATH='$BIN7:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T7/orch' --config '$T7/.catalyst/config.json'"

# ─── Test 8: --state-on-merge override ─────────────────────────────────────
T8="${SCRATCH}/t8"
BIN8="${SCRATCH}/t8/bin"
LOG8="${SCRATCH}/t8/log"
build_config "$T8"
build_orch_dir "$T8/orch"
install_fakes "$BIN8"
touch "$LOG8"

write_signal "$T8/orch" "TST-8" "done" \
  '{"number":118,"url":"https://github.com/o/r/pull/118"}'

run "--state-on-merge overrides default 'done' transition" \
  bash -c "FAKE_PR_118_STATE=MERGED FAKE_PR_118_ADDITIONS=5 \
    FAKE_LINEARIS_LOG='$LOG8' PATH='$BIN8:/usr/bin:/bin' \
    '$BULK_CLOSE' --orch-dir '$T8/orch' --config '$T8/.catalyst/config.json' \
    --state-on-merge 'Shipped to Prod'"

run "override state used in linearis call" \
  expect_contains "$LOG8" "linearis issues update TST-8 --status Shipped to Prod"

# ─── Test 9: missing --orch-dir exits non-zero with error ──────────────────
run "missing --orch-dir fails" \
  bash -c "! '$BULK_CLOSE' 2>/dev/null"

# ─── Test 10: JSON summary output on stdout ────────────────────────────────
T10="${SCRATCH}/t10"
BIN10="${SCRATCH}/t10/bin"
LOG10="${SCRATCH}/t10/log"
OUT10="${SCRATCH}/t10/stdout"
build_config "$T10"
build_orch_dir "$T10/orch"
install_fakes "$BIN10"
touch "$LOG10"

write_signal "$T10/orch" "TST-10" "done" \
  '{"number":110,"url":"https://github.com/o/r/pull/110"}'

FAKE_PR_110_STATE=MERGED FAKE_PR_110_ADDITIONS=25 \
  FAKE_LINEARIS_LOG="$LOG10" PATH="$BIN10:/usr/bin:/bin" \
  "$BULK_CLOSE" --orch-dir "$T10/orch" --config "$T10/.catalyst/config.json" \
  --json > "$OUT10" 2>/dev/null || true

run "--json summary parses as JSON" \
  bash -c "jq -e '.' '$OUT10' >/dev/null"
run "--json summary has transitioned count" \
  bash -c "jq -e '.transitioned' '$OUT10' >/dev/null"
run "--json summary has canceled count" \
  bash -c "jq -e '.canceled' '$OUT10' >/dev/null"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
