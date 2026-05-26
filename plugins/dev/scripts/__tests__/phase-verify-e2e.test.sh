#!/usr/bin/env bash
# Tests for the phase-verify skill (CTL-450 Initiative 1 Phase 4).
#
# phase-verify is the only NEW skill in Phase 4 (the others wrap canonical skills).
# It is read-only against application code — it produces a verify.json artifact
# and may only create test files, never application code.
#
# These tests verify:
#   - SKILL.md exists with the right frontmatter + read-only constraint
#   - The body declares the prelude env-var contract
#   - The body reads phase-implement.json as its prior artifact
#   - The body documents the regression_risk / findings / tests_attempted schema
#   - The body explicitly states it does NOT write application code
#   - The body calls phase-agent-emit-complete with --phase verify
#   - Dispatching with --phase verify succeeds when phase-implement.json exists
#   - Dispatching refuses when phase-implement.json is missing
#
# Run: bash plugins/dev/scripts/__tests__/phase-verify-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-verify/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-verify-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 — '$2' unexpectedly present"; }
assert_file_exists() { [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"; }

# ─── Contract ───────────────────────────────────────────────────────────────
echo "Test 1: phase-verify SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-verify/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  assert_contains "$BODY" "name: phase-verify" "frontmatter declares name: phase-verify"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. user-invocable MUST be true.
  assert_contains "$BODY" "user-invocable: true" "frontmatter sets user-invocable: true (CTL-490)"
  assert_contains "$BODY" "disable-model-invocation: false" "frontmatter sets disable-model-invocation: false — invocable by model + user"

  # Prelude
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_TICKET" "prelude reads CATALYST_TICKET"

  # CRITICAL: read-only constraint must be loud
  assert_contains "$BODY" "NEVER write application code" \
    "body declares 'NEVER write application code' constraint"

  # Prior artifact: phase-implement.json
  assert_contains "$BODY" "phase-implement.json" "body reads phase-implement.json as prior artifact"

  # Output artifact: verify.json
  assert_contains "$BODY" "verify.json" "body writes verify.json artifact"

  # Required schema fields
  assert_contains "$BODY" "regression_risk" "verify.json schema includes regression_risk"
  assert_contains "$BODY" "findings"        "verify.json schema includes findings"
  assert_contains "$BODY" "tests_attempted" "verify.json schema includes tests_attempted"

  # Gates referenced
  assert_contains "$BODY" "validate-type-safety"  "body references validate-type-safety gate"
  assert_contains "$BODY" "scan-reward-hacking"   "body references scan-reward-hacking gate"
  assert_contains "$BODY" "code-reviewer"         "body references code-reviewer agent"
  assert_contains "$BODY" "pr-test-analyzer"      "body references pr-test-analyzer agent"
  assert_contains "$BODY" "silent-failure-hunter" "body references silent-failure-hunter agent"

  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"

  # CTL-558: Linear status write-back moved to the deterministic coordinator —
  # the phase agent no longer carries the linear-transition prose.
  assert_not_contains "$BODY" "--transition verifying" "body does NOT self-transition Linear (coordinator owns it, CTL-558)"

  assert_contains "$BODY" "/goal" "body declares a /goal block"

  # CTL-632: Linear comment-mirror block must be present.
  assert_contains "$BODY" "phase-verify-mirror" "body contains uniquely-named mirror fence"
  assert_contains "$BODY" ".linear-mirror-" "body references the per-phase marker file"
  assert_contains "$BODY" "linearis issues discuss" "body calls linearis issues discuss"
  assert_contains "$BODY" "linearis discuss failed (continuing)" "body has fail-open warning string"
fi

# ─── E2E: dispatcher launches phase-verify when phase-implement.json exists ─
echo ""
echo "Test 2: phase-agent-dispatch --phase verify succeeds with phase-implement.json present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$STUB_DIR" "$WORKER_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: stub mimics today's real `claude --bg` stdout shape. Hex 'c3d4e5f6'.
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"; printf '%s\n' "$@"
  echo "--ENV--"; env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
cat <<EOF
backgrounded · c3d4e5f6
  claude agents             list sessions
  claude attach c3d4e5f6    open in this terminal
EOF
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

echo '{"ticket":"CTL-450","phase":"implement","status":"done"}' > "${WORKER_DIR}/phase-implement.json"

OUT=$("$DISPATCH" --phase verify --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-verify.json"
assert_file_exists "$SIGNAL" "signal file phase-verify.json written"

if [[ -f "$SIGNAL" ]]; then
  assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "signal.status = running"
  assert_eq "verify" "$(jq -r '.phase' "$SIGNAL")" "signal.phase = verify"
  assert_eq "20" "$(jq -r '.turnCap' "$SIGNAL")" "signal.turnCap defaults to 20 (verify)"
  assert_eq "c3d4e5f6" "$(jq -r '.bg_job_id' "$SIGNAL")" "signal.bg_job_id matches hex from stub (CTL-490)"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-verify CTL-450" "claude invoked with phase-verify skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=verify" "env carries CATALYST_PHASE=verify"

# ─── E2E: dispatcher refuses without phase-implement.json ──────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-verify without phase-implement.json"

TEST_DIR="${SCRATCH}/t3"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR"

OUT=$("$DISPATCH" --phase verify --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when phase-implement.json missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"

# ─── CTL-632: Linear comment-mirror runtime exercises ────────────────────
echo ""
echo "Test 4: phase-verify mirror block — happy/fail-open/idempotent/findings-render"

MIRROR_BODY_FILE="${SCRATCH}/mirror-body.sh"
awk '
  /^```bash phase-verify-mirror$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL" > "$MIRROR_BODY_FILE"

if [[ -s "$MIRROR_BODY_FILE" ]]; then
  pass "mirror block extractable from SKILL.md"
else
  fail "mirror block extractable — no \`\`\`bash phase-verify-mirror\`\`\` fence found"
fi

run_verify_mirror() {
  local case_name="$1" stub_kind="$2" gates_json="$3" findings_json="$4" \
        regression_risk="$5" tests_attempted="$6" preseed_marker="${7:-}"
  local case_dir="${SCRATCH}/verify-mirror-${case_name}"
  local worker_dir="${case_dir}/orch/workers/CTL-450"
  mkdir -p "$case_dir/bin" "$worker_dir"

  if [[ "$stub_kind" == "ok" ]]; then
    linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
  else
    linearis_stub_install_failing "$case_dir/bin" "$case_dir/linearis-calls.log"
  fi

  if [[ -n "$preseed_marker" ]]; then
    : > "$worker_dir/.linear-mirror-verify"
  fi

  PATH="$case_dir/bin:$PATH" \
    ORCH_DIR="${case_dir}/orch" \
    TICKET="CTL-450" \
    PHASE="verify" \
    GATES_JSON="$gates_json" \
    FINDINGS_JSON="$findings_json" \
    REGRESSION_RISK="$regression_risk" \
    TESTS_ATTEMPTED="$tests_attempted" \
    ARTIFACT="${worker_dir}/verify.json" \
    bash "$MIRROR_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
  echo "$?" > "$case_dir/exit-code"
  echo "$case_dir"
}

GATES_PASS='{"tsc":{"status":"pass","summary":"clean"},"tests":{"status":"pass","summary":"42/42"},"lint":{"status":"skipped"}}'
GATES_FAIL='{"tsc":{"status":"fail","summary":"3 errors"},"tests":{"status":"pass"}}'
FINDINGS_EMPTY='[]'
FINDINGS_TWO='[{"severity":"high","kind":"type","file":"a.ts","line":1,"message":"x"},{"severity":"low","kind":"lint","file":"b.ts","line":2,"message":"y"}]'

# Case A: happy — pass gates, no findings.
CASE_A="$(run_verify_mirror happy ok "$GATES_PASS" "$FINDINGS_EMPTY" 2 1)"
assert_eq "0" "$(cat "$CASE_A/exit-code")" "mirror-verify happy: exit 0"
LOG_A="$CASE_A/linearis-calls.log"
if grep -q '^discuss$' "$LOG_A" 2>/dev/null; then
  pass "mirror-verify happy: discuss landed"
else
  fail "mirror-verify happy: discuss" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -q 'Phase Verify' "$LOG_A" 2>/dev/null; then
  pass "mirror-verify happy: body has 'Phase Verify' header"
else
  fail "mirror-verify happy: header" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -qE 'Regression risk.*2' "$LOG_A" 2>/dev/null; then
  pass "mirror-verify happy: regression risk rendered"
else
  fail "mirror-verify happy: regression_risk" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
# All three gates referenced in body.
for g in tsc tests lint; do
  if grep -qE "\\*\\*${g}\\*\\*" "$LOG_A" 2>/dev/null; then
    pass "mirror-verify happy: gate '$g' in body"
  else
    fail "mirror-verify happy: gate '$g'" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
  fi
done
MARKER_A="$CASE_A/orch/workers/CTL-450/.linear-mirror-verify"
[[ -e "$MARKER_A" ]] && pass "mirror-verify happy: marker written" || fail "marker missing $MARKER_A"

# Case B: fail-open.
CASE_B="$(run_verify_mirror failopen fail "$GATES_PASS" "$FINDINGS_EMPTY" 0 0)"
assert_eq "0" "$(cat "$CASE_B/exit-code")" "mirror-verify fail-open: exit 0"
MARKER_B="$CASE_B/orch/workers/CTL-450/.linear-mirror-verify"
[[ ! -e "$MARKER_B" ]] && pass "mirror-verify fail-open: no marker" || fail "marker should not exist"
if grep -q 'linearis discuss failed (continuing)' "$CASE_B/stderr.log" 2>/dev/null; then
  pass "mirror-verify fail-open: warning"
else
  fail "mirror-verify fail-open: warning" "stderr:$(printf '\n%s' "$(cat "$CASE_B/stderr.log" 2>/dev/null)")"
fi

# Case C: idempotent.
CASE_C="$(run_verify_mirror idempot ok "$GATES_PASS" "$FINDINGS_EMPTY" 0 0 seed)"
assert_eq "0" "$(cat "$CASE_C/exit-code")" "mirror-verify idempotent: exit 0"
LOG_C="$CASE_C/linearis-calls.log"
if [[ ! -f "$LOG_C" ]] || ! grep -q '^discuss$' "$LOG_C" 2>/dev/null; then
  pass "mirror-verify idempotent: discuss skipped"
else
  fail "mirror-verify idempotent: discuss" "marker not honored"
fi

# Case D: findings-render — 2 findings, both severities surfaced + full JSON in details.
CASE_D="$(run_verify_mirror findings ok "$GATES_FAIL" "$FINDINGS_TWO" 8 0)"
assert_eq "0" "$(cat "$CASE_D/exit-code")" "mirror-verify findings: exit 0"
LOG_D="$CASE_D/linearis-calls.log"
if grep -q 'high' "$LOG_D" 2>/dev/null && grep -q 'low' "$LOG_D" 2>/dev/null; then
  pass "mirror-verify findings: both severity strings present"
else
  fail "mirror-verify findings: severities" "log:$(printf '\n%s' "$(cat "$LOG_D" 2>/dev/null)")"
fi
if grep -q '<details>' "$LOG_D" 2>/dev/null && grep -qE 'a\.ts|b\.ts' "$LOG_D" 2>/dev/null; then
  pass "mirror-verify findings: full JSON in <details>"
else
  fail "mirror-verify findings: details JSON" "log:$(printf '\n%s' "$(cat "$LOG_D" 2>/dev/null)")"
fi

# ─── Test 5 (CTL-608): phase-verify empty-branch backstop gate present ────
echo ""
echo "Test 5 (CTL-608): phase-verify contract — empty-branch backstop gate present"
if [[ -f "$SKILL" ]]; then
  # Backstop for the live phase-implement gate (Phase 1, already landed): if an
  # empty branch (0 commits ahead) somehow reaches verify — e.g. via the
  # reclaim-dead-work path, which emits implement-complete without running the
  # phase-implement End block / gate — verify must fail fast instead of running
  # gates and advancing an empty branch to phase-pr. Lives in its own
  # uniquely-named fence so this harness can extract+run it (like the mirror).
  assert_contains "$BODY" "phase-verify-empty-branch-gate" "body contains uniquely-named empty-branch gate fence"
  assert_contains "$BODY" "rev-list --count" "gate counts commits-ahead via rev-list --count"
  assert_contains "$BODY" "empty_branch:" "gate emits failure reason prefixed empty_branch:"
  assert_contains "$BODY" "empty branch" "gate body documents the empty-branch condition"
fi

# ─── Test 6 (CTL-608): empty-branch gate runtime — empty/non-empty/no-base ─
echo ""
echo "Test 6 (CTL-608): phase-verify empty-branch gate — empty/non-empty/base-unknown"

VERIFY_GATE_FILE="${SCRATCH}/verify-empty-branch-gate.sh"
awk '
  /^```bash phase-verify-empty-branch-gate$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL" > "$VERIFY_GATE_FILE"

if [[ -s "$VERIFY_GATE_FILE" ]]; then
  pass "empty-branch gate extractable from SKILL.md"
else
  fail "empty-branch gate extractable — no \`\`\`bash phase-verify-empty-branch-gate\`\`\` fence found"
fi

# Stub phase-agent-emit-complete under $PLUGIN_ROOT/scripts/ — the gate calls it
# directly. Captures argv to $EMIT_CAPTURE so --status / --reason can be asserted.
install_verify_emit_stub() {
  local plugin_root="$1"
  mkdir -p "$plugin_root/scripts"
  cat > "$plugin_root/scripts/phase-agent-emit-complete" <<'STUB'
#!/usr/bin/env bash
# CTL-608 test stub: capture argv so the gate's terminal emit can be asserted.
echo "$*" >> "${EMIT_CAPTURE:-/dev/null}"
exit 0
STUB
  chmod +x "$plugin_root/scripts/phase-agent-emit-complete"
}

# Empty branch: HEAD == origin/main (0 commits ahead).
build_verify_fixture_empty() {
  local repo_dir="$1"
  mkdir -p "$repo_dir"
  (
    cd "$repo_dir" || exit 1
    git init --quiet --initial-branch=main
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "base" > base.txt
    git add base.txt
    git commit --quiet -m "base commit"
    git update-ref refs/remotes/origin/main HEAD
    git checkout --quiet -b feature
  )
}

# Non-empty branch: origin/main + 2 commits ahead.
build_verify_fixture_nonempty() {
  local repo_dir="$1"
  mkdir -p "$repo_dir"
  (
    cd "$repo_dir" || exit 1
    git init --quiet --initial-branch=main
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "base" > base.txt
    git add base.txt
    git commit --quiet -m "base commit"
    git update-ref refs/remotes/origin/main HEAD
    git checkout --quiet -b feature
    echo "change one" > a.txt
    git add a.txt
    git commit --quiet -m "feat: first commit"
    echo "change two" > b.txt
    git add b.txt
    git commit --quiet -m "feat: second commit"
  )
}

# Base unknown: no main, no origin/main.
build_verify_fixture_no_base() {
  local repo_dir="$1"
  mkdir -p "$repo_dir"
  (
    cd "$repo_dir" || exit 1
    git init --quiet --initial-branch=feature
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "x" > x.txt
    git add x.txt
    git commit --quiet -m "feat: solo commit"
  )
}

run_verify_empty_branch_gate() {
  local case_name="$1" fixture_fn="$2"
  local case_dir="${SCRATCH}/ver-gate-${case_name}"
  local repo_dir="${case_dir}/repo"
  local plugin_root="${case_dir}/plugin"
  mkdir -p "$case_dir"
  "$fixture_fn" "$repo_dir"
  install_verify_emit_stub "$plugin_root"
  (
    cd "$repo_dir" || exit 1
    EMIT_CAPTURE="${case_dir}/emit-capture.log" \
      PLUGIN_ROOT="$plugin_root" \
      PHASE="verify" \
      TICKET="CTL-450" \
      BASE_BRANCH="main" \
      COMMS="" \
      CHANNEL="orch-e2e" \
      ORCH_ID="orch-e2e" \
      bash "$VERIFY_GATE_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
    echo "$?" > "$case_dir/exit-code"
  )
  echo "$case_dir"
}

# Case E — empty branch: gate must emit --status failed (empty_branch:) + exit 1.
VCASE_E="$(run_verify_empty_branch_gate empty build_verify_fixture_empty)"
assert_eq "1" "$(cat "$VCASE_E/exit-code")" "verify gate empty-branch: exit 1"
if grep -q -- '--status failed' "$VCASE_E/emit-capture.log" 2>/dev/null; then
  pass "verify gate empty-branch: emits --status failed"
else
  fail "verify gate empty-branch: --status failed — capture:$(printf '\n%s' "$(cat "$VCASE_E/emit-capture.log" 2>/dev/null)")"
fi
if grep -q 'empty_branch:' "$VCASE_E/emit-capture.log" 2>/dev/null; then
  pass "verify gate empty-branch: reason prefixed empty_branch:"
else
  fail "verify gate empty-branch: reason — capture:$(printf '\n%s' "$(cat "$VCASE_E/emit-capture.log" 2>/dev/null)")"
fi

# Case F — non-empty branch (origin/main + 2 commits ahead): gate falls through,
# exit 0, no --status failed captured.
VCASE_F="$(run_verify_empty_branch_gate nonempty build_verify_fixture_nonempty)"
assert_eq "0" "$(cat "$VCASE_F/exit-code")" "verify gate non-empty: exit 0 (falls through)"
if grep -q -- '--status failed' "$VCASE_F/emit-capture.log" 2>/dev/null; then
  fail "verify gate non-empty: must NOT emit --status failed — capture:$(printf '\n%s' "$(cat "$VCASE_F/emit-capture.log" 2>/dev/null)")"
else
  pass "verify gate non-empty: no --status failed (gate is silent on success)"
fi

# Case G — base unknown (no origin/main, no main): fail-open, exit 0, warn on
# stderr, no --status failed.
VCASE_G="$(run_verify_empty_branch_gate nobase build_verify_fixture_no_base)"
assert_eq "0" "$(cat "$VCASE_G/exit-code")" "verify gate base-unknown: exit 0 (fail-open)"
if grep -q -- '--status failed' "$VCASE_G/emit-capture.log" 2>/dev/null; then
  fail "verify gate base-unknown: must NOT emit --status failed — capture:$(printf '\n%s' "$(cat "$VCASE_G/emit-capture.log" 2>/dev/null)")"
else
  pass "verify gate base-unknown: no --status failed"
fi
if grep -q 'could not resolve integration base' "$VCASE_G/stderr.log" 2>/dev/null; then
  pass "verify gate base-unknown: warns on stderr"
else
  fail "verify gate base-unknown: warning — stderr:$(printf '\n%s' "$(cat "$VCASE_G/stderr.log" 2>/dev/null)")"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-verify-e2e: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
