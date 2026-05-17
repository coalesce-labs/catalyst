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
EMIT_HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "$2"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
assert_file_exists() { if [ -f "$2" ]; then ok "$1"; else fail "$1" "missing file: $2"; fi; }

if ! command -v catalyst-events >/dev/null 2>&1; then
  echo "SKIP: catalyst-events not on PATH — phase-monitor-deploy needs it" >&2
  exit 0
fi

[ -f "$SKILL_FILE" ]  || { echo "FAIL: skill missing: $SKILL_FILE";   exit 1; }
[ -f "$EMIT_HELPER" ] || { echo "FAIL: helper missing: $EMIT_HELPER"; exit 1; }

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
# $2 = sha, $3 = env, $4 = state ("success"|"failure")
write_deploy_event() {
  local out_file="$1" sha="$2" env="$3" state="$4"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sha "$sha" --arg env "$env" --arg state "$state" \
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
      body: {payload: {state: $state}}
    }' >> "$out_file"
}

run_case() {
  local case_name="$1" sha="$2" deploy_state="$3" canary_status="$4" \
        timeout_sec="$5" emit_event="$6"

  local case_dir="$TMPROOT/$case_name"
  local worker="$case_dir/worker"
  mkdir -p "$worker" "$case_dir/bin"

  # Fixture phase-pr.json
  jq -nc --arg sha "$sha" '{
    pr: {number: 1234, url: "https://example.com/pr/1234", mergeCommitSha: $sha}
  }' > "$worker/phase-pr.json"

  local events_file="$case_dir/events.jsonl"
  : > "$events_file"  # create empty so wait-for sees no history

  # Canary stub: writes a fixture JSON to its own stdout, records invocation.
  cat > "$case_dir/bin/canary-stub" <<EOF
#!/usr/bin/env bash
echo invoked >> "$case_dir/canary-invocations.log"
jq -nc --arg s "$canary_status" '{status: \$s, observations: ["fixture"]}'
EOF
  chmod +x "$case_dir/bin/canary-stub"

  # Run the skill body in the background so we can append the deploy event
  # AFTER catalyst-events wait-for has begun watching from EOF. This mirrors
  # the production flow where the deploy webhook arrives after the worker
  # has started waiting.
  (
    PATH="$case_dir/bin:$PATH" \
    TICKET=CTL-9999 \
    WORKER_DIR="$worker" \
    CATALYST_EVENTS_FILE="$events_file" \
    PHASE_DEPLOY_TIMEOUT_SEC="$timeout_sec" \
    PHASE_DEPLOY_ENV="production" \
    PHASE_CANARY_CMD="$case_dir/bin/canary-stub" \
    PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
    PHASE_EMIT_HELPER="$EMIT_HELPER" \
      bash "$SKILL_BODY_FILE" > "$case_dir/stdout.log" 2> "$case_dir/stderr.log"
    echo $? > "$case_dir/exit-code"
  ) &
  local skill_pid=$!

  if [ "$emit_event" = "yes" ]; then
    # Give wait-for time to start. Its inner loop sleeps 1s, so we wait 2s
    # after writing to make sure the next poll picks it up.
    sleep 2
    write_deploy_event "$events_file" "$sha" "production" "$deploy_state"
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
  "$CASE_DIR/worker/phase-monitor-deploy.json"

if [ -f "$CASE_DIR/worker/phase-monitor-deploy.json" ]; then
  DSHA="$(jq -r '.deploy_sha' "$CASE_DIR/worker/phase-monitor-deploy.json")"
  assert_eq "success: deploy_sha matches phase-pr.json" "abc123" "$DSHA"

  DSTATE="$(jq -r '.deploy_state' "$CASE_DIR/worker/phase-monitor-deploy.json")"
  assert_eq "success: deploy_state recorded" "success" "$DSTATE"

  CR_STATUS="$(jq -r '.canary_result.status' "$CASE_DIR/worker/phase-monitor-deploy.json")"
  assert_eq "success: canary_result.status recorded" "success" "$CR_STATUS"
fi

# Canary stub was invoked exactly once
INVOCATIONS="$(wc -l < "$CASE_DIR/canary-invocations.log" 2>/dev/null | tr -d ' ')"
assert_eq "success: canary stub invoked once" "1" "${INVOCATIONS:-0}"

# Emitted event shape
EVENT_NAME="$(jq -r '.attributes."event.name"' "$CASE_DIR/events.jsonl" \
              | tail -1)"
assert_eq "success: emitted phase event name" \
  "phase.monitor-deploy.complete.CTL-9999" "$EVENT_NAME"

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

FAIL_EVENT="$(jq -r '.attributes."event.name"' "$CASE_DIR2/events.jsonl" \
              | tail -1)"
assert_eq "failure: emitted failed event" \
  "phase.monitor-deploy.failed.CTL-9999" "$FAIL_EVENT"

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: no deploy event arrives within timeout → phase.monitor-deploy.skipped

CASE_DIR3="$(run_case skipped abc789 success success 1 no)"

EXIT3="$(cat "$CASE_DIR3/exit-code")"
assert_eq "skipped: exit code 0" 0 "$EXIT3"

if [ -f "$CASE_DIR3/worker/phase-monitor-deploy.json" ]; then
  SSTATE="$(jq -r '.deploy_state' "$CASE_DIR3/worker/phase-monitor-deploy.json")"
  assert_eq "skipped: deploy_state == skipped" "skipped" "$SSTATE"
fi

SKIP_EVENT="$(jq -r '.attributes."event.name"' "$CASE_DIR3/events.jsonl" \
              | tail -1)"
assert_eq "skipped: emitted skipped event" \
  "phase.monitor-deploy.skipped.CTL-9999" "$SKIP_EVENT"

# ─────────────────────────────────────────────────────────────────────────────
# Case 4: phase-pr.json missing → failed event + non-zero

MISS_DIR="$TMPROOT/missing"
mkdir -p "$MISS_DIR/worker"  # but NO phase-pr.json

PATH="$PATH" \
TICKET=CTL-8888 \
WORKER_DIR="$MISS_DIR/worker" \
CATALYST_EVENTS_FILE="$MISS_DIR/events.jsonl" \
PHASE_DEPLOY_TIMEOUT_SEC=1 \
PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
PHASE_EMIT_HELPER="$EMIT_HELPER" \
  bash "$SKILL_BODY_FILE" > "$MISS_DIR/stdout.log" 2> "$MISS_DIR/stderr.log"
MISS_EXIT=$?

if [ "$MISS_EXIT" -ne 0 ]; then
  ok "missing-pr: exits non-zero when phase-pr.json is absent"
else
  fail "missing-pr: exit code" "expected non-zero, got $MISS_EXIT"
fi

MISS_EVENT="$(jq -r '.attributes."event.name"' "$MISS_DIR/events.jsonl" 2>/dev/null \
              | tail -1)"
assert_eq "missing-pr: emits failed event" \
  "phase.monitor-deploy.failed.CTL-8888" "$MISS_EVENT"

# ─────────────────────────────────────────────────────────────────────────────
# Summary

echo
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
