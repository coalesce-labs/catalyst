#!/usr/bin/env bash
# Tests for the briefing-followup skill action handlers (CTL-463 Phase 2).
# Covers: schedule_calendar / file_ticket / dispatch_orchestrator / draft_email
# action scripts + the resolution recorder.
#
# Run: bash plugins/dev/scripts/__tests__/briefing-followup-actions.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
BF_DIR="${REPO_ROOT}/plugins/dev/scripts/briefing-followup"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/briefing-followup/SKILL.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $1"
  shift
  for line in "$@"; do echo "    $line"; done
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label" "expected: $expected" "actual:   $actual"
  fi
}

assert_grep() {
  local label="$1" pattern="$2" content="$3"
  if grep -qF -- "$pattern" <<<"$content"; then
    pass "$label"
  else
    fail "$label" "expected substring: $pattern" \
      "actual: $(printf '%s' "$content" | head -20)"
  fi
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label" "expected exit: $expected" "actual exit:   $actual"
  fi
}

# Install a fake curl that records its full invocation (including stdin body)
# to FAKE_CURL_LOG and emits FAKE_CURL_RESPONSE on stdout.
install_fake_curl() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
# Record args.
{
  echo "curl $*"
  # Surface --data-binary @- bodies if present (read stdin when last arg is '@-').
  for arg in "$@"; do
    if [[ "$arg" == "@-" ]]; then
      echo "BODY_START"
      cat
      echo "BODY_END"
      break
    fi
  done
} >> "${FAKE_CURL_LOG:-/dev/null}"
# Emit fake response.
printf '%s' "${FAKE_CURL_RESPONSE:-{}}"
EOF
  chmod +x "$bin_dir/curl"
}

install_fake_linearis() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/linearis" <<'EOF'
#!/usr/bin/env bash
echo "linearis $*" >> "${FAKE_LINEARIS_LOG:-/dev/null}"
if [[ "${1:-}" == "teams" && "${2:-}" == "list" ]]; then
  # Surface a single fake team so key→UUID resolution can succeed.
  cat <<JSON
[{"id":"${FAKE_LINEARIS_TEAM_UUID:-00000000-0000-0000-0000-000000000001}","key":"${FAKE_LINEARIS_TEAM_KEY:-CTL}","name":"Catalyst"}]
JSON
  exit 0
fi
if [[ "${1:-}" == "issues" && "${2:-}" == "create" ]]; then
  if [[ "${FAKE_LINEARIS_FAIL_CREATE:-0}" == "1" ]]; then
    echo "${FAKE_LINEARIS_FAIL_REASON:-fake auth error}" >&2
    exit 1
  fi
  cat <<JSON
{"identifier":"${FAKE_LINEARIS_ID:-TST-99}","url":"https://linear.app/x/issue/${FAKE_LINEARIS_ID:-TST-99}","title":"fake"}
JSON
  exit 0
fi
exit 0
EOF
  chmod +x "$bin_dir/linearis"
}

install_fake_claude() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
echo "OTEL=${OTEL_RESOURCE_ATTRIBUTES:-}" >> "${FAKE_CLAUDE_LOG:-/dev/null}"
if [[ "${FAKE_CLAUDE_NO_ORCH:-0}" == "1" ]]; then
  echo "${FAKE_CLAUDE_STDERR:-dispatch failed}" >&2
  exit 1
fi
echo "Started orchestrator ${FAKE_CLAUDE_ORCH_ID:-orch_abc123}"
exit 0
EOF
  chmod +x "$bin_dir/claude"
}

# ─── Test 1: action-schedule.sh invokes Calendar create-event with right shape ─
test_action_schedule() {
  echo "test 1: action-schedule.sh invokes Calendar create-event"
  local target="$BF_DIR/action-schedule.sh"
  local t_dir="$SCRATCH/t1"
  local bin_dir="$t_dir/bin"
  local log="$t_dir/curl.log"
  mkdir -p "$t_dir"
  install_fake_curl "$bin_dir"

  local out ec
  out=$(FAKE_CURL_LOG="$log" \
        FAKE_CURL_RESPONSE='{"id":"evt_abc","htmlLink":"https://cal/abc"}' \
        GOOGLE_OAUTH_ACCESS_TOKEN=fake \
        PATH="$bin_dir:$PATH" \
        bash "$target" --title "Foo bar" \
                       --start 2026-05-18T09:00:00Z \
                       --end 2026-05-18T10:00:00Z \
                       --description "test event" 2>&1)
  ec=$?

  assert_exit "schedule exits 0" "0" "$ec"
  assert_grep "schedule stdout has event_id" '"event_id":"evt_abc"' "$out"
  assert_grep "schedule stdout status=scheduled" '"status":"scheduled"' "$out"

  local log_content
  log_content=$(cat "$log" 2>/dev/null || echo "")
  assert_grep "curl invoked with bearer token" "Authorization: Bearer fake" "$log_content"
  assert_grep "curl invoked against calendar events endpoint" \
    "/calendar/v3/calendars/primary/events" "$log_content"
  assert_grep "curl body contains summary" '"summary":"Foo bar"' "$log_content"
  assert_grep "curl body contains start dateTime" \
    '"dateTime":"2026-05-18T09:00:00Z"' "$log_content"

  # Soft-skip path: no token.
  local skip_out skip_ec
  skip_out=$(env -u GOOGLE_OAUTH_ACCESS_TOKEN PATH="$bin_dir:$PATH" \
    bash "$target" --title X --start 2026-05-18T09:00:00Z \
                   --end 2026-05-18T10:00:00Z 2>&1)
  skip_ec=$?
  assert_exit "schedule soft-skip exits 0" "0" "$skip_ec"
  assert_grep "schedule soft-skip status=skipped" '"status":"skipped"' "$skip_out"

  # Hard-failure path: curl returns empty body (no id in response).
  local fail_out fail_ec
  fail_out=$(FAKE_CURL_LOG="$log" \
             FAKE_CURL_RESPONSE='{}' \
             GOOGLE_OAUTH_ACCESS_TOKEN=fake \
             PATH="$bin_dir:$PATH" \
             bash "$target" --title X --start 2026-05-18T09:00:00Z \
                            --end 2026-05-18T10:00:00Z 2>&1)
  fail_ec=$?
  assert_exit "schedule failure exits 1" "1" "$fail_ec"
  assert_grep "schedule failure status=failed" '"status":"failed"' "$fail_out"
}

# ─── Test 2: action-ticket.sh invokes `linearis issues create` ──────────────
test_action_ticket() {
  echo "test 2: action-ticket.sh invokes linearis issues create"
  local target="$BF_DIR/action-ticket.sh"
  local t_dir="$SCRATCH/t2"
  local bin_dir="$t_dir/bin"
  local log="$t_dir/linearis.log"
  mkdir -p "$t_dir"
  install_fake_linearis "$bin_dir"

  local out ec
  out=$(FAKE_LINEARIS_LOG="$log" \
        FAKE_LINEARIS_ID=TST-101 \
        PATH="$bin_dir:$PATH" \
        bash "$target" --title "Test ticket" --team CTL \
                       --description "body text" 2>&1)
  ec=$?

  assert_exit "ticket exits 0" "0" "$ec"
  assert_grep "ticket stdout has identifier" '"identifier":"TST-101"' "$out"
  assert_grep "ticket stdout status=filed" '"status":"filed"' "$out"
  assert_grep "ticket stdout has url" '"url":"https://linear.app' "$out"

  local log_content
  log_content=$(cat "$log" 2>/dev/null || echo "")
  assert_grep "linearis invoked with issues create" "issues create" "$log_content"
  assert_grep "linearis resolved team key to UUID before create" \
    "--team 00000000-0000-0000-0000-000000000001" "$log_content"
  assert_grep "linearis teams list called to resolve key" \
    "teams list" "$log_content"

  # Soft-skip path: linearis not on PATH.
  local skip_out skip_ec
  skip_out=$(PATH="/usr/bin:/bin" bash "$target" --title X --team CTL 2>&1)
  skip_ec=$?
  assert_exit "ticket soft-skip exits 0" "0" "$skip_ec"
  assert_grep "ticket soft-skip status=skipped" '"status":"skipped"' "$skip_out"

  # Hard-failure path: linearis returns non-zero with stderr; reason should surface.
  local fail_out fail_ec
  fail_out=$(FAKE_LINEARIS_LOG="$log" \
             FAKE_LINEARIS_FAIL_CREATE=1 \
             FAKE_LINEARIS_FAIL_REASON="auth denied" \
             PATH="$bin_dir:$PATH" \
             bash "$target" --title X --team CTL 2>&1)
  fail_ec=$?
  assert_exit "ticket failure exits 1" "1" "$fail_ec"
  assert_grep "ticket failure status=failed" '"status":"failed"' "$fail_out"
  assert_grep "ticket failure surfaces stderr reason" "auth denied" "$fail_out"
}

# ─── Test 3: action-orchestrate.sh calls claude headless and returns orch_id ──
test_action_orchestrate() {
  echo "test 3: action-orchestrate.sh dispatches orchestrator"
  local target="$BF_DIR/action-orchestrate.sh"
  local t_dir="$SCRATCH/t3"
  local bin_dir="$t_dir/bin"
  local log="$t_dir/claude.log"
  mkdir -p "$t_dir"
  install_fake_claude "$bin_dir"

  local out ec
  out=$(FAKE_CLAUDE_LOG="$log" \
        FAKE_CLAUDE_ORCH_ID="orch_test123" \
        PATH="$bin_dir:$PATH" \
        bash "$target" --ticket CTL-999 2>&1)
  ec=$?

  assert_exit "orchestrate exits 0" "0" "$ec"
  assert_grep "orchestrate stdout has orchestrator_id" \
    '"orchestrator_id":"orch_test123"' "$out"
  assert_grep "orchestrate stdout status=dispatched" '"status":"dispatched"' "$out"

  local log_content
  log_content=$(cat "$log" 2>/dev/null || echo "")
  assert_grep "claude invoked with -p flag" "-p" "$log_content"
  assert_grep "claude invoked with orchestrate command" \
    "/catalyst-legacy:orchestrate CTL-999" "$log_content"
  # CTL-495: claude inherits OTEL with task.type=briefing-followup.
  assert_grep "claude inherits OTEL with task.type=briefing-followup" \
    "task.type=briefing-followup" "$log_content"

  # Soft-skip path: claude not on PATH.
  local skip_out skip_ec
  skip_out=$(PATH="/usr/bin:/bin" bash "$target" --ticket CTL-999 2>&1)
  skip_ec=$?
  assert_exit "orchestrate soft-skip exits 0" "0" "$skip_ec"
  assert_grep "orchestrate soft-skip status=skipped" '"status":"skipped"' "$skip_out"

  # Hard-failure path: claude prints no orch_id and exits non-zero.
  local fail_out fail_ec
  fail_out=$(FAKE_CLAUDE_LOG="$log" \
             FAKE_CLAUDE_NO_ORCH=1 \
             FAKE_CLAUDE_STDERR="permission denied" \
             PATH="$bin_dir:$PATH" \
             bash "$target" --ticket CTL-999 2>&1)
  fail_ec=$?
  assert_exit "orchestrate failure exits 1" "1" "$fail_ec"
  assert_grep "orchestrate failure status=failed" '"status":"failed"' "$fail_out"
  assert_grep "orchestrate failure surfaces stderr reason" "permission denied" "$fail_out"
}

# ─── Test 4: action-email.sh invokes Gmail drafts ───────────────────────────
test_action_email() {
  echo "test 4: action-email.sh invokes Gmail draft-message"
  local target="$BF_DIR/action-email.sh"
  local t_dir="$SCRATCH/t4"
  local bin_dir="$t_dir/bin"
  local log="$t_dir/curl.log"
  mkdir -p "$t_dir"
  install_fake_curl "$bin_dir"

  local out ec
  out=$(FAKE_CURL_LOG="$log" \
        FAKE_CURL_RESPONSE='{"id":"draft_xyz","message":{"id":"m_1"}}' \
        GMAIL_OAUTH_ACCESS_TOKEN=fake \
        PATH="$bin_dir:$PATH" \
        bash "$target" --to foo@example.com --subject "Hi" \
                       --body "test body" 2>&1)
  ec=$?

  assert_exit "email exits 0" "0" "$ec"
  assert_grep "email stdout has draft_id" '"draft_id":"draft_xyz"' "$out"
  assert_grep "email stdout status=drafted" '"status":"drafted"' "$out"

  local log_content
  log_content=$(cat "$log" 2>/dev/null || echo "")
  assert_grep "curl invoked with bearer token" "Authorization: Bearer fake" "$log_content"
  assert_grep "curl invoked against gmail drafts endpoint" \
    "/gmail/v1/users/me/drafts" "$log_content"
  # body contains "raw":"..." with base64-encoded message
  assert_grep "curl body contains raw field" '"raw":' "$log_content"

  # Soft-skip path: no token.
  local skip_out skip_ec
  skip_out=$(env -u GMAIL_OAUTH_ACCESS_TOKEN PATH="$bin_dir:$PATH" \
    bash "$target" --to foo@example.com --subject Hi --body x 2>&1)
  skip_ec=$?
  assert_exit "email soft-skip exits 0" "0" "$skip_ec"
  assert_grep "email soft-skip status=skipped" '"status":"skipped"' "$skip_out"
}

# ─── Test 5: record-resolution.sh appends to resolutions JSON ───────────────
test_record_resolution() {
  echo "test 5: record-resolution.sh appends to resolutions JSON"
  local target="$BF_DIR/record-resolution.sh"
  local t_dir="$SCRATCH/t5"
  mkdir -p "$t_dir"

  local out ec
  out=$(bash "$target" --log-dir "$t_dir" --date 2026-05-18 \
        --id dec-1 --action schedule_calendar \
        --result '{"event_id":"e1","status":"scheduled"}' 2>&1)
  ec=$?
  assert_exit "first record exits 0" "0" "$ec"

  local resolutions_file="$t_dir/briefing-followup-2026-05-18-resolutions.json"
  if [[ -f "$resolutions_file" ]]; then
    pass "resolutions file created"
  else
    fail "resolutions file created" "expected at $resolutions_file"
    return
  fi

  local len id action event_id
  len=$(jq 'length' "$resolutions_file")
  assert_eq "resolutions array length after 1 record" "1" "$len"

  id=$(jq -r '.[0].decision_id' "$resolutions_file")
  assert_eq "first decision_id" "dec-1" "$id"

  action=$(jq -r '.[0].action' "$resolutions_file")
  assert_eq "first action" "schedule_calendar" "$action"

  event_id=$(jq -r '.[0].result.event_id' "$resolutions_file")
  assert_eq "first result.event_id" "e1" "$event_id"

  # Timestamp present and ISO 8601 (UTC Z).
  local ts
  ts=$(jq -r '.[0].timestamp' "$resolutions_file")
  if [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    pass "timestamp matches ISO 8601 UTC"
  else
    fail "timestamp matches ISO 8601 UTC" "actual: $ts"
  fi

  # Append a second resolution.
  bash "$target" --log-dir "$t_dir" --date 2026-05-18 \
    --id dec-2 --action file_ticket \
    --result '{"identifier":"CTL-1000","status":"filed"}' >/dev/null

  len=$(jq 'length' "$resolutions_file")
  assert_eq "resolutions array length after 2 records" "2" "$len"

  id=$(jq -r '.[1].decision_id' "$resolutions_file")
  assert_eq "second decision_id" "dec-2" "$id"

  # Malformed existing resolutions file: should exit 2 rather than overwrite.
  local m_dir="$SCRATCH/t5-malformed"
  mkdir -p "$m_dir"
  echo "not json" > "$m_dir/briefing-followup-2026-05-18-resolutions.json"
  local mal_ec
  bash "$target" --log-dir "$m_dir" --date 2026-05-18 \
    --id dec-x --action approve --result '{}' >/dev/null 2>&1
  mal_ec=$?
  assert_exit "malformed existing file exits 2" "2" "$mal_ec"
  # And the original malformed file should be untouched.
  local content
  content=$(cat "$m_dir/briefing-followup-2026-05-18-resolutions.json")
  assert_eq "malformed file untouched" "not json" "$content"

  # Invalid --result JSON: should exit 2 (validates input shape).
  local bad_ec
  bash "$target" --log-dir "$SCRATCH/t5" --date 2026-05-18 \
    --id dec-y --action approve --result 'not-json' >/dev/null 2>&1
  bad_ec=$?
  assert_exit "invalid --result JSON exits 2" "2" "$bad_ec"
}

# ─── Test 6: SKILL.md frontmatter still valid (no regression) ───────────────
test_skill_md_frontmatter() {
  echo "test 6: SKILL.md frontmatter is intact"
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "SKILL.md exists at $SKILL_MD" "file missing"
    return
  fi
  local fm
  fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$SKILL_MD")
  assert_grep "frontmatter has name" "name: briefing-followup" "$fm"
  assert_grep "frontmatter has disable-model-invocation" \
    "disable-model-invocation: true" "$fm"
  assert_grep "frontmatter has user-invocable" "user-invocable: true" "$fm"
  assert_grep "frontmatter allows Bash" "Bash" "$fm"
}

test_action_schedule
test_action_ticket
test_action_orchestrate
test_action_email
test_record_resolution
test_skill_md_frontmatter

echo "─────────────────────────────────────"
echo "PASSED: $PASSES"
echo "FAILED: $FAILURES"
echo "─────────────────────────────────────"
exit $(( FAILURES > 0 ? 1 : 0 ))
