#!/usr/bin/env bash
# Tests for the briefing-followup write-back to briefing markdown (CTL-465 Phase 4).
# Covers: writeback.sh updates frontmatter resolutions:, appends "Decisions Made
# Today" body section, commits to the routine-scoped branch with the canonical
# message, emits briefing.followup.complete.<date>, and is idempotent on rerun.
#
# Run: bash plugins/dev/scripts/__tests__/briefing-followup-writeback.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
BF_DIR="${REPO_ROOT}/plugins/dev/scripts/briefing-followup"
WRITEBACK="${BF_DIR}/writeback.sh"
RECORD="${BF_DIR}/record-resolution.sh"
LIB="${REPO_ROOT}/plugins/dev/scripts/briefing-frontmatter-lib.sh"
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

# Build a sandbox git repo with a briefing markdown at the canonical path so
# writeback.sh can run `git commit` against it. The fixture mirrors the shape
# produced by `morning-briefing/render.sh` for a real run.
setup_repo() {
  local repo="$1" date="$2"
  mkdir -p "$repo/thoughts/briefings"
  cat > "$repo/thoughts/briefings/$date.md" <<MD
---
date: $date
generated_by: morning-briefing
decisions:
- id: dec-1
  type: judgment_call
  summary: Pick auth provider
  status: open
- id: dec-2
  type: blocked_pr
  summary: PR #800 stalled
  status: open
  pr_url: https://github.com/org/repo/pull/800
- id: dec-3
  type: adr_drift
  summary: ADR-004 drift detected
  status: open
  adr: docs/adrs/0004.md
---

# Morning Briefing — $date

## Review yesterday

_no data_

## Surface decisions

- **[judgment_call]** Pick auth provider (\`dec-1\`, status: open)
- **[blocked_pr]** PR #800 stalled (\`dec-2\`, status: open)
- **[adr_drift]** ADR-004 drift detected (\`dec-3\`, status: open)

## Plan today

_no data_

## Suggest orchestrator runs

_no data_
MD
  (
    cd "$repo" \
      && git init -q -b main 2>/dev/null || git init -q
    git -C "$repo" config user.email "test@example.com"
    git -C "$repo" config user.name "Test User"
    git -C "$repo" add . && git -C "$repo" commit -q -m "init briefing $date"
  )
}

# Seed a resolutions JSON file as produced by record-resolution.sh after the
# user walks through two decisions.
seed_resolutions() {
  local log_dir="$1" date="$2"
  mkdir -p "$log_dir"
  bash "$RECORD" --log-dir "$log_dir" --date "$date" \
    --id "dec-1" --action "schedule_calendar" \
    --result '{"event_id":"evt-1","html_link":"https://cal/x","status":"scheduled"}' \
    >/dev/null
  bash "$RECORD" --log-dir "$log_dir" --date "$date" \
    --id "dec-3" --action "adr_defer" \
    --result '{"adr_file":"docs/adrs/0004.md","adr_id":"ADR-004","commit_sha":"abc","status":"deferred"}' \
    >/dev/null
}

# Extract the YAML frontmatter block as plain text.
extract_fm() {
  awk '
    /^---[[:space:]]*$/ {
      if (in_block) { exit }
      in_block = 1; next
    }
    in_block { print }
  ' "$1"
}

# Extract everything after the closing frontmatter --- as the body.
extract_body() {
  awk '
    BEGIN { dashes = 0 }
    /^---[[:space:]]*$/ {
      dashes++
      if (dashes == 2) { in_body = 1; next }
      next
    }
    in_body { print }
  ' "$1"
}

# YAML frontmatter → JSON. Mirrors the python parser used by parse-briefing.sh
# so we can assert structurally instead of with regex.
fm_to_json() {
  local file="$1"
  extract_fm "$file" | python3 -c '
import sys, json, yaml
try:
    data = yaml.safe_load(sys.stdin)
except Exception as e:
    sys.stderr.write("yaml parse: " + str(e) + "\n"); sys.exit(2)
json.dump(data, sys.stdout, default=str)
'
}

# ─── Test 1: writeback updates frontmatter resolutions: array ───────────────
test_frontmatter_resolutions() {
  echo "test 1: writeback.sh updates frontmatter resolutions: array"
  local date="2026-05-17"
  local repo="$SCRATCH/t1"
  local log_dir="$SCRATCH/t1-logs"
  setup_repo "$repo" "$date"
  seed_resolutions "$log_dir" "$date"

  local briefing="$repo/thoughts/briefings/$date.md"
  local resolutions="$log_dir/briefing-followup-$date-resolutions.json"

  local out ec
  out=$(bash "$WRITEBACK" --briefing "$briefing" --resolutions "$resolutions" \
        --date "$date" --no-commit --no-event 2>&1)
  ec=$?
  assert_exit "writeback exits 0" "0" "$ec"
  assert_grep "writeback prints status JSON" '"status":' "$out"

  # Frontmatter now has a resolutions: array with 2 entries.
  local fm_json
  fm_json=$(fm_to_json "$briefing" 2>/dev/null)
  local res_count
  res_count=$(printf '%s' "$fm_json" | jq '.resolutions | length' 2>/dev/null)
  assert_eq "resolutions array length = 2" "2" "$res_count"

  # Decision dec-1 → schedule_calendar; status should flip to resolved.
  local dec1_status
  dec1_status=$(printf '%s' "$fm_json" \
    | jq -r '.decisions[] | select(.id == "dec-1") | .status')
  assert_eq "dec-1 status now resolved" "resolved" "$dec1_status"

  # dec-2 had no resolution: must still be open.
  local dec2_status
  dec2_status=$(printf '%s' "$fm_json" \
    | jq -r '.decisions[] | select(.id == "dec-2") | .status')
  assert_eq "dec-2 status unchanged (open)" "open" "$dec2_status"

  # Resolutions carry the canonical fields produced by record-resolution.sh.
  local first_action
  first_action=$(printf '%s' "$fm_json" \
    | jq -r '.resolutions[] | select(.decision_id == "dec-1") | .action')
  assert_eq "dec-1 resolution action = schedule_calendar" "schedule_calendar" "$first_action"
}

# ─── Test 2: writeback appends "## Decisions Made Today" section ────────────
test_decisions_made_today_section() {
  echo "test 2: writeback.sh appends Decisions Made Today section"
  local date="2026-05-17"
  local repo="$SCRATCH/t2"
  local log_dir="$SCRATCH/t2-logs"
  setup_repo "$repo" "$date"
  seed_resolutions "$log_dir" "$date"

  local briefing="$repo/thoughts/briefings/$date.md"
  local resolutions="$log_dir/briefing-followup-$date-resolutions.json"

  bash "$WRITEBACK" --briefing "$briefing" --resolutions "$resolutions" \
    --date "$date" --no-commit --no-event >/dev/null 2>&1

  local body
  body=$(extract_body "$briefing")

  assert_grep "body has Decisions Made Today heading" \
    "## Decisions Made Today" "$body"
  assert_grep "section mentions dec-1 schedule_calendar" \
    "schedule_calendar" "$body"
  assert_grep "section mentions dec-3 adr_defer" \
    "adr_defer" "$body"
  # Decisions with no resolution should NOT appear in the section.
  if grep -qF "dec-2" <<<"$(echo "$body" | awk '/^## Decisions Made Today/{p=1} p')"; then
    fail "Decisions Made Today excludes unresolved dec-2" \
      "dec-2 appeared in the section"
  else
    pass "Decisions Made Today excludes unresolved dec-2"
  fi
}

# ─── Test 3: writeback commits with the canonical message ───────────────────
test_git_commit() {
  echo "test 3: writeback.sh commits with canonical message"
  local date="2026-05-17"
  local repo="$SCRATCH/t3"
  local log_dir="$SCRATCH/t3-logs"
  setup_repo "$repo" "$date"
  seed_resolutions "$log_dir" "$date"

  local briefing="$repo/thoughts/briefings/$date.md"
  local resolutions="$log_dir/briefing-followup-$date-resolutions.json"

  # Default mode commits (no --no-commit). --no-push is honored so the test
  # never touches a remote.
  local out ec
  out=$(bash "$WRITEBACK" --briefing "$briefing" --resolutions "$resolutions" \
        --date "$date" --no-push --no-event 2>&1)
  ec=$?
  assert_exit "writeback (commit) exits 0" "0" "$ec"

  local subj
  subj=$(git -C "$repo" log -1 --pretty=%s)
  assert_eq "commit subject canonical" \
    "briefing(followup): $date resolutions" "$subj"

  # Status JSON reports the SHA so callers can chain it.
  assert_grep "status JSON includes commit_sha" '"commit_sha"' "$out"
  assert_grep "status JSON includes status=updated" '"status":"updated"' "$out"

  # Only the briefing file is in the commit.
  local files
  files=$(git -C "$repo" show --name-only --pretty=format: HEAD | grep -v '^$' || true)
  assert_eq "commit changes exactly one file" \
    "thoughts/briefings/$date.md" "$files"
}

# ─── Test 4: writeback emits briefing.followup.complete.<date> event ────────
test_event_emission() {
  echo "test 4: writeback.sh emits briefing.followup.complete.<date>"
  local date="2026-05-17"
  local repo="$SCRATCH/t4"
  local log_dir="$SCRATCH/t4-logs"
  local events_dir="$SCRATCH/t4-events"
  setup_repo "$repo" "$date"
  seed_resolutions "$log_dir" "$date"

  local briefing="$repo/thoughts/briefings/$date.md"
  local resolutions="$log_dir/briefing-followup-$date-resolutions.json"

  bash "$WRITEBACK" --briefing "$briefing" --resolutions "$resolutions" \
    --date "$date" --no-commit --events-dir "$events_dir" >/dev/null 2>&1

  # Canonical events live at <events-dir>/YYYY-MM.jsonl
  local month_file="${events_dir}/$(date -u +%Y-%m).jsonl"
  if [[ ! -f "$month_file" ]]; then
    fail "event log file written" "expected $month_file"
    return
  fi
  pass "event log file written"

  # Find the briefing.followup.complete event for this date.
  local event_name
  event_name=$(jq -r 'select(.attributes."event.name" | startswith("briefing.followup.complete")) | .attributes."event.name"' \
    "$month_file" 2>/dev/null | head -n 1)
  assert_eq "event name includes date suffix" \
    "briefing.followup.complete.$date" "$event_name"

  # Payload carries the resolution count so consumers can short-circuit.
  local payload_count
  payload_count=$(jq -r 'select(.attributes."event.name" == "briefing.followup.complete.'"$date"'") | .body.payload.resolutionCount' \
    "$month_file" 2>/dev/null | head -n 1)
  assert_eq "payload resolutionCount = 2" "2" "$payload_count"
}

# ─── Test 5: writeback is idempotent on re-run ──────────────────────────────
test_idempotent_rerun() {
  echo "test 5: writeback.sh is idempotent on re-run"
  local date="2026-05-17"
  local repo="$SCRATCH/t5"
  local log_dir="$SCRATCH/t5-logs"
  setup_repo "$repo" "$date"
  seed_resolutions "$log_dir" "$date"

  local briefing="$repo/thoughts/briefings/$date.md"
  local resolutions="$log_dir/briefing-followup-$date-resolutions.json"

  # First run.
  bash "$WRITEBACK" --briefing "$briefing" --resolutions "$resolutions" \
    --date "$date" --no-commit --no-event >/dev/null 2>&1

  # Capture the post-run file content.
  local first_content
  first_content=$(cat "$briefing")
  local first_section_count
  first_section_count=$(grep -c "^## Decisions Made Today" "$briefing" || true)
  assert_eq "first run produces exactly one Decisions Made Today section" \
    "1" "$first_section_count"

  # Second run with the same inputs.
  bash "$WRITEBACK" --briefing "$briefing" --resolutions "$resolutions" \
    --date "$date" --no-commit --no-event >/dev/null 2>&1

  local second_section_count
  second_section_count=$(grep -c "^## Decisions Made Today" "$briefing" || true)
  assert_eq "second run still has exactly one Decisions Made Today section" \
    "1" "$second_section_count"

  # Resolutions array stays at 2 (no duplicates).
  local fm_json res_count
  fm_json=$(fm_to_json "$briefing" 2>/dev/null)
  res_count=$(printf '%s' "$fm_json" | jq '.resolutions | length' 2>/dev/null)
  assert_eq "second run resolutions array still length 2" "2" "$res_count"
}

# ─── Test 6: writeback no-ops when no resolutions recorded ──────────────────
test_skips_when_no_resolutions() {
  echo "test 6: writeback.sh skips when resolutions file is absent or empty"
  local date="2026-05-17"
  local repo="$SCRATCH/t6"
  local log_dir="$SCRATCH/t6-logs"
  setup_repo "$repo" "$date"
  mkdir -p "$log_dir"

  local briefing="$repo/thoughts/briefings/$date.md"
  local missing_resolutions="$log_dir/briefing-followup-$date-resolutions.json"

  # Resolutions file does not exist → skip cleanly.
  local out ec
  out=$(bash "$WRITEBACK" --briefing "$briefing" --resolutions "$missing_resolutions" \
        --date "$date" --no-commit --no-event 2>&1)
  ec=$?
  assert_exit "missing resolutions file → exit 0" "0" "$ec"
  assert_grep "missing resolutions emits status=skipped" '"status":"skipped"' "$out"

  # Briefing markdown is unchanged.
  if grep -qF "## Decisions Made Today" "$briefing"; then
    fail "missing resolutions leaves briefing untouched" \
      "but Decisions Made Today section appeared"
  else
    pass "missing resolutions leaves briefing untouched"
  fi

  # Empty array → also a skip.
  echo "[]" > "$missing_resolutions"
  out=$(bash "$WRITEBACK" --briefing "$briefing" --resolutions "$missing_resolutions" \
        --date "$date" --no-commit --no-event 2>&1)
  ec=$?
  assert_exit "empty resolutions file → exit 0" "0" "$ec"
  assert_grep "empty resolutions emits status=skipped" '"status":"skipped"' "$out"
}

# ─── Test 7: shared frontmatter lib extracts blocks consistently ────────────
test_frontmatter_lib() {
  echo "test 7: briefing-frontmatter-lib.sh extracts blocks consistently"
  if [[ ! -f "$LIB" ]]; then
    fail "lib file exists at expected path" "missing: $LIB"
    return
  fi
  pass "lib file exists"

  local date="2026-05-17"
  local repo="$SCRATCH/t7"
  setup_repo "$repo" "$date"
  local briefing="$repo/thoughts/briefings/$date.md"

  # Source the lib and call its extract function. We document the contract here:
  # `bf_fm_extract <file>` prints the YAML between the two `---` lines.
  local out ec
  out=$(bash -c 'source "$1"; bf_fm_extract "$2"' _ "$LIB" "$briefing" 2>&1)
  ec=$?
  assert_exit "bf_fm_extract exits 0" "0" "$ec"
  assert_grep "extracted block contains date key" "date: $date" "$out"
  assert_grep "extracted block contains decisions list" "decisions:" "$out"

  # bf_fm_to_json prints the frontmatter as JSON via python+yaml. The lib must
  # match parse-briefing.sh's behavior (callers already trust that shape).
  local json
  json=$(bash -c 'source "$1"; bf_fm_to_json "$2"' _ "$LIB" "$briefing" 2>&1)
  local count
  count=$(printf '%s' "$json" | jq '.decisions | length' 2>/dev/null)
  assert_eq "bf_fm_to_json decisions length = 3" "3" "$count"
}

# ─── Test 8: SKILL.md wires writeback into Step 5 ───────────────────────────
test_skill_md_writeback_arm() {
  echo "test 8: SKILL.md invokes writeback.sh before ending the session"
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "SKILL.md exists at $SKILL_MD" "file missing"
    return
  fi
  local content
  content=$(cat "$SKILL_MD")
  assert_grep "SKILL.md references writeback.sh" "writeback.sh" "$content"
  # The Phase 4 contract (write-back at session end) must be in scope summary.
  assert_grep "SKILL.md describes Phase 4 write-back" "resolutions write-back" "$content"
}

# ─── Run all tests ──────────────────────────────────────────────────────────
test_frontmatter_resolutions
test_decisions_made_today_section
test_git_commit
test_event_emission
test_idempotent_rerun
test_skips_when_no_resolutions
test_frontmatter_lib
test_skill_md_writeback_arm

echo
echo "─────────────────────────────────────"
echo "PASSED: $PASSES"
echo "FAILED: $FAILURES"
echo "─────────────────────────────────────"
exit $(( FAILURES > 0 ? 1 : 0 ))
