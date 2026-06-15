#!/usr/bin/env bash
# phase-failure-comment.test.sh — unit tests for lib/phase-failure-comment.sh (CTL-1182 Phase 2).
#
# Strategy: inject CATALYST_COMMENT_POST_HELPER → recording stub so no live
# Linear calls are made. CATALYST_FAILURE_COMMENT=1 is the opt-in; tests verify
# that the default (env unset) is a no-op (test-isolation boundary).
#
# Run: bash plugins/dev/scripts/lib/__tests__/phase-failure-comment.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../phase-failure-comment.sh"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"
  else fail "$label — expected=$(printf '%q' "$expected") actual=$(printf '%q' "$actual")"
  fi
}

if [[ ! -f "$HELPER" ]]; then
  echo "FATAL: $HELPER not found" >&2
  exit 1
fi
if [[ ! -x "$HELPER" ]]; then
  echo "FATAL: $HELPER not executable" >&2
  exit 1
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

make_worker_dir() {
  local ticket="$1"
  mkdir -p "${SCRATCH}/orch/workers/${ticket}"
  echo "${SCRATCH}/orch/workers/${ticket}"
}

make_signal() {
  local dir="$1" ticket="$2" phase="$3"
  cat >"${dir}/phase-${phase}.json" <<EOF
{"ticket":"${ticket}","phase":"${phase}","status":"failed"}
EOF
}

# ─── Stub helper ──────────────────────────────────────────────────────────────
STUB="${SCRATCH}/stub-poster.sh"
STUB_INVOCATIONS="${SCRATCH}/stub-invocations.txt"
STUB_BODY_FILE="${SCRATCH}/stub-body.txt"
cat >"$STUB" <<STUBEOF
#!/usr/bin/env bash
# Recording stub for CATALYST_COMMENT_POST_HELPER
TICKET_ARG="\$1"
BODY_ARG="\$2"
printf '%s\n' "\$TICKET_ARG" >> "${STUB_INVOCATIONS}"
printf '%s' "\$BODY_ARG" > "${STUB_BODY_FILE}"
exit 0
STUBEOF
chmod +x "$STUB"

reset_stub() {
  rm -f "$STUB_INVOCATIONS" "$STUB_BODY_FILE"
}

stub_invocation_count() {
  [[ -f "$STUB_INVOCATIONS" ]] || { echo 0; return; }
  wc -l < "$STUB_INVOCATIONS" | tr -d ' '
}

FAIL_STUB="${SCRATCH}/fail-poster.sh"
cat >"$FAIL_STUB" <<'FSTUBEOF'
#!/usr/bin/env bash
exit 1
FSTUBEOF
chmod +x "$FAIL_STUB"

# ─── Test 1: posts on failure when CATALYST_FAILURE_COMMENT=1 ─────────────────
echo "Test 1: posts on failure when enabled (call_to_action from explanation)"
reset_stub
WORKER_DIR="$(make_worker_dir CTL-T1)"
make_signal "$WORKER_DIR" CTL-T1 implement
jq '. + {explanation:{problem:"push rejected",call_to_action:"Grant workflow scope or push manually"}}' \
  "${WORKER_DIR}/phase-implement.json" > "${WORKER_DIR}/phase-implement.json.tmp" && \
  mv "${WORKER_DIR}/phase-implement.json.tmp" "${WORKER_DIR}/phase-implement.json"

CATALYST_FAILURE_COMMENT=1 \
  CATALYST_COMMENT_POST_HELPER="$STUB" \
  "$HELPER" --ticket CTL-T1 --phase implement --reason "push_rejected" \
    --orch-dir "${SCRATCH}/orch" >/dev/null 2>&1
assert_eq "1" "$(stub_invocation_count)" "stub invoked exactly once"
assert_eq "CTL-T1" "$(cat "${STUB_INVOCATIONS}" 2>/dev/null | head -1)" "stub called with correct ticket"
if grep -q "call_to_action\|Grant workflow scope" "${STUB_BODY_FILE}" 2>/dev/null; then
  pass "body contains call_to_action text"
else
  fail "body missing call_to_action (body: $(cat "${STUB_BODY_FILE}" 2>/dev/null))"
fi
if grep -q "implement\|CTL-T1" "${STUB_BODY_FILE}" 2>/dev/null; then
  pass "body contains phase/ticket header"
else
  fail "body missing phase/ticket header"
fi

# ─── Test 2: reason fallback when no .explanation in signal ───────────────────
echo "Test 2: uses --reason when signal has no .explanation"
reset_stub
WORKER_DIR="$(make_worker_dir CTL-T2)"
make_signal "$WORKER_DIR" CTL-T2 verify

CATALYST_FAILURE_COMMENT=1 \
  CATALYST_COMMENT_POST_HELPER="$STUB" \
  "$HELPER" --ticket CTL-T2 --phase verify --reason "tests_red_after_3_attempts" \
    --orch-dir "${SCRATCH}/orch" >/dev/null 2>&1
assert_eq "1" "$(stub_invocation_count)" "stub invoked once (reason fallback)"
if grep -q "tests_red_after_3_attempts" "${STUB_BODY_FILE}" 2>/dev/null; then
  pass "body contains --reason text"
else
  fail "body missing reason text (body: $(cat "${STUB_BODY_FILE}" 2>/dev/null))"
fi

# ─── Test 3: idempotent (marker prevents double-post) ─────────────────────────
echo "Test 3: idempotent — second invocation with marker present does NOT invoke stub"
reset_stub
WORKER_DIR="$(make_worker_dir CTL-T3)"
make_signal "$WORKER_DIR" CTL-T3 plan

# First invocation: posts, creates marker
CATALYST_FAILURE_COMMENT=1 \
  CATALYST_COMMENT_POST_HELPER="$STUB" \
  "$HELPER" --ticket CTL-T3 --phase plan --reason "artifact_not_gate_visible" \
    --orch-dir "${SCRATCH}/orch" >/dev/null 2>&1
MARKER="${SCRATCH}/orch/workers/CTL-T3/.linear-failure-mirror-plan"
if [[ -f "$MARKER" ]]; then
  pass "marker file created after first invocation"
else
  fail "marker file not created"
fi
reset_stub
# Second invocation: should be no-op
CATALYST_FAILURE_COMMENT=1 \
  CATALYST_COMMENT_POST_HELPER="$STUB" \
  "$HELPER" --ticket CTL-T3 --phase plan --reason "artifact_not_gate_visible" \
    --orch-dir "${SCRATCH}/orch" >/dev/null 2>&1
assert_eq "0" "$(stub_invocation_count)" "stub NOT called on second invocation (idempotent)"

# ─── Test 4: disabled by default (CATALYST_FAILURE_COMMENT unset) ─────────────
echo "Test 4: disabled by default — no post when env unset"
reset_stub
WORKER_DIR="$(make_worker_dir CTL-T4)"
make_signal "$WORKER_DIR" CTL-T4 research

env -u CATALYST_FAILURE_COMMENT \
  CATALYST_COMMENT_POST_HELPER="$STUB" \
  "$HELPER" --ticket CTL-T4 --phase research --reason "artifact_not_gate_visible" \
    --orch-dir "${SCRATCH}/orch" >/dev/null 2>&1
assert_eq "0" "$(stub_invocation_count)" "stub NOT called when CATALYST_FAILURE_COMMENT unset"

# ─── Test 5: best-effort — helper stub exits 1 → phase-failure-comment exits 0 ──
echo "Test 5: best-effort — stub exits 1 does NOT propagate to caller"
reset_stub
WORKER_DIR="$(make_worker_dir CTL-T5)"
make_signal "$WORKER_DIR" CTL-T5 implement

RC=0
CATALYST_FAILURE_COMMENT=1 \
  CATALYST_COMMENT_POST_HELPER="$FAIL_STUB" \
  "$HELPER" --ticket CTL-T5 --phase implement --reason "some_failure" \
    --orch-dir "${SCRATCH}/orch" >/dev/null 2>&1 || RC=$?
assert_eq "0" "$RC" "helper exits 0 even when poster stub fails (best-effort)"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "phase-failure-comment: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
