#!/usr/bin/env bash
# Shell tests for orchestrate-resolve-fixed-threads (CTL-378).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-resolve-fixed-threads.test.sh
#
# Harness mirrors orchestrate-auto-fixup.test.sh: scratch dir, stubbed gh +
# state script that read per-test fixture files. The stub gh routes the call
# shapes this script makes:
#   gh -R <repo> pr view <n> --json state,mergeStateStatus,...   → PR-view fixture
#   gh -R <repo> pr view <n> --json commits                      → commits fixture
#   gh api graphql ... reviewThreads ...                         → threads fixture
#   gh api graphql ... resolveReviewThread ...                   → mutation (logged)
#   gh -R <repo> api repos/.../commits/<sha>                     → changed-files fixture
#   gh -R <repo> api repos/.../pulls/<n>                         → REST recheck fixture

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RESOLVE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-resolve-fixed-threads"
SKILL_MD="${REPO_ROOT}/plugins/legacy/skills/orchestrate/SKILL.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
# Always return 0: the arg-validation tests leave `set -e` active, and a
# single-arg fail() would otherwise return non-zero and abort the run early,
# masking the remaining tests. Totals are reported via $FAILURES at the end.
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; return 0; }

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

  # Stub gh — routes by command shape, reads per-test fixtures, logs mutations.
  cat > "${SCRATCH}/bin/gh" <<'EOF'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"resolveReviewThread"* ]]; then
  # Resolve mutation — log the full call (so tests can assert the threadId) and
  # return a success envelope.
  echo "RESOLVE_CALLED $args" >> "$RESOLVE_LOG"
  echo '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
elif [[ "$args" == *"api graphql"* ]]; then
  # reviewThreads query
  cat "$GH_THREADS_FIXTURE"
elif [[ "$args" == *"pr view"*"--json commits"* || "$args" == *"--json commits"* ]]; then
  cat "$GH_COMMITS_FIXTURE"
elif [[ "$args" == *"pr view"* ]]; then
  cat "$GH_PR_VIEW_FIXTURE"
elif [[ "$args" == *"api"*"/commits/"* ]]; then
  # changed files for a commit sha
  cat "$GH_CHANGED_FILES_FIXTURE"
elif [[ "$args" == *"api"*"/pulls/"* ]]; then
  # REST merge recheck
  echo "RECHECK_CALLED $args" >> "$RECHECK_LOG"
  cat "$GH_REST_FIXTURE"
else
  echo "stub gh: unexpected invocation: $args" >&2
  exit 99
fi
EOF
  chmod +x "${SCRATCH}/bin/gh"
  export CATALYST_RESOLVE_THREADS_GH_BIN="${SCRATCH}/bin/gh"

  export RESOLVE_LOG="${SCRATCH}/resolve.log"; : > "$RESOLVE_LOG"
  export RECHECK_LOG="${SCRATCH}/recheck.log"; : > "$RECHECK_LOG"

  # Default fixtures — overridden per-test.
  export GH_PR_VIEW_FIXTURE="${SCRATCH}/pr-view.json"
  export GH_THREADS_FIXTURE="${SCRATCH}/threads.json"
  export GH_COMMITS_FIXTURE="${SCRATCH}/commits.json"
  export GH_CHANGED_FILES_FIXTURE="${SCRATCH}/changed-files.json"
  export GH_REST_FIXTURE="${SCRATCH}/rest.json"
  echo '{"state":"OPEN","mergeStateStatus":"CLEAN"}' > "$GH_PR_VIEW_FIXTURE"
  echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' > "$GH_THREADS_FIXTURE"
  echo '{"commits":[{"oid":"deadbeef","committedDate":"2026-04-16T11:30:00Z"}]}' > "$GH_COMMITS_FIXTURE"
  echo '{"files":[]}' > "$GH_CHANGED_FILES_FIXTURE"
  echo '{"mergeable_state":"clean"}' > "$GH_REST_FIXTURE"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset STATE_LOG CATALYST_STATE_SCRIPT CATALYST_RESOLVE_THREADS_GH_BIN \
        RESOLVE_LOG RECHECK_LOG GH_PR_VIEW_FIXTURE GH_THREADS_FIXTURE \
        GH_COMMITS_FIXTURE GH_CHANGED_FILES_FIXTURE GH_REST_FIXTURE SCRATCH ORCH_DIR
}

# Build a PR-view fixture (state + mergeStateStatus only — this pass doesn't
# classify checks).
set_pr_view() {
  local state="$1" merge_state="$2"
  jq -n --arg s "$state" --arg m "$merge_state" \
    '{state:$s, mergeStateStatus:$m}' > "$GH_PR_VIEW_FIXTURE"
}

# Build a threads fixture. Input: JSON array of thread objects with keys
# id, path, line, author, type (__typename), createdAt, body, and optional
# isResolved/isOutdated (default false).
set_threads() {
  local threads_json="$1"
  jq -n --argjson t "$threads_json" '
    {data:{repository:{pullRequest:{reviewThreads:{nodes:[
      $t[] | {
        id: .id,
        isResolved: (.isResolved // false),
        isOutdated: (.isOutdated // false),
        path: .path,
        line: .line,
        comments: {nodes: [
          {author: {login: .author, __typename: .type},
           createdAt: .createdAt,
           body: .body}
        ]}
      }
    ]}}}}}' > "$GH_THREADS_FIXTURE"
}

# Build the PR last-commit fixture (gh pr view --json commits).
set_commits() {
  local oid="$1" committed_date="$2"
  jq -n --arg o "$oid" --arg d "$committed_date" \
    '{commits:[{oid:$o, committedDate:$d}]}' > "$GH_COMMITS_FIXTURE"
}

# Build the changed-files fixture (gh api repos/.../commits/<sha>).
# Input: JSON array of filename strings.
set_changed_files() {
  local files_json="$1"
  jq -n --argjson f "$files_json" '{files:[$f[] | {filename:.}]}' > "$GH_CHANGED_FILES_FIXTURE"
}

# Build the REST recheck fixture.
set_rest() {
  local mergeable_state="$1"
  jq -n --arg m "$mergeable_state" '{mergeable_state:$m}' > "$GH_REST_FIXTURE"
}

# Seed a worker signal at ORCH_DIR/workers/<ticket>.json
# Args: TICKET STATUS PR_NUMBER PR_URL [BLOCKED_SINCE]
make_signal() {
  local ticket="$1" status="$2" pr_num="$3" pr_url="$4"
  local blocked_since="${5:-}"
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
  echo "$base" > "${ORCH_DIR}/workers/${ticket}.json"
}

ts_ago() {
  # minutes-ago ISO timestamp, portable across BSD/GNU date.
  local mins="$1"
  date -u -v-"${mins}"M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "${mins} minutes ago" +%Y-%m-%dT%H:%M:%SZ
}

# ─────────────────────────────────────────────────────────────────────────────

echo "orchestrate-resolve-fixed-threads tests"
echo

# ── Phase 1: arg validation + skip gates + summary shape ─────────────────────

echo "test: missing --orch-dir fails"
set +e
"$RESOLVE" --orch-id demo 2>/dev/null; RC=$?
set -e
[ "$RC" != "0" ] && pass "errors without --orch-dir" || fail "errors without --orch-dir" "rc=$RC"

echo "test: missing --orch-id fails"
set +e
"$RESOLVE" --orch-dir /tmp 2>/dev/null; RC=$?
set -e
[ "$RC" != "0" ] && pass "errors without --orch-id" || fail "errors without --orch-id" "rc=$RC"

echo "test: empty workers dir is a clean no-op"
scratch_setup
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo 2>/dev/null)
CHECKED=$(echo "$OUT" | jq -r '.checked' 2>/dev/null || echo "?")
RESOLVED=$(echo "$OUT" | jq -r '.resolved' 2>/dev/null || echo "?")
[ "$CHECKED" = "0" ] && pass "summary.checked=0 when no signals" || fail "summary.checked=0 when no signals" "got: $CHECKED; out: $OUT"
[ "$RESOLVED" = "0" ] && pass "summary.resolved=0 when no signals" || fail "summary.resolved=0 when no signals" "got: $RESOLVED; out: $OUT"
scratch_teardown

echo "test: summary JSON has all four numeric keys"
scratch_setup
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo 2>/dev/null)
for k in checked resolved rechecked skipped; do
  V=$(echo "$OUT" | jq -r ".$k" 2>/dev/null || echo "?")
  case "$V" in
    ''|*[!0-9]*) fail "summary.$k is numeric" "got: $V; out: $OUT" ;;
    *) pass "summary.$k is numeric ($V)" ;;
  esac
done
scratch_teardown

echo "test: terminal worker (done) is skipped, no resolve"
scratch_setup
make_signal "T-1" "done" "42" "https://github.com/o/r/pull/42" "$(ts_ago 30)"
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve for terminal worker" || fail "no resolve for terminal worker" "log: $(cat "$RESOLVE_LOG")"
scratch_teardown

echo "test: worker without pr.number/url is skipped"
scratch_setup
make_signal "T-2" "implementing" "" ""
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve for PR-less worker" || fail "no resolve for PR-less worker"
scratch_teardown

echo "test: state != OPEN (MERGED) is skipped"
scratch_setup
make_signal "T-3" "pr-created" "42" "https://github.com/o/r/pull/42" "$(ts_ago 30)"
set_pr_view "MERGED" "UNKNOWN"
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve when PR merged" || fail "no resolve when PR merged"
scratch_teardown

echo "test: mergeStateStatus != BLOCKED (CLEAN) is skipped"
scratch_setup
make_signal "T-4" "pr-created" "42" "https://github.com/o/r/pull/42" "$(ts_ago 30)"
set_pr_view "OPEN" "CLEAN"
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve when PR clean" || fail "no resolve when PR clean"
scratch_teardown

echo "test: BLOCKED but blockedSince absent → skipped, does NOT write blockedSince"
scratch_setup
make_signal "T-5" "pr-created" "42" "https://github.com/o/r/pull/42"   # no blockedSince
set_pr_view "OPEN" "BLOCKED"
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
BS=$(jq -r '.blockedSince // empty' "${ORCH_DIR}/workers/T-5.json")
[ -z "$BS" ] && pass "blockedSince not written (auto-fixup owns it)" || fail "blockedSince not written" "got: $BS"
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve when blockedSince absent" || fail "no resolve when blockedSince absent"
scratch_teardown

echo "test: BLOCKED within stable window is skipped"
scratch_setup
make_signal "T-6" "pr-created" "42" "https://github.com/o/r/pull/42" "$(ts_ago 5)"
set_pr_view "OPEN" "BLOCKED"
set_threads '[{"id":"TH1","path":"a.ts","line":1,"author":"codex","type":"Bot","createdAt":"2026-04-16T10:00:00Z","body":"fix x"}]'
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 > "${SCRATCH}/out" 2>&1
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve within stable window" || fail "no resolve within stable window"
scratch_teardown

echo "test: non-signal junk JSON does not crash"
scratch_setup
echo '{"notASignal": true}' > "${ORCH_DIR}/workers/junk.json"
set +e
"$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo > "${SCRATCH}/out" 2>&1
RC=$?
set -e
[ "$RC" = "0" ] && pass "junk JSON does not crash (rc=0)" || fail "junk JSON does not crash" "rc=$RC; out: $(cat "${SCRATCH}/out")"
scratch_teardown

# ── Phase 2: eligibility predicate + resolution + recheck ────────────────────
#
# Eligibility = bot author AND last-commit touches thread path AND commit landed
# after the thread's comment. Default commits fixture: committedDate
# 2026-04-16T11:30:00Z. A "before" comment is 11:00:00Z; an "after" one is 11:45.

# Seed a stable BLOCKED worker ready for resolution. Sets ticket R-<n>.
seed_blocked() {
  local ticket="$1"
  make_signal "$ticket" "pr-created" "42" "https://github.com/o/r/pull/42" "$(ts_ago 30)"
  set_pr_view "OPEN" "BLOCKED"
  set_commits "abc123" "2026-04-16T11:30:00Z"
  set_rest "blocked"
}

echo
echo "test: (A) eligible bot thread (touched path, commit after comment) → RESOLVED"
scratch_setup
seed_blocked "R-1"
set_changed_files '["src/foo.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check"}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "1" ] && pass "summary.resolved=1" || fail "summary.resolved=1" "out: $OUT"
grep -q "TH1" "$RESOLVE_LOG" && pass "resolveReviewThread called with thread id TH1" || fail "resolveReviewThread called with TH1" "log: $(cat "$RESOLVE_LOG")"
CNT=$(jq -r '.resolvedThreadCount // 0' "${ORCH_DIR}/workers/R-1.json")
[ "$CNT" = "1" ] && pass "signal resolvedThreadCount=1" || fail "signal resolvedThreadCount=1" "got: $CNT"
TRA=$(jq -r '.threadsResolvedAt // empty' "${ORCH_DIR}/workers/R-1.json")
[ -n "$TRA" ] && pass "signal threadsResolvedAt set" || fail "signal threadsResolvedAt set"
grep -q "worker-threads-auto-resolved" "$STATE_LOG" && pass "emitted worker-threads-auto-resolved event" || fail "emitted worker-threads-auto-resolved event" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: (H) after resolving, authoritative REST recheck is invoked, rechecked=1"
scratch_setup
seed_blocked "R-1H"
set_changed_files '["src/foo.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check"}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RECH=$(echo "$OUT" | jq -r '.rechecked')
[ "$RECH" = "1" ] && pass "summary.rechecked=1" || fail "summary.rechecked=1" "out: $OUT"
grep -q "RECHECK_CALLED" "$RECHECK_LOG" && grep -q "/pulls/42" "$RECHECK_LOG" && pass "REST recheck called on pulls/42" || fail "REST recheck called on pulls/42" "log: $(cat "$RECHECK_LOG")"
scratch_teardown

echo "test: (B) human-authored thread is NEVER resolved"
scratch_setup
seed_blocked "R-2"
set_changed_files '["src/foo.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"alice","type":"User","createdAt":"2026-04-16T11:00:00Z","body":"please fix"}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "0" ] && pass "human thread not resolved (.resolved=0)" || fail "human thread not resolved" "out: $OUT"
[ ! -s "$RESOLVE_LOG" ] && pass "no resolveReviewThread call for human thread" || fail "no resolveReviewThread call for human thread" "log: $(cat "$RESOLVE_LOG")"
scratch_teardown

echo "test: (C) bot thread whose path the last commit did NOT touch → not resolved"
scratch_setup
seed_blocked "R-3"
set_changed_files '["src/other.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check"}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "0" ] && pass "untouched-path thread not resolved" || fail "untouched-path thread not resolved" "out: $OUT"
[ ! -s "$RESOLVE_LOG" ] && pass "no resolve when path untouched" || fail "no resolve when path untouched"
scratch_teardown

echo "test: (D) bot thread whose comment is NEWER than the last commit → not resolved"
scratch_setup
seed_blocked "R-4"
set_changed_files '["src/foo.ts"]'
# commit committedDate 11:30; comment raised at 11:45 (AFTER the push) → not addressed.
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:45:00Z","body":"new concern"}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "0" ] && pass "comment-after-commit thread not resolved" || fail "comment-after-commit thread not resolved" "out: $OUT"
scratch_teardown

echo "test: (E) already-resolved thread is never selected"
scratch_setup
seed_blocked "R-5"
set_changed_files '["src/foo.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check","isResolved":true}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "0" ] && pass "already-resolved thread not re-resolved" || fail "already-resolved thread not re-resolved" "out: $OUT"
scratch_teardown

echo "test: (I) outdated thread is never selected"
scratch_setup
seed_blocked "R-6"
set_changed_files '["src/foo.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check","isOutdated":true}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "0" ] && pass "outdated thread not resolved" || fail "outdated thread not resolved" "out: $OUT"
scratch_teardown

echo "test: (F) mixed set resolves exactly the eligible bot thread"
scratch_setup
seed_blocked "R-7"
set_changed_files '["src/foo.ts"]'
set_threads '[
  {"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"eligible"},
  {"id":"TH2","path":"src/foo.ts","line":7,"author":"alice","type":"User","createdAt":"2026-04-16T11:00:00Z","body":"human"},
  {"id":"TH3","path":"src/bar.ts","line":1,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"untouched path"}
]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "1" ] && pass "exactly 1 thread resolved in mixed set" || fail "exactly 1 thread resolved in mixed set" "out: $OUT"
grep -q "TH1" "$RESOLVE_LOG" && pass "resolved the eligible bot thread TH1" || fail "resolved TH1" "log: $(cat "$RESOLVE_LOG")"
grep -q "TH2" "$RESOLVE_LOG" && fail "human thread TH2 must not be resolved" "log: $(cat "$RESOLVE_LOG")" || pass "human thread TH2 left unresolved"
grep -q "TH3" "$RESOLVE_LOG" && fail "untouched-path thread TH3 must not be resolved" "log: $(cat "$RESOLVE_LOG")" || pass "untouched-path thread TH3 left unresolved"
scratch_teardown

echo "test: (J) a thread with null createdAt does not abort the stream; valid thread still resolves"
scratch_setup
seed_blocked "R-9"
set_changed_files '["src/foo.ts"]'
# TH_NULL has a null createdAt (must be dropped without killing the jq stream);
# TH_OK is fully eligible and must still be resolved.
set_threads '[
  {"id":"TH_NULL","path":"src/foo.ts","line":3,"author":"codex","type":"Bot","createdAt":null,"body":"weird"},
  {"id":"TH_OK","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check"}
]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "1" ] && pass "valid thread resolved despite null-createdAt sibling (.resolved=1)" || fail "valid thread resolved despite null-createdAt sibling" "out: $OUT"
grep -q "TH_OK" "$RESOLVE_LOG" && pass "resolved the valid thread TH_OK" || fail "resolved TH_OK" "log: $(cat "$RESOLVE_LOG")"
grep -q "TH_NULL" "$RESOLVE_LOG" && fail "null-createdAt thread must not be resolved" "log: $(cat "$RESOLVE_LOG")" || pass "null-createdAt thread left unresolved"
scratch_teardown

echo "test: (G) --dry-run counts would-resolve but mutates nothing"
scratch_setup
seed_blocked "R-8"
set_changed_files '["src/foo.ts"]'
set_threads '[{"id":"TH1","path":"src/foo.ts","line":42,"author":"codex","type":"Bot","createdAt":"2026-04-16T11:00:00Z","body":"null check"}]'
OUT=$("$RESOLVE" --orch-dir "$ORCH_DIR" --orch-id demo --stable-minutes 10 --dry-run 2>/dev/null)
RES=$(echo "$OUT" | jq -r '.resolved')
[ "$RES" = "1" ] && pass "dry-run counts the would-resolve (.resolved=1)" || fail "dry-run counts would-resolve" "out: $OUT"
[ ! -s "$RESOLVE_LOG" ] && pass "dry-run makes no resolveReviewThread call" || fail "dry-run makes no resolveReviewThread call" "log: $(cat "$RESOLVE_LOG")"
[ ! -s "$STATE_LOG" ] && pass "dry-run makes no state-script call" || fail "dry-run makes no state-script call" "log: $(cat "$STATE_LOG")"
CNT=$(jq -r '.resolvedThreadCount // empty' "${ORCH_DIR}/workers/R-8.json")
[ -z "$CNT" ] && pass "dry-run does not mutate the signal" || fail "dry-run does not mutate the signal" "got: $CNT"
scratch_teardown

# ── Phase 3: SKILL.md wiring + doc-drift guard ───────────────────────────────

echo
echo "test: SKILL.md references the new script (prevents doc drift)"
grep -q "orchestrate-resolve-fixed-threads" "$SKILL_MD" \
  && pass "SKILL.md references orchestrate-resolve-fixed-threads" || fail "SKILL.md references orchestrate-resolve-fixed-threads"

echo "test: SKILL.md documents the resolvedThreadCount signal field"
grep -q "resolvedThreadCount" "$SKILL_MD" \
  && pass "SKILL.md documents resolvedThreadCount" || fail "SKILL.md documents resolvedThreadCount"

echo "test: the new step is documented BEFORE orchestrate-auto-fixup"
# `|| true` keeps a no-match (grep rc=1) from aborting under the active `set -e`.
RESOLVE_LINE=$(grep -n "orchestrate-resolve-fixed-threads" "$SKILL_MD" | head -1 | cut -d: -f1 || true)
# CTL-726: invocation is now `"${CATALYST_DEV_SCRIPTS}/orchestrate-auto-fixup"`
# (was `"${CLAUDE_PLUGIN_ROOT}/scripts/..."`); match the resolver-agnostic tail.
FIXUP_LINE=$(grep -n '/orchestrate-auto-fixup"' "$SKILL_MD" | head -1 | cut -d: -f1 || true)
if [ -n "$RESOLVE_LINE" ] && [ -n "$FIXUP_LINE" ] && [ "$RESOLVE_LINE" -lt "$FIXUP_LINE" ]; then
  pass "resolve-fixed-threads step precedes auto-fixup (resolve@${RESOLVE_LINE} < fixup@${FIXUP_LINE})"
else
  fail "resolve-fixed-threads step precedes auto-fixup" "resolve@${RESOLVE_LINE:-none} fixup@${FIXUP_LINE:-none}"
fi

echo
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
