#!/usr/bin/env bash
# E2E test for plugins/dev/skills/phase-monitor-deploy/SKILL.md (CTL-451).
#
# Strategy:
#   1. Build tempdir scratch worker dir with a fixture phase-pr.json.
#   2. Pre-write a fixture deployment_status event into CATALYST_EVENTS_FILE
#      so `catalyst-events wait-for` matches the historical event on its first
#      pass (no live timing required).
#   3. Override PHASE_CANARY_CMD to a stub that writes a fixture canary result.
#   4. Extract the executable bash body from the skill (fenced
#      ```bash phase-monitor-deploy-body```) and run with TICKET set.
#   5. Assert phase-monitor-deploy.json shape + emitted event + canary stub
#      was invoked exactly once.
#
# Three cases:
#   success  — deploy success + canary success → phase.monitor-deploy.complete
#   failure  — deploy failure → phase.monitor-deploy.failed (no canary)
#   skipped  — no deploy event before timeout → phase.monitor-deploy.skipped
#
# Run: bash plugins/dev/scripts/__tests__/phase-monitor-deploy-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_FILE="${REPO_ROOT}/plugins/dev/skills/phase-monitor-deploy/SKILL.md"
# CTL-1410 Phase A: every terminal emit rides the production wrapper now.
EMIT_WRAPPER="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "$2"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
assert_file_exists() { if [ -f "$2" ]; then ok "$1"; else fail "$1" "missing file: $2"; fi; }

# CTL-1410 Phase A: every terminal emit now flows through the phase-agent-emit-complete
# wrapper, which appends to $CATALYST_DIR/events/YYYY-MM.jsonl (not the lib-only
# $CATALYST_EVENTS_FILE). Read the last phase event line from a case's catalyst dir.
read_phase_event_line() {
  local catalyst_dir="$1" month
  month=$(date -u +%Y-%m)
  local logfile="${catalyst_dir}/events/${month}.jsonl"
  [ -f "$logfile" ] || { echo ""; return 1; }
  grep -F '"event.name":"phase.' "$logfile" | tail -1
}

if ! command -v catalyst-events >/dev/null 2>&1; then
  echo "SKIP: catalyst-events not on PATH — phase-monitor-deploy needs it" >&2
  exit 0
fi

[ -f "$SKILL_FILE" ]  || { echo "FAIL: skill missing: $SKILL_FILE";   exit 1; }
[ -x "$EMIT_WRAPPER" ] || { echo "FAIL: wrapper missing/not executable: $EMIT_WRAPPER"; exit 1; }

# Extract the executable bash body delimited by ```bash phase-monitor-deploy-body```.
SKILL_BODY_FILE="$(mktemp -t phase-monitor-deploy-body.XXXXXX.sh)"
awk '
  /^```bash phase-monitor-deploy-body$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_FILE" > "$SKILL_BODY_FILE"

if [ ! -s "$SKILL_BODY_FILE" ]; then
  echo "FAIL: could not extract phase-monitor-deploy-body block from $SKILL_FILE" >&2
  exit 1
fi

TMPROOT="$(mktemp -d -t phase-monitor-deploy-test.XXXXXX)"
trap 'rm -rf "$TMPROOT" "$SKILL_BODY_FILE"' EXIT

# Helper: write a fixture canonical OTel event line for a deployment_status into $1.
# $2 = sha, $3 = env, $4 = state ("success"|"failure"), $5 = environmentUrl (optional)
write_deploy_event() {
  local out_file="$1" sha="$2" env="$3" state="$4" url="${5:-}"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sha "$sha" --arg env "$env" --arg state "$state" --arg url "$url" \
    '{
      ts: $ts,
      id: "fixture-deploy-event",
      severityText: "INFO",
      severityNumber: 9,
      resource: {"service.name": "github.webhook"},
      attributes: {
        "event.name": "github.deployment_status",
        "vcs.revision": $sha,
        "deployment.environment": $env,
        "deployment.state": $state
      },
      body: {payload: ({state: $state} + (if $url != "" then {environmentUrl: $url} else {} end))}
    }' >> "$out_file"
}

run_case() {
  local case_name="$1" sha="$2" deploy_state="$3" canary_status="$4" \
        timeout_sec="$5" emit_event="$6" \
        signal_sha="${7-__USE_SHA__}" write_pr="${8:-no}" gh_sha="${9-__NO_STUB__}"

  # signal_sha defaults to "$sha" when caller omits it; pass an explicit ""
  # to force an empty signal (Phase 2 fallback tests).
  if [ "$signal_sha" = "__USE_SHA__" ]; then
    signal_sha="$sha"
  fi

  local case_dir="$TMPROOT/$case_name"
  # CTL-512: lay the worker dir under $orch_dir/workers/CTL-9999 so the
  # phase-agent-emit-complete wrapper can locate phase-monitor-deploy.json
  # via ${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json. WORKER_DIR is
  # still passed explicitly so the skill body's resolution order
  # (WORKER_DIR > ORCH_DIR/workers/TICKET > cwd) sticks.
  local orch_dir="$case_dir/orch"
  local worker="$orch_dir/workers/CTL-9999"
  mkdir -p "$worker" "$case_dir/bin"

  # Fixture phase-monitor-merge.json (primary input for phase-monitor-deploy).
  jq -nc --arg sha "$signal_sha" '{
    pr: {
      mergedAt: "2026-05-18T22:00:00Z",
      ciStatus: "merged",
      mergeCommitSha: $sha
    }
  }' > "$worker/phase-monitor-merge.json"

  # Optionally fixture phase-pr.json for the REST fallback path (Phase 2).
  if [ "$write_pr" = "yes" ]; then
    jq -nc '{
      pr: {number: 1234, url: "https://example.com/pr/1234"}
    }' > "$worker/phase-pr.json"
  fi

  # Stub `gh` on PATH when caller wants the fallback path exercised
  # deterministically. Pass gh_sha="" to stub with an empty merge_commit_sha
  # (Case 6); pass a non-empty SHA to stub with that SHA (Case 5); omit the
  # argument entirely (sentinel __NO_STUB__) to skip the stub.
  #
  # The SKILL body calls `gh repo view --json X --jq '.X'` and `gh api ... --jq '.X'`,
  # so the stub returns the scalar value directly (mimicking what --jq would emit).
  if [ "$gh_sha" != "__NO_STUB__" ]; then
    cat > "$case_dir/bin/gh" <<EOF
#!/usr/bin/env bash
# Minimal gh stub for phase-monitor-deploy fallback path. Returns scalar
# strings (not JSON) to mimic gh's --jq scalar extraction.
case "\$*" in
  *"repo view"*)
    printf '%s\n' "owner/repo"
    ;;
  *"api repos/"*"/pulls/"*)
    printf '%s\n' "$gh_sha"
    ;;
  *) exit 1 ;;
esac
EOF
    chmod +x "$case_dir/bin/gh"
  fi

  local events_file="$case_dir/events.jsonl"
  : > "$events_file"  # create empty so wait-for sees no history

  # Canary stub: writes a fixture JSON to its own stdout, records invocation.
  cat > "$case_dir/bin/canary-stub" <<EOF
#!/usr/bin/env bash
echo invoked >> "$case_dir/canary-invocations.log"
jq -nc --arg s "$canary_status" '{status: \$s, observations: ["fixture"]}'
EOF
  chmod +x "$case_dir/bin/canary-stub"

  # linearis stub (CTL-632 deploy mirror): keep the skill hermetic —
  # case_dir/bin is first on PATH so this shadows any real linearis.
  linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"

  # CTL-550/CTL-1410: the mirror posts through linear-comment-post.sh (app-actor
  # API), NOT `linearis issues discuss` — stub it and point the skill's
  # CATALYST_COMMENT_POST_HELPER override at it so the "mirror posted" assertion
  # is hermetic (independent of machine credentials). The stub logs its args
  # (ticket, body) to comment-post-calls.log and exits 0.
  linear_comment_post_stub_install "$case_dir/bin" "$case_dir/comment-post-calls.log"

  # Run the skill body in the background so we can append the deploy event
  # AFTER catalyst-events wait-for has begun watching from EOF. This mirrors
  # the production flow where the deploy webhook arrives after the worker
  # has started waiting.
  # CTL-512: when the skill body uses the phase-agent-emit-complete wrapper
  # for the skipped branch, the wrapper writes events to
  # $CATALYST_DIR/events/YYYY-MM.jsonl (NOT $CATALYST_EVENTS_FILE — that's a
  # lib-helper-only override). Pre-seed CATALYST_DIR so the wrapper's
  # canonical_jsonl_append lands the event in the same scratch dir we read
  # back; mirror the file into $events_file for the existing assertion.
  local catalyst_dir="$case_dir/catalyst"
  mkdir -p "$catalyst_dir/events"
  local month
  month=$(date -u +%Y-%m)
  : > "$catalyst_dir/events/${month}.jsonl"

  (
    PATH="$case_dir/bin:$PATH" \
    TICKET=CTL-9999 \
    WORKER_DIR="$worker" \
    CATALYST_DIR="$catalyst_dir" \
    CATALYST_ORCHESTRATOR_DIR="$orch_dir" \
    CATALYST_ORCHESTRATOR_ID="orch-test" \
    CATALYST_EVENTS_FILE="$events_file" \
    CATALYST_COMMENT_POST_HELPER="$case_dir/bin/linear-comment-post.sh" \
    PHASE_DEPLOY_TIMEOUT_SEC="$timeout_sec" \
    PHASE_DEPLOY_ENV="production" \
    PHASE_CANARY_CMD="$case_dir/bin/canary-stub" \
    PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
      bash "$SKILL_BODY_FILE" > "$case_dir/stdout.log" 2> "$case_dir/stderr.log"
    echo $? > "$case_dir/exit-code"
  ) &
  local skill_pid=$!

  if [ "$emit_event" = "yes" ]; then
    # Give wait-for time to start. Its inner loop sleeps 1s, so we wait 2s
    # after writing to make sure the next poll picks it up.
    sleep 2
    local deploy_url=""
    [ "$deploy_state" = "success" ] && deploy_url="https://preview.example.dev/ctl-9999"
    write_deploy_event "$events_file" "$sha" "production" "$deploy_state" "$deploy_url"
  fi

  wait "$skill_pid"
  echo "$case_dir"
}

echo "phase-monitor-deploy e2e tests"

# ─────────────────────────────────────────────────────────────────────────────
# Case 1: deploy success + canary success → phase.monitor-deploy.complete

CASE_DIR="$(run_case success abc123 success success 5 yes)"

EXIT="$(cat "$CASE_DIR/exit-code")"
assert_eq "success: exit code 0" 0 "$EXIT"

assert_file_exists "success: phase-monitor-deploy.json created" \
  "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json"

if [ -f "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json" ]; then
  DSHA="$(jq -r '.deploy_sha' "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "success: deploy_sha matches phase-pr.json" "abc123" "$DSHA"

  DSTATE="$(jq -r '.deploy_state' "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "success: deploy_state recorded" "success" "$DSTATE"

  CR_STATUS="$(jq -r '.canary_result.status' "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "success: canary_result.status recorded" "success" "$CR_STATUS"

  # CTL-632 deploy mirror: preview URL persisted as structured data.
  DURL="$(jq -r '.deployment.url' "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "success: deployment.url persisted from environmentUrl" \
    "https://preview.example.dev/ctl-9999" "$DURL"
fi

# CTL-632 deploy mirror: a Linear comment was posted with the env + preview URL.
# CTL-550/CTL-1410: the mirror rides linear-comment-post.sh (app-actor API), not
# `linearis issues discuss` — assert against the comment-post stub's log.
if grep -q 'CTL-9999' "$CASE_DIR/comment-post-calls.log" 2>/dev/null; then
  ok "success: deploy mirror posted to Linear"
else
  fail "success: deploy mirror posted" "no call in $(cat "$CASE_DIR/comment-post-calls.log" 2>/dev/null)"
fi
if grep -q 'Phase Monitor-Deploy' "$CASE_DIR/comment-post-calls.log" 2>/dev/null \
   && grep -q 'preview.example.dev/ctl-9999' "$CASE_DIR/comment-post-calls.log" 2>/dev/null; then
  ok "success: deploy mirror body has header + preview URL"
else
  fail "success: deploy mirror body" "log: $(cat "$CASE_DIR/comment-post-calls.log" 2>/dev/null)"
fi

# Canary stub was invoked exactly once
INVOCATIONS="$(wc -l < "$CASE_DIR/canary-invocations.log" 2>/dev/null | tr -d ' ')"
assert_eq "success: canary stub invoked once" "1" "${INVOCATIONS:-0}"

# Emitted event shape (CTL-1410: from the wrapper sink)
EVENT_NAME="$(read_phase_event_line "$CASE_DIR/catalyst" \
              | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "success: emitted phase event name" \
  "phase.monitor-deploy.complete.CTL-9999" "$EVENT_NAME"

# CTL-1410 Phase A: the wrapper flips the signal file's status to done in-band
# (merged onto the artifact write, preserving deploy_state/canary_result).
SUCCESS_SIG_STATUS="$(jq -r '.status' \
  "$CASE_DIR/orch/workers/CTL-9999/phase-monitor-deploy.json" 2>/dev/null)"
assert_eq "success: signal status flipped to done (CTL-1410)" "done" "$SUCCESS_SIG_STATUS"

# ─────────────────────────────────────────────────────────────────────────────
# Case 2: deploy failure → phase.monitor-deploy.failed, canary NOT invoked

CASE_DIR2="$(run_case failure abc456 failure success 5 yes)"

EXIT2="$(cat "$CASE_DIR2/exit-code")"
if [ "$EXIT2" -ne 0 ]; then
  ok "failure: exits non-zero"
else
  fail "failure: exit code" "expected non-zero, got $EXIT2"
fi

# Canary should NOT have been invoked
if [ ! -f "$CASE_DIR2/canary-invocations.log" ]; then
  ok "failure: canary stub was NOT invoked"
else
  fail "failure: canary not invoked" "canary log exists with $(wc -l < "$CASE_DIR2/canary-invocations.log") lines"
fi

FAIL_EVENT="$(read_phase_event_line "$CASE_DIR2/catalyst" \
              | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "failure: emitted failed event" \
  "phase.monitor-deploy.failed.CTL-9999" "$FAIL_EVENT"

# CTL-1410 Phase A: the deploy-failure branch writes the artifact then the wrapper
# flips the signal's status to failed in-band (merged onto the artifact).
FAIL_SIG_STATUS="$(jq -r '.status' \
  "$CASE_DIR2/orch/workers/CTL-9999/phase-monitor-deploy.json" 2>/dev/null)"
assert_eq "failure: signal status flipped to failed (CTL-1410)" "failed" "$FAIL_SIG_STATUS"

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: no deploy event arrives within timeout → phase.monitor-deploy.skipped

CASE_DIR3="$(run_case skipped abc789 success success 1 no)"

EXIT3="$(cat "$CASE_DIR3/exit-code")"
assert_eq "skipped: exit code 0" 0 "$EXIT3"

if [ -f "$CASE_DIR3/orch/workers/CTL-9999/phase-monitor-deploy.json" ]; then
  SSTATE="$(jq -r '.deploy_state' "$CASE_DIR3/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "skipped: deploy_state == skipped" "skipped" "$SSTATE"

  # CTL-512: signal status is written by the wrapper now (not just the
  # artifact's deploy_state). The execution-core scheduler's
  # isTicketInFlight predicate reads .status and treats 'skipped' on
  # monitor-deploy as terminal-success so the wave slot frees.
  SIG_STATUS="$(jq -r '.status' "$CASE_DIR3/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "skipped: signal status == skipped (CTL-512)" "skipped" "$SIG_STATUS"

  HAS_COMPLETED="$(jq -r 'has("completedAt")' "$CASE_DIR3/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "skipped: signal has completedAt (terminal, CTL-512)" "true" "$HAS_COMPLETED"
fi

# CTL-512: skipped now flows through phase-agent-emit-complete, which emits
# to $CATALYST_DIR/events/YYYY-MM.jsonl rather than $CATALYST_EVENTS_FILE.
SKIP_MONTH=$(date -u +%Y-%m)
SKIP_EVENT="$(jq -r '.attributes."event.name" // empty' \
              "$CASE_DIR3/catalyst/events/${SKIP_MONTH}.jsonl" 2>/dev/null \
              | grep '^phase\.monitor-deploy\.' | tail -1)"
assert_eq "skipped: emitted skipped event" \
  "phase.monitor-deploy.skipped.CTL-9999" "$SKIP_EVENT"

# ─────────────────────────────────────────────────────────────────────────────
# Case 4: phase-monitor-merge.json missing → failed event + non-zero

MISS_DIR="$TMPROOT/missing"
MISS_ORCH="$MISS_DIR/orch"
MISS_WORKER="$MISS_ORCH/workers/CTL-8888"
MISS_CATALYST="$MISS_DIR/catalyst"
mkdir -p "$MISS_WORKER" "$MISS_CATALYST/events"  # but NO phase-monitor-merge.json

PATH="$PATH" \
TICKET=CTL-8888 \
WORKER_DIR="$MISS_WORKER" \
CATALYST_DIR="$MISS_CATALYST" \
CATALYST_ORCHESTRATOR_DIR="$MISS_ORCH" \
CATALYST_ORCHESTRATOR_ID="orch-test" \
PHASE_DEPLOY_TIMEOUT_SEC=1 \
PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
  bash "$SKILL_BODY_FILE" > "$MISS_DIR/stdout.log" 2> "$MISS_DIR/stderr.log"
MISS_EXIT=$?

if [ "$MISS_EXIT" -ne 0 ]; then
  ok "missing-merge: exits non-zero when phase-monitor-merge.json is absent"
else
  fail "missing-merge: exit code" "expected non-zero, got $MISS_EXIT"
fi

MISS_LINE="$(read_phase_event_line "$MISS_CATALYST")"
MISS_EVENT="$(printf '%s' "$MISS_LINE" | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "missing-merge: emits failed event" \
  "phase.monitor-deploy.failed.CTL-8888" "$MISS_EVENT"

# Failure reason should cite the new file, not phase-pr.json. CTL-1410: the
# wrapper carries the --reason text in body.payload.failure_reason (body.message
# is a generic "Phase … failed on …" string).
MISS_REASON="$(printf '%s' "$MISS_LINE" | jq -r '.body.payload.failure_reason // empty' 2>/dev/null)"
case "$MISS_REASON" in
  *phase-monitor-merge.json*) ok "missing-merge: failure reason cites phase-monitor-merge.json" ;;
  *) fail "missing-merge: failure reason" "expected reason to mention phase-monitor-merge.json, got: $MISS_REASON" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# Case 5: phase-monitor-merge.json present but .pr.mergeCommitSha empty →
#         skill falls back to `gh api repos/.../pulls/<n>` and proceeds.
#
# Args: case=fallback, sha-for-deploy-event=fallbeef, deploy=success,
#       canary=success, timeout=5s, emit=yes,
#       signal_sha=""  (empty in signal file — triggers fallback),
#       write_pr=yes   (so fallback can read .pr.number from phase-pr.json),
#       gh_sha=fallbeef (what the stubbed `gh api` returns).

CASE_DIR5="$(run_case fallback fallbeef success success 5 yes "" yes fallbeef)"

EXIT5="$(cat "$CASE_DIR5/exit-code")"
assert_eq "fallback: exit code 0" 0 "$EXIT5"

if [ -f "$CASE_DIR5/orch/workers/CTL-9999/phase-monitor-deploy.json" ]; then
  DSHA5="$(jq -r '.deploy_sha' "$CASE_DIR5/orch/workers/CTL-9999/phase-monitor-deploy.json")"
  assert_eq "fallback: deploy_sha came from gh REST fallback" \
    "fallbeef" "$DSHA5"
fi

CMPL5="$(read_phase_event_line "$CASE_DIR5/catalyst" \
         | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "fallback: emitted complete event after fallback" \
  "phase.monitor-deploy.complete.CTL-9999" "$CMPL5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 6: signal empty AND gh fallback also returns empty → still fails clean.
#
# write_pr=yes so the fallback gets a PR number; gh_sha="" stubs gh to return
# {merge_commit_sha: ""} so the fallback resolves to empty too.

CASE_DIR6="$(run_case fallback-fail "" success success 1 no "" yes "")"

EXIT6="$(cat "$CASE_DIR6/exit-code")"
if [ "$EXIT6" -ne 0 ]; then
  ok "fallback-fail: exits non-zero when both signal and gh return empty"
else
  fail "fallback-fail: exit code" "expected non-zero, got $EXIT6"
fi

REASON6="$(read_phase_event_line "$CASE_DIR6/catalyst" \
          | jq -r '.body.payload.failure_reason // empty' 2>/dev/null)"
case "$REASON6" in
  *gh*|*REST*|*fallback*|*empty*) ok "fallback-fail: failure reason mentions fallback path" ;;
  *) fail "fallback-fail: reason" "expected reason to mention gh/REST/fallback/empty, got: $REASON6" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# Summary

echo
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
