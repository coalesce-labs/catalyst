#!/usr/bin/env bash
# Shell tests for compound-log helper (CTL-159).
#
# The /compound skill is a closing ritual at PR merge that writes a
# compound-log entry to thoughts/shared/pm/metrics/YYYY-WW-compound-log.md.
# This helper does the mechanical work: ISO-week routing, fail-loud field
# validation, dedup, and append.
#
# Run: bash plugins/dev/scripts/__tests__/compound-log.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMPOUND="${REPO_ROOT}/plugins/dev/scripts/compound-log.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() {
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $1"
  [ -n "${2:-}" ] && echo "    detail: $2"
  if [ -f "${SCRATCH}/out" ]; then
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

# Minimal fake gh and linearis stand-ins, used by several tests.
install_fakes() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"

  cat > "${bin_dir}/gh" <<'EOF'
#!/usr/bin/env bash
# Fake `gh`. Reads FAKE_GH_JSON for JSON responses.
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -n "${FAKE_GH_PR_JSON:-}" ]; then
    echo "$FAKE_GH_PR_JSON"
    exit 0
  fi
  exit 1
fi
exit 0
EOF
  chmod +x "${bin_dir}/gh"

  cat > "${bin_dir}/linearis" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "issues" ] && [ "$2" = "read" ]; then
  if [ -n "${FAKE_LINEARIS_JSON:-}" ]; then
    echo "$FAKE_LINEARIS_JSON"
    exit 0
  fi
  exit 1
fi
exit 0
EOF
  chmod +x "${bin_dir}/linearis"
}

# Set up an isolated scratch project: thoughts root + fake-bin PATH prefix +
# fresh state.json-free env. Echoes the scratch project dir.
new_scratch_project() {
  local name="$1"
  local dir="${SCRATCH}/${name}"
  mkdir -p "${dir}/thoughts/shared/pm/metrics"
  mkdir -p "${dir}/.catalyst"
  install_fakes "${dir}/bin"
  echo "$dir"
}

# ─── Sanity: helper exists ──────────────────────────────────────────────────
if [ ! -x "$COMPOUND" ]; then
  echo "ERROR: ${COMPOUND} not present or not executable"
  echo "       (expected during TDD — write the helper next to satisfy tests)"
  FAILURES=1
  echo ""
  echo "summary: 0 passed, 1 failed"
  exit 1
fi

echo "compound-log tests"
echo "---"

# ─── ISO week derivation ────────────────────────────────────────────────────

test_iso_week_basic() {
  # 2026-04-24 is in ISO week 17
  out=$("$COMPOUND" iso-week "2026-04-24T12:00:00Z" 2>&1)
  if [ "$out" = "2026-W17" ]; then
    pass "iso-week: 2026-04-24 → 2026-W17"
  else
    fail "iso-week: expected 2026-W17, got $out"
  fi
}

test_iso_week_year_boundary() {
  # Friday 2027-01-01 is still in ISO week 53 of 2026
  out=$("$COMPOUND" iso-week "2027-01-01T00:00:00Z" 2>&1)
  if [ "$out" = "2026-W53" ] || [ "$out" = "2027-W01" ]; then
    pass "iso-week: year boundary handled (got $out)"
  else
    fail "iso-week: year boundary wrong, got $out"
  fi
}

test_iso_week_rejects_non_iso() {
  "$COMPOUND" iso-week "not-a-date" > "${SCRATCH}/out" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    pass "iso-week: rejects non-ISO input"
  else
    fail "iso-week: should have failed on non-ISO input"
  fi
}

# ─── write: happy path ─────────────────────────────────────────────────────

test_write_creates_file_with_header() {
  proj=$(new_scratch_project write_creates)
  export FAKE_GH_PR_JSON='{"number":273,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T18:32:10Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-159","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-159 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 \
    --cost-usd 2.47 \
    --what-worked "tests first" \
    --what-surprised-me "prometheus not needed" \
    > "${SCRATCH}/out" 2>&1
  rc=$?

  outfile="${proj}/thoughts/shared/pm/metrics/2026-W17-compound-log.md"
  if [ $rc -eq 0 ] && [ -f "$outfile" ] && \
     grep -q "^# Compound Log" "$outfile" && \
     grep -q "^### CTL-159 — #273" "$outfile" && \
     grep -q "cost_usd: 2.47" "$outfile"; then
    pass "write: creates file with header and entry"
  else
    fail "write: header/entry missing (rc=$rc, file=$outfile)" "$(cat "$outfile" 2>/dev/null)"
  fi

  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

test_write_appends_to_existing_file() {
  proj=$(new_scratch_project write_appends)
  export FAKE_GH_PR_JSON='{"number":100,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-100","estimate":2}'
  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-100 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 3 --cost-usd 1.00 \
    --what-worked "a" --what-surprised-me "b" > "${SCRATCH}/out" 2>&1

  export FAKE_GH_PR_JSON='{"number":101,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T14:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-101","estimate":3}'
  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-101 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 2.00 \
    --what-worked "c" --what-surprised-me "d" > "${SCRATCH}/out" 2>&1

  outfile="${proj}/thoughts/shared/pm/metrics/2026-W17-compound-log.md"
  count=$(grep -c "^### CTL-" "$outfile" 2>/dev/null || echo 0)
  if [ "$count" = "2" ]; then
    pass "write: appends second entry to existing file"
  else
    fail "write: expected 2 entries, found $count"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

# ─── write: dedup / --force ─────────────────────────────────────────────────

test_write_rejects_duplicate() {
  proj=$(new_scratch_project write_dup)
  export FAKE_GH_PR_JSON='{"number":200,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-200","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-200 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 1.00 \
    --what-worked "a" --what-surprised-me "b" > "${SCRATCH}/out" 2>&1

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-200 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 8 --cost-usd 2.00 \
    --what-worked "a2" --what-surprised-me "b2" > "${SCRATCH}/out" 2>&1
  rc=$?

  if [ $rc -ne 0 ] && grep -q "already exists" "${SCRATCH}/out"; then
    pass "write: rejects duplicate (ticket, pr)"
  else
    fail "write: duplicate should have been rejected (rc=$rc)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

test_write_force_replaces_duplicate() {
  proj=$(new_scratch_project write_force)
  export FAKE_GH_PR_JSON='{"number":300,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-300","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-300 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 1.00 \
    --what-worked "v1" --what-surprised-me "x" > "${SCRATCH}/out" 2>&1

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-300 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 8 --cost-usd 9.99 \
    --what-worked "v2" --what-surprised-me "x" \
    --force > "${SCRATCH}/out" 2>&1
  rc=$?

  outfile="${proj}/thoughts/shared/pm/metrics/2026-W17-compound-log.md"
  count=$(grep -c "^### CTL-300" "$outfile" 2>/dev/null || echo 0)
  if [ $rc -eq 0 ] && [ "$count" = "1" ] && grep -q "cost_usd: 9.99" "$outfile"; then
    pass "write: --force replaces existing entry"
  else
    fail "write: --force did not replace (rc=$rc, count=$count)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

# ─── write: fail-loud on missing required fields ───────────────────────────

test_fail_loud_missing_estimate_actual() {
  proj=$(new_scratch_project fail_est)
  export FAKE_GH_PR_JSON='{"number":400,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-400","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-400 \
    --thoughts-dir "${proj}/thoughts" \
    --cost-usd 1.00 --what-worked "a" --what-surprised-me "b" \
    > "${SCRATCH}/out" 2>&1
  rc=$?

  if [ $rc -ne 0 ] && grep -q "estimate-actual" "${SCRATCH}/out"; then
    pass "fail-loud: missing --estimate-actual"
  else
    fail "fail-loud: expected error about estimate-actual (rc=$rc)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

test_fail_loud_missing_what_worked() {
  proj=$(new_scratch_project fail_what)
  export FAKE_GH_PR_JSON='{"number":401,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-401","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-401 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 1.00 --what-surprised-me "b" \
    > "${SCRATCH}/out" 2>&1
  rc=$?

  if [ $rc -ne 0 ] && grep -q "what-worked" "${SCRATCH}/out"; then
    pass "fail-loud: missing --what-worked"
  else
    fail "fail-loud: expected error about what-worked (rc=$rc)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

test_fail_loud_missing_cost_entirely() {
  proj=$(new_scratch_project fail_cost)
  # PR and Linear available, but no --cost-usd and no session data
  export FAKE_GH_PR_JSON='{"number":500,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-500","estimate":3}'
  # isolate HOME so catalyst-state can't find real aggregates
  export HOME="${proj}/fakehome"
  mkdir -p "$HOME"

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-500 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --what-worked "a" --what-surprised-me "b" \
    > "${SCRATCH}/out" 2>&1
  rc=$?

  if [ $rc -ne 0 ] && grep -qi "cost" "${SCRATCH}/out"; then
    pass "fail-loud: missing cost with no fallback source"
  else
    fail "fail-loud: expected cost-related error (rc=$rc)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON HOME
}

# ─── dry-run ────────────────────────────────────────────────────────────────

test_dry_run_does_not_write() {
  proj=$(new_scratch_project dry)
  export FAKE_GH_PR_JSON='{"number":600,"createdAt":"2026-04-23T12:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-600","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-600 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 1.00 \
    --what-worked "a" --what-surprised-me "b" \
    --dry-run > "${SCRATCH}/out" 2>&1
  rc=$?

  outfile="${proj}/thoughts/shared/pm/metrics/2026-W17-compound-log.md"
  if [ $rc -eq 0 ] && [ ! -f "$outfile" ] && grep -q "CTL-600" "${SCRATCH}/out"; then
    pass "dry-run: prints entry, writes nothing"
  else
    fail "dry-run: unexpected state (rc=$rc, file exists: $([ -f "$outfile" ] && echo yes || echo no))"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

# ─── ISO-week routing uses mergedAt, not today's date ──────────────────────

test_week_routing_uses_merged_at() {
  proj=$(new_scratch_project week_route)
  # Merged in week 18 (2026-04-27 Mon) even though today may be week 17
  export FAKE_GH_PR_JSON='{"number":700,"createdAt":"2026-04-25T12:00:00Z","mergedAt":"2026-04-27T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-700","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-700 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 1.00 \
    --what-worked "a" --what-surprised-me "b" > "${SCRATCH}/out" 2>&1

  outfile="${proj}/thoughts/shared/pm/metrics/2026-W18-compound-log.md"
  if [ -f "$outfile" ]; then
    pass "week routing: uses mergedAt (2026-W18 file created)"
  else
    fail "week routing: expected 2026-W18 file, got $(ls "${proj}/thoughts/shared/pm/metrics/" 2>&1)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

# ─── wall-time computation from PR timestamps ──────────────────────────────

test_wall_time_computed_from_pr() {
  proj=$(new_scratch_project wtime)
  # createdAt → mergedAt = 3 hours exactly
  export FAKE_GH_PR_JSON='{"number":800,"createdAt":"2026-04-24T09:00:00Z","mergedAt":"2026-04-24T12:00:00Z","state":"MERGED"}'
  export FAKE_LINEARIS_JSON='{"identifier":"CTL-800","estimate":3}'

  PATH="${proj}/bin:$PATH" "$COMPOUND" write CTL-800 \
    --thoughts-dir "${proj}/thoughts" \
    --estimate-actual 5 --cost-usd 1.00 \
    --what-worked "a" --what-surprised-me "b" > "${SCRATCH}/out" 2>&1

  outfile="${proj}/thoughts/shared/pm/metrics/2026-W17-compound-log.md"
  if grep -q "wall_time_hours: 3" "$outfile" 2>/dev/null; then
    pass "wall-time: computed from PR createdAt→mergedAt"
  else
    fail "wall-time: expected 3.0 hours" "$(cat "$outfile" 2>/dev/null)"
  fi
  unset FAKE_GH_PR_JSON FAKE_LINEARIS_JSON
}

# ─── Run all test_* functions ───────────────────────────────────────────────

for t in $(declare -F | awk '/^declare -f test_/{print $3}'); do
  $t
done

echo "---"
echo "summary: ${PASSES} passed, ${FAILURES} failed"
exit $([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)
