#!/usr/bin/env bash
# Tests for the morning-briefing skill MVP (CTL-457).
# Covers: render.sh, output-path.sh, validate-frontmatter.sh, the gather-*.sh
# credential-absent paths, the SKILL.md frontmatter contract, and the
# briefing-frontmatter.schema.json file itself.
#
# Run: bash plugins/dev/scripts/__tests__/morning-briefing-skill.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
MB_DIR="${REPO_ROOT}/plugins/dev/scripts/morning-briefing"
SCHEMA="${REPO_ROOT}/plugins/dev/templates/briefing-frontmatter.schema.json"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/morning-briefing/SKILL.md"

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

# ─── Test: schema exists and parses ──────────────────────────────────────────
test_schema_exists() {
  echo "test: schema file exists and is valid JSON"
  if [[ ! -f "$SCHEMA" ]]; then
    fail "schema file exists" "missing: $SCHEMA"; return
  fi
  pass "schema file exists"
  if jq -e . "$SCHEMA" >/dev/null 2>&1; then
    pass "schema parses as JSON"
  else
    fail "schema parses as JSON" "jq failed"
  fi
  local required
  required=$(jq -r '.required | join(",")' "$SCHEMA")
  assert_eq "schema declares required: date,generated_by,decisions" \
    "date,generated_by,decisions" "$required"
}

# ─── Test: render.sh produces 4 sections + populated decisions block ────────
test_render_produces_4_sections() {
  echo "test: render.sh produces 4 sections"
  local fixture="$SCRATCH/fixture.json"
  cat > "$fixture" <<'JSON'
{
  "date": "2026-05-17",
  "yesterday": {
    "linear":   [{"id":"CTL-100","title":"Ship X","state":"Done"}],
    "github":   [{"number":799,"title":"feat: scaffold","url":"https://github.com/org/repo/pull/799"}],
    "granola":  [{"id":"not_abc","title":"Sync w/ team","created_at":"2026-05-16T15:00:00Z"}],
    "drive":    [],
    "calendar": []
  },
  "decisions": [
    {"id":"dec-1","type":"blocked_pr","summary":"PR #800 stalled","status":"open"},
    {"id":"dec-2","type":"judgment_call","summary":"Pick auth provider","status":"open"}
  ],
  "today": {
    "linear_in_progress": [{"id":"CTL-200","title":"Build briefing skill"}],
    "calendar":           [{"title":"1:1 w/ Alice","start":"2026-05-17T14:00:00Z"}],
    "followups":          [{"action":"Email vendor about renewal"}]
  },
  "suggested_runs": [{"id":"CTL-300","title":"Rewrite onboarding","priority":"High"}]
}
JSON
  local out="$SCRATCH/render-1.md"
  bash "$MB_DIR/render.sh" --input "$fixture" --output "$out" >/dev/null
  local content
  content=$(cat "$out")
  assert_grep "Heading: Morning Briefing" "# Morning Briefing — 2026-05-17" "$content"
  assert_grep "Section: Review yesterday"        "## Review yesterday" "$content"
  assert_grep "Section: Surface decisions"       "## Surface decisions" "$content"
  assert_grep "Section: Plan today"              "## Plan today" "$content"
  assert_grep "Section: Suggest orchestrator runs" "## Suggest orchestrator runs" "$content"
  assert_grep "Linear item rendered"             "[CTL-100] Ship X" "$content"
  assert_grep "GitHub item rendered"             "[#799] feat: scaffold" "$content"
  assert_grep "Suggested run rendered"           "CTL-300" "$content"
}

# ─── Test: render.sh writes decisions array in frontmatter ─────────────────
test_render_writes_decisions_block() {
  echo "test: render.sh emits decisions array in frontmatter"
  local fixture="$SCRATCH/fixture-dec.json"
  cat > "$fixture" <<'JSON'
{
  "date": "2026-05-17",
  "decisions": [
    {"id":"dec-a","type":"blocked_pr","summary":"A","status":"open"},
    {"id":"dec-b","type":"adr_drift","summary":"B","status":"open"}
  ]
}
JSON
  local out="$SCRATCH/render-dec.md"
  bash "$MB_DIR/render.sh" --input "$fixture" --output "$out" >/dev/null
  # Extract frontmatter and count decisions
  local fm count
  fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$out")
  count=$(printf '%s\n' "$fm" \
    | python3 -c 'import sys,yaml; print(len(yaml.safe_load(sys.stdin).get("decisions", [])))')
  assert_eq "frontmatter decisions length" "2" "$count"
  assert_grep "decisions block surfaces 'A'" "A" "$(printf '%s' "$fm")"
  assert_grep "decisions block surfaces 'B'" "B" "$(printf '%s' "$fm")"
}

# ─── Test: render.sh shows _no data_ for empty sections ─────────────────────
test_render_no_data_placeholder() {
  echo "test: render.sh shows _no data_ on empty input"
  local fixture="$SCRATCH/fixture-empty.json"
  echo '{"date":"2026-05-17","decisions":[]}' > "$fixture"
  local out="$SCRATCH/render-empty.md"
  bash "$MB_DIR/render.sh" --input "$fixture" --output "$out" >/dev/null
  local content
  content=$(cat "$out")
  # At least one '_no data_' per empty section
  local count
  count=$(grep -c '^_no data_$' "$out")
  if [[ "$count" -ge 4 ]]; then
    pass "_no data_ appears in at least 4 places (got $count)"
  else
    fail "_no data_ appears in at least 4 places" "got $count" "content:" "$content"
  fi
}

# ─── Test: output-path.sh default ───────────────────────────────────────────
test_output_path_default() {
  echo "test: output-path.sh --date prints thoughts/briefings/<date>.md"
  local actual
  actual=$(bash "$MB_DIR/output-path.sh" --date 2026-05-17 --root /tmp/proj)
  assert_eq "default output path" "/tmp/proj/thoughts/briefings/2026-05-17.md" "$actual"
}

# ─── Test: output-path.sh dry-run ───────────────────────────────────────────
test_output_path_dry_run() {
  echo "test: output-path.sh --dry-run goes to /tmp"
  local actual
  actual=$(bash "$MB_DIR/output-path.sh" --dry-run --date 2026-05-17)
  assert_eq "dry-run path" "/tmp/morning-briefing-2026-05-17.md" "$actual"
}

# ─── Test: output-path.sh defaults --date to today ─────────────────────────
test_output_path_default_date() {
  echo "test: output-path.sh defaults --date to today UTC"
  local today actual
  today=$(date -u +%Y-%m-%d)
  actual=$(bash "$MB_DIR/output-path.sh" --root /tmp/proj)
  assert_eq "default date path" "/tmp/proj/thoughts/briefings/${today}.md" "$actual"
}

# ─── Test: output-path.sh rejects bad date ──────────────────────────────────
test_output_path_rejects_bad_date() {
  echo "test: output-path.sh rejects malformed --date"
  local ec
  bash "$MB_DIR/output-path.sh" --date "not-a-date" >/dev/null 2>&1
  ec=$?
  assert_exit "bad date exits non-zero" "2" "$ec"
}

# ─── Test: validate-frontmatter passes on rendered fixture ─────────────────
test_validate_frontmatter_passes() {
  echo "test: validate-frontmatter.sh succeeds on rendered fixture"
  local fixture="$SCRATCH/v-fixture.json"
  cat > "$fixture" <<'JSON'
{
  "date": "2026-05-17",
  "decisions": [{"id":"d","type":"blocked_pr","summary":"x","status":"open"}]
}
JSON
  local out="$SCRATCH/v-render.md"
  bash "$MB_DIR/render.sh" --input "$fixture" --output "$out" >/dev/null
  local ec
  bash "$MB_DIR/validate-frontmatter.sh" "$out" >/dev/null 2>&1
  ec=$?
  assert_exit "valid frontmatter exits 0" "0" "$ec"
}

# ─── Test: validate-frontmatter rejects missing required field ─────────────
test_validate_frontmatter_fails_on_bad_schema() {
  echo "test: validate-frontmatter.sh rejects bad frontmatter"
  local bad="$SCRATCH/bad.md"
  cat > "$bad" <<'MD'
---
generated_by: morning-briefing
decisions: []
---

# missing date field
MD
  local ec
  bash "$MB_DIR/validate-frontmatter.sh" "$bad" >/dev/null 2>&1
  ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "invalid frontmatter should exit non-zero" "got exit 0"
  else
    pass "invalid frontmatter exits non-zero (got $ec)"
  fi
}

# ─── Test: gather-*.sh degrade to {} when creds absent ──────────────────────
# Run with PATH stripped of linearis/gh and with env vars cleared.
test_gather_no_creds() {
  local name="$1" script="$2" envunset_var="$3"
  echo "test: ${name} returns {} when creds absent"
  local out ec
  out=$(env -i HOME="$HOME" PATH="/usr/bin:/bin" bash "$script" --date 2026-05-17 2>/dev/null)
  ec=$?
  assert_exit "${name} exits 0 without creds" "0" "$ec"
  assert_eq "${name} prints {} without creds" "{}" "$out"
}

test_gather_linear_no_creds()   { test_gather_no_creds "gather-linear"   "$MB_DIR/gather-linear.sh"   "LINEAR_API_KEY"; }
test_gather_github_no_creds()   { test_gather_no_creds "gather-github"   "$MB_DIR/gather-github.sh"   "GH_TOKEN"; }
test_gather_granola_no_creds()  { test_gather_no_creds "gather-granola"  "$MB_DIR/gather-granola.sh"  "GRANOLA_API_KEY"; }
test_gather_drive_no_creds()    { test_gather_no_creds "gather-drive"    "$MB_DIR/gather-drive.sh"    "GOOGLE_OAUTH_ACCESS_TOKEN"; }
test_gather_calendar_no_creds() { test_gather_no_creds "gather-calendar" "$MB_DIR/gather-calendar.sh" "GOOGLE_OAUTH_ACCESS_TOKEN"; }

# ─── Test: SKILL.md exists with required frontmatter ────────────────────────
test_skill_md_exists_with_correct_frontmatter() {
  echo "test: SKILL.md exists with correct frontmatter"
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "SKILL.md exists" "missing: $SKILL_MD"; return
  fi
  pass "SKILL.md exists"
  local fm
  fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$SKILL_MD")
  assert_grep "name: morning-briefing" "name: morning-briefing" "$fm"
  assert_grep "disable-model-invocation: true" "disable-model-invocation: true" "$fm"
  assert_grep "allowed-tools includes Bash" "allowed-tools: Bash" "$fm"
}

# ─── Test: end-to-end — gather (empty) → render → validate ─────────────────
test_end_to_end_empty_creds() {
  echo "test: end-to-end pipeline with no creds produces a valid briefing"
  local d="$SCRATCH/e2e"
  mkdir -p "$d"
  # Gather everything (no creds → all {})
  env -i HOME="$HOME" PATH="/usr/bin:/bin" bash "$MB_DIR/gather-linear.sh"   --date 2026-05-17 > "$d/linear.json"
  env -i HOME="$HOME" PATH="/usr/bin:/bin" bash "$MB_DIR/gather-github.sh"   --date 2026-05-17 > "$d/github.json"
  env -i HOME="$HOME" PATH="/usr/bin:/bin" bash "$MB_DIR/gather-granola.sh"  --date 2026-05-17 > "$d/granola.json"
  env -i HOME="$HOME" PATH="/usr/bin:/bin" bash "$MB_DIR/gather-drive.sh"    --date 2026-05-17 > "$d/drive.json"
  env -i HOME="$HOME" PATH="/usr/bin:/bin" bash "$MB_DIR/gather-calendar.sh" --date 2026-05-17 > "$d/calendar.json"
  echo '{"decisions":[]}' > "$d/decisions.json"
  echo '{"today":{"linear_in_progress":[],"calendar":[],"followups":[]}}' > "$d/today.json"
  echo '{"suggested_runs":[]}' > "$d/suggested.json"

  jq -s --arg date "2026-05-17" '
    {date: $date}
    + {yesterday: ((.[0] // {}) + (.[1] // {}) + (.[2] // {}) + (.[3] // {}) + (.[4] // {}))}
    + (.[5] // {}) + (.[6] // {}) + (.[7] // {})
  ' "$d/linear.json" "$d/github.json" "$d/granola.json" "$d/drive.json" "$d/calendar.json" \
    "$d/decisions.json" "$d/today.json" "$d/suggested.json" \
    > "$d/input.json"

  bash "$MB_DIR/render.sh" --input "$d/input.json" --output "$d/briefing.md" >/dev/null
  local ec
  bash "$MB_DIR/validate-frontmatter.sh" "$d/briefing.md" >/dev/null 2>&1
  ec=$?
  assert_exit "end-to-end produces schema-valid briefing" "0" "$ec"
}

# ─── Run all tests ──────────────────────────────────────────────────────────
test_schema_exists
test_render_produces_4_sections
test_render_writes_decisions_block
test_render_no_data_placeholder
test_output_path_default
test_output_path_dry_run
test_output_path_default_date
test_output_path_rejects_bad_date
test_validate_frontmatter_passes
test_validate_frontmatter_fails_on_bad_schema
test_gather_linear_no_creds
test_gather_github_no_creds
test_gather_granola_no_creds
test_gather_drive_no_creds
test_gather_calendar_no_creds
test_skill_md_exists_with_correct_frontmatter
test_end_to_end_empty_creds

echo
echo "─────────────────────────────────────"
echo "PASSED: $PASSES"
echo "FAILED: $FAILURES"
echo "─────────────────────────────────────"
exit $(( FAILURES > 0 ? 1 : 0 ))
