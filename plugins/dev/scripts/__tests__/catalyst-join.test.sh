#!/usr/bin/env bash
# Tests for catalyst-join.sh (CTL-1185).
# Run: bash plugins/dev/scripts/__tests__/catalyst-join.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
JOIN="${REPO_ROOT}/plugins/dev/scripts/catalyst-join.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1${2:+ — $2}"; }

run() {
  local name="$1"; shift
  if "$@" >"${SCRATCH}/out" 2>&1; then
    pass "$name"
  else
    fail "$name" "rc=$?"
    sed 's/^/    /' "${SCRATCH}/out"
  fi
}

expect_exit() {
  local expected="$1"; shift
  set +e; "$@" >"${SCRATCH}/out" 2>&1; local rc=$?; set -e
  if [[ "$rc" -eq "$expected" ]]; then return 0; fi
  echo "    expected rc=$expected got rc=$rc"
  sed 's/^/    /' "${SCRATCH}/out"
  return 1
}

expect_contains() {
  local needle="$1"
  if grep -qF -- "$needle" "${SCRATCH}/out"; then return 0; fi
  echo "    missing: $needle"
  sed 's/^/    /' "${SCRATCH}/out"
  return 1
}

expect_not_contains() {
  local needle="$1"
  if ! grep -qF -- "$needle" "${SCRATCH}/out"; then return 0; fi
  echo "    unexpected: $needle"
  return 1
}

# Build a minimal stub directory with stubbable provisioner scripts
make_stubs() {
  local dir="$1"
  mkdir -p "$dir"
  local log="${dir}/invocations.log"

  cat > "$dir/stub-setup-catalyst.sh" <<EOF
#!/usr/bin/env bash
echo "setup-catalyst CATALYST_AUTONOMOUS=\${CATALYST_AUTONOMOUS:-unset}" >> "$log"
exit 0
EOF
  chmod +x "$dir/stub-setup-catalyst.sh"

  cat > "$dir/stub-install-cli.sh" <<EOF
#!/usr/bin/env bash
echo "install-cli" >> "$log"
exit 0
EOF
  chmod +x "$dir/stub-install-cli.sh"

  cat > "$dir/stub-setup-plugin-source.sh" <<EOF
#!/usr/bin/env bash
echo "setup-plugin-source" >> "$log"
exit 0
EOF
  chmod +x "$dir/stub-setup-plugin-source.sh"

  cat > "$dir/stub-catalyst-stack" <<EOF
#!/usr/bin/env bash
echo "catalyst-stack \$*" >> "$log"
exit 0
EOF
  chmod +x "$dir/stub-catalyst-stack"

  cat > "$dir/stub-check-setup.sh" <<EOF
#!/usr/bin/env bash
echo "check-setup" >> "$log"
exit 0
EOF
  chmod +x "$dir/stub-check-setup.sh"

  # Reachability probe stub: success by default
  cat > "$dir/stub-reach-probe.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$dir/stub-reach-probe.sh"
}

# Run catalyst-join.sh with a fully-stubbed env (HOME + CATALYST_DIR redirected)
run_join() {
  local stub_dir="$1"; shift
  local scratch_home="${SCRATCH}/home_$$"
  mkdir -p "$scratch_home"
  env -i \
    HOME="$scratch_home" \
    CATALYST_DIR="${SCRATCH}/catalyst_$$" \
    PATH="${stub_dir}:${PATH}" \
    CATALYST_JOIN_SETUP_SCRIPT="${stub_dir}/stub-setup-catalyst.sh" \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT="${stub_dir}/stub-install-cli.sh" \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT="${stub_dir}/stub-setup-plugin-source.sh" \
    CATALYST_JOIN_STACK_BIN="${stub_dir}/stub-catalyst-stack" \
    CATALYST_JOIN_DOCTOR_SCRIPT="${stub_dir}/stub-check-setup.sh" \
    CATALYST_JOIN_REACH_PROBE="${stub_dir}/stub-reach-probe.sh" \
    CATALYST_JOIN_FETCH_CMD="${stub_dir}/stub-fetch.sh" \
    bash "$JOIN" "$@"
}

# ── Prerequisites ──────────────────────────────────────────────────────────────

echo "=== Prerequisites ==="

if [[ -f "$JOIN" ]]; then
  pass "catalyst-join.sh exists"
else
  fail "catalyst-join.sh exists" "not found at $JOIN"
fi

run "syntax check (bash -n)" bash -n "$JOIN"

# ── Phase 1: Skeleton — arg parsing, preflight, progress marker ────────────────

echo ""
echo "=== Phase 1: arg parsing, preflight, progress marker ==="

STUBS="${SCRATCH}/stubs1"
make_stubs "$STUBS"

# T1.1: --help exits 0 and prints usage with CATALYST_SEED doc
run "T1.1 --help exits 0 and documents CATALYST_SEED" bash -c "
  out=\$(bash '$JOIN' --help 2>&1)
  rc=\$?
  [[ \$rc -eq 0 ]] && echo \"\$out\" | grep -qF 'CATALYST_SEED'"

# T1.2: -h exits 0
run "T1.2 -h exits 0" bash "$JOIN" -h

# T1.3: missing token AND no --bundle → exits non-zero
run "T1.3 missing token exits non-zero" bash -c "
  s=\$(env -i HOME='${SCRATCH}/h13' CATALYST_DIR='${SCRATCH}/c13' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' 2>&1; echo rc=\$?)
  echo \"\$s\" | grep -q 'rc=[^0]'"

# T1.4: malformed token (not_a_token) → exits non-zero, no marker stage
run "T1.4 malformed token (not_a_token) rejected" bash -c "
  tmpcat='${SCRATCH}/c14'
  mkdir -p \"\$tmpcat/cluster\"
  env -i HOME='${SCRATCH}/h14' CATALYST_DIR=\"\$tmpcat\" \
    CATALYST_JOIN_TOKEN='not_a_token' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' >/dev/null 2>&1; ec=\$?
  [[ \$ec -ne 0 ]] && \
  ( [[ ! -f \"\$tmpcat/cluster/join-progress.json\" ]] || \
    ! jq -e '.completedStages | length > 0' \"\$tmpcat/cluster/join-progress.json\" >/dev/null 2>&1 )"

# T1.5: wrong-length token → exits non-zero
run "T1.5 wrong-length token rejected" bash -c "
  env -i HOME='${SCRATCH}/h15' CATALYST_DIR='${SCRATCH}/c15' \
    CATALYST_JOIN_TOKEN='jt_abc123' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' >/dev/null 2>&1; [[ \$? -ne 0 ]]"

# T1.6: non-hex token → exits non-zero
NONHEX_TOKEN="jt_$(printf 'Z%.0s' {1..64})"
run "T1.6 non-hex token rejected" bash -c "
  env -i HOME='${SCRATCH}/h16' CATALYST_DIR='${SCRATCH}/c16' \
    CATALYST_JOIN_TOKEN='$NONHEX_TOKEN' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' >/dev/null 2>&1; [[ \$? -ne 0 ]]"

# T1.7: well-formed token passes format validation (bundle mode, no network)
GOOD_TOKEN="jt_$(printf 'a%.0s' {1..64})"
FIXTURE_BUNDLE="${SCRATCH}/bundle.json"
cat > "$FIXTURE_BUNDLE" <<'BEOF'
{
  "layer1Identity": {"projectKey": "CTL", "teamKey": "T1", "stateMap": {}},
  "botCreds": {"orchestrator": "tok_orch", "worker": "tok_worker"},
  "hostsRoster": ["mini"],
  "livenessAnchorIssue": "CTL-1",
  "repoUrl": "https://github.com/example/repo",
  "pluginSourceUrl": "https://github.com/example/plugins"
}
BEOF
run "T1.7 well-formed token passes format validation" bash -c "
  env -i HOME='${SCRATCH}/h17' CATALYST_DIR='${SCRATCH}/c17' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    CATALYST_JOIN_FETCH_CMD='${STUBS}/stub-fetch.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1"

# T1.8: --bundle selects bundle mode; CATALYST_SEED not required
run "T1.8 --bundle mode does not require CATALYST_SEED" bash -c "
  env -i HOME='${SCRATCH}/h18' CATALYST_DIR='${SCRATCH}/c18' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1"

# T1.9: reachability probe failure → exits non-zero (non-bundle mode)
STUBS_NOREACH="${SCRATCH}/stubs_noreach"
make_stubs "$STUBS_NOREACH"
cat > "$STUBS_NOREACH/stub-reach-probe.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$STUBS_NOREACH/stub-reach-probe.sh"

run "T1.9 reachability failure exits non-zero" bash -c "
  env -i HOME='${SCRATCH}/h19' CATALYST_DIR='${SCRATCH}/c19' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS_NOREACH}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS_NOREACH}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS_NOREACH}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS_NOREACH}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS_NOREACH}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS_NOREACH}/stub-reach-probe.sh' \
    bash '$JOIN' >/dev/null 2>&1; [[ \$? -ne 0 ]]"

# T1.10: --bundle mode skips reachability probe
run "T1.10 --bundle skips reachability probe" bash -c "
  env -i HOME='${SCRATCH}/h110' CATALYST_DIR='${SCRATCH}/c110' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS_NOREACH}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS_NOREACH}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS_NOREACH}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS_NOREACH}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS_NOREACH}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS_NOREACH}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1"

# T1.11: progress marker round-trip
run "T1.11 progress marker created after successful run" bash -c "
  catdir='${SCRATCH}/c111'
  env -i HOME='${SCRATCH}/h111' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  marker=\"\$catdir/cluster/join-progress.json\"
  [[ -f \"\$marker\" ]] && \
  jq -e '.completedStages | type == \"array\"' \"\$marker\" >/dev/null && \
  jq -e '.startedAt | length > 0' \"\$marker\" >/dev/null"

# ── Phase 2: Bundle acquisition ────────────────────────────────────────────────

echo ""
echo "=== Phase 2: Bundle acquisition ==="

STUBS2="${SCRATCH}/stubs2"
make_stubs "$STUBS2"

# T2.1: --bundle with valid fixture → success, marker records bundlePath
run "T2.1 --bundle valid fixture succeeds" bash -c "
  catdir='${SCRATCH}/c21'
  env -i HOME='${SCRATCH}/h21' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1 && \
  jq -e '.bundlePath | length > 0' \"\$catdir/cluster/join-progress.json\" >/dev/null"

# T2.2: --bundle with malformed JSON (missing required keys) → exits non-zero
MALFORMED_BUNDLE="${SCRATCH}/malformed.json"
echo '{"layer1Identity": {"projectKey": "CTL"}}' > "$MALFORMED_BUNDLE"

run "T2.2 --bundle malformed bundle rejected" bash -c "
  env -i HOME='${SCRATCH}/h22' CATALYST_DIR='${SCRATCH}/c22' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$MALFORMED_BUNDLE' >/dev/null 2>&1; [[ \$? -ne 0 ]]"

# T2.3: Seed fetch via mock (CATALYST_JOIN_FETCH_CMD stub) → success
FETCH_STUB="${STUBS2}/stub-fetch.sh"
cat > "$FETCH_STUB" <<EOF
#!/usr/bin/env bash
cat '$FIXTURE_BUNDLE'
EOF
chmod +x "$FETCH_STUB"

run "T2.3 seed fetch via mock succeeds" bash -c "
  catdir='${SCRATCH}/c23'
  env -i HOME='${SCRATCH}/h23' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    CATALYST_JOIN_FETCH_CMD='$FETCH_STUB' \
    bash '$JOIN' >/dev/null 2>&1"

# T2.4: Token-consumed (fetch stub exits non-zero) → exits non-zero, prints re-mint command
CONSUMED_STUB="${STUBS2}/stub-fetch-consumed.sh"
cat > "$CONSUMED_STUB" <<'EOF'
#!/usr/bin/env bash
echo "HTTP 410 consumed" >&2
exit 1
EOF
chmod +x "$CONSUMED_STUB"

run "T2.4 consumed token prints re-mint command" bash -c "
  env -i HOME='${SCRATCH}/h24' CATALYST_DIR='${SCRATCH}/c24' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    CATALYST_JOIN_FETCH_CMD='$CONSUMED_STUB' \
    bash '$JOIN' 2>&1 | grep -q 'catalyst cluster join-token'"

# T2.5: --bundle mode does NOT call fetch stub
FETCH_TRACK="${STUBS2}/stub-fetch-track.sh"
FETCH_TRACK_LOG="${SCRATCH}/fetch-track.log"
cat > "$FETCH_TRACK" <<EOF
#!/usr/bin/env bash
echo "called" >> "$FETCH_TRACK_LOG"
cat '$FIXTURE_BUNDLE'
EOF
chmod +x "$FETCH_TRACK"

run "T2.5 --bundle mode does not call fetch stub" bash -c "
  rm -f '$FETCH_TRACK_LOG'
  env -i HOME='${SCRATCH}/h25' CATALYST_DIR='${SCRATCH}/c25' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    CATALYST_JOIN_FETCH_CMD='$FETCH_TRACK' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  [[ ! -f '$FETCH_TRACK_LOG' ]]"

# ── Phase 3: Provisioner orchestration ────────────────────────────────────────

echo ""
echo "=== Phase 3: Provisioner orchestration ==="

STUBS3="${SCRATCH}/stubs3"
make_stubs "$STUBS3"
INVLOG3="${STUBS3}/invocations.log"

# T3.1: Fresh run executes provisioners in order: setup-catalyst, install-cli, setup-plugin-source
run "T3.1 provisioners run in correct order" bash -c "
  catdir='${SCRATCH}/c31'
  rm -f '$INVLOG3'
  env -i HOME='${SCRATCH}/h31' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # Verify order: setup-catalyst before install-cli before setup-plugin-source
  grep -n 'setup-catalyst\|install-cli\|setup-plugin-source' '$INVLOG3' | \
    awk -F: '{print \$1, \$2}' | sort -n | \
    awk '{print \$2}' | tr '\n' ' ' | grep -q 'setup-catalyst.*install-cli.*setup-plugin-source'"

# T3.2: setup-catalyst invoked with CATALYST_AUTONOMOUS=1
run "T3.2 setup-catalyst invoked with CATALYST_AUTONOMOUS=1" bash -c "
  catdir='${SCRATCH}/c32'
  rm -f '$INVLOG3'
  env -i HOME='${SCRATCH}/h32' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  grep 'setup-catalyst' '$INVLOG3' | grep -q 'CATALYST_AUTONOMOUS=1'"

# T3.3: Resumability — pre-seed marker with setup-catalyst completed; re-run skips it
run "T3.3 resume skips already-completed stages" bash -c "
  catdir='${SCRATCH}/c33'
  mkdir -p \"\$catdir/cluster\"
  rm -f '$INVLOG3'
  # Pre-seed the marker
  printf '{\"completedStages\":[\"setup-catalyst\"],\"startedAt\":\"2026-01-01T00:00:00Z\",\"token\":\"$GOOD_TOKEN\"}' \
    > \"\$catdir/cluster/join-progress.json\"
  env -i HOME='${SCRATCH}/h33' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # setup-catalyst stub must NOT have been invoked this run
  ! grep -q 'setup-catalyst' '$INVLOG3'"

# T3.4: Provisioner failure → records failedStage, exits non-zero, does not run later provisioners
STUBS3F="${SCRATCH}/stubs3f"
make_stubs "$STUBS3F"
INVLOG3F="${STUBS3F}/invocations.log"
cat > "$STUBS3F/stub-install-cli.sh" <<EOF
#!/usr/bin/env bash
echo "install-cli" >> "$INVLOG3F"
exit 1
EOF
chmod +x "$STUBS3F/stub-install-cli.sh"

run "T3.4 provisioner failure records failedStage and exits non-zero" bash -c "
  catdir='${SCRATCH}/c34'
  rm -f '$INVLOG3F'
  env -i HOME='${SCRATCH}/h34' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3F}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3F}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3F}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3F}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3F}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3F}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1; ec=\$?
  [[ \$ec -ne 0 ]] && \
  jq -e '.failedStage == \"install-cli\"' \"\$catdir/cluster/join-progress.json\" >/dev/null && \
  ! grep -q 'setup-plugin-source' '$INVLOG3F'"

# T3.5: Re-run after failure resumes at the failed stage (skips completed, retries failed)
STUBS3R="${SCRATCH}/stubs3r"
make_stubs "$STUBS3R"
INVLOG3R="${STUBS3R}/invocations.log"

run "T3.5 re-run after failure resumes from failed stage" bash -c "
  catdir='${SCRATCH}/c35'
  mkdir -p \"\$catdir/cluster\"
  rm -f '$INVLOG3R'
  # Pre-seed: setup-catalyst done, install-cli failed
  printf '{\"completedStages\":[\"setup-catalyst\"],\"failedStage\":\"install-cli\",\"startedAt\":\"2026-01-01T00:00:00Z\",\"token\":\"$GOOD_TOKEN\"}' \
    > \"\$catdir/cluster/join-progress.json\"
  env -i HOME='${SCRATCH}/h35' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3R}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3R}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3R}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3R}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3R}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3R}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # setup-catalyst skipped, install-cli and later ran
  ! grep -q 'setup-catalyst' '$INVLOG3R' && \
  grep -q 'install-cli' '$INVLOG3R'"

# ── Phase 4: SHARED config merge, per-node items, doctor gate, SHADOW stop ────

echo ""
echo "=== Phase 4: Config merge, per-node items, doctor gate, SHADOW stop ==="

STUBS4="${SCRATCH}/stubs4"
make_stubs "$STUBS4"

# T4.1: Merge-preserve — existing node-local keys survive; SHARED bundle keys added
run "T4.1 merge-preserve: node-local keys survive" bash -c "
  catdir='${SCRATCH}/c41'
  home41='${SCRATCH}/h41'
  mkdir -p \"\$home41/.config/catalyst\"
  # Pre-existing Layer-2 with node-local keys
  printf '{\"catalyst\":{\"host\":{\"name\":\"testnode\"},\"otel\":{\"endpoint\":\"http://localhost:4317\"}}}' \
    > \"\$home41/.config/catalyst/config.json\"
  env -i HOME=\"\$home41\" CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS4}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS4}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS4}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS4}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS4}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS4}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  cfg=\"\$home41/.config/catalyst/config.json\"
  jq -e '.catalyst.otel.endpoint == \"http://localhost:4317\"' \"\$cfg\" >/dev/null && \
  jq -e '.catalyst.cluster.livenessAnchorIssue | length > 0' \"\$cfg\" >/dev/null"

# T4.2: host.name persisted explicitly
run "T4.2 host.name written to Layer-2 config" bash -c "
  catdir='${SCRATCH}/c42'
  home42='${SCRATCH}/h42'
  mkdir -p \"\$home42/.config/catalyst\"
  printf '{}' > \"\$home42/.config/catalyst/config.json\"
  env -i HOME=\"\$home42\" CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_HOST_NAME='mynode' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS4}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS4}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS4}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS4}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS4}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS4}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  jq -e '.catalyst.host.name == \"mynode\"' \"\$home42/.config/catalyst/config.json\" >/dev/null"

# T4.3: LOCAL hosts.json written; committed roster NOT touched
run "T4.3 local hosts.json written; committed roster untouched" bash -c "
  catdir='${SCRATCH}/c43'
  home43='${SCRATCH}/h43'
  mkdir -p \"\$home43/.config/catalyst\"
  printf '{}' > \"\$home43/.config/catalyst/config.json\"
  # Place a fake committed roster to check it's not modified
  roster='${SCRATCH}/committed-hosts.json'
  printf '[\"mini\"]' > \"\$roster\"
  orig_sum=\$(md5 -q \"\$roster\" 2>/dev/null || md5sum \"\$roster\" | cut -d' ' -f1)
  env -i HOME=\"\$home43\" CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_HOST_NAME='newnode' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS4}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS4}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS4}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS4}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS4}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS4}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # Local roster must exist
  local_roster=\"\$catdir/cluster/local-hosts.json\"
  [[ -f \"\$local_roster\" ]] && \
  jq -e 'type == \"array\" or type == \"object\"' \"\$local_roster\" >/dev/null && \
  # Committed roster must be unchanged
  new_sum=\$(md5 -q \"\$roster\" 2>/dev/null || md5sum \"\$roster\" | cut -d' ' -f1)
  [[ \"\$orig_sum\" == \"\$new_sum\" ]]"

# T4.4: Doctor gate failure → exits non-zero before catalyst-stack
STUBS4D="${SCRATCH}/stubs4d"
make_stubs "$STUBS4D"
INVLOG4D="${STUBS4D}/invocations.log"
cat > "$STUBS4D/stub-check-setup.sh" <<EOF
#!/usr/bin/env bash
echo "check-setup-fail" >> "$INVLOG4D"
exit 1
EOF
chmod +x "$STUBS4D/stub-check-setup.sh"

run "T4.4 doctor gate failure exits non-zero before stack install" bash -c "
  catdir='${SCRATCH}/c44'
  home44='${SCRATCH}/h44'
  mkdir -p \"\$home44/.config/catalyst\"
  printf '{}' > \"\$home44/.config/catalyst/config.json\"
  rm -f '$INVLOG4D'
  env -i HOME=\"\$home44\" CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS4D}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS4D}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS4D}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS4D}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS4D}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS4D}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1; [[ \$? -ne 0 ]] && \
  ! grep -q 'catalyst-stack install-services' '$INVLOG4D'"

# T4.5: catalyst-stack install-services runs AFTER config merge
STUBS4O="${SCRATCH}/stubs4o"
make_stubs "$STUBS4O"
INVLOG4O="${STUBS4O}/invocations.log"

run "T4.5 catalyst-stack install-services runs last" bash -c "
  catdir='${SCRATCH}/c45'
  home45='${SCRATCH}/h45'
  mkdir -p \"\$home45/.config/catalyst\"
  printf '{}' > \"\$home45/.config/catalyst/config.json\"
  rm -f '$INVLOG4O'
  env -i HOME=\"\$home45\" CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS4O}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS4O}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS4O}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS4O}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS4O}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS4O}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # stack install-services must be last in the log
  last=\$(tail -1 '$INVLOG4O')
  echo \"\$last\" | grep -q 'install-services'"

# T4.6: Idempotency — second run with same host.name produces identical config
run "T4.6 idempotency: second run is no-op" bash -c "
  catdir='${SCRATCH}/c46'
  home46='${SCRATCH}/h46'
  mkdir -p \"\$home46/.config/catalyst\"
  printf '{}' > \"\$home46/.config/catalyst/config.json\"
  base_env=\"HOME=\$home46 CATALYST_DIR=\$catdir CATALYST_JOIN_TOKEN=$GOOD_TOKEN CATALYST_HOST_NAME=testnode\"
  base_env+=' CATALYST_JOIN_SETUP_SCRIPT=${STUBS4}/stub-setup-catalyst.sh'
  base_env+=' CATALYST_JOIN_INSTALL_CLI_SCRIPT=${STUBS4}/stub-install-cli.sh'
  base_env+=' CATALYST_JOIN_PLUGIN_SRC_SCRIPT=${STUBS4}/stub-setup-plugin-source.sh'
  base_env+=' CATALYST_JOIN_STACK_BIN=${STUBS4}/stub-catalyst-stack'
  base_env+=' CATALYST_JOIN_DOCTOR_SCRIPT=${STUBS4}/stub-check-setup.sh'
  base_env+=' CATALYST_JOIN_REACH_PROBE=${STUBS4}/stub-reach-probe.sh'
  # Run 1
  env -i \$base_env bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  cfg=\"\$home46/.config/catalyst/config.json\"
  sum1=\$(md5 -q \"\$cfg\" 2>/dev/null || md5sum \"\$cfg\" | cut -d' ' -f1)
  # Run 2
  env -i \$base_env bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  sum2=\$(md5 -q \"\$cfg\" 2>/dev/null || md5sum \"\$cfg\" | cut -d' ' -f1)
  [[ \"\$sum1\" == \"\$sum2\" ]]"

# ── Summary ────────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
