#!/usr/bin/env bash
# Unit tests for plugins/dev/scripts/lib/phase-mirror-footer.sh (CTL-632 footer).
#
# The footer is appended verbatim into every phase-agent Linear mirror comment,
# so the contract is: ALWAYS exit 0, ALWAYS print a `---` + at least one line,
# and resolve each field (model, sub-agent count, active working duration,
# catalyst session id, short job id, long session uuid, cwd) independently and
# fail-soft from the signal file + bg job state.json + conversation JSONL.
#
# Run: bash plugins/dev/scripts/__tests__/phase-mirror-footer.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FOOTER="${REPO_ROOT}/plugins/dev/scripts/lib/phase-mirror-footer.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-mirror-footer-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
assert_grep() {
  local pattern="$1" str="$2" label="$3"
  if grep -qE -- "$pattern" <<<"$str"; then pass "$label"; else fail "$label — '$pattern' not in:
$str"; fi
}
assert_not_grep() {
  local pattern="$1" str="$2" label="$3"
  if grep -qE -- "$pattern" <<<"$str"; then fail "$label — '$pattern' unexpectedly present"; else pass "$label"; fi
}

# Build a worker dir (signal) + bg jobs dir (state.json) + conversation JSONL.
#
# with_usage (4th arg, default "no"): when "yes", the conversation assistant
# events additionally carry message.usage AND a deterministic sub-agent JSONL
# is written at <conv-without-.jsonl>/subagents/agent-x.jsonl with extra usage,
# so the footer's CTL-666 cost segment resolves to a positive, sub-agent-
# inclusive total. Default "no" keeps the original usage-free conv.jsonl so the
# pre-existing tests (and the zero-usage fail-soft case) are unaffected.
build_fixture() {
  local case_dir="$1" with_bg="${2:-yes}" with_jsonl="${3:-yes}" with_usage="${4:-no}"
  local worker_dir="${case_dir}/orch/workers/CTL-449"
  local jobs_dir="${case_dir}/jobs"
  mkdir -p "$worker_dir" "$jobs_dir"

  cat > "${worker_dir}/phase-implement.json" <<'JSON'
{"status":"running","ticket":"CTL-449","phase":"implement","bg_job_id":"abcd1234","catalystSessionId":"sess_TESTSESSION","model":"opus"}
JSON

  if [[ "$with_jsonl" == "yes" ]]; then
    if [[ "$with_usage" == "yes" ]]; then
      # Same model / Task+Agent / turn_duration shape as the default fixture
      # (so the model, sub-agent-count, and active-duration assertions still
      # hold) but with message.usage so a non-zero cost resolves.
      cat > "${case_dir}/conv.jsonl" <<'JSONL'
{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"content":[{"type":"tool_use","name":"Task","input":{}}]}}
{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"content":[{"type":"tool_use","name":"Agent","input":{}}]}}
{"type":"system","subtype":"turn_duration","durationMs":472338}
{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"content":[{"type":"text","text":"done"}]}}
JSONL
      mkdir -p "${case_dir}/conv/subagents"
      cat > "${case_dir}/conv/subagents/agent-x.jsonl" <<'JSONL'
{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_tokens":4000,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
JSONL
    else
      cat > "${case_dir}/conv.jsonl" <<'JSONL'
{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"tool_use","name":"Task","input":{}}]}}
{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"tool_use","name":"Agent","input":{}}]}}
{"type":"system","subtype":"turn_duration","durationMs":472338}
{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"done"}]}}
JSONL
    fi
  fi

  if [[ "$with_bg" == "yes" ]]; then
    mkdir -p "${jobs_dir}/abcd1234"
    local jsonl_path="${case_dir}/conv.jsonl"
    [[ "$with_jsonl" == "yes" ]] || jsonl_path="${case_dir}/missing.jsonl"
    cat > "${jobs_dir}/abcd1234/state.json" <<JSON
{"sessionId":"abcd1234-dead-beef-0000-1234567890ab","cwd":"/tmp/wt/CTL-449","linkScanPath":"${jsonl_path}"}
JSON
  fi
  echo "$case_dir"
}

run_footer() {
  local case_dir="$1"
  # Unset the controlling session's env so we exercise file-based resolution
  # (otherwise the test host's own CLAUDE_CODE_SESSION_ID / CATALYST_SESSION_ID
  # leak in and mask the signal/bg-state values).
  env -u CLAUDE_CODE_SESSION_ID -u CATALYST_SESSION_ID \
    CATALYST_BG_JOBS_DIR="${case_dir}/jobs" \
    bash "$FOOTER" --orch-dir "${case_dir}/orch" --ticket CTL-449 --phase implement 2>/dev/null
}

# ─── Test 1: full resolution ──────────────────────────────────────────────────
echo "Test 1: full resolution (signal + bg state + JSONL)"
C1="$(build_fixture "${SCRATCH}/full" yes yes)"
OUT1="$(run_footer "$C1")"
assert_grep '^---$' "$OUT1" "emits --- separator"
assert_grep 'model `claude-opus-4-7`' "$OUT1" "model resolved from JSONL last assistant"
assert_grep '2 sub-agent\(s\) launched' "$OUT1" "counts Task + Agent tool_use = 2 sub-agents"
assert_grep 'active 7m 52s' "$OUT1" "active duration = sum of turn_duration (472338ms)"
assert_grep 'catalyst session `sess_TESTSESSION`' "$OUT1" "catalyst session id from signal"
assert_grep 'job `abcd1234`' "$OUT1" "short job id from signal bg_job_id"
assert_grep 'session uuid `abcd1234-dead-beef-0000-1234567890ab`' "$OUT1" "long uuid from bg state"
assert_grep 'cwd `/tmp/wt/CTL-449`' "$OUT1" "cwd from bg state"

# ─── Test 2: degraded — no bg state.json (no JSONL reachable) ─────────────────
echo ""
echo "Test 2: degraded — signal only, no bg state/JSONL"
C2="$(build_fixture "${SCRATCH}/nobg" no no)"
OUT2="$(run_footer "$C2")"
assert_grep '^---$' "$OUT2" "still emits footer"
assert_grep 'catalyst session `sess_TESTSESSION`' "$OUT2" "catalyst session id still from signal"
assert_grep 'job `abcd1234`' "$OUT2" "short job id still from signal"
assert_grep 'model `opus`' "$OUT2" "model falls back to signal .model when no JSONL"
assert_grep '\? sub-agent\(s\) launched' "$OUT2" "sub-agent count is ? without JSONL"
assert_not_grep 'active ' "$OUT2" "no active-duration line without JSONL"
assert_not_grep 'session uuid' "$OUT2" "no uuid line when neither env nor bg state provides one"

# ─── Test 3: missing args → minimal footer, exit 0 ────────────────────────────
echo ""
echo "Test 3: missing args → minimal footer, never breaks the body"
OUT3="$(env -u CLAUDE_CODE_SESSION_ID -u CATALYST_SESSION_ID bash "$FOOTER" --phase implement)"
RC3=$?
assert_grep '^---$' "$OUT3" "minimal footer still has --- separator"
assert_grep 'metadata unavailable' "$OUT3" "minimal footer placeholder line"
[[ "$RC3" == "0" ]] && pass "exit 0 on missing args" || fail "exit 0 on missing args — got $RC3"

# ─── Test 4: long uuid prefers CLAUDE_CODE_SESSION_ID env ─────────────────────
echo ""
echo "Test 4: CLAUDE_CODE_SESSION_ID env wins for the long uuid"
C4="$(build_fixture "${SCRATCH}/env" yes yes)"
OUT4="$(CLAUDE_CODE_SESSION_ID="feedface-1111-2222-3333-444455556666" \
  CATALYST_BG_JOBS_DIR="${C4}/jobs" \
  bash "$FOOTER" --orch-dir "${C4}/orch" --ticket CTL-449 --phase implement 2>/dev/null)"
assert_grep 'session uuid `feedface-1111-2222-3333-444455556666`' "$OUT4" "uuid taken from CLAUDE_CODE_SESSION_ID env"

# ─── Test 5: every phase mirror skill wires the footer helper ─────────────────
echo ""
echo "Test 5: all 9 phase mirror skills reference phase-mirror-footer.sh"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"
for phase in research plan implement verify remediate review triage pr monitor-merge; do
  skill="${SKILLS_DIR}/phase-${phase}/SKILL.md"
  if [[ -f "$skill" ]] && grep -q 'phase-mirror-footer\.sh' "$skill"; then
    pass "phase-${phase} wires the footer helper"
  else
    fail "phase-${phase} wires the footer helper — not found in $skill"
  fi
done

# ─── Test 6: CTL-666 cost segment present when JSONL + pricing resolve ────────
echo ""
echo "Test 6: cost segment present (sub-agent-inclusive) when usage resolves"
C6="$(build_fixture "${SCRATCH}/cost" yes yes yes)"
OUT6="$(run_footer "$C6")"
# parent 1000in/500out opus = 0.0525; sub-agent 4000in/2000out = 0.21; total 0.2625 → ~$0.26
assert_grep '~\$[0-9]+\.[0-9]{2}' "$OUT6" "cost segment has a \$X.XX figure"
assert_grep '~\$0\.26' "$OUT6" "cost reflects parent+sub-agent total (not parent-only \$0.05)"
# tokens: input 5000 + output 2500 = 7500 → 7.5k
assert_grep '7\.5k tokens \(incl\. sub-agents\)' "$OUT6" "token total humanized + incl. sub-agents marker"
# the cost segment is additive — the pre-existing line fields still resolve
assert_grep 'model `claude-opus-4-7`' "$OUT6" "model still resolved alongside cost segment"
assert_grep '2 sub-agent\(s\) launched' "$OUT6" "sub-agent count still resolved alongside cost segment"
assert_grep 'active 7m 52s' "$OUT6" "active duration still resolved alongside cost segment"

# ─── Test 7: fail-soft — no JSONL → no cost segment, footer otherwise intact ──
echo ""
echo "Test 7: fail-soft — no JSONL reachable → no cost segment"
C7="$(build_fixture "${SCRATCH}/cost-nojsonl" no no)"
OUT7="$(run_footer "$C7")"
assert_grep '^---$' "$OUT7" "still emits footer separator"
assert_not_grep '\$[0-9]' "$OUT7" "no cost segment when JSONL unresolvable"
assert_not_grep 'incl\. sub-agents' "$OUT7" "no sub-agents marker when JSONL unresolvable"

# ─── Test 8: fail-soft — zero-usage JSONL → no cost segment (no ~\$0.00) ───────
echo ""
echo "Test 8: fail-soft — zero-usage JSONL → cost segment omitted"
C8="$(build_fixture "${SCRATCH}/cost-zero" yes yes)"   # default with_usage=no → no usage blocks
OUT8="$(run_footer "$C8")"
assert_grep 'model `claude-opus-4-7`' "$OUT8" "footer still resolves model on zero-usage JSONL"
assert_not_grep '\$[0-9]' "$OUT8" "no cost segment when cost resolves to 0 (no ~\$0.00)"
assert_not_grep 'incl\. sub-agents' "$OUT8" "no sub-agents marker on zero-usage JSONL"

# ─── Test 9: fail-soft — pricing file missing → no cost segment, exit 0 ───────
echo ""
echo "Test 9: fail-soft — missing pricing file → cost segment omitted, exit 0"
C9="$(build_fixture "${SCRATCH}/cost-nopricing" yes yes yes)"
OUT9="$(env -u CLAUDE_CODE_SESSION_ID -u CATALYST_SESSION_ID \
  CATALYST_BG_JOBS_DIR="${C9}/jobs" \
  CATALYST_MIRROR_PRICING="/no/such/pricing.json" \
  bash "$FOOTER" --orch-dir "${C9}/orch" --ticket CTL-449 --phase implement 2>/dev/null)"
RC9=$?
assert_not_grep '\$[0-9]' "$OUT9" "no cost segment when pricing file missing"
[[ "$RC9" == "0" ]] && pass "exit 0 when pricing file missing" || fail "exit 0 when pricing file missing — got $RC9"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "phase-mirror-footer: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
