#!/usr/bin/env bash
# Tests for the phase-review skill (CTL-450 Initiative 1 Phase 4).
#
# phase-review wraps the gstack /review skill (NOT /ultrareview — that one stays
# user-triggered). It reads the prior verify.json, runs /review against the diff,
# writes ${ORCH_DIR}/workers/<TICKET>/review.json, and creates at most ONE
# remediation commit for HIGH-severity findings with deterministic fixes.
#
# Run: bash plugins/dev/scripts/__tests__/phase-review-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-review/SKILL.md"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-review-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }
assert_contains() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 — '$2' WAS present (must not be)"; }
assert_file_exists() { [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"; }

# ─── Contract ───────────────────────────────────────────────────────────────
echo "Test 1: phase-review SKILL.md contract"
assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-review/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY=$(cat "$SKILL")
  assert_contains "$BODY" "name: phase-review" "frontmatter declares name: phase-review"
  # CTL-490: phase skills are dispatched via `claude --bg "/catalyst-dev:phase-X ..."`,
  # which the bg session parses as a user slash command. user-invocable MUST be true.
  assert_contains "$BODY" "user-invocable: true" "frontmatter sets user-invocable: true (CTL-490)"
  assert_contains "$BODY" "disable-model-invocation: false" "frontmatter sets disable-model-invocation: false — invocable by model + user"

  # Allowed-tools must include Edit (since we may write remediation commits)
  assert_contains "$BODY" "Edit" "allowed-tools includes Edit (for remediation commits)"

  # Prelude
  assert_contains "$BODY" "CATALYST_ORCHESTRATOR_DIR" "prelude reads CATALYST_ORCHESTRATOR_DIR"
  assert_contains "$BODY" "CATALYST_TICKET" "prelude reads CATALYST_TICKET"

  # Prior artifact: verify.json from phase-verify
  assert_contains "$BODY" "verify.json" "body reads prior verify.json artifact"

  # Output artifact: review.json
  assert_contains "$BODY" "review.json" "body writes review.json artifact"

  # Schema fields
  assert_contains "$BODY" "remediationCommit" "review.json schema includes remediationCommit"
  assert_contains "$BODY" "reviewPassed"      "review.json schema includes reviewPassed"

  # Delegates to /review — must not invoke /ultrareview
  assert_contains "$BODY" "/review" "body invokes /review (gstack)"
  assert_not_contains "$BODY" "Invoke /ultrareview" "body does NOT instruct invoking /ultrareview"
  # Either no mention of ultrareview or only a no-op directive — assert the
  # body acknowledges and forbids it.
  assert_contains "$BODY" "ultrareview" "body acknowledges ultrareview (to forbid it)"

  assert_contains "$BODY" "phase-agent-emit-complete" "body calls phase-agent-emit-complete"
  assert_contains "$BODY" '--status complete' "body emits --status complete on success"

  # CTL-558: Linear status write-back moved to the deterministic coordinator —
  # the phase agent no longer carries the linear-transition prose.
  assert_not_contains "$BODY" "--transition reviewing" "body does NOT self-transition Linear (coordinator owns it, CTL-558)"

  assert_contains "$BODY" "/goal" "body declares a /goal block"

  # Remediation commit cap: at most ONE
  assert_contains "$BODY" "at most ONE" "body documents at-most-one-remediation-commit constraint"

  # CTL-632: Linear comment-mirror block must be present.
  assert_contains "$BODY" "phase-review-mirror" "body contains uniquely-named mirror fence"
  assert_contains "$BODY" ".linear-mirror-" "body references the per-phase marker file"
  assert_contains "$BODY" "linearis issues discuss" "body calls linearis issues discuss"
  assert_contains "$BODY" "linearis discuss failed (continuing)" "body has fail-open warning string"
fi

# ─── E2E: dispatcher launches phase-review when verify.json present ────────
echo ""
echo "Test 2: phase-agent-dispatch --phase review succeeds with verify.json present"

TEST_DIR="${SCRATCH}/t2"
STUB_DIR="${TEST_DIR}/bin"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$STUB_DIR" "$WORKER_DIR"

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# CTL-490: stub mimics today's real `claude --bg` stdout shape. Hex 'd4e5f607'.
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
{
  echo "--ARGS--"; printf '%s\n' "$@"
  echo "--ENV--"; env | grep -E '^CATALYST_(ORCHESTRATOR_(DIR|ID)|PHASE|TICKET)=' | sort
  echo "--END--"
} > "$LOG"
cat <<EOF
backgrounded · d4e5f607
  claude agents             list sessions
  claude attach d4e5f607    open in this terminal
EOF
STUB
chmod +x "$STUB_DIR/claude"

export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
export PATH="${STUB_DIR}:${PATH}"

cat > "${WORKER_DIR}/verify.json" <<EOF
{"regression_risk": 3, "findings": [], "tests_attempted": 0, "gates": {}}
EOF

OUT=$("$DISPATCH" --phase review --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
assert_eq "0" "$RC" "dispatch exit code 0"
SIGNAL="${WORKER_DIR}/phase-review.json"
assert_file_exists "$SIGNAL" "signal file phase-review.json written"

if [[ -f "$SIGNAL" ]]; then
  assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "signal.status = running"
  assert_eq "review" "$(jq -r '.phase' "$SIGNAL")" "signal.phase = review"
  assert_eq "25" "$(jq -r '.turnCap' "$SIGNAL")" "signal.turnCap defaults to 25 (review)"
  assert_eq "d4e5f607" "$(jq -r '.bg_job_id' "$SIGNAL")" "signal.bg_job_id matches hex from stub (CTL-490)"
fi

LOG=$(cat "$CLAUDE_STUB_LOG" 2>/dev/null || echo "")
assert_contains "$LOG" "/catalyst-dev:phase-review CTL-450" "claude invoked with phase-review skill prompt"
assert_contains "$LOG" "CATALYST_PHASE=review" "env carries CATALYST_PHASE=review"

# ─── E2E: dispatcher refuses without verify.json ───────────────────────────
echo ""
echo "Test 3: phase-agent-dispatch refuses phase-review without verify.json"

TEST_DIR="${SCRATCH}/t3"
ORCH_DIR="${TEST_DIR}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-450"
mkdir -p "$WORKER_DIR"

OUT=$("$DISPATCH" --phase review --ticket CTL-450 --orch-dir "$ORCH_DIR" --orch-id orch-test 2>/dev/null)
RC=$?
REFUSED=$(echo "$OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "2" "$RC" "exit code 2 when verify.json missing"
assert_eq "refused" "$REFUSED" "stdout status = refused"

# ─── CTL-632: Linear comment-mirror runtime exercises ────────────────────
echo ""
echo "Test 4: phase-review mirror block — happy-pass/happy-fail/fail-open/idempotent"

# Note on the plan's 5th case (`emit-failed-not-complete` invariant tied to
# memory #41): the current phase-review SKILL.md does not yet have an
# emit-failed-on-block code path (it only emits `failed` on unrecoverable
# verification crashes via the Failure handling block). Implementing
# emit-failed-on-block is outside CTL-632's scope; the mirror block here
# runs on the success end-block path, which is reached for both
# reviewPassed=true and reviewPassed=false today. Case 5 is therefore
# deferred to whichever ticket lands the emit-failed-on-block fix.

MIRROR_BODY_FILE="${SCRATCH}/mirror-body.sh"
awk '
  /^```bash phase-review-mirror$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL" > "$MIRROR_BODY_FILE"

if [[ -s "$MIRROR_BODY_FILE" ]]; then
  pass "mirror block extractable from SKILL.md"
else
  fail "mirror block extractable — no \`\`\`bash phase-review-mirror\`\`\` fence found"
fi

run_review_mirror() {
  local case_name="$1" stub_kind="$2" review_passed="$3" findings_json="$4" \
        remediation_sha="$5" preseed_marker="${6:-}"
  local case_dir="${SCRATCH}/review-mirror-${case_name}"
  local worker_dir="${case_dir}/orch/workers/CTL-450"
  mkdir -p "$case_dir/bin" "$worker_dir"

  if [[ "$stub_kind" == "ok" ]]; then
    linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log"
  else
    linearis_stub_install_failing "$case_dir/bin" "$case_dir/linearis-calls.log"
  fi

  if [[ -n "$preseed_marker" ]]; then
    : > "$worker_dir/.linear-mirror-review"
  fi

  PATH="$case_dir/bin:$PATH" \
    ORCH_DIR="${case_dir}/orch" \
    TICKET="CTL-450" \
    PHASE="review" \
    REVIEW_PASSED="$review_passed" \
    REVIEW_FINDINGS_JSON="$findings_json" \
    REMEDIATION_SHA="$remediation_sha" \
    bash "$MIRROR_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
  echo "$?" > "$case_dir/exit-code"
  echo "$case_dir"
}

FINDINGS_EMPTY='[]'
FINDINGS_HIGH='[{"severity":"high","kind":"review","file":"a.ts","line":1,"message":"x","addressedBy":"deferred-to-human"}]'

# Case A: happy-passed.
CASE_A="$(run_review_mirror happy_pass ok true "$FINDINGS_EMPTY" "")"
assert_eq "0" "$(cat "$CASE_A/exit-code")" "mirror-review happy-pass: exit 0"
LOG_A="$CASE_A/linearis-calls.log"
if grep -q '^discuss$' "$LOG_A" 2>/dev/null; then
  pass "mirror-review happy-pass: discuss landed"
else
  fail "mirror-review happy-pass: discuss" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -qE 'Result.*PASS' "$LOG_A" 2>/dev/null; then
  pass "mirror-review happy-pass: body shows Result: PASS"
else
  fail "mirror-review happy-pass: PASS label" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
if grep -q 'none' "$LOG_A" 2>/dev/null; then
  pass "mirror-review happy-pass: 'none' fallback for empty findings"
else
  fail "mirror-review happy-pass: empty findings fallback" "log:$(printf '\n%s' "$(cat "$LOG_A" 2>/dev/null)")"
fi
MARKER_A="$CASE_A/orch/workers/CTL-450/.linear-mirror-review"
[[ -e "$MARKER_A" ]] && pass "mirror-review happy-pass: marker written" || fail "marker missing $MARKER_A"

# Case B: happy-failed (reviewPassed=false, 1 HIGH finding, remediation sha).
CASE_B="$(run_review_mirror happy_fail ok false "$FINDINGS_HIGH" "abc1234")"
assert_eq "0" "$(cat "$CASE_B/exit-code")" "mirror-review happy-fail: exit 0"
LOG_B="$CASE_B/linearis-calls.log"
if grep -qE 'Result.*FAIL' "$LOG_B" 2>/dev/null; then
  pass "mirror-review happy-fail: body shows Result: FAIL"
else
  fail "mirror-review happy-fail: FAIL label" "log:$(printf '\n%s' "$(cat "$LOG_B" 2>/dev/null)")"
fi
if grep -q 'high' "$LOG_B" 2>/dev/null; then
  pass "mirror-review happy-fail: HIGH severity surfaced"
else
  fail "mirror-review happy-fail: severity" "log:$(printf '\n%s' "$(cat "$LOG_B" 2>/dev/null)")"
fi
if grep -q 'abc1234' "$LOG_B" 2>/dev/null; then
  pass "mirror-review happy-fail: remediation sha rendered"
else
  fail "mirror-review happy-fail: remediation sha" "log:$(printf '\n%s' "$(cat "$LOG_B" 2>/dev/null)")"
fi
if grep -q '<details>' "$LOG_B" 2>/dev/null && grep -q 'a\.ts' "$LOG_B" 2>/dev/null; then
  pass "mirror-review happy-fail: full findings JSON in <details>"
else
  fail "mirror-review happy-fail: details JSON" "log:$(printf '\n%s' "$(cat "$LOG_B" 2>/dev/null)")"
fi

# Case C: fail-open.
CASE_C="$(run_review_mirror failopen fail true "$FINDINGS_EMPTY" "")"
assert_eq "0" "$(cat "$CASE_C/exit-code")" "mirror-review fail-open: exit 0"
MARKER_C="$CASE_C/orch/workers/CTL-450/.linear-mirror-review"
[[ ! -e "$MARKER_C" ]] && pass "mirror-review fail-open: no marker" || fail "marker should not exist"
if grep -q 'linearis discuss failed (continuing)' "$CASE_C/stderr.log" 2>/dev/null; then
  pass "mirror-review fail-open: warning to stderr"
else
  fail "mirror-review fail-open: warning" "stderr:$(printf '\n%s' "$(cat "$CASE_C/stderr.log" 2>/dev/null)")"
fi

# Case D: idempotent.
CASE_D="$(run_review_mirror idempot ok true "$FINDINGS_EMPTY" "" seed)"
assert_eq "0" "$(cat "$CASE_D/exit-code")" "mirror-review idempotent: exit 0"
LOG_D="$CASE_D/linearis-calls.log"
if [[ ! -f "$LOG_D" ]] || ! grep -q '^discuss$' "$LOG_D" 2>/dev/null; then
  pass "mirror-review idempotent: discuss skipped"
else
  fail "mirror-review idempotent: discuss" "marker not honored"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-review-e2e: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
