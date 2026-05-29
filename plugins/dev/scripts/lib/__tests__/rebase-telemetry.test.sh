#!/usr/bin/env bash
# Tests for lib/rebase-telemetry.sh (CTL-707 Phase 1).
# Run: bash plugins/dev/scripts/lib/__tests__/rebase-telemetry.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TELEMETRY_LIB="${LIB_DIR}/rebase-telemetry.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t rebase-telemetry-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# Point emissions at the scratch dir.
export EVENTS_DIR="${SCRATCH}/events"

# shellcheck source=../rebase-telemetry.sh
source "$TELEMETRY_LIB"

echo "rebase-telemetry tests (CTL-707 Phase 1)"

# Helper: return the last line written to the month's JSONL file.
last_event_line() {
  local month_file="${EVENTS_DIR}/$(date -u +%Y-%m).jsonl"
  tail -n1 "$month_file" 2>/dev/null || echo ""
}

# ── 1. emit_stale_base_detected ─────────────────────────────────────────────
echo "1. emit_stale_base_detected"
emit_stale_base_detected \
  --orch CTL-705 --ticket CTL-707 --phase plan \
  --commits-behind 3 --files-at-risk '["a.ts","b.ts"]'
LINE="$(last_event_line)"
assert_eq "phase.plan.stale-base-detected.CTL-707" \
  "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "stale-base event name"
assert_eq "WARN" \
  "$(jq -r '.severityText' <<<"$LINE")" "stale-base severity"
assert_eq "3" \
  "$(jq -r '.body.payload.commits_behind' <<<"$LINE")" "commits_behind payload"
assert_eq '["a.ts","b.ts"]' \
  "$(jq -c '.body.payload.files_at_risk' <<<"$LINE")" "files_at_risk payload"

# ── 2. emit_auto_rebased ────────────────────────────────────────────────────
echo "2. emit_auto_rebased"
emit_auto_rebased --orch CTL-705 --ticket CTL-707 --phase plan --strategy additive
LINE="$(last_event_line)"
assert_eq "phase.plan.auto-rebased.CTL-707" \
  "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "auto-rebased event name"
assert_eq "INFO" \
  "$(jq -r '.severityText' <<<"$LINE")" "auto-rebased severity"
assert_eq "additive" \
  "$(jq -r '.body.payload.strategy' <<<"$LINE")" "auto-rebased strategy"

# ── 3. emit_rebase_conflict_categorized ─────────────────────────────────────
echo "3. emit_rebase_conflict_categorized"
emit_rebase_conflict_categorized \
  --orch CTL-705 --ticket CTL-707 --phase implement \
  --test-count 2 --noise-count 1 --source-count 0 --thoughts-count 0
LINE="$(last_event_line)"
assert_eq "phase.implement.rebase-conflict-categorized.CTL-707" \
  "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "categorized event name"
assert_eq "WARN" \
  "$(jq -r '.severityText' <<<"$LINE")" "categorized severity"
assert_eq "2" \
  "$(jq -r '.body.payload.test_count' <<<"$LINE")" "test_count"
assert_eq "1" \
  "$(jq -r '.body.payload.noise_count' <<<"$LINE")" "noise_count"
assert_eq "0" \
  "$(jq -r '.body.payload.source_count' <<<"$LINE")" "source_count"
assert_eq "0" \
  "$(jq -r '.body.payload.thoughts_count' <<<"$LINE")" "thoughts_count"

# ── 4. emit_rebase_conflict_stalled ─────────────────────────────────────────
echo "4. emit_rebase_conflict_stalled"
emit_rebase_conflict_stalled \
  --orch CTL-705 --ticket CTL-707 --phase verify \
  --reason "source_conflict_ctl708_unavailable" \
  --files '["src/foo.ts"]' \
  --category "source"
LINE="$(last_event_line)"
assert_eq "phase.verify.rebase-conflict-stalled.CTL-707" \
  "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "stalled event name"
assert_eq "ERROR" \
  "$(jq -r '.severityText' <<<"$LINE")" "stalled severity"
assert_eq "source_conflict_ctl708_unavailable" \
  "$(jq -r '.body.payload.reason' <<<"$LINE")" "stalled reason"
assert_eq '["src/foo.ts"]' \
  "$(jq -c '.body.payload.files' <<<"$LINE")" "stalled files"
assert_eq "source" \
  "$(jq -r '.body.payload.category' <<<"$LINE")" "stalled category"

# ── 5. attributes carry orch + worker ───────────────────────────────────────
echo "5. attributes carry orch + worker"
emit_auto_rebased --orch MY-ORCH --ticket CTL-707 --phase plan --strategy clean
LINE="$(last_event_line)"
assert_eq "MY-ORCH" \
  "$(jq -r '.attributes["catalyst.orchestrator.id"]' <<<"$LINE")" "orch in attributes"
assert_eq "CTL-707" \
  "$(jq -r '.attributes["catalyst.worker.ticket"]' <<<"$LINE")" "worker ticket in attributes"

# ── 6. service name is catalyst.worktree-rebase ─────────────────────────────
echo "6. service name"
assert_eq "catalyst.worktree-rebase" \
  "$(jq -r '.resource["service.name"]' <<<"$LINE")" "service name in resource"

# ── 7. emit_stale_base_detected with thoughts conflict phase ─────────────────
echo "7. emit_rebase_conflict_stalled thoughts reason"
emit_rebase_conflict_stalled \
  --orch "" --ticket CTL-100 --phase research \
  --reason "thoughts_symlink_broken" \
  --files '[]' --category "thoughts"
LINE="$(last_event_line)"
assert_eq "phase.research.rebase-conflict-stalled.CTL-100" \
  "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "thoughts stalled event name"
assert_eq "thoughts_symlink_broken" \
  "$(jq -r '.body.payload.reason' <<<"$LINE")" "thoughts stalled reason"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
