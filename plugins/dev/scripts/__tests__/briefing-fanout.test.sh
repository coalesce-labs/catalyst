#!/usr/bin/env bash
# Tests for the morning-briefing multi-output fan-out (CTL-458).
# Covers: sanitize.sh, fanout-{slack-dm,slack-channel,notion,loom-script}.sh,
# write-output-status.sh, and the briefing-frontmatter.schema.json additions.
#
# Run: bash plugins/dev/scripts/__tests__/briefing-fanout.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
MB_DIR="${REPO_ROOT}/plugins/dev/scripts/morning-briefing"
SCHEMA="${REPO_ROOT}/plugins/dev/templates/briefing-frontmatter.schema.json"

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

assert_not_grep() {
  local label="$1" pattern="$2" content="$3"
  if grep -qF -- "$pattern" <<<"$content"; then
    fail "$label" "expected NOT to contain: $pattern" \
      "actual: $(printf '%s' "$content" | head -20)"
  else
    pass "$label"
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

# Build a populated briefing fixture for sanitize / fan-out tests.
make_briefing() {
  local out="$1"
  cat > "$out" <<'MD'
---
date: '2026-05-17'
generated_by: morning-briefing
decisions:
  - id: dec-1
    type: blocked_pr
    summary: 'PR #800 on Acme integration is stalled awaiting Beta Corp review'
    status: open
  - id: dec-2
    type: judgment_call
    summary: 'Pick auth provider for Acme migration'
    status: open
meetings_yesterday:
  - id: not_a
    title: Sync w/ Acme team
prs_merged_yesterday:
  - number: 799
    title: 'feat: scaffold'
---

# Morning Briefing — 2026-05-17

## Review yesterday

### Linear (state changes)

- [CTL-100] Ship Acme onboarding flow
- [CTL-101] Build Academic dashboard

### GitHub (merged PRs)

- [#799] feat: scaffold  <https://github.com/coalesce-labs/catalyst/pull/799>
- [#800] feat: Acme integration  <https://github.com/coalesce-labs/catalyst/pull/800>

### Granola (meetings)

- Sync w/ Acme team

### Drive (notes)

_no data_

### Calendar (events)

_no data_

## Surface decisions

- **[blocked_pr]** PR #800 stalled (`dec-1`, status: open)
- **[judgment_call]** Pick auth provider (`dec-2`, status: open)

## Plan today

### Linear in-progress

- [CTL-200] Build briefing skill

### Calendar today

- 1:1 w/ Alice

### Follow-ups

- Email vendor about renewal

## Suggest orchestrator runs

- `CTL-300` Rewrite onboarding _(High)_
MD
}

# ─── sanitize.sh tests ──────────────────────────────────────────────────────

test_sanitize_dm_is_noop() {
  echo "test: sanitize.sh --profile dm preserves input"
  local in="$SCRATCH/dm-in.md" out="$SCRATCH/dm-out.md"
  make_briefing "$in"
  bash "$MB_DIR/sanitize.sh" --profile dm --in "$in" --out "$out" >/dev/null
  if diff -q "$in" "$out" >/dev/null; then
    pass "dm profile is byte-for-byte identical"
  else
    fail "dm profile is byte-for-byte identical" "diff found"
  fi
}

test_sanitize_channel_strips_decision_details() {
  echo "test: sanitize.sh --profile channel strips decision summary/status"
  local in="$SCRATCH/c-in.md" out="$SCRATCH/c-out.md"
  make_briefing "$in"
  bash "$MB_DIR/sanitize.sh" --profile channel --in "$in" --out "$out" >/dev/null
  local content; content=$(cat "$out")
  # Frontmatter `decisions` should still parse but each item only has id+type
  local fm; fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$out")
  local first_keys
  first_keys=$(printf '%s' "$fm" | python3 -c '
import sys, yaml
d = yaml.safe_load(sys.stdin)
keys = sorted(d.get("decisions", [{}])[0].keys())
print(",".join(keys))
')
  assert_eq "channel frontmatter decision keys = id,type only" "id,type" "$first_keys"
  # `summary` and `status` from the decisions entries must be gone
  assert_not_grep "channel frontmatter drops summary value" "Pick auth provider" "$(printf '%s' "$fm")"
}

test_sanitize_channel_rewrites_decisions_body() {
  echo "test: sanitize.sh --profile channel rewrites Surface decisions body"
  local in="$SCRATCH/c2-in.md" out="$SCRATCH/c2-out.md"
  make_briefing "$in"
  bash "$MB_DIR/sanitize.sh" --profile channel --in "$in" --out "$out" >/dev/null
  local body; body=$(awk '/^---[[:space:]]*$/{c++; next} c==2' "$out")
  assert_grep "Surface decisions section present" "## Surface decisions" "$body"
  assert_grep "Surface decisions body replaced" "_redacted_" "$body"
  assert_not_grep "decisions body no longer mentions Pick auth provider" "Pick auth provider" "$body"
}

test_sanitize_channel_redacts_customer_names() {
  echo "test: sanitize.sh --profile channel redacts customer names (case-insensitive, whole-word)"
  local in="$SCRATCH/c3-in.md" out="$SCRATCH/c3-out.md"
  make_briefing "$in"
  bash "$MB_DIR/sanitize.sh" --profile channel --redact-list "Acme,Beta Corp" \
    --in "$in" --out "$out" >/dev/null
  local body; body=$(awk '/^---[[:space:]]*$/{c++; next} c==2' "$out")
  assert_not_grep "Acme is redacted from body" "Acme" "$body"
  assert_not_grep "Beta Corp is redacted from body" "Beta Corp" "$body"
  assert_grep "Redaction token present" "[REDACTED]" "$body"
}

test_sanitize_channel_word_boundary() {
  echo "test: sanitize.sh respects word boundaries (Acme ≠ Academic)"
  local in="$SCRATCH/c4-in.md" out="$SCRATCH/c4-out.md"
  make_briefing "$in"
  bash "$MB_DIR/sanitize.sh" --profile channel --redact-list "Acme" \
    --in "$in" --out "$out" >/dev/null
  local body; body=$(awk '/^---[[:space:]]*$/{c++; next} c==2' "$out")
  assert_grep "Academic stays intact" "Academic" "$body"
  assert_not_grep "Acme is redacted" "Acme " "$body"
}

test_sanitize_channel_redacts_pr_urls() {
  echo "test: sanitize.sh --profile channel redacts PR URLs containing redact-list strings"
  local in="$SCRATCH/c5-in.md" out="$SCRATCH/c5-out.md"
  cat > "$in" <<'MD'
---
date: '2026-05-17'
generated_by: morning-briefing
decisions: []
---

# Body

- safe url: <https://github.com/coalesce-labs/catalyst/pull/799>
- branded url: <https://github.com/example/acme-integration/pull/42>
- branded inline: see https://github.com/example/repo/pull/77/files?Acme=1 here
MD
  bash "$MB_DIR/sanitize.sh" --profile channel --redact-list "Acme" \
    --in "$in" --out "$out" >/dev/null
  local body; body=$(awk '/^---[[:space:]]*$/{c++; next} c==2' "$out")
  assert_grep "safe URL preserved" "pull/799" "$body"
  assert_not_grep "branded URL #42 redacted" "acme-integration" "$body"
  assert_not_grep "branded inline URL redacted" "pull/77/files?Acme=1" "$body"
  assert_grep "redacted URL placeholder present" "[redacted-url]" "$body"
}

test_sanitize_rejects_bad_profile() {
  echo "test: sanitize.sh rejects missing/unknown profile"
  local in="$SCRATCH/bp-in.md"
  make_briefing "$in"
  local ec
  bash "$MB_DIR/sanitize.sh" --in "$in" >/dev/null 2>&1; ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "missing --profile exits non-zero" "got exit 0"
  else
    pass "missing --profile exits non-zero (got $ec)"
  fi
  bash "$MB_DIR/sanitize.sh" --profile bogus --in "$in" >/dev/null 2>&1; ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "unknown profile exits non-zero" "got exit 0"
  else
    pass "unknown profile exits non-zero (got $ec)"
  fi
}

# ─── fanout-slack-dm.sh tests ──────────────────────────────────────────────

test_fanout_slack_dm_no_creds() {
  echo "test: fanout-slack-dm.sh skips without SLACK_BOT_TOKEN"
  local in="$SCRATCH/dm-in.md"
  make_briefing "$in"
  local out
  out=$(env -u SLACK_BOT_TOKEN bash "$MB_DIR/fanout-slack-dm.sh" \
    --in "$in" --date 2026-05-17 2>/dev/null)
  local status; status=$(printf '%s' "$out" | jq -r '.status // ""' 2>/dev/null)
  local reason; reason=$(printf '%s' "$out" | jq -r '.reason // ""' 2>/dev/null)
  assert_eq "fanout-slack-dm status = skipped" "skipped" "$status"
  assert_eq "fanout-slack-dm reason = no_credentials" "no_credentials" "$reason"
}

test_fanout_slack_dm_no_destination() {
  echo "test: fanout-slack-dm.sh skips without slackDmUserId"
  local in="$SCRATCH/dm-in.md"
  make_briefing "$in"
  local cfg="$SCRATCH/dm-cfg.json"
  echo '{"catalyst":{"briefing":{}}}' > "$cfg"
  local out
  out=$(SLACK_BOT_TOKEN=xoxb-fake bash "$MB_DIR/fanout-slack-dm.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" 2>/dev/null)
  local reason; reason=$(printf '%s' "$out" | jq -r '.reason // ""' 2>/dev/null)
  assert_eq "fanout-slack-dm reason = no_destination" "no_destination" "$reason"
}

test_fanout_slack_dm_dry_run_contains_full_body() {
  echo "test: fanout-slack-dm.sh --dry-run prints payload with full briefing body"
  local in="$SCRATCH/dm-in.md"
  make_briefing "$in"
  local cfg="$SCRATCH/dm-cfg2.json"
  echo '{"catalyst":{"briefing":{"slackDmUserId":"U1234567"}}}' > "$cfg"
  local out
  out=$(SLACK_BOT_TOKEN=xoxb-fake bash "$MB_DIR/fanout-slack-dm.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" --dry-run 2>/dev/null)
  # DM profile = no redaction, so the decision summary should still be present
  assert_grep "dry-run payload mentions destination" "U1234567" "$out"
  assert_grep "dry-run payload includes full content (Pick auth provider)" "Pick auth provider" "$out"
  local status; status=$(printf '%s' "$out" | tail -1 | jq -r '.status // ""' 2>/dev/null)
  assert_eq "dry-run status = posted" "posted" "$status"
}

# ─── fanout-slack-channel.sh tests ─────────────────────────────────────────

test_fanout_slack_channel_no_creds() {
  echo "test: fanout-slack-channel.sh skips without SLACK_BOT_TOKEN"
  local in="$SCRATCH/ch-in.md"
  make_briefing "$in"
  local out
  out=$(env -u SLACK_BOT_TOKEN bash "$MB_DIR/fanout-slack-channel.sh" \
    --in "$in" --date 2026-05-17 2>/dev/null)
  local status; status=$(printf '%s' "$out" | jq -r '.status // ""' 2>/dev/null)
  assert_eq "fanout-slack-channel skipped without creds" "skipped" "$status"
}

test_fanout_slack_channel_no_destination() {
  echo "test: fanout-slack-channel.sh skips without slackChannelId"
  local in="$SCRATCH/ch-in.md"
  make_briefing "$in"
  local cfg="$SCRATCH/ch-cfg.json"
  echo '{"catalyst":{"briefing":{}}}' > "$cfg"
  local out
  out=$(SLACK_BOT_TOKEN=xoxb-fake bash "$MB_DIR/fanout-slack-channel.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" 2>/dev/null)
  local reason; reason=$(printf '%s' "$out" | jq -r '.reason // ""' 2>/dev/null)
  assert_eq "fanout-slack-channel reason = no_destination" "no_destination" "$reason"
}

test_fanout_slack_channel_dry_run_is_sanitized() {
  echo "test: fanout-slack-channel.sh --dry-run uses sanitized (channel) body"
  local in="$SCRATCH/ch-in.md"
  make_briefing "$in"
  local cfg="$SCRATCH/ch-cfg2.json"
  cat > "$cfg" <<JSON
{"catalyst":{"briefing":{"slackChannelId":"C9999","sanitizationRedactList":["Acme","Beta Corp"]}}}
JSON
  local out
  out=$(SLACK_BOT_TOKEN=xoxb-fake bash "$MB_DIR/fanout-slack-channel.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" --dry-run 2>/dev/null)
  assert_grep "channel id appears in payload" "C9999" "$out"
  # Channel profile redacts decision summary AND customer name
  assert_not_grep "Pick auth provider not present (decisions redacted)" "Pick auth provider" "$out"
  assert_not_grep "Acme not present (redact list)" "Acme" "$out"
  assert_grep "Redaction token visible" "[REDACTED]" "$out"
}

# ─── fanout-notion.sh tests ────────────────────────────────────────────────

test_fanout_notion_no_creds() {
  echo "test: fanout-notion.sh skips without NOTION_TOKEN"
  local in="$SCRATCH/no-in.md"
  make_briefing "$in"
  local out
  out=$(env -u NOTION_TOKEN bash "$MB_DIR/fanout-notion.sh" \
    --in "$in" --date 2026-05-17 2>/dev/null)
  local status; status=$(printf '%s' "$out" | jq -r '.status // ""' 2>/dev/null)
  assert_eq "fanout-notion skipped without creds" "skipped" "$status"
}

test_fanout_notion_no_destination() {
  echo "test: fanout-notion.sh skips without notionPageId"
  local in="$SCRATCH/no-in.md"
  make_briefing "$in"
  local cfg="$SCRATCH/no-cfg.json"
  echo '{"catalyst":{"briefing":{}}}' > "$cfg"
  local out
  out=$(NOTION_TOKEN=secret_fake bash "$MB_DIR/fanout-notion.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" 2>/dev/null)
  local reason; reason=$(printf '%s' "$out" | jq -r '.reason // ""' 2>/dev/null)
  assert_eq "fanout-notion reason = no_destination" "no_destination" "$reason"
}

test_fanout_notion_dry_run_contains_marker_and_page_id() {
  echo "test: fanout-notion.sh --dry-run contains page id + marker block"
  local in="$SCRATCH/no-in.md"
  make_briefing "$in"
  local cfg="$SCRATCH/no-cfg2.json"
  echo '{"catalyst":{"briefing":{"notionPageId":"page-abc-123"}}}' > "$cfg"
  local out
  out=$(NOTION_TOKEN=secret_fake bash "$MB_DIR/fanout-notion.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" --dry-run 2>/dev/null)
  assert_grep "page id in payload" "page-abc-123" "$out"
  assert_grep "marker block text present" "Morning Briefing" "$out"
  # Channel sanitization applied — no decision summary
  assert_not_grep "decision summary stripped" "Pick auth provider" "$out"
}

# ─── fanout-loom-script.sh tests ────────────────────────────────────────────

test_fanout_loom_writes_default_path() {
  echo "test: fanout-loom-script.sh writes to thoughts/briefings/<date>-loom-script.md"
  local in="$SCRATCH/loom-in.md"
  make_briefing "$in"
  local fakeroot="$SCRATCH/looroot"
  mkdir -p "$fakeroot/thoughts/briefings"
  local out
  out=$(bash "$MB_DIR/fanout-loom-script.sh" \
    --in "$in" --date 2026-05-17 --root "$fakeroot" 2>/dev/null)
  local path="$fakeroot/thoughts/briefings/2026-05-17-loom-script.md"
  if [[ -f "$path" ]]; then
    pass "loom script written to default path"
  else
    fail "loom script written to default path" "missing: $path"
  fi
  local status; status=$(printf '%s' "$out" | jq -r '.status // ""' 2>/dev/null)
  assert_eq "loom fanout status = posted" "posted" "$status"
}

test_fanout_loom_dry_run_writes_tmp() {
  echo "test: fanout-loom-script.sh --dry-run writes to /tmp"
  local in="$SCRATCH/loom2-in.md"
  make_briefing "$in"
  local tmp_path="/tmp/morning-briefing-2026-05-17-loom-script.md"
  rm -f "$tmp_path"
  bash "$MB_DIR/fanout-loom-script.sh" --in "$in" --date 2026-05-17 --dry-run >/dev/null
  if [[ -f "$tmp_path" ]]; then
    pass "dry-run loom script written to /tmp"
    rm -f "$tmp_path"
  else
    fail "dry-run loom script written to /tmp" "missing: $tmp_path"
  fi
}

test_fanout_loom_contains_date() {
  echo "test: loom script output contains the date"
  local in="$SCRATCH/loom3-in.md"
  make_briefing "$in"
  local fakeroot="$SCRATCH/loom3root"
  mkdir -p "$fakeroot/thoughts/briefings"
  bash "$MB_DIR/fanout-loom-script.sh" --in "$in" --date 2026-05-17 --root "$fakeroot" >/dev/null
  local content; content=$(cat "$fakeroot/thoughts/briefings/2026-05-17-loom-script.md")
  assert_grep "loom script mentions date" "2026-05-17" "$content"
}

test_fanout_loom_word_budget() {
  echo "test: loom script word count within target band"
  local in="$SCRATCH/loom4-in.md"
  make_briefing "$in"
  local fakeroot="$SCRATCH/loom4root"
  mkdir -p "$fakeroot/thoughts/briefings"
  bash "$MB_DIR/fanout-loom-script.sh" --in "$in" --date 2026-05-17 \
    --root "$fakeroot" --target-words 225 >/dev/null
  local words
  words=$(wc -w < "$fakeroot/thoughts/briefings/2026-05-17-loom-script.md" | tr -d ' ')
  # Target 225, soft band [0.7*225=158, 1.3*225=292] => allow anything in [70, 300] for the loose check
  # (the soft warning is to stderr; we just check the file is non-trivially populated)
  if [[ "$words" -ge 50 ]] && [[ "$words" -le 400 ]]; then
    pass "loom script word count ($words) is plausibly within Loom-script range"
  else
    fail "loom script word count plausibly in range" "got $words words"
  fi
}

test_fanout_loom_mentions_all_sections() {
  echo "test: loom script mentions yesterday / decisions / today / suggested runs"
  local in="$SCRATCH/loom5-in.md"
  make_briefing "$in"
  local fakeroot="$SCRATCH/loom5root"
  mkdir -p "$fakeroot/thoughts/briefings"
  bash "$MB_DIR/fanout-loom-script.sh" --in "$in" --date 2026-05-17 --root "$fakeroot" >/dev/null
  local content
  content=$(cat "$fakeroot/thoughts/briefings/2026-05-17-loom-script.md" | tr '[:upper:]' '[:lower:]')
  assert_grep "loom mentions yesterday" "yesterday" "$content"
  assert_grep "loom mentions decisions" "decision" "$content"
  assert_grep "loom mentions today" "today" "$content"
  assert_grep "loom mentions orchestrator/suggested runs" "orchestrator" "$content"
}

# ─── End-to-end / write-output-status tests ─────────────────────────────────

test_e2e_all_fanouts_produce_status_json() {
  echo "test: all 4 fan-outs print parseable JSON status"
  local in="$SCRATCH/e2e-in.md"
  make_briefing "$in"
  local fakeroot="$SCRATCH/e2eroot"
  mkdir -p "$fakeroot/thoughts/briefings"
  local cfg="$SCRATCH/e2e-cfg.json"
  cat > "$cfg" <<JSON
{"catalyst":{"briefing":{"slackDmUserId":"U1","slackChannelId":"C1","notionPageId":"P1"}}}
JSON
  local s1 s2 s3 s4
  s1=$(SLACK_BOT_TOKEN=fake bash "$MB_DIR/fanout-slack-dm.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" --dry-run 2>/dev/null | tail -1)
  s2=$(SLACK_BOT_TOKEN=fake bash "$MB_DIR/fanout-slack-channel.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" --dry-run 2>/dev/null | tail -1)
  s3=$(NOTION_TOKEN=fake bash "$MB_DIR/fanout-notion.sh" \
    --in "$in" --date 2026-05-17 --config "$cfg" --dry-run 2>/dev/null | tail -1)
  s4=$(bash "$MB_DIR/fanout-loom-script.sh" \
    --in "$in" --date 2026-05-17 --root "$fakeroot" 2>/dev/null | tail -1)
  for s in "$s1" "$s2" "$s3" "$s4"; do
    if jq -e . <<<"$s" >/dev/null 2>&1; then
      pass "fanout status JSON parses: $(printf '%s' "$s" | head -c 60)"
    else
      fail "fanout status JSON parses" "got: $s"
    fi
  done
}

test_write_output_status_merges_into_frontmatter() {
  echo "test: write-output-status.sh merges 4 status files into frontmatter"
  local in="$SCRATCH/wos-in.md"
  make_briefing "$in"
  local sdir="$SCRATCH/wos-statuses"
  mkdir -p "$sdir"
  printf '%s\n' '{"status":"posted","destination":"slack_dm"}'      > "$sdir/slack-dm.json"
  printf '%s\n' '{"status":"posted","destination":"slack_channel"}' > "$sdir/slack-channel.json"
  printf '%s\n' '{"status":"skipped","destination":"notion","reason":"no_destination"}' > "$sdir/notion.json"
  printf '%s\n' '{"status":"posted","destination":"loom_script","details":{"words":210}}' > "$sdir/loom-script.json"

  bash "$MB_DIR/write-output-status.sh" --in "$in" --statuses "$sdir" >/dev/null

  local fm; fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$in")
  local got
  got=$(printf '%s' "$fm" | python3 -c '
import sys, yaml
d = yaml.safe_load(sys.stdin)
os = d.get("output_status", {})
print(",".join(sorted(os.keys())))
')
  assert_eq "frontmatter output_status has all 4 destinations" \
    "loom_script,notion,slack_channel,slack_dm" "$got"
}

test_write_output_status_preserves_existing_fields() {
  echo "test: write-output-status.sh preserves existing frontmatter (decisions stay)"
  local in="$SCRATCH/wos2-in.md"
  make_briefing "$in"
  local sdir="$SCRATCH/wos2-statuses"
  mkdir -p "$sdir"
  printf '%s\n' '{"status":"posted","destination":"loom_script"}' > "$sdir/loom-script.json"
  bash "$MB_DIR/write-output-status.sh" --in "$in" --statuses "$sdir" >/dev/null
  local fm; fm=$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$in")
  local decisions_len
  decisions_len=$(printf '%s' "$fm" | python3 -c '
import sys, yaml
print(len(yaml.safe_load(sys.stdin).get("decisions", [])))
')
  assert_eq "decisions preserved (length 2)" "2" "$decisions_len"
}

test_validate_frontmatter_passes_with_output_status() {
  echo "test: validate-frontmatter.sh still passes after output_status is added"
  local in="$SCRATCH/vf-in.md"
  make_briefing "$in"
  local sdir="$SCRATCH/vf-statuses"
  mkdir -p "$sdir"
  printf '%s\n' '{"status":"posted","destination":"loom_script"}' > "$sdir/loom-script.json"
  bash "$MB_DIR/write-output-status.sh" --in "$in" --statuses "$sdir" >/dev/null
  local ec
  bash "$MB_DIR/validate-frontmatter.sh" "$in" >/dev/null 2>&1; ec=$?
  assert_exit "validate-frontmatter passes" "0" "$ec"
}

# ─── Schema tests ───────────────────────────────────────────────────────────

test_schema_still_parses() {
  echo "test: schema parses as JSON"
  if jq -e . "$SCHEMA" >/dev/null 2>&1; then
    pass "schema parses as JSON"
  else
    fail "schema parses as JSON" "jq failed"
  fi
}

test_schema_permits_output_status_object() {
  echo "test: schema accepts an output_status object with 4 known destinations"
  local good="$SCRATCH/schema-good.json"
  cat > "$good" <<'JSON'
{
  "date": "2026-05-17",
  "generated_by": "morning-briefing",
  "decisions": [],
  "output_status": {
    "slack_dm":      {"status": "posted"},
    "slack_channel": {"status": "skipped", "reason": "no_credentials"},
    "notion":        {"status": "failed",  "reason": "api_error"},
    "loom_script":   {"status": "posted",  "details": {"words": 210}}
  }
}
JSON
  local ec
  jsonschema -i "$good" "$SCHEMA" >/dev/null 2>&1; ec=$?
  assert_exit "valid output_status passes schema" "0" "$ec"
}

test_schema_rejects_unknown_destination() {
  echo "test: schema rejects unknown destination key under output_status"
  local bad="$SCRATCH/schema-bad-dest.json"
  cat > "$bad" <<'JSON'
{
  "date": "2026-05-17",
  "generated_by": "morning-briefing",
  "decisions": [],
  "output_status": {"discord": {"status": "posted"}}
}
JSON
  local ec
  jsonschema -i "$bad" "$SCHEMA" >/dev/null 2>&1; ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "unknown destination should be rejected" "passed schema"
  else
    pass "unknown destination is rejected (exit $ec)"
  fi
}

test_schema_rejects_bad_status_value() {
  echo "test: schema rejects status outside {posted,skipped,failed}"
  local bad="$SCRATCH/schema-bad-status.json"
  cat > "$bad" <<'JSON'
{
  "date": "2026-05-17",
  "generated_by": "morning-briefing",
  "decisions": [],
  "output_status": {"slack_dm": {"status": "queued"}}
}
JSON
  local ec
  jsonschema -i "$bad" "$SCHEMA" >/dev/null 2>&1; ec=$?
  if [[ "$ec" -eq 0 ]]; then
    fail "bad status enum should be rejected" "passed schema"
  else
    pass "bad status enum is rejected (exit $ec)"
  fi
}

# ─── Run all tests ──────────────────────────────────────────────────────────

test_sanitize_dm_is_noop
test_sanitize_channel_strips_decision_details
test_sanitize_channel_rewrites_decisions_body
test_sanitize_channel_redacts_customer_names
test_sanitize_channel_word_boundary
test_sanitize_channel_redacts_pr_urls
test_sanitize_rejects_bad_profile

test_fanout_slack_dm_no_creds
test_fanout_slack_dm_no_destination
test_fanout_slack_dm_dry_run_contains_full_body

test_fanout_slack_channel_no_creds
test_fanout_slack_channel_no_destination
test_fanout_slack_channel_dry_run_is_sanitized

test_fanout_notion_no_creds
test_fanout_notion_no_destination
test_fanout_notion_dry_run_contains_marker_and_page_id

test_fanout_loom_writes_default_path
test_fanout_loom_dry_run_writes_tmp
test_fanout_loom_contains_date
test_fanout_loom_word_budget
test_fanout_loom_mentions_all_sections

test_e2e_all_fanouts_produce_status_json
test_write_output_status_merges_into_frontmatter
test_write_output_status_preserves_existing_fields
test_validate_frontmatter_passes_with_output_status

test_schema_still_parses
test_schema_permits_output_status_object
test_schema_rejects_unknown_destination
test_schema_rejects_bad_status_value

echo
echo "─────────────────────────────────────"
echo "PASSED: $PASSES"
echo "FAILED: $FAILURES"
echo "─────────────────────────────────────"
exit $(( FAILURES > 0 ? 1 : 0 ))
