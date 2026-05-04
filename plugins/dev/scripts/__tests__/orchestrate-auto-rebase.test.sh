#!/usr/bin/env bash
# Shell tests for orchestrate-auto-rebase (CTL-232).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-auto-rebase.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
AUTO_REBASE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-auto-rebase"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers" "${SCRATCH}/bin"

  # Stub state script — logs every invocation so tests can assert.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Stub orchestrate-rebase — records every dispatch invocation.
  cat > "${SCRATCH}/bin/orchestrate-rebase" <<'EOF'
#!/usr/bin/env bash
echo "REBASE_CALLED $*" >> "$REBASE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/orchestrate-rebase"
  export REBASE_LOG="${SCRATCH}/rebase.log"
  : > "$REBASE_LOG"
  export CATALYST_AUTO_REBASE_DISPATCH_BIN="${SCRATCH}/bin/orchestrate-rebase"

  # Stub gh — reads from a per-test fixture file.
  cat > "${SCRATCH}/bin/gh" <<'EOF'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"pr view"* ]]; then
  cat "$GH_PR_VIEW_FIXTURE"
else
  echo "stub gh: unexpected invocation: $args" >&2
  exit 99
fi
EOF
  chmod +x "${SCRATCH}/bin/gh"
  export CATALYST_AUTO_REBASE_GH_BIN="${SCRATCH}/bin/gh"

  export GH_PR_VIEW_FIXTURE="${SCRATCH}/pr-view.json"
  echo '{"state":"OPEN","mergeStateStatus":"CLEAN","baseRefName":"main"}' > "$GH_PR_VIEW_FIXTURE"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset STATE_LOG REBASE_LOG CATALYST_STATE_SCRIPT CATALYST_AUTO_REBASE_DISPATCH_BIN \
        CATALYST_AUTO_REBASE_GH_BIN GH_PR_VIEW_FIXTURE SCRATCH ORCH_DIR
}

set_pr_view() {
  local state="$1" merge_state="$2" base_ref="${3:-main}"
  jq -n --arg s "$state" --arg m "$merge_state" --arg b "$base_ref" \
    '{state:$s, mergeStateStatus:$m, baseRefName:$b}' \
    > "$GH_PR_VIEW_FIXTURE"
}

# Seed a worker signal at ORCH_DIR/workers/<ticket>.json
make_signal() {
  # Args: TICKET STATUS PR_NUMBER PR_URL [DIRTY_SINCE] [REBASE_ATTEMPTS]
  local ticket="$1" status="$2" pr_num="$3" pr_url="$4"
  local dirty_since="${5:-}" attempts="${6:-0}"
  local now="2026-05-04T12:00:00Z"

  if [ -z "$pr_num" ]; then
    jq -n --arg t "$ticket" --arg s "$status" --arg ts "$now" \
      '{ticket:$t, status:$s, phase:5, startedAt:$ts, updatedAt:$ts, pr:null}' \
      > "${ORCH_DIR}/workers/${ticket}.json"
    return
  fi

  local base
  base=$(jq -n --arg t "$ticket" --arg s "$status" --arg ts "$now" \
    --argjson n "$pr_num" --arg u "$pr_url" \
    '{ticket:$t, status:$s, phase:5, startedAt:$ts, updatedAt:$ts,
      pr:{number:$n, url:$u, ciStatus:"pending"}}')

  if [ -n "$dirty_since" ]; then
    base=$(echo "$base" | jq --arg ds "$dirty_since" '.dirtySince = $ds')
  fi
  if [ -n "$attempts" ] && [ "$attempts" != "0" ]; then
    base=$(echo "$base" | jq --argjson a "$attempts" '.rebaseAttempts = $a')
  fi
  echo "$base" > "${ORCH_DIR}/workers/${ticket}.json"
}

# ---

echo "orchestrate-auto-rebase tests"
echo

echo "test: missing --orch-dir fails"
set +e
"$AUTO_REBASE" --orch-id demo 2>/dev/null; RC=$?
set -e
[ "$RC" != "0" ] && pass "errors without --orch-dir" || fail "errors without --orch-dir" "rc=$RC"

echo "test: missing --orch-id fails"
set +e
"$AUTO_REBASE" --orch-dir /tmp 2>/dev/null; RC=$?
set -e
[ "$RC" != "0" ] && pass "errors without --orch-id" || fail "errors without --orch-id" "rc=$RC"

echo "test: empty workers dir is a clean no-op"
scratch_setup
OUT=$("$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo 2>/dev/null)
CHECKED=$(echo "$OUT" | jq -r '.checked' 2>/dev/null || echo "?")
[ "$CHECKED" = "0" ] && pass "summary.checked=0 when no signals" || fail "summary.checked=0 when no signals" "got: $CHECKED; out: $OUT"
[ ! -s "$REBASE_LOG" ] && pass "no rebase dispatch when empty" || fail "no rebase dispatch when empty" "log: $(cat "$REBASE_LOG")"
scratch_teardown

echo "test: worker without PR is skipped"
scratch_setup
make_signal "T-1" "implementing" "" ""
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$REBASE_LOG" ] && pass "no dispatch for PR-less worker" || fail "no dispatch for PR-less worker"
DIRTY_SINCE=$(jq -r '.dirtySince // empty' "${ORCH_DIR}/workers/T-1.json")
[ -z "$DIRTY_SINCE" ] && pass "no dirtySince written for PR-less worker" || fail "no dirtySince written for PR-less worker" "got: $DIRTY_SINCE"
scratch_teardown

echo "test: terminal worker is skipped"
scratch_setup
make_signal "T-2" "done" "42" "https://github.com/o/r/pull/42"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$REBASE_LOG" ] && pass "no dispatch for terminal worker" || fail "no dispatch for terminal worker"
scratch_teardown

echo "test: MERGED PR is skipped (state != OPEN)"
scratch_setup
make_signal "T-3" "pr-created" "42" "https://github.com/o/r/pull/42"
set_pr_view "MERGED" "UNKNOWN"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$REBASE_LOG" ] && pass "no dispatch when PR merged" || fail "no dispatch when PR merged"
scratch_teardown

echo "test: MERGED PR clears stale dirtySince"
scratch_setup
make_signal "T-3a" "pr-created" "42" "https://github.com/o/r/pull/42" "2026-05-04T11:00:00Z"
set_pr_view "MERGED" "UNKNOWN"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
DIRTY_SINCE=$(jq -r '.dirtySince // empty' "${ORCH_DIR}/workers/T-3a.json")
[ -z "$DIRTY_SINCE" ] && pass "dirtySince cleared when PR is no longer OPEN" || fail "dirtySince cleared when PR is no longer OPEN" "got: $DIRTY_SINCE"
scratch_teardown

echo "test: non-DIRTY OPEN PR clears dirtySince and skips"
scratch_setup
make_signal "T-4" "pr-created" "42" "https://github.com/o/r/pull/42" "2026-05-04T11:00:00Z"
set_pr_view "OPEN" "CLEAN"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
DIRTY_SINCE=$(jq -r '.dirtySince // empty' "${ORCH_DIR}/workers/T-4.json")
[ -z "$DIRTY_SINCE" ] && pass "dirtySince cleared when PR is no longer DIRTY" || fail "dirtySince cleared when PR is no longer DIRTY" "got: $DIRTY_SINCE"
[ ! -s "$REBASE_LOG" ] && pass "no dispatch on CLEAN" || fail "no dispatch on CLEAN"
scratch_teardown

echo "test: BEHIND PR (not DIRTY) is skipped — auto-merge handles BEHIND"
scratch_setup
make_signal "T-4b" "pr-created" "42" "https://github.com/o/r/pull/42"
set_pr_view "OPEN" "BEHIND"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$REBASE_LOG" ] && pass "no dispatch on BEHIND" || fail "no dispatch on BEHIND" "log: $(cat "$REBASE_LOG")"
scratch_teardown

echo "test: first observation of DIRTY sets dirtySince, does not dispatch"
scratch_setup
make_signal "T-5" "pr-created" "42" "https://github.com/o/r/pull/42"
set_pr_view "OPEN" "DIRTY"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
DIRTY_SINCE=$(jq -r '.dirtySince // empty' "${ORCH_DIR}/workers/T-5.json")
[ -n "$DIRTY_SINCE" ] && pass "dirtySince recorded on first DIRTY observation" || fail "dirtySince recorded on first DIRTY observation"
[ ! -s "$REBASE_LOG" ] && pass "no dispatch on first observation" || fail "no dispatch on first observation"
scratch_teardown

echo "test: DIRTY within stable-minutes window does not dispatch"
scratch_setup
recent=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "1 minute ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-6" "pr-created" "42" "https://github.com/o/r/pull/42" "$recent"
set_pr_view "OPEN" "DIRTY"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 2 > "${SCRATCH}/out" 2>&1
[ ! -s "$REBASE_LOG" ] && pass "no dispatch within stable window" || fail "no dispatch within stable window"
scratch_teardown

echo "test: stable DIRTY dispatches rebase, bumps attempts"
scratch_setup
old=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-7" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "DIRTY" "main"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 2 > "${SCRATCH}/out" 2>&1
grep -q "REBASE_CALLED" "$REBASE_LOG" && pass "dispatched orchestrate-rebase" || fail "dispatched orchestrate-rebase" "log: $(cat "$REBASE_LOG")"
grep -q -- "--dispatch" "$REBASE_LOG" && pass "called with --dispatch flag" || fail "called with --dispatch flag" "log: $(cat "$REBASE_LOG")"
grep -q -- "--pr 42" "$REBASE_LOG" && pass "called with correct --pr" || fail "called with correct --pr" "log: $(cat "$REBASE_LOG")"
grep -q -- "--base-branch main" "$REBASE_LOG" && pass "called with --base-branch from PR view" || fail "called with --base-branch from PR view" "log: $(cat "$REBASE_LOG")"
grep -q "T-7" "$REBASE_LOG" && pass "called with ticket id" || fail "called with ticket id" "log: $(cat "$REBASE_LOG")"
ATTEMPTS=$(jq -r '.rebaseAttempts' "${ORCH_DIR}/workers/T-7.json")
[ "$ATTEMPTS" = "1" ] && pass "rebaseAttempts bumped to 1" || fail "rebaseAttempts bumped to 1" "got: $ATTEMPTS"
LAST=$(jq -r '.lastRebaseDispatchedAt // empty' "${ORCH_DIR}/workers/T-7.json")
[ -n "$LAST" ] && pass "lastRebaseDispatchedAt recorded" || fail "lastRebaseDispatchedAt recorded"
scratch_teardown

echo "test: PR with non-default base branch is forwarded to orchestrate-rebase"
scratch_setup
old=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-7b" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "DIRTY" "develop"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 2 > "${SCRATCH}/out" 2>&1
grep -q -- "--base-branch develop" "$REBASE_LOG" && pass "non-default base branch forwarded" || fail "non-default base branch forwarded" "log: $(cat "$REBASE_LOG")"
scratch_teardown

echo "test: rebaseAttempts at budget → escalates, does not dispatch"
scratch_setup
old=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-8" "pr-created" "42" "https://github.com/o/r/pull/42" "$old" "2"
set_pr_view "OPEN" "DIRTY" "main"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 2 --max-rebases 2 > "${SCRATCH}/out" 2>&1
grep -q "attention demo rebase-budget-exhausted T-8" "$STATE_LOG" \
  && pass "raised rebase-budget-exhausted attention" || fail "raised rebase-budget-exhausted attention" "log: $(cat "$STATE_LOG")"
[ ! -s "$REBASE_LOG" ] && pass "no dispatch after budget exhausted" || fail "no dispatch after budget exhausted" "log: $(cat "$REBASE_LOG")"
scratch_teardown

echo "test: --dry-run does not mutate signals or dispatch"
scratch_setup
old=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-9" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "DIRTY" "main"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 2 --dry-run > "${SCRATCH}/out" 2>&1
ATTEMPTS=$(jq -r '.rebaseAttempts // 0' "${ORCH_DIR}/workers/T-9.json")
[ "$ATTEMPTS" = "0" ] && pass "dry-run does not bump rebaseAttempts" || fail "dry-run does not bump rebaseAttempts" "got: $ATTEMPTS"
[ ! -s "$REBASE_LOG" ] && pass "dry-run does not invoke orchestrate-rebase" || fail "dry-run does not invoke orchestrate-rebase"
[ ! -s "$STATE_LOG" ] && pass "dry-run does not call state script" || fail "dry-run does not call state script"
scratch_teardown

echo "test: dispatch failure raises rebase-dispatch-failed attention"
scratch_setup
# Replace the rebase stub with one that fails
cat > "${SCRATCH}/bin/orchestrate-rebase" <<'EOF'
#!/usr/bin/env bash
echo "rebase stub failed" >&2
exit 1
EOF
chmod +x "${SCRATCH}/bin/orchestrate-rebase"
old=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-10" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "DIRTY" "main"
"$AUTO_REBASE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 2 > "${SCRATCH}/out" 2>&1
grep -q "attention demo rebase-dispatch-failed T-10" "$STATE_LOG" \
  && pass "raised rebase-dispatch-failed attention" || fail "raised rebase-dispatch-failed attention" "log: $(cat "$STATE_LOG")"
ATTEMPTS=$(jq -r '.rebaseAttempts // 0' "${ORCH_DIR}/workers/T-10.json")
[ "$ATTEMPTS" = "0" ] && pass "rebaseAttempts not bumped on dispatch failure" || fail "rebaseAttempts not bumped on dispatch failure" "got: $ATTEMPTS"
scratch_teardown

echo
echo "orchestrate-auto-rebase: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
