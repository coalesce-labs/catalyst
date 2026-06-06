#!/usr/bin/env bash
# Tests for gather-retro.sh — the deterministic read side of ticket-retro (CTL-814).
#
# The retro is a read-only VIEW over what Loops A/B captured. These tests build
# fixture stores (friction logs, learnings, compound-log weeks, a prior retro
# with watch-items) and assert the gathered JSON: window resolution
# (since-last-retro default, --since, --tickets), record filtering, watch-item
# parsing, and the all-stores-empty degradation contract.
#
# Run: bash plugins/dev/scripts/__tests__/ticket-retro-gather.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
GATHER="${REPO_ROOT}/plugins/dev/scripts/ticket-retro/gather-retro.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() {
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $1"
  [ -n "${2:-}" ] && echo "    detail: $2"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label" "expected=$expected actual=$actual"; fi
}

if [ ! -x "$GATHER" ]; then
  echo "ERROR: $GATHER not present or not executable"
  echo "summary: 0 passed, 1 failed"
  exit 1
fi

# ── Fixture builder ──────────────────────────────────────────────────────────

new_project() {
  local dir="${SCRATCH}/$1"
  mkdir -p "$dir/thoughts/shared/friction" \
           "$dir/thoughts/shared/learnings/architecture-patterns" \
           "$dir/thoughts/shared/pm/metrics" \
           "$dir/thoughts/shared/compound/retros"
  echo "$dir"
}

write_friction() {
  local dir="$1" ticket="$2" phase="$3" ts="$4" line="$5"
  cat >> "$dir/thoughts/shared/friction/${ticket}.md" <<EOF
## ${phase} · ${ticket} · ${ts}
- **Backtracks / redone work:** ${line}
EOF
}

write_learning() {
  local dir="$1" slug="$2" title="$3" component="$4"
  cat > "$dir/thoughts/shared/learnings/architecture-patterns/${slug}.md" <<EOF
---
title: "${title}"
date: 2026-06-06
category: architecture-patterns
problem_type: workflow_issue
component: ${component}
severity: medium
---

Body.
EOF
}

write_compound_week() {
  local dir="$1"
  cat > "$dir/thoughts/shared/pm/metrics/2026-W23-compound-log.md" <<'EOF'
# Compound Log — 2026-W23

One entry per merged PR. Fields follow the CTL-159 schema.

### CTL-50 — #900 — 2026-06-04T12:00:00Z

```yaml
linear_key: CTL-50
pr_number: 900
merged_at: 2026-06-04T12:00:00Z
estimate_at_start: 3
estimate_actual: 5
cost_usd: 4.20
wall_time_hours: 2.0
what_worked: "plan held"
what_surprised_me: "ci flake"
```

EOF
}

write_prior_retro() {
  local dir="$1" date="$2"
  cat > "$dir/thoughts/shared/compound/retros/${date}.md" <<'EOF'
---
date: RETRO_DATE
type: retro
generated_by: ticket-retro
---

# Ticket Retro — RETRO_DATE

## Recurring friction patterns

- **signal file missing artifact path** (2 records)

## Watch items

```yaml watch-items
- pattern: "signal file missing artifact path on re-walk"
  component: phase-agent
  first_seen: 2026-06-01
  source: CTL-696
- pattern: "stale plugin cache serving old skill bodies"
  component: cli
  first_seen: 2026-06-01
  source: CTL-628
```
EOF
  sed -i '' "s/RETRO_DATE/${date}/g" "$dir/thoughts/shared/compound/retros/${date}.md" 2>/dev/null \
    || sed -i "s/RETRO_DATE/${date}/g" "$dir/thoughts/shared/compound/retros/${date}.md"
}

run_gather() {
  local dir="$1"; shift
  (cd "$dir" && bash "$GATHER" --thoughts-dir "$dir/thoughts" --no-github --db /nonexistent "$@")
}

echo "ticket-retro gather tests"
echo "---"

# ── All stores empty → zeroed JSON, exit 0 ───────────────────────────────────

test_empty_stores_degrade() {
  local proj out rc
  proj=$(new_project empty)
  out=$(run_gather "$proj")
  rc=$?
  assert_eq "empty: exit 0" "0" "$rc"
  assert_eq "empty: friction []" "0" "$(echo "$out" | jq '.friction | length')"
  assert_eq "empty: learnings []" "0" "$(echo "$out" | jq '.learnings | length')"
  assert_eq "empty: merged_prs []" "0" "$(echo "$out" | jq '.merged_prs | length')"
  assert_eq "empty: db_stats []" "0" "$(echo "$out" | jq '.db_stats | length')"
  assert_eq "empty: prior_retro null" "null" "$(echo "$out" | jq '.prior_retro')"
  assert_eq "empty: window source default" "default-14d" "$(echo "$out" | jq -r '.window.source')"
  assert_eq "empty: calibration entries 0" "0" "$(echo "$out" | jq '.calibration.entries // 0')"
}

# ── since-last-retro window + watch-items parse ──────────────────────────────

test_last_retro_window_and_watch_items() {
  local proj out
  proj=$(new_project lastretro)
  write_prior_retro "$proj" "2026-06-03"
  # one friction record BEFORE the retro date (excluded), one after (included)
  write_friction "$proj" "CTL-10" "research" "2026-06-02T10:00:00+0900" "old record"
  write_friction "$proj" "CTL-11" "implement" "2026-06-05T10:00:00+0900" "new record"

  out=$(run_gather "$proj")
  assert_eq "last-retro: window source" "last-retro" "$(echo "$out" | jq -r '.window.source')"
  assert_eq "last-retro: window since" "2026-06-03" "$(echo "$out" | jq -r '.window.since')"
  assert_eq "last-retro: only post-floor friction kept" "1" "$(echo "$out" | jq '.friction | length')"
  assert_eq "last-retro: kept the right record" "CTL-11" "$(echo "$out" | jq -r '.friction[0].ticket')"
  assert_eq "last-retro: 2 watch items parsed" "2" "$(echo "$out" | jq '.prior_retro.watch_items | length')"
  assert_eq "last-retro: watch item pattern" "signal file missing artifact path on re-walk" \
    "$(echo "$out" | jq -r '.prior_retro.watch_items[0].pattern')"
  assert_eq "last-retro: watch item component" "phase-agent" \
    "$(echo "$out" | jq -r '.prior_retro.watch_items[0].component')"
  assert_eq "last-retro: watch item source" "CTL-628" \
    "$(echo "$out" | jq -r '.prior_retro.watch_items[1].source')"
}

# ── --since override + learnings + calibration ───────────────────────────────

test_since_override_and_stores() {
  local proj out
  proj=$(new_project since)
  write_friction "$proj" "CTL-20" "verify" "2026-06-05T10:00:00+0900" "flaky suite"
  write_learning "$proj" "some-learning" "Phase env can leak sibling ticket" "phase-agent"
  write_compound_week "$proj"

  out=$(run_gather "$proj" --since 2026-06-01)
  assert_eq "since: window source" "--since" "$(echo "$out" | jq -r '.window.source')"
  assert_eq "since: friction kept" "1" "$(echo "$out" | jq '.friction | length')"
  assert_eq "since: learning title" "Phase env can leak sibling ticket" \
    "$(echo "$out" | jq -r '.learnings[0].title')"
  assert_eq "since: learning component" "phase-agent" "$(echo "$out" | jq -r '.learnings[0].component')"
  assert_eq "since: calibration entries" "1" "$(echo "$out" | jq '.calibration.entries')"
  assert_eq "since: calibration actual for CTL-50" "5" \
    "$(echo "$out" | jq '.calibration.tickets["CTL-50"].estimate_actual')"
}

# ── --tickets filter ─────────────────────────────────────────────────────────

test_tickets_filter() {
  local proj out
  proj=$(new_project tickets)
  write_friction "$proj" "CTL-30" "plan" "2026-06-05T10:00:00+0900" "kept"
  write_friction "$proj" "CTL-31" "plan" "2026-06-05T11:00:00+0900" "filtered out"

  out=$(run_gather "$proj" --tickets ctl-30)
  assert_eq "tickets: filter keeps only CTL-30" "1" "$(echo "$out" | jq '.friction | length')"
  assert_eq "tickets: kept ticket" "CTL-30" "$(echo "$out" | jq -r '.friction[0].ticket')"
  assert_eq "tickets: window drops to all-time" "--tickets (all time)" \
    "$(echo "$out" | jq -r '.window.source')"
}

# ── merged_prs via fake gh: ticket extraction + version-string exclusion ────

test_merged_prs_ticket_extraction() {
  local proj out
  proj=$(new_project ghfake)
  mkdir -p "$proj/bin"
  cat > "$proj/bin/gh" <<'EOF'
#!/usr/bin/env bash
cat <<'JSON'
[
  {"number": 10, "title": "feat(dev): real ticket work (CTL-99)", "headRefName": "ryan/ctl-99-thing",
   "mergedAt": "2026-06-06T10:00:00Z", "additions": 100, "deletions": 20},
  {"number": 11, "title": "docs(dev): refresh linearis skill to v2026.4.9", "headRefName": "docs/linearis-v2026-4-9",
   "mergedAt": "2026-06-06T11:00:00Z", "additions": 50, "deletions": 5},
  {"number": 12, "title": "old PR outside window (CTL-1)", "headRefName": "ctl-1-old",
   "mergedAt": "2026-01-01T00:00:00Z", "additions": 9, "deletions": 9}
]
JSON
EOF
  chmod +x "$proj/bin/gh"

  out=$(cd "$proj" && PATH="$proj/bin:$PATH" bash "$GATHER" \
    --thoughts-dir "$proj/thoughts" --db /nonexistent --since 2026-06-01)
  assert_eq "gh: one PR matched (version string + out-of-window excluded)" "1" \
    "$(echo "$out" | jq '.merged_prs | length')"
  assert_eq "gh: ticket uppercased from branch" "CTL-99" \
    "$(echo "$out" | jq -r '.merged_prs[0].ticket')"
  assert_eq "gh: churn carried" "100" "$(echo "$out" | jq '.merged_prs[0].additions')"
}

# ── Run ──────────────────────────────────────────────────────────────────────

test_empty_stores_degrade
test_last_retro_window_and_watch_items
test_since_override_and_stores
test_tickets_filter
test_merged_prs_ticket_extraction

echo "---"
echo "summary: ${PASSES} passed, ${FAILURES} failed"
exit $([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)
