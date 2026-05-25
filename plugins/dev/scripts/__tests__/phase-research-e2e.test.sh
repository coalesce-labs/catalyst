#!/usr/bin/env bash
# Tests for the phase-research skill (CTL-450 Initiative 1 Phase 4).
#
# These are contract/E2E tests that verify the skill's SKILL.md adheres to the
# phase-agent template (CTL-448) and that dispatching it via phase-agent-dispatch
# does the right plumbing (claude is stubbed). We can't actually execute the
# skill body in bash — the body is LLM prose — so we verify:
#   - SKILL.md exists with the right frontmatter
#   - The body declares the prelude env-var contract
#   - The body invokes /catalyst-dev:research-codebase (not a reimplementation)
#   - The body calls phase-agent-emit-complete with --phase research
#   - The body references the expected artifact path
#     (thoughts/shared/research/*-<ticket>.md)
#   - Dispatching with --phase research --ticket <T> spawns claude --bg with the
#     right prompt + env when triage.json exists
#   - Dispatching refuses when triage.json is missing
#
# Run: bash plugins/dev/scripts/__tests__/phase-research-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-research/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-research-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  [[ "$expected" == "$actual" ]] && pass "$label" || fail "$label — expected '$expected', got '$actual'"
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] && pass "$label" || fail "$label — '$needle' not found"
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" != *"$needle"* ]] && pass "$label" || fail "$label — '$needle' unexpectedly present"
}
assert_file_exists() {
  [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"
}

# ─── Contract: SKILL.md frontmatter + body ─────────────────────────────────
echo "Test 1: phase-research SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-research/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  # Frontmatter
  assert_contains "$BODY" "name: phase-research" "frontmatter declares name: phase-research"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. user-invocable MUST be true
  # for the dispatch to resolve.
  assert_contains "$BODY" "user-invocable: true" "frontmatter sets user-invocable: true (CTL-490)"
  assert_contains "$BODY" "Task" "allowed-tools includes Task (for invoking research-codebase)"
  assert_contains "$BODY" "Bash" "allowed-tools includes Bash"

  # Prelude contract — must declare all four env vars from the template
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_ID"  "prelude reads CATALYST_ORCHESTRATOR_ID"
  assert_contains "$BODY" "CATALYST_PHASE"            "prelude reads CATALYST_PHASE"
  assert_contains "$BODY" "CATALYST_TICKET"           "prelude reads CATALYST_TICKET"

  # Prior-phase artifact gate: triage.json
  assert_contains "$BODY" "triage.json" "body references prior triage.json artifact"

  # Body delegates to canonical research-codebase skill
  assert_contains "$BODY" "/catalyst-dev:research-codebase" "body invokes /catalyst-dev:research-codebase"

  # Output artifact path
  assert_contains "$BODY" "thoughts/shared/research/" "body writes to thoughts/shared/research/"

  # Terminal emitter
  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"
  assert_contains "$BODY" '--status failed' "body emits --status failed on error path"

  # CTL-558: Linear status write-back moved to the deterministic coordinator —
  # the phase agent no longer carries the linear-transition prose.
  assert_not_contains "$BODY" "--transition researching" "body does NOT self-transition Linear (coordinator owns it, CTL-558)"

  # /goal block (turn cap)
  assert_contains "$BODY" "/goal" "body declares a /goal block"

  # CTL-632: Linear comment-mirror block must be present.
  assert_contains "$BODY" "phase-research-mirror" "body contains uniquely-named mirror fence (extractable by tests)"
  assert_contains "$BODY" ".linear-mirror-" "body references the per-phase marker file"
  assert_contains "$BODY" "linearis issues discuss" "body calls linearis issues discuss"
  assert_contains "$BODY" "linearis discuss failed (continuing)" "body has fail-open warning string"
fi

# ─── E2E: dispatcher launches phase-research when triage.json exists ───────
echo ""
echo "Test 2: phase-agent-dispatch --phase research succeeds with triage.json present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$STUB_DIR" "$WORKER_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: stub mimics today's real `claude --bg` stdout shape so the
# dispatcher's hex-grep parser finds the job ID. Hex token 'a1b2c3d4'.
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"
  printf '%s\n' "$@"
  echo "--ENV--"
  env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
cat <<EOF
backgrounded · a1b2c3d4
  claude agents             list sessions
  claude attach a1b2c3d4    open in this terminal
EOF
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

# Place a triage.json so the dispatcher's prior-artifact gate passes.
echo '{"ticket":"CTL-450","status":"done","classification":"feature"}' > "${WORKER_DIR}/triage.json"

OUT=$("$DISPATCH" --phase research --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-research.json"
assert_file_exists "$SIGNAL" "signal file phase-research.json written"

if [[ -f "$SIGNAL" ]]; then
  STATUS=$(jq -r '.status' "$SIGNAL")
  PHASE=$(jq -r '.phase' "$SIGNAL")
  JOB=$(jq -r '.bg_job_id' "$SIGNAL")
  assert_eq "running" "$STATUS" "signal.status = running after spawn"
  assert_eq "research" "$PHASE" "signal.phase = research"
  assert_eq "a1b2c3d4" "$JOB" "signal.bg_job_id = hex from stub (CTL-490)"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-research CTL-450" "claude invoked with phase-research skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=research" "env carries CATALYST_PHASE=research"
assert_contains "$LOG" "CATALYST_TICKET=CTL-450" "env carries CATALYST_TICKET=CTL-450"

# ─── E2E: dispatcher refuses when triage.json is missing ───────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-research without triage.json"

TEST_DIR="${SCRATCH}/t3"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR"

OUT=$("$DISPATCH" --phase research --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when triage.json missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"
SIGNAL_EXISTS="no"
[[ -f "${WORKER_DIR}/phase-research.json" ]] && SIGNAL_EXISTS="yes"
assert_eq "no" "$SIGNAL_EXISTS" "no signal file written on refusal"

# ─── CTL-632: Linear comment-mirror block ─ runtime exercises ──────────────
echo ""
echo "Test 4: phase-research mirror block — happy path"

extract_mirror() {
  awk '
    /^```bash phase-research-mirror$/ {capture=1; next}
    /^```$/ {if (capture) {capture=0}}
    capture { print }
  ' "$SKILL"
}

MIRROR_BODY_FILE="${SCRATCH}/mirror-body.sh"
extract_mirror > "$MIRROR_BODY_FILE"
if [[ ! -s "$MIRROR_BODY_FILE" ]]; then
  fail "mirror block extractable" "no \`\`\`bash phase-research-mirror\`\`\` fence found in SKILL.md"
else
  pass "mirror block extractable from SKILL.md"
fi

run_mirror_case() {
  local case_name="$1" stub_kind="$2" preseed_marker="${3:-}"
  local case_dir="${SCRATCH}/mirror-${case_name}"
  local worker_dir="${case_dir}/orch/workers/CTL-450"
  local research_doc="${case_dir}/research.md"
  mkdir -p "$case_dir/bin" "$worker_dir"

  cat >"$research_doc" <<'DOC'
# Research: CTL-450 — fixture title

## Summary

This is the summary opening paragraph that the mirror block extracts.
A second prose line.

## Findings

- foo
DOC

  if [[ "$stub_kind" == "ok" ]]; then
    linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
  else
    linearis_stub_install_failing "$case_dir/bin" "$case_dir/linearis-calls.log"
  fi

  if [[ -n "$preseed_marker" ]]; then
    : > "$worker_dir/.linear-mirror-research"
  fi

  PATH="$case_dir/bin:$PATH" \
    ORCH_DIR="${case_dir}/orch" \
    TICKET="CTL-450" \
    PHASE="research" \
    RESEARCH_DOC="$research_doc" \
    bash "$MIRROR_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
  echo "$?" > "$case_dir/exit-code"
  echo "$case_dir"
}

# Case A: happy — stub OK, no pre-seeded marker.
CASE_A="$(run_mirror_case happy ok)"
EXIT_A="$(cat "$CASE_A/exit-code")"
assert_eq "0" "$EXIT_A" "mirror happy: exit code 0 (fail-open: mirror never propagates non-zero)"

LOG_A="$CASE_A/linearis-calls.log"
if grep -q '^discuss$' "$LOG_A" 2>/dev/null; then
  pass "mirror happy: discuss call landed"
else
  fail "mirror happy: discuss call" "no 'discuss' in $LOG_A:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi

# The body must contain the rendered template (Phase Research header).
if grep -q 'Phase Research' "$LOG_A" 2>/dev/null; then
  pass "mirror happy: body carries 'Phase Research' header"
else
  fail "mirror happy: body 'Phase Research'" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi

# Doc path must appear in the body.
if grep -q 'research.md' "$LOG_A" 2>/dev/null; then
  pass "mirror happy: body carries research doc path"
else
  fail "mirror happy: doc path in body" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi

# Marker written.
MARKER_A="$CASE_A/orch/workers/CTL-450/.linear-mirror-research"
if [[ -e "$MARKER_A" ]]; then
  pass "mirror happy: .linear-mirror-research marker written"
else
  fail "mirror happy: marker file" "missing: $MARKER_A"
fi

# Case B: fail-open — failing stub, body still exits 0, marker NOT written, warning on stderr.
echo ""
echo "Test 5: phase-research mirror — fail-open"
CASE_B="$(run_mirror_case failopen fail)"
EXIT_B="$(cat "$CASE_B/exit-code")"
assert_eq "0" "$EXIT_B" "mirror fail-open: still exits 0"

MARKER_B="$CASE_B/orch/workers/CTL-450/.linear-mirror-research"
if [[ ! -e "$MARKER_B" ]]; then
  pass "mirror fail-open: marker NOT written on failed post"
else
  fail "mirror fail-open: marker" "marker should not exist when linearis discuss fails"
fi

if grep -q 'linearis discuss failed (continuing)' "$CASE_B/stderr.log" 2>/dev/null; then
  pass "mirror fail-open: warning logged to stderr"
else
  fail "mirror fail-open: warning" "stderr:$(printf '\n%s' "$(cat "$CASE_B/stderr.log" 2>/dev/null)")"
fi

# Case C: idempotent — pre-seeded marker, no discuss call.
echo ""
echo "Test 6: phase-research mirror — idempotent"
CASE_C="$(run_mirror_case idempot ok seed)"
EXIT_C="$(cat "$CASE_C/exit-code")"
assert_eq "0" "$EXIT_C" "mirror idempotent: exit code 0"

LOG_C="$CASE_C/linearis-calls.log"
if [[ ! -f "$LOG_C" ]] || ! grep -q '^discuss$' "$LOG_C" 2>/dev/null; then
  pass "mirror idempotent: no discuss call (marker honored)"
else
  fail "mirror idempotent: discuss call" "found discuss in $LOG_C — marker not honored"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-research-e2e: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
