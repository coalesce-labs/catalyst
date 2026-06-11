#!/usr/bin/env bash
# Shell tests for the CTL-940 hotpatch rework: `catalyst-stack hotpatch`
# updates the pluginDirs git checkout (ff-only) and never touches the
# marketplace plugin cache. --legacy-rsync keeps the deprecated cache-rsync.
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-hotpatch.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
REAL_PATH="$PATH"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

check() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

# ── Git fixtures: bare origin + node checkout containing plugins/dev ────────
GITC="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main"

make_fixture() {
  # make_fixture NAME → sets FIX_SEED, FIX_ORIGIN, FIX_CHECKOUT
  local base="${SCRATCH}/fix_$1"
  mkdir -p "${base}/seed"
  $GITC -C "${base}/seed" init -q
  mkdir -p "${base}/seed/plugins/dev/.claude-plugin"
  echo '{"name":"catalyst-dev","version":"1.0.0"}' \
    > "${base}/seed/plugins/dev/.claude-plugin/plugin.json"
  echo "v1" > "${base}/seed/plugins/dev/marker.txt"
  $GITC -C "${base}/seed" add -A
  $GITC -C "${base}/seed" commit -qm "initial"
  $GITC init -q --bare "${base}/origin.git"
  $GITC -C "${base}/seed" remote add origin "${base}/origin.git"
  $GITC -C "${base}/seed" push -q -u origin main
  $GITC clone -q "${base}/origin.git" "${base}/checkout"
  FIX_SEED="${base}/seed"
  FIX_ORIGIN="${base}/origin.git"
  FIX_CHECKOUT="${base}/checkout"
}

advance_origin() {
  echo "v2" > "${FIX_SEED}/plugins/dev/marker.txt"
  $GITC -C "${FIX_SEED}" commit -qam "update marker"
  $GITC -C "${FIX_SEED}" push -q origin main
}

# Service stubs; rsync stub records invocations so we can assert the new
# hotpatch path never calls it.
STUBDIR="${SCRATCH}/stubs"
mkdir -p "$STUBDIR"
for svc in catalyst-broker catalyst-monitor; do
  printf '#!/usr/bin/env bash\necho running; exit 0\n' > "$STUBDIR/$svc"
  chmod +x "$STUBDIR/$svc"
done
cat > "$STUBDIR/catalyst-execution-core" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in status) echo "stopped" ;; *) echo "running" ;; esac
exit 0
EOF
chmod +x "$STUBDIR/catalyst-execution-core"
cat > "$STUBDIR/rsync" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${SCRATCH}/rsync.args"
exit 0
EOF
chmod +x "$STUBDIR/rsync"

# Fake HOME with a marketplace plugin cache that must never be touched.
FAKE_HOME="${SCRATCH}/fake_home"
FAKE_CACHE="${FAKE_HOME}/.claude/plugins/cache/catalyst/catalyst-dev/1.0.0"
mkdir -p "$FAKE_CACHE"
echo "untouched" > "${FAKE_CACHE}/sentinel.txt"

# Neutral cwd outside any repo carrying .catalyst/config.json so only the
# env/machine-config layers are in play.
NEUTRAL="${SCRATCH}/neutral"
mkdir -p "$NEUTRAL"

# hotpatch PLUGIN_DIRS_ENV MACHINE_CFG [extra args...] — runs the subcommand
# from the neutral cwd. Pass "" to leave a layer unset.
hotpatch() {
  local pdirs="$1" mcfg="$2"; shift 2
  local env_args=(PATH="${STUBDIR}:${REAL_PATH}" HOME="$FAKE_HOME"
                  CATALYST_MACHINE_CONFIG="${mcfg:-${SCRATCH}/absent.json}")
  [[ -n "$pdirs" ]] && env_args+=(CATALYST_PLUGIN_DIRS="$pdirs")
  (cd "$NEUTRAL" && env "${env_args[@]}" "$STACK" hotpatch "$@")
}

echo "catalyst-stack hotpatch (CTL-940) tests"

# ── 1. clean + behind → ff-pull updates the checkout ─────────────────────────
make_fixture pull
advance_origin
rm -f "${SCRATCH}/rsync.args"
t1() {
  hotpatch "${FIX_CHECKOUT}/plugins/dev" "" || return 1
  [[ "$(cat "${FIX_CHECKOUT}/plugins/dev/marker.txt")" == v2 ]]
}
check "hotpatch ff-pulls a clean behind checkout to origin/main" t1
check "hotpatch never invokes rsync on the new path" \
  bash -c "[[ ! -f '${SCRATCH}/rsync.args' ]]"
t1c() {
  [[ "$(cat "${FAKE_CACHE}/sentinel.txt")" == untouched ]] \
    && [[ "$(ls "$FAKE_CACHE")" == sentinel.txt ]]
}
check "hotpatch never touches the plugin cache" t1c
t1d() { hotpatch "${FIX_CHECKOUT}/plugins/dev" "" 2>&1 | grep -qi "up to date"; }
check "hotpatch is idempotent when already up to date" t1d

# ── 2. dirty checkout → refuse ───────────────────────────────────────────────
make_fixture dirty
advance_origin
echo "local edit" >> "${FIX_CHECKOUT}/plugins/dev/marker.txt"
t2() {
  local out rc
  out="$(hotpatch "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi dirty <<<"$out"
}
check "hotpatch refuses a dirty checkout with a clear message" t2
t2b() {
  grep -q "local edit" "${FIX_CHECKOUT}/plugins/dev/marker.txt" \
    && ! grep -q v2 "${FIX_CHECKOUT}/plugins/dev/marker.txt"
}
check "refused dirty checkout is left un-pulled" t2b

# ── 3. diverged checkout → refuse ────────────────────────────────────────────
make_fixture diverged
advance_origin
( cd "${FIX_CHECKOUT}" \
  && echo "local commit" > local.txt \
  && $GITC add local.txt \
  && $GITC commit -qm "local divergence" )
t3() {
  local out rc
  out="$(hotpatch "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qiE "diverg|ahead" <<<"$out"
}
check "hotpatch refuses a diverged checkout" t3

# ── 4. pluginDirs resolution order ───────────────────────────────────────────
make_fixture mcfg
advance_origin
MACHINE_CFG="${SCRATCH}/machine-config.json"
printf '{"catalyst":{"orchestration":{"pluginDirs":["%s"]}}}\n' \
  "${FIX_CHECKOUT}/plugins/dev" > "$MACHINE_CFG"
t4() {
  hotpatch "" "$MACHINE_CFG" || return 1
  [[ "$(cat "${FIX_CHECKOUT}/plugins/dev/marker.txt")" == v2 ]]
}
check "hotpatch resolves the checkout from machine-config pluginDirs" t4

make_fixture envwins
advance_origin
t5() {
  # machine config still points at the (already-updated) mcfg fixture;
  # env points at the envwins fixture — the env one must get pulled.
  hotpatch "${FIX_CHECKOUT}/plugins/dev" "$MACHINE_CFG" || return 1
  [[ "$(cat "${FIX_CHECKOUT}/plugins/dev/marker.txt")" == v2 ]]
}
check "env CATALYST_PLUGIN_DIRS wins over machine config" t5

make_fixture repocfg
advance_origin
REPO_CWD="${SCRATCH}/repocfg_cwd"
mkdir -p "${REPO_CWD}/.catalyst"
printf '{"catalyst":{"orchestration":{"pluginDirs":["%s"]}}}\n' \
  "${FIX_CHECKOUT}/plugins/dev" > "${REPO_CWD}/.catalyst/config.json"
t6() {
  (cd "$REPO_CWD" && \
    env PATH="${STUBDIR}:${REAL_PATH}" HOME="$FAKE_HOME" \
        CATALYST_MACHINE_CONFIG="$MACHINE_CFG" \
        "$STACK" hotpatch) || return 1
  [[ "$(cat "${FIX_CHECKOUT}/plugins/dev/marker.txt")" == v2 ]]
}
check "repo .catalyst/config.json pluginDirs wins over machine config" t6

# ── 5. no pluginDirs anywhere → refuse with config guidance ──────────────────
t7() {
  local out rc
  out="$(hotpatch "" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -q "pluginDirs" <<<"$out"
}
check "hotpatch without pluginDirs fails naming pluginDirs config" t7

# ── 6. --legacy-rsync keeps the deprecated cache-rsync path ──────────────────
make_fixture legacy
rm -f "${SCRATCH}/rsync.args"
t8() {
  local out
  out="$( (cd "$NEUTRAL" && \
    env PATH="${STUBDIR}:${REAL_PATH}" HOME="$FAKE_HOME" \
        CATALYST_REPO_DIR="${FIX_CHECKOUT}" \
        "$STACK" hotpatch --legacy-rsync 2>&1) )" || return 1
  grep -q -- "-ac" "${SCRATCH}/rsync.args" && grep -qi deprecat <<<"$out"
}
check "--legacy-rsync still rsyncs into the cache and warns deprecated" t8
check "legacy rsync still never uses --delete" \
  bash -c "! grep -q -- '--delete' '${SCRATCH}/rsync.args'"

# ── 7. static guard: only the legacy path references the plugin cache ────────
t9() {
  local count legacy_count
  count=$(grep -c "plugins/cache" "$STACK")
  legacy_count=$(awk '/BEGIN LEGACY RSYNC/,/END LEGACY RSYNC/' "$STACK" \
    | grep -c "plugins/cache")
  [[ "$count" -gt 0 && "$count" -le "$legacy_count" ]]
}
check "new hotpatch path has no plugin-cache reference outside legacy block" t9

echo ""
TOTAL=$((PASSES + FAILURES))
echo "catalyst-stack-hotpatch: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
