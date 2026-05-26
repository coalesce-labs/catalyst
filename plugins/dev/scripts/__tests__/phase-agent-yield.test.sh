#!/usr/bin/env bash
# Shell tests for the codified bg_job_id yield helper (CTL-615).
#
# Asserts the four operator invariants from memories #43/#44/#49/#50:
#   1. A duplicate worker (signal.bg_job_id != $CLAUDE_JOB_DIR's basename)
#      whose canonical job dir is still present writes a yield sidecar and
#      exits 0 — leaving the signal file untouched and emitting no event.
#   2. The canonical worker (matching bg_job_id) does NOT yield — caller
#      proceeds with normal prelude.
#   3. A duplicate whose canonical job dir has been reaped also does NOT
#      yield — there is nothing live to yield to. Caller proceeds.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/phase-agent-yield-check.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-agent-yield-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# Stub bin: emit-complete invocation under any yield path is a hard test fail.
STUB_BIN="${SCRATCH}/stubs"
mkdir -p "${STUB_BIN}"
cat > "${STUB_BIN}/phase-agent-emit-complete" <<'STUB'
#!/usr/bin/env bash
echo "FAIL: phase-agent-emit-complete invoked from yield path" >&2
exit 99
STUB
chmod +x "${STUB_BIN}/phase-agent-emit-complete"
export PATH="${STUB_BIN}:${PATH}"

# Common scratch layout
WORKER_DIR="${SCRATCH}/orch/workers/CTL-TEST"
JOBS_ROOT="${SCRATCH}/jobs"
OUR_JOB_DIR="${JOBS_ROOT}/our-job"
OTHER_JOB_DIR="${JOBS_ROOT}/other-job"
mkdir -p "${WORKER_DIR}" "${OUR_JOB_DIR}" "${OTHER_JOB_DIR}"
export CLAUDE_JOB_DIR="${OUR_JOB_DIR}"

SIGNAL="${WORKER_DIR}/phase-implement.json"
SIDECAR="${WORKER_DIR}/.phase-implement-yield"

reset_signal_other() {
  cat > "${SIGNAL}" <<JSON
{"ticket":"CTL-TEST","phase":"implement","status":"running","bg_job_id":"other-job"}
JSON
  rm -f "${SIDECAR}"
}

reset_signal_ours() {
  cat > "${SIGNAL}" <<JSON
{"ticket":"CTL-TEST","phase":"implement","status":"running","bg_job_id":"our-job"}
JSON
  rm -f "${SIDECAR}"
}

run_helper() {
  bash "${HELPER}" \
    --signal "${SIGNAL}" \
    --jobs-root "${JOBS_ROOT}" \
    --phase implement \
    --worker-dir "${WORKER_DIR}"
}

# ─── Test 1: duplicate worker yields (canonical alive) ───────────────────────
echo ""
echo "--- Test 1: duplicate worker yields when canonical job is alive ---"
reset_signal_other
mkdir -p "${OTHER_JOB_DIR}"
EXPECTED_PRE="$(jq -S . "${SIGNAL}")"

if run_helper; then
  pass "helper exited 0 (yield fired)"
else
  fail "helper must exit 0 when duplicate; got non-zero"
fi
if [[ -f "${SIDECAR}" ]]; then
  pass "yield sidecar written"
  if jq -e '.canonicalJob == "other-job" and .ourJob == "our-job"' "${SIDECAR}" >/dev/null 2>&1; then
    pass "sidecar names canonical and our job correctly"
  else
    fail "sidecar payload missing/wrong ourJob/canonicalJob"
  fi
else
  fail "yield sidecar not written"
fi
ACTUAL_POST="$(jq -S . "${SIGNAL}")"
if [[ "${EXPECTED_PRE}" == "${ACTUAL_POST}" ]]; then
  pass "signal file untouched by yield"
else
  fail "signal file mutated during yield"
fi

# ─── Test 2: canonical worker does not yield ─────────────────────────────────
echo ""
echo "--- Test 2: canonical worker (matching bg_job_id) does not yield ---"
reset_signal_ours
mkdir -p "${OTHER_JOB_DIR}"

if run_helper; then
  fail "helper must exit non-zero when canonical (no yield); got 0"
else
  pass "helper exited non-zero (proceed-with-prelude)"
fi
if [[ -f "${SIDECAR}" ]]; then
  fail "sidecar must not be written for canonical worker"
else
  pass "no sidecar (canonical case)"
fi

# ─── Test 3: duplicate but canonical reaped — proceed normally ───────────────
echo ""
echo "--- Test 3: duplicate but canonical job reaped — no yield ---"
reset_signal_other
rm -rf "${OTHER_JOB_DIR}"

if run_helper; then
  fail "helper must exit non-zero when canonical is dead; got 0"
else
  pass "helper exited non-zero (canonical reaped)"
fi
if [[ -f "${SIDECAR}" ]]; then
  fail "sidecar must not be written when canonical is reaped"
else
  pass "no sidecar (canonical reaped)"
fi

# ─── Test 4: missing CLAUDE_JOB_DIR — caller proceeds ────────────────────────
echo ""
echo "--- Test 4: missing CLAUDE_JOB_DIR — caller proceeds ---"
mkdir -p "${OTHER_JOB_DIR}"
reset_signal_other
unset CLAUDE_JOB_DIR
if run_helper; then
  fail "helper must exit non-zero when CLAUDE_JOB_DIR unset; got 0"
else
  pass "helper exited non-zero (no env, proceed)"
fi
if [[ -f "${SIDECAR}" ]]; then
  fail "sidecar must not be written when CLAUDE_JOB_DIR unset"
else
  pass "no sidecar (no env)"
fi
export CLAUDE_JOB_DIR="${OUR_JOB_DIR}"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo " ${PASSES} passed, ${FAILURES} failed"
echo "══════════════════════════════════════════════"

if [[ "${FAILURES}" -gt 0 ]]; then
  exit 1
fi
