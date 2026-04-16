#!/usr/bin/env bash
# Shell tests for orchestrate-auto-fixup (CTL-64).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-auto-fixup.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
AUTO_FIXUP="${REPO_ROOT}/plugins/dev/scripts/orchestrate-auto-fixup"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/orchestrate/SKILL.md"

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

  # Stub orchestrate-fixup — records every dispatch invocation.
  cat > "${SCRATCH}/bin/orchestrate-fixup" <<'EOF'
#!/usr/bin/env bash
echo "FIXUP_CALLED $*" >> "$FIXUP_LOG"
EOF
  chmod +x "${SCRATCH}/bin/orchestrate-fixup"
  export FIXUP_LOG="${SCRATCH}/fixup.log"
  : > "$FIXUP_LOG"
  export CATALYST_AUTO_FIXUP_DISPATCH_BIN="${SCRATCH}/bin/orchestrate-fixup"

  # Stub gh — reads from a per-test fixture table.
  cat > "${SCRATCH}/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Route by command shape — the two calls we make are:
#   gh -R <repo> pr view <n> --json state,mergeStateStatus,reviewDecision,statusCheckRollup
#   gh api graphql -f query=... -F owner=... -F repo=... -F pr=...
args="$*"
if [[ "$args" == *"pr view"* ]]; then
  cat "$GH_PR_VIEW_FIXTURE"
elif [[ "$args" == *"api graphql"* ]]; then
  cat "$GH_THREADS_FIXTURE"
else
  echo "stub gh: unexpected invocation: $args" >&2
  exit 99
fi
EOF
  chmod +x "${SCRATCH}/bin/gh"
  export CATALYST_AUTO_FIXUP_GH_BIN="${SCRATCH}/bin/gh"

  # Default fixtures — overridden per-test via set_fixtures.
  export GH_PR_VIEW_FIXTURE="${SCRATCH}/pr-view.json"
  export GH_THREADS_FIXTURE="${SCRATCH}/threads.json"
  echo '{"state":"OPEN","mergeStateStatus":"CLEAN","reviewDecision":null,"statusCheckRollup":[]}' > "$GH_PR_VIEW_FIXTURE"
  echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' > "$GH_THREADS_FIXTURE"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset STATE_LOG FIXUP_LOG CATALYST_STATE_SCRIPT CATALYST_AUTO_FIXUP_DISPATCH_BIN CATALYST_AUTO_FIXUP_GH_BIN GH_PR_VIEW_FIXTURE GH_THREADS_FIXTURE SCRATCH ORCH_DIR
}

# Build a PR-view fixture with given merge state, review decision, and check conclusions.
set_pr_view() {
  local state="$1" merge_state="$2" review_dec="$3" checks_json="$4"
  if [ "$review_dec" = "null" ]; then
    jq -n --arg s "$state" --arg m "$merge_state" --argjson checks "$checks_json" \
      '{state:$s, mergeStateStatus:$m, reviewDecision:null, statusCheckRollup:$checks}' \
      > "$GH_PR_VIEW_FIXTURE"
  else
    jq -n --arg s "$state" --arg m "$merge_state" --arg r "$review_dec" --argjson checks "$checks_json" \
      '{state:$s, mergeStateStatus:$m, reviewDecision:$r, statusCheckRollup:$checks}' \
      > "$GH_PR_VIEW_FIXTURE"
  fi
}

# Build a threads fixture with given unresolved thread nodes. Input is a JSON array
# of {path, line, author, body} objects.
set_threads() {
  local threads_json="$1"
  jq -n --argjson t "$threads_json" \
    '{data:{repository:{pullRequest:{reviewThreads:{nodes:[$t[] | {isResolved:false, isOutdated:false, path:.path, line:.line, comments:{nodes:[{author:{login:.author}, body:.body}]}}]}}}}}' \
    > "$GH_THREADS_FIXTURE"
}

# Seed a worker signal at ORCH_DIR/workers/<ticket>.json
make_signal() {
  # Args: TICKET STATUS PR_NUMBER PR_URL [BLOCKED_SINCE] [FIXUP_ATTEMPTS]
  local ticket="$1" status="$2" pr_num="$3" pr_url="$4"
  local blocked_since="${5:-}" attempts="${6:-0}"
  local now="2026-04-16T12:00:00Z"

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

  if [ -n "$blocked_since" ]; then
    base=$(echo "$base" | jq --arg bs "$blocked_since" '.blockedSince = $bs')
  fi
  if [ -n "$attempts" ] && [ "$attempts" != "0" ]; then
    base=$(echo "$base" | jq --argjson a "$attempts" '.fixupAttempts = $a')
  fi
  echo "$base" > "${ORCH_DIR}/workers/${ticket}.json"
}

# ---

echo "orchestrate-auto-fixup tests"
echo

echo "test: missing --orch-dir fails"
set +e
"$AUTO_FIXUP" --orch-id demo 2>/dev/null; RC=$?
set -e
[ "$RC" != "0" ] && pass "errors without --orch-dir" || fail "errors without --orch-dir" "rc=$RC"

echo "test: missing --orch-id fails"
set +e
"$AUTO_FIXUP" --orch-dir /tmp 2>/dev/null; RC=$?
set -e
[ "$RC" != "0" ] && pass "errors without --orch-id" || fail "errors without --orch-id" "rc=$RC"

echo "test: empty workers dir is a clean no-op"
scratch_setup
OUT=$("$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo 2>/dev/null)
CHECKED=$(echo "$OUT" | jq -r '.checked' 2>/dev/null || echo "?")
[ "$CHECKED" = "0" ] && pass "summary.checked=0 when no signals" || fail "summary.checked=0 when no signals" "got: $CHECKED; out: $OUT"
[ ! -s "$FIXUP_LOG" ] && pass "no fixup dispatch when empty" || fail "no fixup dispatch when empty" "log: $(cat "$FIXUP_LOG")"
scratch_teardown

echo "test: worker without PR is skipped"
scratch_setup
make_signal "T-1" "implementing" "" ""
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch for PR-less worker" || fail "no dispatch for PR-less worker"
BLOCKED_SINCE=$(jq -r '.blockedSince // empty' "${ORCH_DIR}/workers/T-1.json")
[ -z "$BLOCKED_SINCE" ] && pass "no blockedSince written for PR-less worker" || fail "no blockedSince written for PR-less worker" "got: $BLOCKED_SINCE"
scratch_teardown

echo "test: terminal worker is skipped"
scratch_setup
make_signal "T-2" "done" "42" "https://github.com/o/r/pull/42"
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch for terminal worker" || fail "no dispatch for terminal worker"
scratch_teardown

echo "test: MERGED PR is skipped (state != OPEN)"
scratch_setup
make_signal "T-3" "pr-created" "42" "https://github.com/o/r/pull/42"
set_pr_view "MERGED" "UNKNOWN" "null" "[]"
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch when PR merged" || fail "no dispatch when PR merged"
scratch_teardown

echo "test: non-BLOCKED OPEN PR clears blockedSince and skips"
scratch_setup
make_signal "T-4" "pr-created" "42" "https://github.com/o/r/pull/42" "2026-04-16T11:00:00Z"
set_pr_view "OPEN" "CLEAN" "null" "[]"
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
BLOCKED_SINCE=$(jq -r '.blockedSince // empty' "${ORCH_DIR}/workers/T-4.json")
[ -z "$BLOCKED_SINCE" ] && pass "blockedSince cleared when PR is no longer blocked" || fail "blockedSince cleared when PR is no longer blocked" "got: $BLOCKED_SINCE"
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch on CLEAN" || fail "no dispatch on CLEAN"
scratch_teardown

echo "test: first observation of BLOCKED sets blockedSince, does not dispatch"
scratch_setup
make_signal "T-5" "pr-created" "42" "https://github.com/o/r/pull/42"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" "[]"
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
BLOCKED_SINCE=$(jq -r '.blockedSince // empty' "${ORCH_DIR}/workers/T-5.json")
[ -n "$BLOCKED_SINCE" ] && pass "blockedSince recorded on first BLOCKED observation" || fail "blockedSince recorded on first BLOCKED observation"
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch on first observation" || fail "no dispatch on first observation"
scratch_teardown

echo "test: BLOCKED within stable-minutes window does not dispatch"
scratch_setup
# blockedSince 5 minutes ago, stable-minutes=10 → not yet actionable.
recent=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "5 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-6" "pr-created" "42" "https://github.com/o/r/pull/42" "$recent"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" "[]"
set_threads '[{"path":"a.ts","line":1,"author":"codex-bot","body":"fix x"}]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch within stable window" || fail "no dispatch within stable window"
scratch_teardown

echo "test: stable BLOCKED with failing required check → checks-failing attention, no dispatch"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-7" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "BLOCKED" "APPROVED" '[{"conclusion":"FAILURE","status":"COMPLETED","name":"ci"}]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
grep -q "attention demo checks-failing T-7" "$STATE_LOG" \
  && pass "raised checks-failing attention" || fail "raised checks-failing attention" "log: $(cat "$STATE_LOG")"
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch when checks are failing" || fail "no dispatch when checks are failing"
scratch_teardown

echo "test: stable BLOCKED + CI running (IN_PROGRESS) defers (no dispatch, no attention)"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-8" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" '[{"conclusion":null,"status":"IN_PROGRESS","name":"ci"}]'
set_threads '[{"path":"a.ts","line":1,"author":"codex-bot","body":"fix x"}]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch while CI still running" || fail "no dispatch while CI still running"
[ ! -s "$STATE_LOG" ] && pass "no attention raised while CI still running" || fail "no attention raised while CI still running" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: stable BLOCKED + CI passing + unresolved threads → dispatches fixup, bumps attempts"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-9" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" '[{"conclusion":"SUCCESS","status":"COMPLETED","name":"ci"}]'
set_threads '[{"path":"src/foo.ts","line":42,"author":"codex-bot","body":"Missing null check on session"},{"path":"src/bar.ts","line":7,"author":"codex-bot","body":"Timing attack in compare"}]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
grep -q "FIXUP_CALLED" "$FIXUP_LOG" && pass "dispatched orchestrate-fixup" || fail "dispatched orchestrate-fixup" "log: $(cat "$FIXUP_LOG")"
grep -q -- "--dispatch" "$FIXUP_LOG" && pass "called with --dispatch flag" || fail "called with --dispatch flag" "log: $(cat "$FIXUP_LOG")"
grep -q -- "--pr 42" "$FIXUP_LOG" && pass "called with correct --pr" || fail "called with correct --pr" "log: $(cat "$FIXUP_LOG")"
grep -q "T-9" "$FIXUP_LOG" && pass "called with ticket id" || fail "called with ticket id" "log: $(cat "$FIXUP_LOG")"
ATTEMPTS=$(jq -r '.fixupAttempts' "${ORCH_DIR}/workers/T-9.json")
[ "$ATTEMPTS" = "1" ] && pass "fixupAttempts bumped to 1" || fail "fixupAttempts bumped to 1" "got: $ATTEMPTS"
LAST=$(jq -r '.lastFixupDispatchedAt // empty' "${ORCH_DIR}/workers/T-9.json")
[ -n "$LAST" ] && pass "lastFixupDispatchedAt recorded" || fail "lastFixupDispatchedAt recorded"
scratch_teardown

echo "test: stable BLOCKED + CI passing + REVIEW_REQUIRED + no threads → review-required attention, no dispatch"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-10" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "BLOCKED" "REVIEW_REQUIRED" '[{"conclusion":"SUCCESS","status":"COMPLETED","name":"ci"}]'
set_threads '[]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
grep -q "attention demo review-required T-10" "$STATE_LOG" \
  && pass "raised review-required attention" || fail "raised review-required attention" "log: $(cat "$STATE_LOG")"
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch when review-required only" || fail "no dispatch when review-required only" "log: $(cat "$FIXUP_LOG")"
scratch_teardown

echo "test: fixupAttempts at budget → escalates, does not dispatch"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-11" "pr-created" "42" "https://github.com/o/r/pull/42" "$old" "2"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" '[{"conclusion":"SUCCESS","status":"COMPLETED","name":"ci"}]'
set_threads '[{"path":"a.ts","line":1,"author":"codex-bot","body":"still broken"}]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 --max-fixups 2 > "${SCRATCH}/out" 2>&1
grep -q "attention demo fixup-budget-exhausted T-11" "$STATE_LOG" \
  && pass "raised fixup-budget-exhausted attention" || fail "raised fixup-budget-exhausted attention" "log: $(cat "$STATE_LOG")"
[ ! -s "$FIXUP_LOG" ] && pass "no dispatch after budget exhausted" || fail "no dispatch after budget exhausted" "log: $(cat "$FIXUP_LOG")"
scratch_teardown

echo "test: --dry-run does not mutate signals or dispatch"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-12" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" '[{"conclusion":"SUCCESS","status":"COMPLETED","name":"ci"}]'
set_threads '[{"path":"a.ts","line":1,"author":"codex-bot","body":"fix x"}]'
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 --dry-run > "${SCRATCH}/out" 2>&1
ATTEMPTS=$(jq -r '.fixupAttempts // 0' "${ORCH_DIR}/workers/T-12.json")
[ "$ATTEMPTS" = "0" ] && pass "dry-run does not bump fixupAttempts" || fail "dry-run does not bump fixupAttempts" "got: $ATTEMPTS"
[ ! -s "$FIXUP_LOG" ] && pass "dry-run does not invoke orchestrate-fixup" || fail "dry-run does not invoke orchestrate-fixup"
[ ! -s "$STATE_LOG" ] && pass "dry-run does not call state script" || fail "dry-run does not call state script"
scratch_teardown

echo "test: non-worker JSON files are ignored gracefully"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-13" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
echo '{"notASignal": true}' > "${ORCH_DIR}/workers/junk.json"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" '[{"conclusion":"SUCCESS","status":"COMPLETED","name":"ci"}]'
set_threads '[{"path":"a.ts","line":1,"author":"codex-bot","body":"fix x"}]'
set +e
"$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
RC=$?
set -e
[ "$RC" = "0" ] && pass "non-signal JSON does not crash" || fail "non-signal JSON does not crash" "rc=$RC; out: $(cat "${SCRATCH}/out")"
grep -q "FIXUP_CALLED" "$FIXUP_LOG" && pass "dispatches for real worker despite junk file" || fail "dispatches for real worker despite junk file"
scratch_teardown

echo "test: summary JSON on stdout"
scratch_setup
old=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
make_signal "T-14" "pr-created" "42" "https://github.com/o/r/pull/42" "$old"
set_pr_view "OPEN" "BLOCKED" "CHANGES_REQUESTED" '[{"conclusion":"SUCCESS","status":"COMPLETED","name":"ci"}]'
set_threads '[{"path":"a.ts","line":1,"author":"codex-bot","body":"fix x"}]'
OUT=$("$AUTO_FIXUP" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
CHECKED=$(echo "$OUT" | jq -r '.checked' 2>/dev/null || echo "?")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched' 2>/dev/null || echo "?")
[ "$CHECKED" = "1" ] && pass "summary.checked=1" || fail "summary.checked=1" "got: $CHECKED; out: $OUT"
[ "$DISPATCHED" = "1" ] && pass "summary.dispatched=1" || fail "summary.dispatched=1" "got: $DISPATCHED; out: $OUT"
scratch_teardown

echo
echo "test: SKILL.md documents the new script (prevents doc drift)"
grep -q "orchestrate-auto-fixup" "$SKILL_MD" \
  && pass "SKILL.md references orchestrate-auto-fixup" || fail "SKILL.md references orchestrate-auto-fixup"
grep -q "blockedSince" "$SKILL_MD" \
  && pass "SKILL.md documents blockedSince field" || fail "SKILL.md documents blockedSince field"
grep -q "fixupAttempts" "$SKILL_MD" \
  && pass "SKILL.md documents fixupAttempts field" || fail "SKILL.md documents fixupAttempts field"

echo
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
