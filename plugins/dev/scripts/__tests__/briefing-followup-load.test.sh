#!/usr/bin/env bash
# Tests for the briefing-followup skill MVP (CTL-462 Phase 1).
# Covers: parse-briefing.sh path resolution, frontmatter loading,
# decision extraction, error paths for missing/malformed briefings,
# and the SKILL.md frontmatter contract.
#
# Run: bash plugins/dev/scripts/__tests__/briefing-followup-load.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
BF_DIR="${REPO_ROOT}/plugins/dev/scripts/briefing-followup"
PARSER="${BF_DIR}/parse-briefing.sh"
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

# Write a valid briefing fixture at <root>/thoughts/briefings/<date>.md.
write_fixture() {
  local root="$1" date="$2"
  mkdir -p "$root/thoughts/briefings"
  cat > "$root/thoughts/briefings/$date.md" <<MD
---
date: $date
generated_by: morning-briefing
decisions:
  - id: dec-1
    type: blocked_pr
    summary: "PR #800 stalled"
    status: open
    pr_url: https://github.com/org/repo/pull/800
  - id: dec-2
    type: judgment_call
    summary: Pick auth provider
    status: open
  - id: dec-3
    type: adr_drift
    summary: ADR-004 drift detected
    status: resolved
    adr: docs/adrs/0004.md
---

# Morning Briefing — $date

## Review yesterday
_no data_
MD
}

# ─── Test 1: parser loads thoughts/briefings/<date>.md by default (today) ────
test_load_default_today() {
  echo "test 1: parse-briefing loads thoughts/briefings/<today>.md by default"
  local today root
  today=$(date -u +%Y-%m-%d)
  root="$SCRATCH/proj1"
  write_fixture "$root" "$today"
  local actual ec
  actual=$(bash "$PARSER" path --root "$root" 2>&1)
  ec=$?
  assert_exit "default path exits 0" "0" "$ec"
  assert_eq "default path is today's briefing" \
    "$root/thoughts/briefings/${today}.md" "$actual"

  # Confirm we can actually load it
  local decisions
  decisions=$(bash "$PARSER" decisions --root "$root" 2>/dev/null)
  ec=$?
  assert_exit "load default briefing exits 0" "0" "$ec"
  if printf '%s' "$decisions" | jq -e 'type == "array"' >/dev/null 2>&1; then
    pass "decisions output is a JSON array"
  else
    fail "decisions output is a JSON array" "got: $decisions"
  fi
}

# ─── Test 2: parser loads with --date YYYY-MM-DD ─────────────────────────────
test_load_explicit_date() {
  echo "test 2: parse-briefing loads with explicit --date"
  local date="2026-04-01" root="$SCRATCH/proj2"
  write_fixture "$root" "$date"
  local actual ec
  actual=$(bash "$PARSER" path --date "$date" --root "$root" 2>&1)
  ec=$?
  assert_exit "explicit-date path exits 0" "0" "$ec"
  assert_eq "explicit-date path resolved" \
    "$root/thoughts/briefings/${date}.md" "$actual"

  local decisions
  decisions=$(bash "$PARSER" decisions --date "$date" --root "$root" 2>/dev/null)
  ec=$?
  assert_exit "load explicit-date briefing exits 0" "0" "$ec"
  # Default status filter = open → expect 2 decisions, not 3
  local count
  count=$(printf '%s' "$decisions" | jq 'length')
  assert_eq "default decisions filter = open (2 of 3)" "2" "$count"
}

# ─── Test 3: parser errors gracefully when briefing missing ─────────────────
test_missing_briefing_error() {
  echo "test 3: parse-briefing errors gracefully when briefing missing"
  local date="2026-04-02" root="$SCRATCH/proj3"
  mkdir -p "$root"
  # Note: no briefing file written
  local stderr ec
  stderr=$(bash "$PARSER" decisions --date "$date" --root "$root" 2>&1 1>/dev/null)
  ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "missing briefing should exit non-zero" "got exit 0"
  else
    pass "missing briefing exits non-zero (got $ec)"
  fi
  # Diagnostics should mention the path AND suggest running morning-briefing
  assert_grep "error mentions briefing path" "$root/thoughts/briefings/${date}.md" "$stderr"
  assert_grep "error suggests morning-briefing skill" "morning-briefing" "$stderr"
}

# ─── Test 4: parser extracts decisions from frontmatter ─────────────────────
test_parse_decisions_block() {
  echo "test 4: parse-briefing parses decisions: from frontmatter"
  local date="2026-04-03" root="$SCRATCH/proj4"
  write_fixture "$root" "$date"

  # All-status filter should return all 3 decisions
  local all
  all=$(bash "$PARSER" decisions --date "$date" --root "$root" --status all 2>/dev/null)
  local all_count
  all_count=$(printf '%s' "$all" | jq 'length')
  assert_eq "all-status filter returns 3 decisions" "3" "$all_count"

  # Verify each required field is present on first decision
  local first
  first=$(printf '%s' "$all" | jq '.[0]')
  assert_grep "decision has id field"      '"id"'      "$first"
  assert_grep "decision has type field"    '"type"'    "$first"
  assert_grep "decision has summary field" '"summary"' "$first"
  assert_grep "decision has status field"  '"status"'  "$first"

  # Single-decision lookup by id
  local dec
  dec=$(bash "$PARSER" decision --date "$date" --root "$root" --id "dec-2" 2>/dev/null)
  local dec_summary
  dec_summary=$(printf '%s' "$dec" | jq -r '.summary')
  assert_eq "decision by id (dec-2) summary" "Pick auth provider" "$dec_summary"

  # Unknown id → non-zero
  local ec
  bash "$PARSER" decision --date "$date" --root "$root" --id "no-such-id" >/dev/null 2>&1
  ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "unknown decision id should exit non-zero" "got exit 0"
  else
    pass "unknown decision id exits non-zero (got $ec)"
  fi

  # Agenda subcommand renders a numbered, human-readable list
  local agenda
  agenda=$(bash "$PARSER" agenda --date "$date" --root "$root" 2>/dev/null)
  assert_grep "agenda includes dec-1 summary" "PR #800 stalled" "$agenda"
  assert_grep "agenda includes dec-2 summary" "Pick auth provider" "$agenda"
  # dec-3 is status=resolved, so default agenda (status=open) should exclude it
  if grep -qF "ADR-004 drift detected" <<<"$agenda"; then
    fail "agenda default filter (open) excludes resolved decisions" \
      "but dec-3 (status=resolved) appeared in output"
  else
    pass "agenda default filter (open) excludes resolved decisions"
  fi
}

# ─── Test 5: parser survives malformed frontmatter (clear error, no crash) ──
test_malformed_frontmatter() {
  echo "test 5: parse-briefing surfaces a clear error on malformed frontmatter"
  local date="2026-04-04" root="$SCRATCH/proj5"
  mkdir -p "$root/thoughts/briefings"
  # Malformed YAML: unterminated list, missing colon, mixed indentation
  cat > "$root/thoughts/briefings/$date.md" <<'MD'
---
date: 2026-04-04
generated_by: morning-briefing
decisions:
  - id dec-1
    type: blocked_pr
   summary: Broken YAML
---

# Body
MD
  local stderr ec
  stderr=$(bash "$PARSER" decisions --date "$date" --root "$root" 2>&1 1>/dev/null)
  ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "malformed frontmatter should exit non-zero" "got exit 0"
  else
    pass "malformed frontmatter exits non-zero (got $ec)"
  fi
  # Should mention the file path so the user knows what failed
  assert_grep "error mentions briefing path" \
    "$root/thoughts/briefings/${date}.md" "$stderr"

  # Edge case: file exists but has no frontmatter at all
  local date2="2026-04-05"
  cat > "$root/thoughts/briefings/$date2.md" <<'MD'
# Just a heading, no frontmatter

Plain markdown.
MD
  stderr=$(bash "$PARSER" decisions --date "$date2" --root "$root" 2>&1 1>/dev/null)
  ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "no-frontmatter file should exit non-zero" "got exit 0"
  else
    pass "no-frontmatter file exits non-zero (got $ec)"
  fi
}

# ─── Test: parser rejects malformed --date ──────────────────────────────────
test_bad_date_arg() {
  echo "test: parse-briefing rejects malformed --date"
  local ec
  bash "$PARSER" path --date "not-a-date" --root "$SCRATCH" >/dev/null 2>&1
  ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "malformed --date should exit non-zero" "got exit 0"
  else
    pass "malformed --date exits non-zero (got $ec)"
  fi
}

# ─── Test: --file overrides --date / --root path resolution ─────────────────
test_explicit_file_override() {
  echo "test: --file overrides path resolution"
  local date="2026-04-06" root="$SCRATCH/proj6"
  mkdir -p "$root"
  local custom="$SCRATCH/custom-briefing.md"
  cat > "$custom" <<MD
---
date: $date
generated_by: morning-briefing
decisions:
  - id: only
    type: scope_question
    summary: From custom path
    status: open
---

# Body
MD
  local decisions count
  decisions=$(bash "$PARSER" decisions --file "$custom" 2>/dev/null)
  count=$(printf '%s' "$decisions" | jq 'length')
  assert_eq "--file loads decisions" "1" "$count"
}

# ─── Test: SKILL.md exists with required frontmatter ────────────────────────
test_skill_md_frontmatter() {
  echo "test: SKILL.md exists with correct frontmatter"
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "SKILL.md exists" "missing: $SKILL_MD"; return
  fi
  pass "SKILL.md exists"
  local fm
  fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$SKILL_MD")
  assert_grep "name: briefing-followup" "name: briefing-followup" "$fm"
  assert_grep "disable-model-invocation: true" "disable-model-invocation: true" "$fm"
  assert_grep "user-invocable: true" "user-invocable: true" "$fm"
  assert_grep "allowed-tools includes Bash" "Bash" "$fm"
}

# ─── Run all tests ──────────────────────────────────────────────────────────
test_load_default_today
test_load_explicit_date
test_missing_briefing_error
test_parse_decisions_block
test_malformed_frontmatter
test_bad_date_arg
test_explicit_file_override
test_skill_md_frontmatter

echo
echo "─────────────────────────────────────"
echo "PASSED: $PASSES"
echo "FAILED: $FAILURES"
echo "─────────────────────────────────────"
exit $(( FAILURES > 0 ? 1 : 0 ))
