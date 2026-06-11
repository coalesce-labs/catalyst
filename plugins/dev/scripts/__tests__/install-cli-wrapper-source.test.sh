#!/usr/bin/env bash
# CTL-1000: install-cli generated wrappers prefer the healthy pristine plugin
# checkout (pluginDirs) over the marketplace cache, falling back to the cache
# with ONE loud stderr warning when the checkout is unhealthy/absent.
# Run: bash plugins/dev/scripts/__tests__/install-cli-wrapper-source.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALL_CLI="${REPO_ROOT}/plugins/dev/scripts/install-cli.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

GITC="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main"

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

# seed_cache HOME VER — create a cache version dir with a catalyst-events stub
# that prints FROM-CACHE; install-cli writes wrappers only when SOURCE_DIR is
# the cache, so we point CATALYST_CLI_SOURCE at this dir.
seed_cache() {
  local home="$1" ver="$2"
  local cache="${home}/.claude/plugins/cache/catalyst/catalyst-dev/${ver}/scripts"
  mkdir -p "$cache"
  cat > "${cache}/catalyst-events" <<'CLI'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" || "${1:-}" == "-V" ]]; then
  echo "catalyst-events cache-stub ver"
  exit 0
fi
echo "FROM-CACHE"
CLI
  chmod +x "${cache}/catalyst-events"
  printf '%s' "$cache"
}

# make_checkout BASE — build a standalone git checkout at BASE with a
# plugins/dev/scripts/catalyst-events stub that prints FROM-CHECKOUT, plus the
# plugin manifest + version.txt the underlying --version path expects. Leaves
# the checkout clean on main. Sets FIX_CHECKOUT=<root>, FIX_PD=<root>/plugins/dev.
make_checkout() {
  local base="$1"
  mkdir -p "${base}"
  $GITC -C "${base}" init -q
  mkdir -p "${base}/plugins/dev/.claude-plugin" "${base}/plugins/dev/scripts"
  echo '{"name":"catalyst-dev","version":"1.0.0"}' \
    > "${base}/plugins/dev/.claude-plugin/plugin.json"
  echo "1.0.0" > "${base}/plugins/dev/version.txt"
  cat > "${base}/plugins/dev/scripts/catalyst-events" <<'CLI'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" || "${1:-}" == "-V" ]]; then
  echo "catalyst-events checkout-stub ver"
  exit 0
fi
echo "FROM-CHECKOUT"
CLI
  chmod +x "${base}/plugins/dev/scripts/catalyst-events"
  $GITC -C "${base}" add -A
  $GITC -C "${base}" commit -qm "initial"
  FIX_CHECKOUT="${base}"
  FIX_PD="${base}/plugins/dev"
}

# install_wrappers HOME — install the wrapper for catalyst-events into
# $HOME/.catalyst/bin by pointing the install source at the seeded cache.
install_wrappers() {
  local home="$1" cache="$2"
  HOME="$home" CATALYST_CLI_SOURCE="$cache" \
    CATALYST_BIN_DIR="${home}/.catalyst/bin" \
    bash "$INSTALL_CLI" >/dev/null 2>&1
}

echo "install-cli wrapper-source (CTL-1000) tests"

# ── W1: healthy checkout → wrapper execs the checkout script ────────────────
H1="$SCRATCH/h1"; mkdir -p "$H1"
C1="$(seed_cache "$H1" 9.0.0)"
make_checkout "$SCRATCH/co1"
install_wrappers "$H1" "$C1"
run "W1 healthy checkout → FROM-CHECKOUT" bash -c "
  out=\$(HOME='$H1' CATALYST_PLUGIN_DIRS='$FIX_PD' '$H1/.catalyst/bin/catalyst-events' run 2>/dev/null)
  [[ \"\$out\" == 'FROM-CHECKOUT' ]]
"

# ── W2: --version on healthy checkout reports source: checkout + HEAD ────────
run "W2 --version reports source: checkout + root + HEAD" bash -c "
  out=\$(HOME='$H1' CATALYST_PLUGIN_DIRS='$FIX_PD' '$H1/.catalyst/bin/catalyst-events' --version 2>&1)
  echo \"\$out\" | grep -qF 'source: checkout' \\
    && echo \"\$out\" | grep -qF '$FIX_CHECKOUT' \\
    && echo \"\$out\" | grep -qiF 'HEAD'
"

# ── W3: CATALYST_FORCE_CACHE=1 → cache, NO warning ──────────────────────────
run "W3 force-cache → FROM-CACHE, no WARN" bash -c "
  out=\$(HOME='$H1' CATALYST_FORCE_CACHE=1 CATALYST_PLUGIN_DIRS='$FIX_PD' \
        '$H1/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w3.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] && ! grep -q 'WARN' '$SCRATCH/w3.err'
"

# ── W4: pluginDirs unset everywhere → cache, NO warning (silent, not degraded) ─
H4="$SCRATCH/h4"; mkdir -p "$H4"
C4="$(seed_cache "$H4" 9.0.0)"
install_wrappers "$H4" "$C4"
run "W4 no pluginDirs → FROM-CACHE, no WARN" bash -c "
  cd '$SCRATCH'
  out=\$(HOME='$H4' XDG_CONFIG_HOME='$H4/.config-empty' \
        '$H4/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w4.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] && ! grep -q 'WARN' '$SCRATCH/w4.err'
"

# ── W5: off-main checkout → cache + ONE warning naming OFF_MAIN ──────────────
H5="$SCRATCH/h5"; mkdir -p "$H5"
C5="$(seed_cache "$H5" 9.0.0)"
make_checkout "$SCRATCH/co5"
$GITC -C "$FIX_CHECKOUT" checkout -q -b feature
PD5="$FIX_PD"
install_wrappers "$H5" "$C5"
run "W5 off-main checkout → FROM-CACHE + ONE WARN naming OFF_MAIN" bash -c "
  out=\$(HOME='$H5' CATALYST_PLUGIN_DIRS='$PD5' \
        '$H5/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w5.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] || { echo \"stdout=\$out\"; exit 1; }
  grep -q 'WARN' '$SCRATCH/w5.err' || { echo 'no WARN'; cat '$SCRATCH/w5.err'; exit 1; }
  grep -q 'OFF_MAIN' '$SCRATCH/w5.err' || { echo 'no OFF_MAIN'; cat '$SCRATCH/w5.err'; exit 1; }
  c=\$(grep -c 'WARN' '$SCRATCH/w5.err'); [[ \"\$c\" == '1' ]]
"

# ── W6: dirty checkout → cache + warning naming DIRTY ───────────────────────
H6="$SCRATCH/h6"; mkdir -p "$H6"
C6="$(seed_cache "$H6" 9.0.0)"
make_checkout "$SCRATCH/co6"
echo "dirty edit" >> "$FIX_CHECKOUT/plugins/dev/version.txt"
PD6="$FIX_PD"
install_wrappers "$H6" "$C6"
run "W6 dirty checkout → FROM-CACHE + WARN naming DIRTY" bash -c "
  out=\$(HOME='$H6' CATALYST_PLUGIN_DIRS='$PD6' \
        '$H6/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w6.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] \\
    && grep -q 'WARN' '$SCRATCH/w6.err' \\
    && grep -q 'DIRTY' '$SCRATCH/w6.err'
"

# ── W7: missing checkout dir → cache + warning naming MISSING ───────────────
H7="$SCRATCH/h7"; mkdir -p "$H7"
C7="$(seed_cache "$H7" 9.0.0)"
install_wrappers "$H7" "$C7"
run "W7 missing pluginDirs path → FROM-CACHE + WARN naming MISSING" bash -c "
  out=\$(HOME='$H7' CATALYST_PLUGIN_DIRS='$SCRATCH/no-such-dir/plugins/dev' \
        '$H7/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w7.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] \\
    && grep -q 'WARN' '$SCRATCH/w7.err' \\
    && grep -q 'MISSING' '$SCRATCH/w7.err'
"

# ── W8: linked-worktree checkout → cache + warning naming LINKED_WORKTREE ────
H8="$SCRATCH/h8"; mkdir -p "$H8"
C8="$(seed_cache "$H8" 9.0.0)"
make_checkout "$SCRATCH/co8"
# park primary off main so the linked worktree itself sits on main, isolating
# the worktree signal from the off-main signal.
$GITC -C "$FIX_CHECKOUT" checkout -q -b parking
LINKED_WT8="$SCRATCH/co8-linkedwt"
$GITC -C "$FIX_CHECKOUT" worktree add -q "$LINKED_WT8" main
PD8="$LINKED_WT8/plugins/dev"
install_wrappers "$H8" "$C8"
run "W8 linked-worktree → FROM-CACHE + WARN naming LINKED_WORKTREE" bash -c "
  out=\$(HOME='$H8' CATALYST_PLUGIN_DIRS='$PD8' \
        '$H8/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w8.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] \\
    && grep -q 'WARN' '$SCRATCH/w8.err' \\
    && grep -q 'LINKED_WORKTREE' '$SCRATCH/w8.err'
"

# ── W9: non-git dir → cache + warning naming NOT_A_CHECKOUT ─────────────────
H9="$SCRATCH/h9"; mkdir -p "$H9"
C9="$(seed_cache "$H9" 9.0.0)"
PLAIN9="$SCRATCH/plain9/plugins/dev"
mkdir -p "$PLAIN9"
install_wrappers "$H9" "$C9"
run "W9 non-git dir → FROM-CACHE + WARN naming NOT_A_CHECKOUT" bash -c "
  out=\$(HOME='$H9' CATALYST_PLUGIN_DIRS='$PLAIN9' \
        '$H9/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w9.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] \\
    && grep -q 'WARN' '$SCRATCH/w9.err' \\
    && grep -q 'NOT_A_CHECKOUT' '$SCRATCH/w9.err'
"

# ── W10: repo .catalyst/config.json pluginDirs is read (walk-up) ────────────
H10="$SCRATCH/h10"; mkdir -p "$H10"
C10="$(seed_cache "$H10" 9.0.0)"
make_checkout "$SCRATCH/co10"
PD10="$FIX_PD"
install_wrappers "$H10" "$C10"
# Build an ancestor repo dir with .catalyst/config.json pointing at the checkout,
# and a nested cwd to exercise the walk-up.
REPO10="$SCRATCH/repo10"
mkdir -p "$REPO10/.catalyst" "$REPO10/nested/deeper"
printf '{"catalyst":{"orchestration":{"pluginDirs":["%s"]}}}\n' "$PD10" \
  > "$REPO10/.catalyst/config.json"
run "W10 repo .catalyst/config.json pluginDirs walk-up → FROM-CHECKOUT" bash -c "
  cd '$REPO10/nested/deeper'
  out=\$(HOME='$H10' XDG_CONFIG_HOME='$H10/.config-empty' \
        '$H10/.catalyst/bin/catalyst-events' run 2>/dev/null)
  [[ \"\$out\" == 'FROM-CHECKOUT' ]]
"

# ── W11: warning goes to stderr only (stdout stays clean) ───────────────────
run "W11 warning is stderr-only" bash -c "
  # stdout (2>/dev/null) is exactly FROM-CACHE, no WARN
  so=\$(HOME='$H5' CATALYST_PLUGIN_DIRS='$PD5' \
       '$H5/.catalyst/bin/catalyst-events' run 2>/dev/null)
  [[ \"\$so\" == 'FROM-CACHE' ]] || { echo \"stdout=\$so\"; exit 1; }
  echo \"\$so\" | grep -q 'WARN' && { echo 'WARN leaked to stdout'; exit 1; }
  # combined stream contains WARN
  both=\$(HOME='$H5' CATALYST_PLUGIN_DIRS='$PD5' \
        '$H5/.catalyst/bin/catalyst-events' run 2>&1)
  echo \"\$both\" | grep -q 'WARN'
"

# ── W12: single warning across sibling exec (CATALYST_WRAPPER_WARNED) ────────
run "W12 CATALYST_WRAPPER_WARNED suppresses child warning" bash -c "
  out=\$(HOME='$H5' CATALYST_WRAPPER_WARNED=1 CATALYST_PLUGIN_DIRS='$PD5' \
        '$H5/.catalyst/bin/catalyst-events' run 2>'$SCRATCH/w12.err')
  [[ \"\$out\" == 'FROM-CACHE' ]] || { echo \"stdout=\$out\"; exit 1; }
  c=\$(grep -c 'WARN' '$SCRATCH/w12.err' || true); [[ \"\$c\" == '0' ]]
"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "install-cli-wrapper-source: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
