#!/usr/bin/env bash
# Shell tests for install-cli.sh.
# Run: bash plugins/dev/scripts/__tests__/install-cli.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALL_CLI="${REPO_ROOT}/plugins/dev/scripts/install-cli.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Fake source dir with stub catalyst-* scripts + an unrelated file
setup_source() {
  local src="$1"
  rm -rf "$src"
  mkdir -p "$src"
  for f in catalyst-comms catalyst-session.sh catalyst-state.sh catalyst-db.sh \
           catalyst-monitor.sh catalyst-thoughts.sh catalyst-claude.sh; do
    echo '#!/usr/bin/env bash' > "$src/$f"
    echo "echo stub-$f" >> "$src/$f"
    chmod +x "$src/$f"
  done
  # unrelated file — must NOT be symlinked
  echo '#!/usr/bin/env bash' > "$src/not-a-cli.sh"
  chmod +x "$src/not-a-cli.sh"
}

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

expect_contains() {
  local file="$1" needle="$2"
  if grep -qF -- "$needle" "$file"; then
    return 0
  else
    echo "    missing: $needle"
    echo "    in:"
    sed 's/^/      /' "$file"
    return 1
  fi
}

expect_not_contains() {
  local file="$1" needle="$2"
  if grep -qF -- "$needle" "$file"; then
    echo "    unexpected presence: $needle"
    sed 's/^/      /' "$file"
    return 1
  fi
  return 0
}

echo "install-cli tests"

# ── 1. help exits 0 and prints usage ────────────────────────────────────────
run "help exits 0 and prints usage" bash -c "
  $INSTALL_CLI --help 2>&1 | grep -q Usage
"

# ── 2. unknown flag exits non-zero ──────────────────────────────────────────
run "unknown flag exits non-zero" expect_exit 2 bash -c "
  $INSTALL_CLI --bogus-flag
"

# ── 3. install creates bin dir and all expected symlinks ───────────────────
SRC1="$SCRATCH/plugin1/scripts"
BIN1="$SCRATCH/bin1"
setup_source "$SRC1"

run "install creates bin dir" bash -c "
  CATALYST_CLI_SOURCE='$SRC1' CATALYST_CLI_BIN_DIR='$BIN1' $INSTALL_CLI >/dev/null
  [[ -d '$BIN1' ]]
"

for cli in catalyst-comms catalyst-session catalyst-state catalyst-db \
           catalyst-monitor catalyst-thoughts catalyst-claude; do
  run "installs symlink: $cli" bash -c "
    [[ -L '$BIN1/$cli' ]]
  "
  run "$cli resolves to real file" bash -c "
    target=\$(readlink '$BIN1/$cli')
    [[ -e \"\$target\" ]]
  "
done

# ── 4. .sh suffix stripped on link name ─────────────────────────────────────
run "catalyst-session points at catalyst-session.sh" bash -c "
  target=\$(readlink '$BIN1/catalyst-session')
  [[ \"\$target\" = *catalyst-session.sh ]]
"

# ── 5. non-allowlisted file is NOT symlinked ────────────────────────────────
run "non-allowlisted file not symlinked" bash -c "
  [[ ! -e '$BIN1/not-a-cli' && ! -e '$BIN1/not-a-cli.sh' ]]
"

# ── 6. idempotency — run twice, still works ─────────────────────────────────
run "second run does not error" bash -c "
  CATALYST_CLI_SOURCE='$SRC1' CATALYST_CLI_BIN_DIR='$BIN1' $INSTALL_CLI >/dev/null 2>&1
"

run "second run leaves 7 symlinks" bash -c "
  count=\$(find '$BIN1' -maxdepth 1 -type l | wc -l | tr -d ' ')
  [[ \"\$count\" = '7' ]]
"

# ── 7. re-point on source move — symlinks point at new location ────────────
SRC2="$SCRATCH/plugin2/scripts"
setup_source "$SRC2"
run "re-install with new source updates targets" bash -c "
  CATALYST_CLI_SOURCE='$SRC2' CATALYST_CLI_BIN_DIR='$BIN1' $INSTALL_CLI >/dev/null
  target=\$(readlink '$BIN1/catalyst-comms')
  [[ \"\$target\" = '$SRC2/catalyst-comms' ]]
"

# ── 8. PATH hint when bin dir not in PATH ───────────────────────────────────
BIN3="$SCRATCH/bin3"
setup_source "$SCRATCH/plugin3/scripts"
run "prints PATH hint when not on PATH" bash -c "
  PATH='/usr/bin:/bin' HOME='$SCRATCH/home3' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin3/scripts' CATALYST_CLI_BIN_DIR='$BIN3' \
    $INSTALL_CLI > '$SCRATCH/out3' 2>&1
  grep -qF 'PATH' '$SCRATCH/out3' && grep -qF '$BIN3' '$SCRATCH/out3'
"

# ── 9. NO PATH hint when bin dir already on PATH ────────────────────────────
BIN4="$SCRATCH/bin4"
setup_source "$SCRATCH/plugin4/scripts"
run "no PATH hint when already on PATH" bash -c "
  PATH='$BIN4:/usr/bin:/bin' HOME='$SCRATCH/home4' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin4/scripts' CATALYST_CLI_BIN_DIR='$BIN4' \
    $INSTALL_CLI > '$SCRATCH/out4' 2>&1
  ! grep -qE 'add.*to.*PATH|add.*PATH' '$SCRATCH/out4'
"

# ── 10. --uninstall removes catalyst-* symlinks ────────────────────────────
BIN5="$SCRATCH/bin5"
setup_source "$SCRATCH/plugin5/scripts"
run "install before uninstall" bash -c "
  CATALYST_CLI_SOURCE='$SCRATCH/plugin5/scripts' CATALYST_CLI_BIN_DIR='$BIN5' $INSTALL_CLI >/dev/null
"

# Touch an unrelated file in the bin dir — uninstall must leave it
touch "$BIN5/unrelated"
run "uninstall removes catalyst-* links" bash -c "
  CATALYST_CLI_BIN_DIR='$BIN5' $INSTALL_CLI --uninstall >/dev/null
  [[ ! -e '$BIN5/catalyst-comms' && ! -e '$BIN5/catalyst-session' ]]
"
run "uninstall leaves unrelated files alone" bash -c "
  [[ -e '$BIN5/unrelated' ]]
"

# ── 11. --uninstall removes dir if empty ────────────────────────────────────
BIN6="$SCRATCH/bin6"
setup_source "$SCRATCH/plugin6/scripts"
run "install + uninstall with no other files removes dir" bash -c "
  CATALYST_CLI_SOURCE='$SCRATCH/plugin6/scripts' CATALYST_CLI_BIN_DIR='$BIN6' $INSTALL_CLI >/dev/null
  CATALYST_CLI_BIN_DIR='$BIN6' $INSTALL_CLI --uninstall >/dev/null
  [[ ! -d '$BIN6' ]]
"

# ── 12. source auto-detect uses script's own dir when no env override ───────
# Simulate: copy install-cli.sh into a scratch plugin dir with stubs, run without env.
AUTO_SRC="$SCRATCH/auto/scripts"
mkdir -p "$AUTO_SRC"
cp "$INSTALL_CLI" "$AUTO_SRC/install-cli.sh"
setup_source "$AUTO_SRC"   # this overwrites the install-cli.sh copy — re-copy
cp "$INSTALL_CLI" "$AUTO_SRC/install-cli.sh"
BIN7="$SCRATCH/bin7"
run "auto-detect source from script's own dir" bash -c "
  CATALYST_CLI_BIN_DIR='$BIN7' bash '$AUTO_SRC/install-cli.sh' >/dev/null
  target=\$(readlink '$BIN7/catalyst-comms')
  [[ \"\$target\" = '$AUTO_SRC/catalyst-comms' ]]
"

# ── 13. missing source fails clearly ────────────────────────────────────────
run "missing source dir fails with error message" bash -c "
  set +e
  out=\$(CATALYST_CLI_SOURCE='$SCRATCH/does-not-exist' \
         CATALYST_CLI_BIN_DIR='$SCRATCH/bin-err' \
         $INSTALL_CLI 2>&1)
  rc=\$?
  set -e
  [[ \"\$rc\" -ne 0 ]] && echo \"\$out\" | grep -qi 'source'
"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "install-cli: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
