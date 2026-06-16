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

  # CTL-1214 (PATH-B #6): provision-thoughts is a new pre-setup-catalyst stage.
  # Stub it (mirror of setup-plugin-source) so the real provision-thoughts.sh
  # never runs and aborts the hermetic flow.
  cat > "$dir/stub-provision-thoughts.sh" <<EOF
#!/usr/bin/env bash
echo "provision-thoughts" >> "$log"
exit 0
EOF
  chmod +x "$dir/stub-provision-thoughts.sh"

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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT="${stub_dir}/stub-provision-thoughts.sh" \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS_NOREACH}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS_NOREACH}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  marker=\"\$catdir/cluster/join-progress.json\"
  [[ -f \"\$marker\" ]] && \
  jq -e '.completedStages | type == \"array\"' \"\$marker\" >/dev/null && \
  jq -e '.startedAt | length > 0' \"\$marker\" >/dev/null"

# T1.12: (PATH-B #2) DEFAULT preflight (no CATALYST_JOIN_REACH_PROBE override) with the
# `tailscale` CLI absent from PATH falls back to the nc/curl TCP probe:
#  - a reachable local TCP port → preflight SUCCEEDS (join proceeds, fails later in a
#    benign stage; we assert it gets PAST preflight, i.e. no reachability fail message)
#  - a CLOSED port → preflight FAILS (non-zero, with the reachability fail message)
# PATH is /usr/bin:/bin so nc/curl/jq/bash resolve but `tailscale` does NOT (not installed).
# A throwaway `nc -l` listener provides the open port; an unbound port provides the closed case.
T112_PATH="/usr/bin:/bin"
if command -v nc >/dev/null 2>&1; then
  # Pick a high port unlikely to be in use; bind a one-shot listener to it.
  T112_PORT=53999
  # Open-port case: background keep-open (-k) listener so the readiness probe and the
  # script's own preflight probe both find the port bound (a plain `nc -l` accepts a
  # SINGLE connection and exits, so the readiness check would consume it).
  ( nc -k -l 127.0.0.1 "$T112_PORT" >/dev/null 2>&1 ) &
  T112_LPID=$!
  # Give the listener a moment to bind (no foreground sleep allowed by harness rules;
  # use a short bounded wait loop on the port becoming connectable).
  T112_READY=0
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    if nc -z -G 1 127.0.0.1 "$T112_PORT" >/dev/null 2>&1; then T112_READY=1; break; fi
  done

  run "T1.12 default preflight succeeds via nc/curl fallback (tailscale absent, port open)" bash -c "
    [[ '$T112_READY' -eq 1 ]] || { echo 'listener never came up'; exit 1; }
    out=\$(env -i HOME='${SCRATCH}/h112' CATALYST_DIR='${SCRATCH}/c112' \
      PATH='$T112_PATH' \
      CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
      CATALYST_SEED='127.0.0.1:$T112_PORT' \
      CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
      CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
      CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
      CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
      CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
      CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
      bash '$JOIN' 2>&1)
    # The default preflight must NOT emit a reachability/port failure. (The run may
    # later stop in another stage; we only assert preflight passed.)
    ! echo \"\$out\" | grep -qiE 'not reachable|Tailscale ping'"

  # Reap the listener if it's still alive.
  kill "$T112_LPID" >/dev/null 2>&1 || true
  wait "$T112_LPID" 2>/dev/null || true

  # Closed-port case: a port with nothing bound → preflight must FAIL.
  T112_CLOSED_PORT=53997
  run "T1.12b default preflight fails when port is closed (nc/curl fallback, tailscale absent)" bash -c "
    out=\$(env -i HOME='${SCRATCH}/h112b' CATALYST_DIR='${SCRATCH}/c112b' \
      PATH='$T112_PATH' \
      CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
      CATALYST_SEED='127.0.0.1:$T112_CLOSED_PORT' \
      CATALYST_JOIN_SETUP_SCRIPT='${STUBS}/stub-setup-catalyst.sh' \
      CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS}/stub-install-cli.sh' \
      CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS}/stub-setup-plugin-source.sh' \
      CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS}/stub-provision-thoughts.sh' \
      CATALYST_JOIN_STACK_BIN='${STUBS}/stub-catalyst-stack' \
      CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS}/stub-check-setup.sh' \
      bash '$JOIN' 2>&1); ec=\$?
    [[ \$ec -ne 0 ]] && echo \"\$out\" | grep -qiE 'not reachable'"
else
  fail "T1.12 default preflight nc/curl fallback" "nc not available to build the local listener"
  fail "T1.12b default preflight closed-port fallback" "nc not available"
fi

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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    CATALYST_JOIN_FETCH_CMD='$FETCH_TRACK' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  [[ ! -f '$FETCH_TRACK_LOG' ]]"

# T2.6: (PATH-B #1) seed-fetch bundle_url path ends in /join-bundle AND that literal
# matches JOIN_ROUTE in execution-core/join-listener.mjs. Two assertions:
#  (a) runtime: the fetch stub receives a URL ending in /join-bundle as $1, and
#  (b) contract: the .sh literal and the .mjs JOIN_ROUTE literal are byte-identical.
JOIN_LISTENER="${REPO_ROOT}/plugins/dev/scripts/execution-core/join-listener.mjs"
URL_CAPTURE="${SCRATCH}/t26-url.log"
URL_STUB="${STUBS2}/stub-fetch-url.sh"
cat > "$URL_STUB" <<EOF
#!/usr/bin/env bash
echo "\$1" > "$URL_CAPTURE"
cat '$FIXTURE_BUNDLE'
EOF
chmod +x "$URL_STUB"

run "T2.6 seed-fetch bundle_url ends in /join-bundle and matches JOIN_ROUTE" bash -c "
  rm -f '$URL_CAPTURE'
  env -i HOME='${SCRATCH}/h26' CATALYST_DIR='${SCRATCH}/c26' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_SEED='mini:7400' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    CATALYST_JOIN_FETCH_CMD='$URL_STUB' \
    bash '$JOIN' >/dev/null 2>&1
  # (a) runtime URL the seed-fetch built ends in /join-bundle
  [[ -f '$URL_CAPTURE' ]] && grep -qE '/join-bundle\$' '$URL_CAPTURE' && \
  # (b) the catalyst-join.sh literal is /join-bundle (PATH-B #1, not the old /bundle)
  grep -qF 'bundle_url=\"http://\${host}:\${port}/join-bundle\"' '$JOIN' && \
  # (c) join-listener.mjs JOIN_ROUTE is exactly \"/join-bundle\" — the contract both sides pin
  grep -qE 'JOIN_ROUTE\s*=\s*\"/join-bundle\"' '$JOIN_LISTENER'"

# T2.7: (PATH-B #4) a bundle whose .livenessAnchorIssue is literal null (all other
# required keys present) is ACCEPTED — validate_bundle asserts key EXISTENCE, not
# truthiness. A STRUCTURALLY-missing key still fails.
NULL_ANCHOR_BUNDLE="${SCRATCH}/null-anchor.json"
cat > "$NULL_ANCHOR_BUNDLE" <<'BEOF'
{
  "layer1Identity": {"projectKey": "CTL", "teamKey": "T1", "stateMap": {}},
  "botCreds": {"orchestrator": "tok_orch", "worker": "tok_worker"},
  "hostsRoster": ["mini"],
  "livenessAnchorIssue": null,
  "repoUrl": "https://github.com/example/repo",
  "pluginSourceUrl": "https://github.com/example/plugins"
}
BEOF

run "T2.7 null-valued required key (livenessAnchorIssue=null) is accepted" bash -c "
  env -i HOME='${SCRATCH}/h27' CATALYST_DIR='${SCRATCH}/c27' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$NULL_ANCHOR_BUNDLE' >/dev/null 2>&1"

# T2.7b: a structurally-MISSING required key (.livenessAnchorIssue absent entirely)
# still fails — confirms the existence assertion didn't become a no-op.
MISSING_ANCHOR_BUNDLE="${SCRATCH}/missing-anchor.json"
cat > "$MISSING_ANCHOR_BUNDLE" <<'BEOF'
{
  "layer1Identity": {"projectKey": "CTL", "teamKey": "T1", "stateMap": {}},
  "botCreds": {"orchestrator": "tok_orch", "worker": "tok_worker"},
  "hostsRoster": ["mini"],
  "repoUrl": "https://github.com/example/repo",
  "pluginSourceUrl": "https://github.com/example/plugins"
}
BEOF

run "T2.7b structurally-missing required key still rejected" bash -c "
  env -i HOME='${SCRATCH}/h27b' CATALYST_DIR='${SCRATCH}/c27b' \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS2}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS2}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS2}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS2}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS2}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS2}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS2}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$MISSING_ANCHOR_BUNDLE' >/dev/null 2>&1; [[ \$? -ne 0 ]]"

# ── Phase 3: Provisioner orchestration ────────────────────────────────────────

echo ""
echo "=== Phase 3: Provisioner orchestration ==="

STUBS3="${SCRATCH}/stubs3"
make_stubs "$STUBS3"
INVLOG3="${STUBS3}/invocations.log"

# T3.1: Fresh run executes provisioners in order: provision-thoughts, setup-catalyst,
# install-cli, setup-plugin-source. (github-auth runs first but logs nothing when
# gh is absent from the env -i PATH — do_github_auth returns 0 with no invocation.)
run "T3.1 provisioners run in correct order" bash -c "
  catdir='${SCRATCH}/c31'
  rm -f '$INVLOG3'
  env -i HOME='${SCRATCH}/h31' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS3}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # Verify order: provision-thoughts before setup-catalyst before install-cli
  # before setup-plugin-source. The grep alternation pins each provisioner's
  # first log line; their stable order in invocations.log is the assertion.
  grep -n 'provision-thoughts\|setup-catalyst\|install-cli\|setup-plugin-source' '$INVLOG3' | \
    awk -F: '{print \$1, \$2}' | sort -n | \
    awk '{print \$2}' | tr '\n' ' ' | \
    grep -q 'provision-thoughts.*setup-catalyst.*install-cli.*setup-plugin-source'"

# T3.2: setup-catalyst invoked with CATALYST_AUTONOMOUS=1
run "T3.2 setup-catalyst invoked with CATALYST_AUTONOMOUS=1" bash -c "
  catdir='${SCRATCH}/c32'
  rm -f '$INVLOG3'
  env -i HOME='${SCRATCH}/h32' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS3}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS3}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS3}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS3}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS3}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS3F}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS3R}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS3R}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS3R}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS3R}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # setup-catalyst skipped, install-cli and later ran
  ! grep -q 'setup-catalyst' '$INVLOG3R' && \
  grep -q 'install-cli' '$INVLOG3R'"

# T3.6: (PATH-B #6 wiring) the provision-thoughts stage is invoked (appears in
# invocations.log) AND runs BEFORE setup-catalyst — setup-catalyst's thoughts-init
# binds the checkout to the repos provision-thoughts cloned, so order matters.
STUBS36="${SCRATCH}/stubs36"
make_stubs "$STUBS36"
INVLOG36="${STUBS36}/invocations.log"

run "T3.6 provision-thoughts invoked and runs before setup-catalyst" bash -c "
  catdir='${SCRATCH}/c36'
  rm -f '$INVLOG36'
  env -i HOME='${SCRATCH}/h36' CATALYST_DIR=\"\$catdir\" \
    CATALYST_JOIN_TOKEN='$GOOD_TOKEN' \
    CATALYST_JOIN_SETUP_SCRIPT='${STUBS36}/stub-setup-catalyst.sh' \
    CATALYST_JOIN_INSTALL_CLI_SCRIPT='${STUBS36}/stub-install-cli.sh' \
    CATALYST_JOIN_PLUGIN_SRC_SCRIPT='${STUBS36}/stub-setup-plugin-source.sh' \
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS36}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS36}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS36}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS36}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # (a) provision-thoughts ran at all
  grep -q 'provision-thoughts' '$INVLOG36' && \
  # (b) its log line precedes setup-catalyst's (lower line number)
  pt_line=\$(grep -n 'provision-thoughts' '$INVLOG36' | head -1 | cut -d: -f1) && \
  sc_line=\$(grep -n 'setup-catalyst' '$INVLOG36' | head -1 | cut -d: -f1) && \
  [[ -n \"\$pt_line\" && -n \"\$sc_line\" && \"\$pt_line\" -lt \"\$sc_line\" ]]"

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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS4}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS4}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS4}/stub-provision-thoughts.sh' \
    CATALYST_JOIN_STACK_BIN='${STUBS4}/stub-catalyst-stack' \
    CATALYST_JOIN_DOCTOR_SCRIPT='${STUBS4}/stub-check-setup.sh' \
    CATALYST_JOIN_REACH_PROBE='${STUBS4}/stub-reach-probe.sh' \
    bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  # Local roster must exist AND contain exactly the host name — a content
  # assertion (not just type), so a polluted multi-line roster value fails here
  # (CTL-1185 remediate: this is the test that lets the HIGH roster bug through).
  local_roster=\"\$catdir/cluster/local-hosts.json\"
  [[ -f \"\$local_roster\" ]] && \
  jq -e '. == [\"newnode\"]' \"\$local_roster\" >/dev/null && \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS4D}/stub-provision-thoughts.sh' \
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
    CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT='${STUBS4O}/stub-provision-thoughts.sh' \
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
  base_env+=' CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT=${STUBS4}/stub-provision-thoughts.sh'
  base_env+=' CATALYST_JOIN_STACK_BIN=${STUBS4}/stub-catalyst-stack'
  base_env+=' CATALYST_JOIN_DOCTOR_SCRIPT=${STUBS4}/stub-check-setup.sh'
  base_env+=' CATALYST_JOIN_REACH_PROBE=${STUBS4}/stub-reach-probe.sh'
  # Run 1
  env -i \$base_env bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  cfg=\"\$home46/.config/catalyst/config.json\"
  roster=\"\$catdir/cluster/local-hosts.json\"
  sum1=\$(md5 -q \"\$cfg\" 2>/dev/null || md5sum \"\$cfg\" | cut -d' ' -f1)
  rsum1=\$(md5 -q \"\$roster\" 2>/dev/null || md5sum \"\$roster\" | cut -d' ' -f1)
  # Run 2
  env -i \$base_env bash '$JOIN' --bundle '$FIXTURE_BUNDLE' >/dev/null 2>&1
  sum2=\$(md5 -q \"\$cfg\" 2>/dev/null || md5sum \"\$cfg\" | cut -d' ' -f1)
  rsum2=\$(md5 -q \"\$roster\" 2>/dev/null || md5sum \"\$roster\" | cut -d' ' -f1)
  # CTL-1185 remediate: config AND roster must both be byte-identical across runs,
  # and the roster must still be exactly [host] (not a duplicated/polluted value).
  [[ \"\$sum1\" == \"\$sum2\" ]] && [[ \"\$rsum1\" == \"\$rsum2\" ]] && \
  jq -e '. == [\"testnode\"]' \"\$roster\" >/dev/null"

# ── Summary ────────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
