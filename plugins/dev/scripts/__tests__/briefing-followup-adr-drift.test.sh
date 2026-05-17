#!/usr/bin/env bash
# Tests for the briefing-followup ADR-drift resolution flow (CTL-464 Phase 3).
# Covers: action-adr.sh sub-modes update / ticket / defer + the SKILL.md
# adr_drift case arm.
#
# Run: bash plugins/dev/scripts/__tests__/briefing-followup-adr-drift.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
BF_DIR="${REPO_ROOT}/plugins/dev/scripts/briefing-followup"
TARGET="${BF_DIR}/action-adr.sh"
RECORD="${BF_DIR}/record-resolution.sh"
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

assert_regex() {
  local label="$1" pattern="$2" content="$3"
  if [[ "$content" =~ $pattern ]]; then
    pass "$label"
  else
    fail "$label" "expected regex match: $pattern" "actual: $content"
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

# Build a sandbox git repo containing a single ADR with frontmatter.
setup_repo() {
  local repo="$1"
  mkdir -p "$repo/docs/adrs"
  cat > "$repo/docs/adrs/0001-test.md" <<'ADR'
---
adr_id: ADR-001
title: Test ADR
date: 2026-05-17
---

# Test ADR

Body of the ADR.
ADR
  (
    cd "$repo" \
      && git init -q -b main 2>/dev/null || git init -q \
      && git config user.email "test@example.com" \
      && git config user.name "Test User" \
      && git add . \
      && git commit -q -m "init"
  )
}

# Fake $EDITOR. FAKE_EDITOR_SCRIPT runs with $1 = the file path.
install_fake_editor() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/editor" <<'EOF'
#!/usr/bin/env bash
echo "editor $*" >> "${FAKE_EDITOR_LOG:-/dev/null}"
if [[ -n "${FAKE_EDITOR_SCRIPT:-}" ]]; then
  bash -c "$FAKE_EDITOR_SCRIPT" -- "$1"
fi
EOF
  chmod +x "$bin_dir/editor"
}

install_fake_linearis() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/linearis" <<'EOF'
#!/usr/bin/env bash
echo "linearis $*" >> "${FAKE_LINEARIS_LOG:-/dev/null}"
if [[ "${1:-}" == "teams" && "${2:-}" == "list" ]]; then
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

# ─── Test 1: action-adr.sh --mode update ─────────────────────────────────────
test_action_adr_update() {
  echo "test 1: action-adr.sh --mode update"
  local t_dir="$SCRATCH/t1"
  local repo="$t_dir/repo"
  local bin_dir="$t_dir/bin"
  local editor_log="$t_dir/editor.log"
  mkdir -p "$t_dir"
  setup_repo "$repo"
  install_fake_editor "$bin_dir"

  local adr_file="$repo/docs/adrs/0001-test.md"

  # Happy path: editor appends a line. action-adr.sh should commit.
  local out ec
  out=$(FAKE_EDITOR_LOG="$editor_log" \
        FAKE_EDITOR_SCRIPT='printf "\nNew section.\n" >> "$1"' \
        EDITOR="editor" \
        PATH="$bin_dir:$PATH" \
        bash "$TARGET" --mode update --adr-file "$adr_file" 2>&1)
  ec=$?

  assert_exit "update happy exits 0" "0" "$ec"
  assert_grep "update happy status=updated" '"status":"updated"' "$out"
  assert_grep "update happy adr_id surfaced" '"adr_id":"ADR-001"' "$out"
  assert_grep "update happy commit_sha present" '"commit_sha":"' "$out"

  # Verify git history.
  local subj
  subj=$(git -C "$repo" log -1 --pretty=%s)
  assert_eq "update commit subject" "docs(adr): resolve drift in ADR-001" "$subj"

  # No-edit path: re-run with a no-op editor; should skip with "no changes".
  local out2 ec2
  out2=$(FAKE_EDITOR_LOG="$editor_log" \
         FAKE_EDITOR_SCRIPT='' \
         EDITOR="editor" \
         PATH="$bin_dir:$PATH" \
         bash "$TARGET" --mode update --adr-file "$adr_file" 2>&1)
  ec2=$?
  assert_exit "update no-edit exits 0" "0" "$ec2"
  assert_grep "update no-edit status=skipped" '"status":"skipped"' "$out2"
  assert_grep "update no-edit reason mentions no changes" "no changes" "$out2"

  # Soft-skip: EDITOR unset.
  local out3 ec3
  out3=$(env -u EDITOR PATH="$bin_dir:$PATH" \
         bash "$TARGET" --mode update --adr-file "$adr_file" 2>&1)
  ec3=$?
  assert_exit "update no-EDITOR exits 0" "0" "$ec3"
  assert_grep "update no-EDITOR status=skipped" '"status":"skipped"' "$out3"
  assert_grep "update no-EDITOR reason mentions EDITOR" "EDITOR" "$out3"
}

# ─── Test 2: action-adr.sh --mode ticket ─────────────────────────────────────
test_action_adr_ticket() {
  echo "test 2: action-adr.sh --mode ticket"
  local t_dir="$SCRATCH/t2"
  local repo="$t_dir/repo"
  local bin_dir="$t_dir/bin"
  local log="$t_dir/linearis.log"
  mkdir -p "$t_dir"
  setup_repo "$repo"
  install_fake_linearis "$bin_dir"

  local adr_file="$repo/docs/adrs/0001-test.md"

  # Happy path.
  local out ec
  out=$(FAKE_LINEARIS_LOG="$log" \
        FAKE_LINEARIS_ID=TST-101 \
        PATH="$bin_dir:$PATH" \
        bash "$TARGET" --mode ticket --adr-file "$adr_file" --team CTL \
                       --summary "Code lacks worktree convention" \
                       --drift-status "code_ahead_of_adr" 2>&1)
  ec=$?

  assert_exit "ticket happy exits 0" "0" "$ec"
  assert_grep "ticket happy identifier" '"identifier":"TST-101"' "$out"
  assert_grep "ticket happy adr_id" '"adr_id":"ADR-001"' "$out"
  assert_grep "ticket happy status=filed" '"status":"filed"' "$out"
  assert_grep "ticket happy url" '"url":"https://linear.app' "$out"

  local log_content
  log_content=$(cat "$log" 2>/dev/null || echo "")
  assert_grep "linearis invoked: issues create" "issues create" "$log_content"
  assert_grep "linearis team resolved to UUID" \
    "00000000-0000-0000-0000-000000000001" "$log_content"
  assert_grep "linearis title references ADR-001" "ADR-001" "$log_content"
  assert_grep "linearis description references adr file path" \
    "/docs/adrs/0001-test.md" "$log_content"

  # Soft-skip: linearis not on PATH.
  local skip_out skip_ec
  skip_out=$(PATH="/usr/bin:/bin" \
             bash "$TARGET" --mode ticket --adr-file "$adr_file" --team CTL 2>&1)
  skip_ec=$?
  assert_exit "ticket soft-skip exits 0" "0" "$skip_ec"
  assert_grep "ticket soft-skip status=skipped" '"status":"skipped"' "$skip_out"

  # Hard fail.
  local fail_out fail_ec
  fail_out=$(FAKE_LINEARIS_LOG="$log" \
             FAKE_LINEARIS_FAIL_CREATE=1 \
             FAKE_LINEARIS_FAIL_REASON="auth denied" \
             PATH="$bin_dir:$PATH" \
             bash "$TARGET" --mode ticket --adr-file "$adr_file" --team CTL 2>&1)
  fail_ec=$?
  assert_exit "ticket fail exits 1" "1" "$fail_ec"
  assert_grep "ticket fail status=failed" '"status":"failed"' "$fail_out"
  assert_grep "ticket fail surfaces stderr reason" "auth denied" "$fail_out"
}

# ─── Test 3: action-adr.sh --mode defer ──────────────────────────────────────
test_action_adr_defer() {
  echo "test 3: action-adr.sh --mode defer"
  local t_dir="$SCRATCH/t3"
  local repo="$t_dir/repo"
  mkdir -p "$t_dir"
  setup_repo "$repo"

  local adr_file="$repo/docs/adrs/0001-test.md"

  # Happy path: explicit date + reason.
  local out ec
  out=$(bash "$TARGET" --mode defer --adr-file "$adr_file" \
        --reason "intentional divergence" --date 2026-05-17 2>&1)
  ec=$?

  assert_exit "defer happy exits 0" "0" "$ec"
  assert_grep "defer happy status=deferred" '"status":"deferred"' "$out"
  assert_grep "defer happy adr_id" '"adr_id":"ADR-001"' "$out"
  assert_grep "defer happy commit_sha present" '"commit_sha":"' "$out"

  local file_content
  file_content=$(cat "$adr_file")
  assert_grep "defer appended drift-noted comment" \
    "<!-- drift-noted: 2026-05-17: intentional divergence -->" "$file_content"

  local subj
  subj=$(git -C "$repo" log -1 --pretty=%s)
  assert_eq "defer commit subject" "docs(adr): defer drift on ADR-001" "$subj"

  # Default date: omit --date, should use today's UTC date.
  local out2 ec2
  out2=$(bash "$TARGET" --mode defer --adr-file "$adr_file" \
         --reason "another deferral" 2>&1)
  ec2=$?
  assert_exit "defer default-date exits 0" "0" "$ec2"
  local file_content2
  file_content2=$(cat "$adr_file")
  # Must contain a drift-noted comment with today's date — match by regex.
  local today
  today=$(date -u +%Y-%m-%d)
  assert_grep "defer default-date used today UTC" \
    "<!-- drift-noted: ${today}: another deferral -->" "$file_content2"

  # Missing --reason: invocation error.
  local bad_ec
  bash "$TARGET" --mode defer --adr-file "$adr_file" >/dev/null 2>&1
  bad_ec=$?
  assert_exit "defer missing --reason exits 2" "2" "$bad_ec"
}

# ─── Test 4: action-adr.sh integrates with record-resolution.sh ──────────────
test_action_adr_record_resolution() {
  echo "test 4: action-adr.sh result JSON feeds record-resolution.sh"
  local t_dir="$SCRATCH/t4"
  local repo="$t_dir/repo"
  local log_dir="$t_dir/logs"
  local bin_dir="$t_dir/bin"
  mkdir -p "$t_dir" "$log_dir"
  setup_repo "$repo"

  local adr_file="$repo/docs/adrs/0001-test.md"

  # Defer mode (no external deps) — guarantees a successful action.
  local action_out
  action_out=$(bash "$TARGET" --mode defer --adr-file "$adr_file" \
               --reason "test integration" --date 2026-05-17 2>&1)

  bash "$RECORD" --log-dir "$log_dir" --date 2026-05-17 \
    --id "adr-drift-0001-test-0" --action "adr_defer" \
    --result "$action_out" >/dev/null

  local resfile="$log_dir/briefing-followup-2026-05-17-resolutions.json"
  if [[ -f "$resfile" ]]; then
    pass "resolutions file written for defer"
  else
    fail "resolutions file written for defer" "expected at $resfile"
    return
  fi

  local action recorded_status
  action=$(jq -r '.[0].action' "$resfile")
  assert_eq "recorded action is adr_defer" "adr_defer" "$action"
  recorded_status=$(jq -r '.[0].result.status' "$resfile")
  assert_eq "recorded result.status is deferred" "deferred" "$recorded_status"

  # Update mode — chain editor stub then record-resolution.
  install_fake_editor "$bin_dir"
  local update_out
  update_out=$(FAKE_EDITOR_SCRIPT='printf "\nMore.\n" >> "$1"' \
               EDITOR="editor" \
               PATH="$bin_dir:$PATH" \
               bash "$TARGET" --mode update --adr-file "$adr_file" 2>&1)

  bash "$RECORD" --log-dir "$log_dir" --date 2026-05-17 \
    --id "adr-drift-0001-test-0" --action "adr_update" \
    --result "$update_out" >/dev/null

  local len updated_status
  len=$(jq 'length' "$resfile")
  assert_eq "resolutions file now has 2 entries" "2" "$len"
  updated_status=$(jq -r '.[1].result.status' "$resfile")
  assert_eq "recorded result.status is updated" "updated" "$updated_status"
}

# ─── Test 5: SKILL.md adr_drift arm wired to action-adr.sh ───────────────────
test_skill_md_adr_arm() {
  echo "test 5: SKILL.md adr_drift case arm references action-adr.sh"
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "SKILL.md exists at $SKILL_MD" "file missing"
    return
  fi
  local content
  content=$(cat "$SKILL_MD")

  # Placeholder text must be gone.
  if grep -qF "Phase 3 / CTL-464 will wire ADR actions" "$SKILL_MD"; then
    fail "SKILL.md placeholder removed" \
      "still contains 'Phase 3 / CTL-464 will wire ADR actions'"
  else
    pass "SKILL.md placeholder removed"
  fi

  # adr_drift arm references action-adr.sh.
  assert_grep "SKILL.md handler table lists adr_update" "adr_update" "$content"
  assert_grep "SKILL.md handler table lists adr_ticket" "adr_ticket" "$content"
  assert_grep "SKILL.md handler table lists adr_defer" "adr_defer" "$content"
  assert_grep "SKILL.md references action-adr.sh" "action-adr.sh" "$content"
}

# ─── Test 6: soft-skip when ADR file isn't in a git repo ─────────────────────
test_action_adr_not_in_git_repo() {
  echo "test 6: action-adr.sh soft-skips when ADR file isn't in a git repo"
  local t_dir="$SCRATCH/t6"
  local bin_dir="$t_dir/bin"
  mkdir -p "$t_dir/loose"
  install_fake_editor "$bin_dir"

  local adr_file="$t_dir/loose/0001-test.md"
  cat > "$adr_file" <<'ADR'
---
adr_id: ADR-001
---
body
ADR

  # update mode
  local out ec
  out=$(FAKE_EDITOR_SCRIPT='printf "x\n" >> "$1"' EDITOR="editor" \
        PATH="$bin_dir:$PATH" \
        bash "$TARGET" --mode update --adr-file "$adr_file" 2>&1)
  ec=$?
  assert_exit "update non-repo exits 0" "0" "$ec"
  assert_grep "update non-repo status=skipped" '"status":"skipped"' "$out"
  assert_grep "update non-repo reason mentions git repo" "git repo" "$out"

  # defer mode (separate adr file to keep state clean)
  local adr_file2="$t_dir/loose/0002-test.md"
  cat > "$adr_file2" <<'ADR'
---
adr_id: ADR-002
---
body
ADR
  local out2 ec2
  out2=$(bash "$TARGET" --mode defer --adr-file "$adr_file2" \
         --reason "outside repo" 2>&1)
  ec2=$?
  assert_exit "defer non-repo exits 0" "0" "$ec2"
  assert_grep "defer non-repo status=skipped" '"status":"skipped"' "$out2"
  assert_grep "defer non-repo reason mentions git repo" "git repo" "$out2"

  # File must NOT have been modified (the soft-skip happens before append).
  local body
  body=$(cat "$adr_file2")
  if grep -qF "drift-noted" <<<"$body"; then
    fail "defer non-repo did not append to file" \
      "file was modified despite soft-skip"
  else
    pass "defer non-repo did not append to file"
  fi
}

# ─── Test 7: adr_id fallback to basename when frontmatter missing ────────────
test_action_adr_basename_fallback() {
  echo "test 7: action-adr.sh derives adr_id from basename when frontmatter absent"
  local t_dir="$SCRATCH/t7"
  local repo="$t_dir/repo"
  mkdir -p "$repo/docs/adrs"
  cat > "$repo/docs/adrs/0042-no-frontmatter.md" <<'ADR'
# ADR with no YAML frontmatter

Body text only.
ADR
  (
    cd "$repo" \
      && git init -q -b main 2>/dev/null || git init -q
    git -C "$repo" config user.email "test@example.com"
    git -C "$repo" config user.name "Test"
    git -C "$repo" add . && git -C "$repo" commit -q -m "init"
  )

  local adr_file="$repo/docs/adrs/0042-no-frontmatter.md"

  # Defer mode — easy path with no external deps.
  local out
  out=$(bash "$TARGET" --mode defer --adr-file "$adr_file" \
        --reason "no fm" --date 2026-05-17 2>&1)

  assert_grep "adr_id falls back to basename" \
    '"adr_id":"0042-no-frontmatter"' "$out"

  local subj
  subj=$(git -C "$repo" log -1 --pretty=%s)
  assert_eq "defer commit subject uses basename adr_id" \
    "docs(adr): defer drift on 0042-no-frontmatter" "$subj"
}

test_action_adr_update
test_action_adr_ticket
test_action_adr_defer
test_action_adr_record_resolution
test_skill_md_adr_arm
test_action_adr_not_in_git_repo
test_action_adr_basename_fallback

echo "─────────────────────────────────────"
echo "PASSED: $PASSES"
echo "FAILED: $FAILURES"
echo "─────────────────────────────────────"
exit $(( FAILURES > 0 ? 1 : 0 ))
