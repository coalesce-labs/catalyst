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

# CAT-264: snapshot the operator's real runtime before any test runs. The final
# assertion makes hermeticity self-enforcing when future start/stop cases land.
_live_runtime_fingerprint() {
  local marker="${HOME}/catalyst/stack-halt.json"
  if [[ -e "$marker" ]]; then
    stat -f '%m:%z' "$marker" 2>/dev/null || stat -c '%Y:%s' "$marker" 2>/dev/null || echo unreadable
  else
    echo absent
  fi
}
export -f _live_runtime_fingerprint
LIVE_MARKER_SNAPSHOT="${SCRATCH}/live-runtime.snapshot"
_live_runtime_fingerprint > "$LIVE_MARKER_SNAPSHOT"

# CAT-264: every start/stop/restart case invokes the real catalyst-stack, which
# post-CAT-163 writes or clears the operator halt marker, appends unified events,
# and may stop runtime processes under ${CATALYST_DIR:-$HOME/catalyst}. Scope the
# entire suite once so future cases inherit the same hermetic boundary.
export CATALYST_DIR="${SCRATCH}/catalyst"
mkdir -p "${CATALYST_DIR}"

# Keep --print fixtures outside linked worktrees/temp roots so the CTL-1473
# production guard does not mask host-name rendering assertions, without
# littering the live $HOME/catalyst runtime directory.
BAKE_ROOT="${CATALYST_STACK_TEST_BAKE_ROOT:-${HOME}/.cache/catalyst-stack-tests}"
mkdir -p "${BAKE_ROOT}"
BAKE="$(mktemp -d "${BAKE_ROOT}/bake.XXXXXX")"
mkdir -p "${BAKE}/log-shipper"
cp "${REPO_ROOT}/plugins/dev/scripts/log-shipper/config.alloy" "${BAKE}/log-shipper/config.alloy"
trap 'rm -rf "$SCRATCH" "$BAKE"' EXIT

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

# CTL-1494: status must inventory the coordination-publish daemon. With no
# CATALYST_COORDINATION_MODE set (default off) the line reads
# 'coordination     off (inert)'; must remain green even with no bun on PATH
# (coordination_mode falls back to off).
run "status lists coordination" bash -c "
  PATH='${STUBDIR}:${REAL_PATH}' '${STACK}' status 2>&1 | grep -q coordination
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

# git stub: records args and models the one-checkout hotpatch preflight.
cat > "$STUBDIR2/git" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/git.args"
case "\$*" in
  *"rev-parse --show-toplevel"*) echo "${FAKE_REPO}" ;;
  *"status --porcelain"*) [[ "\${GIT_MODE:-}" == dirty ]] && echo ' M dirty-file' ;;
  *"rev-list --count origin/main..HEAD"*) [[ "\${GIT_MODE:-}" == ahead ]] && echo 1 || echo 0 ;;
  *"rev-list --count HEAD..origin/main"*) echo 1 ;;
  *"rev-parse HEAD"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
esac
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

run "hotpatch (one-checkout): restart --hotpatch calls git pull --ff-only" bash -c "
  rm -f '${SCRATCH}/git.args' '${SCRATCH}/rsync.args'
  PATH='${STUBDIR2}:${REAL_PATH}' \
    CATALYST_PLUGIN_DIRS='${FAKE_REPO}/plugins/dev' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' restart --hotpatch >/dev/null 2>&1
  grep -q 'fetch -q origin main' '${SCRATCH}/git.args' &&
  grep -q 'pull --ff-only' '${SCRATCH}/git.args' &&
  [[ ! -f '${SCRATCH}/rsync.args' ]]
"

run "hotpatch (--legacy-rsync): calls rsync with -ac" bash -c "
  rm -f '${SCRATCH}/git.args' '${SCRATCH}/rsync.args' '${SCRATCH}/legacy.err'
  PATH='${STUBDIR2}:${REAL_PATH}' \
    CATALYST_REPO_DIR='${FAKE_REPO}' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' hotpatch --legacy-rsync >/dev/null 2>'${SCRATCH}/legacy.err'
  grep -q -- '-ac' '${SCRATCH}/rsync.args'
"

run "hotpatch (--legacy-rsync): warns that the path is deprecated" bash -c "
  grep -qi 'deprecated' '${SCRATCH}/legacy.err'
"

run "hotpatch (--legacy-rsync): rsync never uses --delete" bash -c "
  [[ -f '${SCRATCH}/rsync.args' ]] && ! grep -q -- '--delete' '${SCRATCH}/rsync.args'
"

run "hotpatch (--legacy-rsync): rsync excludes node_modules" bash -c "
  grep -q 'node_modules' '${SCRATCH}/rsync.args'
"

run "hotpatch (--legacy-rsync): rsync targets catalyst-dev in destination" bash -c "
  grep -q 'catalyst-dev' '${SCRATCH}/rsync.args'
"

# git fail stubs
STUBDIR_GITFAIL="${SCRATCH}/stubs_gitfail"
make_stubs "$STUBDIR_GITFAIL"
cp "$STUBDIR2/catalyst-execution-core" "$STUBDIR_GITFAIL/catalyst-execution-core"
cat > "$STUBDIR_GITFAIL/git" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/git_gitfail.args"
case "\$*" in
  *"rev-parse --show-toplevel"*) echo "${FAKE_REPO}" ;;
  *"status --porcelain"*) ;;
  *"rev-list --count origin/main..HEAD"*) echo 0 ;;
  *"rev-list --count HEAD..origin/main"*) echo 1 ;;
  *"rev-parse HEAD"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *"pull --ff-only"*) exit 1 ;;
esac
exit 0
EOF
chmod +x "$STUBDIR_GITFAIL/git"
cat > "$STUBDIR_GITFAIL/rsync" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/rsync_gitfail.args"
exit 0
EOF
chmod +x "$STUBDIR_GITFAIL/rsync"

run "hotpatch (one-checkout): aborts on non-ff pull after attempting it" bash -c "
  rm -f '${SCRATCH}/git_gitfail.args' '${SCRATCH}/rsync_gitfail.args'
  set +e
  PATH='${STUBDIR_GITFAIL}:${REAL_PATH}' \
    CATALYST_PLUGIN_DIRS='${FAKE_REPO}/plugins/dev' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' restart --hotpatch >/dev/null 2>&1
  rc=\$?
  set -e
  [[ \$rc -ne 0 ]] && grep -q 'pull --ff-only' '${SCRATCH}/git_gitfail.args' && [[ ! -f '${SCRATCH}/rsync_gitfail.args' ]]
"

run "hotpatch (one-checkout): dirty checkout aborts before fetch" bash -c "
  rm -f '${SCRATCH}/git.args'
  ! PATH='${STUBDIR2}:${REAL_PATH}' GIT_MODE=dirty \
    CATALYST_PLUGIN_DIRS='${FAKE_REPO}/plugins/dev' HOME='${SCRATCH}/fake_home' \
    '${STACK}' restart --hotpatch >/dev/null 2>&1
  ! grep -q 'fetch -q origin main' '${SCRATCH}/git.args'
"

run "hotpatch (one-checkout): ahead checkout aborts before pull" bash -c "
  rm -f '${SCRATCH}/git.args'
  ! PATH='${STUBDIR2}:${REAL_PATH}' GIT_MODE=ahead \
    CATALYST_PLUGIN_DIRS='${FAKE_REPO}/plugins/dev' HOME='${SCRATCH}/fake_home' \
    '${STACK}' restart --hotpatch >/dev/null 2>&1
  grep -q 'fetch -q origin main' '${SCRATCH}/git.args' && ! grep -q 'pull --ff-only' '${SCRATCH}/git.args'
"

run "start --hotpatch on live stack refuses with restart message" bash -c "
  PATH='${STUBDIR_LIVE}:${REAL_PATH}' \
    CATALYST_REPO_DIR='${FAKE_REPO}' \
    HOME='${SCRATCH}/fake_home' \
    '${STACK}' start --hotpatch 2>&1 | grep -qi 'restart'
"

# ── CTL-1166: install-services (launchd auto-start) ───────────────────────────
# All assertions use --print, which is pure (no launchctl/filesystem side
# effects) and OS-independent, so they run identically in CI and on macOS.

run "install-services --print emits the catalyst-stack LaunchAgent label" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -q 'ai.coalesce.catalyst-stack'
"

run "install-services --print runs 'catalyst-stack start'" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -q '<string>start</string>'
"

run "install-services --print sets RunAtLoad true" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -A1 'RunAtLoad' | grep -q '<true/>'
"

run "install-services --print defaults StartInterval to 600" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -A1 'StartInterval' | grep -q '<integer>600</integer>'
"

run "install-services --print honors --interval" bash -c "
  '${STACK}' install-services --print --interval 300 2>&1 | grep -A1 'StartInterval' | grep -q '<integer>300</integer>'
"

run "install-services --print injects HOME + catalyst bin on PATH" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -q '.catalyst/bin'
"

# CTL-1289: the daemon shells out to linearis/node/claude every tick; on a
# joined member those live under ~/.local. The stack plist PATH must include the
# member's npm/user prefix, and must STILL carry homebrew/system dirs (seed
# no-regression — the seed resolves its tools from homebrew).
run "install-services --print: stack plist PATH includes ~/.local member prefix (CTL-1289)" bash -c "
  out=\$('${STACK}' install-services --print 2>&1)
  path_line=\$(printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-stack/{found=1} found' | grep -A1 '<key>PATH</key>' | tail -1)
  printf '%s' \"\$path_line\" | grep -q '.local/node/bin' &&
  printf '%s' \"\$path_line\" | grep -q '.local/bin' &&
  printf '%s' \"\$path_line\" | grep -q '/opt/homebrew/bin' &&
  printf '%s' \"\$path_line\" | grep -q '/usr/bin'
"

run "install-services --print is side-effect-free (writes no plist)" bash -c "
  fh='${SCRATCH}/se_home'; mkdir -p \"\$fh/Library/LaunchAgents\";
  HOME=\"\$fh\" '${STACK}' install-services --print >/dev/null 2>&1;
  [[ ! -e \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-stack.plist\" ]]
"

run "install-services rejects an unknown arg" bash -c "
  ! '${STACK}' install-services --bogus >/dev/null 2>&1
"

run "install-services rejects a non-numeric --interval" bash -c "
  ! '${STACK}' install-services --interval abc >/dev/null 2>&1
"

run "--help lists install-services" bash -c "
  '${STACK}' --help 2>&1 | grep -q 'install-services'
"

run "rendered plist passes plutil lint (macOS)" bash -c "
  if command -v plutil >/dev/null 2>&1; then
    '${STACK}' install-services --print > '${SCRATCH}/ctl1166.plist' 2>/dev/null
    plutil -lint '${SCRATCH}/ctl1166.plist' >/dev/null
  else
    true  # plutil is macOS-only; skip the lint elsewhere
  fi
"

# ── CTL-1202: install-services pins CATALYST_HOST_NAME from Layer-2 config ────
HOSTCFG_HOME="${SCRATCH}/host_home"
mkdir -p "${HOSTCFG_HOME}/.config/catalyst"
printf '{"catalyst":{"host":{"name":"mini"}}}' > "${HOSTCFG_HOME}/.config/catalyst/config.json"

run "install-services --print host-name fixture is non-ephemeral and renders output" bash -c "
  ! bash -c 'source \"${STACK}\"; _is_ephemeral_dir \"${BAKE}\"' >/dev/null 2>&1 &&
  out=\$(HOME='${HOSTCFG_HOME}' CATALYST_FORCE_BAKE_DIR='${BAKE}' '${STACK}' install-services --print 2>/dev/null) &&
  [[ -n \"\$out\" ]]
"

run "install-services --print pins CATALYST_HOST_NAME key" bash -c "
  HOME='${HOSTCFG_HOME}' CATALYST_FORCE_BAKE_DIR='${BAKE}' '${STACK}' install-services --print 2>&1 | grep -q '<key>CATALYST_HOST_NAME</key>'
"

run "install-services --print pins configured host name value" bash -c "
  HOME='${HOSTCFG_HOME}' CATALYST_FORCE_BAKE_DIR='${BAKE}' '${STACK}' install-services --print 2>&1 | grep -A1 'CATALYST_HOST_NAME' | grep -q '<string>mini</string>'
"

run "install-services --print honors CATALYST_LAYER2_CONFIG_FILE" bash -c "
  CATALYST_LAYER2_CONFIG_FILE='${HOSTCFG_HOME}/.config/catalyst/config.json' CATALYST_FORCE_BAKE_DIR='${BAKE}' '${STACK}' install-services --print 2>&1 | grep -A1 'CATALYST_HOST_NAME' | grep -q '<string>mini</string>'
"

run "install-services --print omits key when host.name unset" bash -c "
  emptyhome=\$(mktemp -d);
  out=\$(HOME=\"\$emptyhome\" CATALYST_FORCE_BAKE_DIR='${BAKE}' '${STACK}' install-services --print 2>/dev/null);
  printf '%s' \"\$out\" | grep -q 'ai.coalesce.catalyst-stack' && ! printf '%s' \"\$out\" | grep -q '<key>CATALYST_HOST_NAME</key>'
"

# ── CTL-1236: thoughts-sync LaunchAgent ───────────────────────────────────────
# All assertions use --print (pure, no launchctl/filesystem side effects).

run "install-services --print emits the thoughts-sync label" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -q 'ai.coalesce.catalyst-thoughts-sync'
"

run "install-services --print ProgramArguments include thoughts-pull-sync" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -q 'thoughts-pull-sync'
"

run "install-services --print sets thoughts-sync StartInterval to 300 by default" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-thoughts-sync/{found=1} found && /StartInterval/{p=1} p && /<integer>/{print; exit}' | grep -q '<integer>300</integer>'
"

run "install-services --print honors --sync-interval 120" bash -c "
  out=\$('${STACK}' install-services --print --sync-interval 120 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-thoughts-sync/{found=1} found && /StartInterval/{p=1} p && /<integer>/{print; exit}' | grep -q '<integer>120</integer>'
"

run "install-services --print keeps stack and sync StartInterval independent" bash -c "
  out=\$('${STACK}' install-services --print --interval 600 --sync-interval 120 2>/dev/null)
  stack_ok=\$(printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-stack/{found=1; f=0} found && /StartInterval/{p=1} p && /<integer>/{print; exit}')
  sync_ok=\$(printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-thoughts-sync/{found=1} found && /StartInterval/{p=1} p && /<integer>/{print; exit}')
  echo \"\$stack_ok\" | grep -q '<integer>600</integer>' && echo \"\$sync_ok\" | grep -q '<integer>120</integer>'
"

run "install-services --print injects rich PATH into thoughts-sync plist" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  # find the sync plist section and check for .catalyst/bin in its PATH
  printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-thoughts-sync/{found=1} found' | grep -q '.catalyst/bin'
"

run "install-services --print sets RunAtLoad true in thoughts-sync plist" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/ai.coalesce.catalyst-thoughts-sync/{found=1} found' | grep -A1 'RunAtLoad' | grep -q '<true/>'
"

run "install-services --print is side-effect-free (no thoughts-sync plist written)" bash -c "
  fh='${SCRATCH}/se_home2'; mkdir -p \"\$fh/Library/LaunchAgents\";
  HOME=\"\$fh\" '${STACK}' install-services --print >/dev/null 2>&1;
  [[ ! -e \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-thoughts-sync.plist\" ]]
"

run "rendered thoughts-sync plist passes plutil lint (macOS)" bash -c "
  if command -v plutil >/dev/null 2>&1; then
    '${STACK}' install-services --print 2>/dev/null > '${SCRATCH}/full_plists.txt'
    # Extract ONLY the thoughts-sync plist (the 2nd of three). Bounded to count==2 so
    # the 3rd (log-shipper, CTL-1285) plist does not concatenate and fail plutil.
    awk '/^<\?xml/{count++} count==2' '${SCRATCH}/full_plists.txt' > '${SCRATCH}/sync.plist'
    plutil -lint '${SCRATCH}/sync.plist' >/dev/null
  else
    true
  fi
"

run "install-services rejects a non-numeric --sync-interval" bash -c "
  ! '${STACK}' install-services --sync-interval abc >/dev/null 2>&1
"

run "--help lists --sync-interval" bash -c "
  '${STACK}' --help 2>&1 | grep -q 'sync-interval'
"

run "services-status reports the thoughts-sync plist line" bash -c "
  fh='${SCRATCH}/status_home'; mkdir -p \"\$fh/Library/LaunchAgents\";
  printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-thoughts-sync.plist\";
  HOME=\"\$fh\" '${STACK}' services-status 2>&1 | grep -q 'thoughts-sync'
"

run "uninstall-services removes all three plists" bash -c "
  if [[ \"\$(uname -s)\" != \"Darwin\" ]]; then true; else
    fh='${SCRATCH}/uninst_home'
    mkdir -p \"\$fh/Library/LaunchAgents\"
    printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-stack.plist\"
    printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-thoughts-sync.plist\"
    printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-log-shipper.plist\"
    # Run uninstall with a fake launchctl that always exits 0
    mkdir -p '${SCRATCH}/uninst_bin'
    printf '#!/usr/bin/env bash\nexit 0\n' > '${SCRATCH}/uninst_bin/launchctl'
    chmod +x '${SCRATCH}/uninst_bin/launchctl'
    PATH='${SCRATCH}/uninst_bin:${REAL_PATH}' HOME=\"\$fh\" '${STACK}' uninstall-services >/dev/null 2>&1 || true
    [[ ! -e \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-stack.plist\" ]] && \
    [[ ! -e \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-thoughts-sync.plist\" ]] && \
    [[ ! -e \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-log-shipper.plist\" ]]
  fi
"

# ── CTL-1285: dedicated log-shipper LaunchAgent (KeepAlive) ───────────────────
# --print assertions are pure (no launchctl/filesystem), so they run in CI + macOS.

run "install-services --print emits the log-shipper label" bash -c "
  '${STACK}' install-services --print 2>&1 | grep -q 'ai.coalesce.catalyst-log-shipper'
"

run "install-services --print log-shipper ProgramArguments run launch.sh" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==3' | grep -q 'launch.sh'
"

run "install-services --print log-shipper passes --config" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==3' | grep -q '<string>--config</string>'
"

run "install-services --print log-shipper sets KeepAlive true" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==3' | grep -A1 '<key>KeepAlive</key>' | grep -q '<true/>'
"

run "install-services --print log-shipper has NO StartInterval (KeepAlive supersedes)" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  ! printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==3' | grep -q 'StartInterval'
"

run "install-services --print log-shipper has NO AbandonProcessGroup (launchd owns its pgid)" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  ! printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==3' | grep -q 'AbandonProcessGroup'
"

run "install-services --print stack plist DOES set AbandonProcessGroup (CTL-1285 daemon-reap fix)" bash -c "
  out=\$('${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==1' | grep -A1 '<key>AbandonProcessGroup</key>' | grep -q '<true/>'
"

run "install-services --print log-shipper pins CATALYST_HOST_NAME from config" bash -c "
  out=\$(HOME='${HOSTCFG_HOME}' CATALYST_FORCE_BAKE_DIR='${BAKE}' '${STACK}' install-services --print 2>/dev/null)
  printf '%s\n' \"\$out\" | awk '/^<\?xml/{c++} c==3' | grep -A1 'CATALYST_HOST_NAME' | grep -q '<string>mini</string>'
"

run "rendered log-shipper plist passes plutil lint (macOS)" bash -c "
  if command -v plutil >/dev/null 2>&1; then
    '${STACK}' install-services --print 2>/dev/null > '${SCRATCH}/full3.txt'
    awk '/^<\?xml/{c++} c==3' '${SCRATCH}/full3.txt' > '${SCRATCH}/shipper.plist'
    plutil -lint '${SCRATCH}/shipper.plist' >/dev/null
  else
    true
  fi
"

run "install-services --print is side-effect-free (no log-shipper plist written)" bash -c "
  fh='${SCRATCH}/se_home3'; mkdir -p \"\$fh/Library/LaunchAgents\";
  HOME=\"\$fh\" '${STACK}' install-services --print >/dev/null 2>&1;
  [[ ! -e \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-log-shipper.plist\" ]]
"

run "services-status reports the log-shipper plist line" bash -c "
  fh='${SCRATCH}/status_home_ship'; mkdir -p \"\$fh/Library/LaunchAgents\";
  printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-log-shipper.plist\";
  HOME=\"\$fh\" '${STACK}' services-status 2>&1 | grep -q 'log-shipper'
"

# Defer-guard: when the shipper agent plist exists, start_shipper/stop_shipper must
# yield to launchd instead of starting/killing Alloy themselves.
run "start defers to the shipper agent when its plist is present" bash -c "
  fh='${SCRATCH}/defer_home'; mkdir -p \"\$fh/Library/LaunchAgents\" \"\$fh/catalyst\";
  printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-log-shipper.plist\";
  out=\$(PATH='${STUBDIR}:${REAL_PATH}' HOME=\"\$fh\" '${STACK}' start 2>&1)
  printf '%s\n' \"\$out\" | grep -q 'deferring to the agent' && [[ ! -e \"\$fh/catalyst/alloy.pid\" ]]
"

run "stop leaves the launchd-managed shipper running when its plist is present" bash -c "
  fh='${SCRATCH}/defer_home2'; mkdir -p \"\$fh/Library/LaunchAgents\" \"\$fh/catalyst\";
  printf '<plist/>' > \"\$fh/Library/LaunchAgents/ai.coalesce.catalyst-log-shipper.plist\";
  PATH='${STUBDIR}:${REAL_PATH}' HOME=\"\$fh\" '${STACK}' stop 2>&1 | grep -q 'leaving it running'
"

run "suite is hermetic: no writes to the live CATALYST_DIR" bash -c "
  test \"\$(cat '${LIVE_MARKER_SNAPSHOT}')\" = \"\$(_live_runtime_fingerprint)\"
"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "catalyst-stack: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
