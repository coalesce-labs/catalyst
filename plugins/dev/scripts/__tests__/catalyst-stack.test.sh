#!/usr/bin/env bash
# Shell tests for catalyst-stack (CTL-696).
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
REAL_PATH="$PATH"
# PATH without Homebrew, so mitmdump (/opt/homebrew/bin/mitmdump) is absent.
MINIMAL_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" = "$expected" ]]; then
    return 0
  else
    echo "    expected rc=$expected got rc=$rc"
    sed 's/^/    /' "${SCRATCH}/out"
    return 1
  fi
}

# Run catalyst-stack with a custom PATH (stubs first, real PATH appended so
# standard utilities like bash/sed/pgrep remain accessible).
run_stack() {
  local stub_dir="$1"; shift
  PATH="${stub_dir}:${REAL_PATH}" "${STACK}" "$@"
}

# ── Stub dirs ────────────────────────────────────────────────────────────────
make_stubs() {
  local dir="$1"
  mkdir -p "$dir"
  for svc in catalyst-broker catalyst-monitor; do
    cat > "$dir/$svc" <<'EOF'
#!/usr/bin/env bash
echo "running"; exit 0
EOF
    chmod +x "$dir/$svc"
  done
  cat > "$dir/catalyst-execution-core" <<'EOF'
#!/usr/bin/env bash
echo "running"; exit 0
EOF
  chmod +x "$dir/catalyst-execution-core"
  cat > "$dir/brew" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$dir/brew"
}

STUBDIR="${SCRATCH}/stubs"
make_stubs "$STUBDIR"
# mitmdump stub — records invocations
cat > "$STUBDIR/mitmdump" <<EOF
#!/usr/bin/env bash
touch "${STUBDIR}/mitmdump.called"
exit 0
EOF
chmod +x "$STUBDIR/mitmdump"

# stubs without mitmdump (simulate not installed)
STUBDIR_NO_MITM="${SCRATCH}/stubs_no_mitm"
make_stubs "$STUBDIR_NO_MITM"

# stubs where execution-core reports "stopped"
STUBDIR_STOPPED="${SCRATCH}/stubs_stopped"
make_stubs "$STUBDIR_STOPPED"
cat > "$STUBDIR_STOPPED/catalyst-execution-core" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  status) echo "stopped" ;;
  *) echo "running" ;;
esac
exit 0
EOF
chmod +x "$STUBDIR_STOPPED/catalyst-execution-core"

# stubs where execution-core reports "running" (for live-stack check)
STUBDIR_LIVE="${SCRATCH}/stubs_live"
make_stubs "$STUBDIR_LIVE"

# ── Phase 1 tests ─────────────────────────────────────────────────────────────

echo "catalyst-stack tests"

run "catalyst-stack is vendored and executable" bash -c "[[ -x '${STACK}' ]]"

run "help exits 0 and documents --proxy as opt-in" \
  bash -c "PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' --help 2>&1 | grep -q -- '--proxy'"

run "default start does not invoke mitmdump" bash -c "
  rm -f '${STUBDIR}/mitmdump.called'
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' start >/dev/null 2>&1
  [[ ! -f '${STUBDIR}/mitmdump.called' ]]
"

run "--no-proxy is accepted as a no-op (exit 0)" bash -c "
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' start --no-proxy >/dev/null 2>&1
"

run "--no-proxy does not invoke mitmdump" bash -c "
  rm -f '${STUBDIR}/mitmdump.called'
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' start --no-proxy >/dev/null 2>&1
  [[ ! -f '${STUBDIR}/mitmdump.called' ]]
"

run "--proxy missing mitmdump declined exits non-zero" bash -c "
  set +e
  out=\$(printf 'n\n' | PATH='${STUBDIR_NO_MITM}:${MINIMAL_PATH}' '${STACK}' start --proxy 2>&1)
  rc=\$?
  set -e
  [[ \$rc -ne 0 ]] && echo \"\$out\" | grep -qi mitmproxy
"

run "unknown arg fails with exit 1" bash -c "
  set +e
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' start --bogus >/dev/null 2>&1
  rc=\$?
  set -e
  [[ \$rc -ne 0 ]]
"

run "status lists execution-core" bash -c "
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' status 2>&1 | grep -q execution-core
"

run "stop exits 0" bash -c "
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' stop >/dev/null 2>&1
"

run "restart exits 0" bash -c "
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' restart >/dev/null 2>&1
"

# CTL-1107: restart with no args must not crash on empty-array expansion under
# bash 3.2 (macOS system shell). The plain "restart exits 0" test above passes
# on bash 5.x regardless, so pin the system bash explicitly to guard the fix.
if [[ -x /bin/bash ]]; then
  run "restart exits 0 under system bash (3.2)" /bin/bash -c "
    set +e
    PATH='${STUBDIR}:${REAL_PATH}' /bin/bash '${STACK}' restart >'${SCRATCH}/sysbash.out' 2>&1
    rc=\$?
    set -e
    if [[ \$rc -ne 0 ]]; then
      echo 'restart crashed under system bash:'; cat '${SCRATCH}/sysbash.out'
      exit 1
    fi
    if grep -q 'unbound variable' '${SCRATCH}/sysbash.out'; then
      echo 'restart emitted unbound-variable error:'; cat '${SCRATCH}/sysbash.out'
      exit 1
    fi
  "
else
  echo "  SKIP: /bin/bash not present — cannot pin bash 3.2 regression"
fi

# ── CTL-946: proxy env-injection assertions ───────────────────────────────────
# A stub that records its env to a file, so we can assert what the daemon sees.

STUBDIR_ENVLOG="${SCRATCH}/stubs_envlog"
make_stubs "$STUBDIR_ENVLOG"
# Overwrite execution-core stub: report stopped on status (so start_daemon proceeds),
# then log env on any other invocation (start) and succeed.
cat > "$STUBDIR_ENVLOG/catalyst-execution-core" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  status) echo "stopped"; exit 0 ;;
  *) env > "${SCRATCH}/daemon.env"; echo "running"; exit 0 ;;
esac
EOF
chmod +x "$STUBDIR_ENVLOG/catalyst-execution-core"
# Provide mitmdump so --proxy can proceed (pgrep won't find it running, so start proceeds).
cat > "$STUBDIR_ENVLOG/mitmdump" <<EOF
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$STUBDIR_ENVLOG/mitmdump"
# Fake CA cert so the CA-missing guard doesn't block.
mkdir -p "${SCRATCH}/fake_mitm_home/.mitmproxy"
touch "${SCRATCH}/fake_mitm_home/.mitmproxy/mitmproxy-ca-cert.pem"
# Fake mitm_linear_addon.py (catalyst-stack copies from vendored if not at MITM_ADDON).
mkdir -p "${SCRATCH}/fake_mitm_home/catalyst"
touch "${SCRATCH}/fake_mitm_home/catalyst/mitm_linear_addon.py"

run "default start injects no HTTPS_PROXY into daemon env (CTL-946)" bash -c "
  rm -f '${SCRATCH}/daemon.env'
  PATH='${STUBDIR_ENVLOG}:${REAL_PATH}' \
    HOME='${SCRATCH}/fake_mitm_home' \
    '${STACK}' start >/dev/null 2>&1 || true
  # HTTPS_PROXY must be absent from the env the daemon process sees
  ! grep -q '^HTTPS_PROXY=' '${SCRATCH}/daemon.env' 2>/dev/null
"

run "--proxy start injects HTTPS_PROXY into daemon env (CTL-946)" bash -c "
  rm -f '${SCRATCH}/daemon.env'
  HOME='${SCRATCH}/fake_mitm_home' \
    PATH='${STUBDIR_ENVLOG}:${REAL_PATH}' \
    '${STACK}' start --proxy >/dev/null 2>&1 || true
  grep -q '^HTTPS_PROXY=' '${SCRATCH}/daemon.env' 2>/dev/null
"

run "--proxy start injects NO_PROXY with anthropic.com into daemon env (CTL-946)" bash -c "
  grep -q 'anthropic\.com' '${SCRATCH}/daemon.env' 2>/dev/null
"

# ── Addon portability tests ───────────────────────────────────────────────────

ADDON="${REPO_ROOT}/plugins/dev/scripts/mitm_linear_addon.py"

run "vendored addon exists" bash -c "[[ -f '${ADDON}' ]]"

run "vendored addon has no hardcoded /Users/ryan LOG path" bash -c "
  ! grep -qF '\"/Users/ryan/catalyst/linear-proxy.jsonl\"' '${ADDON}'
"

run "vendored addon resolves LOG portably" bash -c "
  grep -Eq 'expanduser|MITM_LOG|environ' '${ADDON}'
"

run "vendored addon parses as valid python3" bash -c "
  python3 -c \"import ast; ast.parse(open('${ADDON}').read())\"
"

# ── Phase 2: --hotpatch tests ─────────────────────────────────────────────────

FAKE_REPO="${SCRATCH}/fake_repo"
mkdir -p "${FAKE_REPO}/.git" "${FAKE_REPO}/plugins/dev"
FAKE_CACHE="${SCRATCH}/fake_home/.claude/plugins/cache/catalyst/catalyst-dev/1.0.0"
mkdir -p "${FAKE_CACHE}"

STUBDIR2="${SCRATCH}/stubs2"
make_stubs "$STUBDIR2"
# execution-core reports stopped so start proceeds
cat > "$STUBDIR2/catalyst-execution-core" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  status) echo "stopped" ;;
  *) echo "running" ;;
esac
exit 0
EOF
chmod +x "$STUBDIR2/catalyst-execution-core"

# git stub: records args, succeeds
cat > "$STUBDIR2/git" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/git.args"
exit 0
EOF
chmod +x "$STUBDIR2/git"

# rsync stub: records args, succeeds
cat > "$STUBDIR2/rsync" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/rsync.args"
exit 0
EOF
chmod +x "$STUBDIR2/rsync"

run "restart --hotpatch calls git pull --ff-only" bash -c "
  rm -f '${SCRATCH}/git.args' '${SCRATCH}/rsync.args'
  PATH='${STUBDIR2}:${REAL_PATH}' \
    CATALYST_REPO_DIR='${FAKE_REPO}' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' restart --hotpatch >/dev/null 2>&1
  grep -q 'pull --ff-only' '${SCRATCH}/git.args'
"

run "restart --hotpatch calls rsync with -ac" bash -c "
  grep -q -- '-ac' '${SCRATCH}/rsync.args'
"

run "hotpatch rsync never uses --delete" bash -c "
  ! grep -q -- '--delete' '${SCRATCH}/rsync.args'
"

run "hotpatch rsync excludes node_modules" bash -c "
  grep -q 'node_modules' '${SCRATCH}/rsync.args'
"

run "hotpatch rsync targets catalyst-dev in destination" bash -c "
  grep -q 'catalyst-dev' '${SCRATCH}/rsync.args'
"

# git fail stubs
STUBDIR_GITFAIL="${SCRATCH}/stubs_gitfail"
make_stubs "$STUBDIR_GITFAIL"
cp "$STUBDIR2/catalyst-execution-core" "$STUBDIR_GITFAIL/catalyst-execution-core"
cat > "$STUBDIR_GITFAIL/git" <<EOF
#!/usr/bin/env bash
if echo "\$@" | grep -q "ff-only"; then exit 1; fi
echo "\$@" >> "${SCRATCH}/git_gitfail.args"
exit 0
EOF
chmod +x "$STUBDIR_GITFAIL/git"
cat > "$STUBDIR_GITFAIL/rsync" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/rsync_gitfail.args"
exit 0
EOF
chmod +x "$STUBDIR_GITFAIL/rsync"

run "hotpatch aborts on non-ff pull before rsync" bash -c "
  rm -f '${SCRATCH}/rsync_gitfail.args'
  set +e
  PATH='${STUBDIR_GITFAIL}:${REAL_PATH}' \
    CATALYST_REPO_DIR='${FAKE_REPO}' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' restart --hotpatch >/dev/null 2>&1
  rc=\$?
  set -e
  [[ \$rc -ne 0 ]] && [[ ! -f '${SCRATCH}/rsync_gitfail.args' ]]
"

run "start --hotpatch on live stack refuses with restart message" bash -c "
  PATH='${STUBDIR_LIVE}:${REAL_PATH}' \
    CATALYST_REPO_DIR='${FAKE_REPO}' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' start --hotpatch 2>&1 | grep -qi 'restart'
"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "catalyst-stack: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
