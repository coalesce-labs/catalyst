#!/usr/bin/env bash
# Shell tests for `catalyst-stack parity` (CTL-941): freshness + drift report
# for the per-host plugin checkout. Nonzero exit on drift.
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-parity.test.sh

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

GITC="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main"

make_fixture() {
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
  FIX_CHECKOUT="${base}/checkout"
}

advance_origin() {
  echo "v2" > "${FIX_SEED}/plugins/dev/marker.txt"
  $GITC -C "${FIX_SEED}" commit -qam "update marker"
  $GITC -C "${FIX_SEED}" push -q origin main
}

NEUTRAL="${SCRATCH}/neutral"
mkdir -p "$NEUTRAL"
MACHINE_CFG_ABSENT="${SCRATCH}/absent.json"

# parity PLUGIN_DIRS_ENV MACHINE_CFG → runs the subcommand from neutral cwd
parity() {
  local pdirs="$1" mcfg="$2"; shift 2
  local env_args=(PATH="$REAL_PATH"
                  CATALYST_MACHINE_CONFIG="${mcfg:-$MACHINE_CFG_ABSENT}")
  [[ -n "$pdirs" ]] && env_args+=(CATALYST_PLUGIN_DIRS="$pdirs")
  (cd "$NEUTRAL" && env "${env_args[@]}" "$STACK" parity "$@")
}

echo "catalyst-stack parity (CTL-941) tests"

# ── 1. clean, current checkout via machine config → exit 0 ──────────────────
make_fixture clean
MACHINE_CFG="${SCRATCH}/machine-config.json"
printf '{"catalyst":{"orchestration":{"pluginDirs":["%s"]}}}\n' \
  "${FIX_CHECKOUT}/plugins/dev" > "$MACHINE_CFG"
t1() {
  local out rc
  out="$(parity "" "$MACHINE_CFG" 2>&1)"; rc=$?
  [[ $rc -eq 0 ]] && grep -qi "machine-config" <<<"$out"
}
check "clean current checkout (machine config) exits 0" t1

# ── 2. behind origin/main → drift, reports behind count ─────────────────────
make_fixture behind
advance_origin
t2() {
  local out rc
  out="$(parity "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "behind origin/main by 1" <<<"$out"
}
check "behind checkout exits nonzero and reports behind-by count" t2

# ── 3. dirty checkout → drift, reports dirty files ──────────────────────────
make_fixture dirtyp
echo "edit" >> "${FIX_CHECKOUT}/plugins/dev/marker.txt"
t3() {
  local out rc
  out="$(parity "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "dirty" <<<"$out" && grep -q "marker.txt" <<<"$out"
}
check "dirty checkout exits nonzero and names the dirty file" t3

# ── 4. SSH remote → drift (unauthable from daemon contexts) ─────────────────
make_fixture sshp
$GITC -C "${FIX_CHECKOUT}" remote set-url origin git@github.com:fake/fake.git
t4() {
  local out rc
  out="$(parity "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qiE "ssh" <<<"$out"
}
check "ssh remote is flagged as drift" t4

# ── 5. pluginDirs unset everywhere → drift naming the config ────────────────
t5() {
  local out rc
  out="$(parity "" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -q "pluginDirs" <<<"$out"
}
check "missing pluginDirs config exits nonzero naming pluginDirs" t5

# ── 6. broken plugin manifest → drift ────────────────────────────────────────
make_fixture badmanifest
echo "{not json" > "${FIX_CHECKOUT}/plugins/dev/.claude-plugin/plugin.json"
$GITC -C "${FIX_CHECKOUT}" commit -qam "break manifest" 2>/dev/null || true
t6() {
  local out rc
  out="$(parity "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "manifest" <<<"$out"
}
check "unparseable plugin manifest exits nonzero" t6

# ── 7. env-resolved pluginDirs reports machine config as unset ──────────────
make_fixture envsrc
t7() {
  local out
  out="$(parity "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)" || true
  grep -qi "machine config" <<<"$out"
}
check "parity reports whether pluginDirs is set in machine config" t7

# ── 8. off-main checkout → drift naming "main" (CTL-992) ────────────────────
make_fixture offmain
$GITC -C "${FIX_CHECKOUT}" checkout -q -b feature
t8() {
  local out rc
  out="$(parity "${FIX_CHECKOUT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "main" <<<"$out" && grep -q "feature" <<<"$out"
}
check "off-main checkout exits nonzero and names main + branch" t8

# ── 9. linked-worktree pluginDirs → drift naming "worktree" (CTL-992) ───────
make_fixture linked
# park primary off main so the linked worktree can itself sit on main,
# isolating the worktree signal from the off-main signal.
$GITC -C "${FIX_CHECKOUT}" checkout -q -b parking
LINKED_WT="${SCRATCH}/fix_linked/linkedwt"
$GITC -C "${FIX_CHECKOUT}" worktree add -q "$LINKED_WT" main
t9() {
  local out rc
  out="$(parity "${LINKED_WT}/plugins/dev" "" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "worktree" <<<"$out"
}
check "linked-worktree pluginDirs exits nonzero and names worktree" t9

echo ""
TOTAL=$((PASSES + FAILURES))
echo "catalyst-stack-parity: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
