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
  for f in catalyst-comms catalyst-events catalyst-session.sh catalyst-state.sh catalyst-db.sh \
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

for cli in catalyst-comms catalyst-events catalyst-session catalyst-state catalyst-db \
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
  CATALYST_CLI_SOURCE='$SRC1' CATALYST_CLI_BIN_DIR='$BIN1' $INSTALL_CLI --force >/dev/null 2>&1
"

run "second run leaves 8 symlinks" bash -c "
  count=\$(find '$BIN1' -maxdepth 1 -type l | wc -l | tr -d ' ')
  [[ \"\$count\" = '8' ]]
"

# ── 7. re-point on source move — symlinks point at new location ────────────
SRC2="$SCRATCH/plugin2/scripts"
setup_source "$SRC2"
run "re-install with new source updates targets" bash -c "
  CATALYST_CLI_SOURCE='$SRC2' CATALYST_CLI_BIN_DIR='$BIN1' $INSTALL_CLI >/dev/null
  target=\$(readlink '$BIN1/catalyst-comms')
  [[ \"\$target\" = '$SRC2/catalyst-comms' ]]
"

# ── 8. PATH bootstrap output mentions BIN_DIR when not on PATH ─────────────
HOME3="$SCRATCH/home3"
mkdir -p "$HOME3"
BIN3="$SCRATCH/bin3"
setup_source "$SCRATCH/plugin3/scripts"
run "PATH bootstrap output mentions bin dir when not on PATH" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME3' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin3/scripts' CATALYST_BIN_DIR='$BIN3' \
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
  CATALYST_CLI_SOURCE='$SCRATCH/plugin5/scripts' CATALYST_CLI_BIN_DIR='$BIN5' $INSTALL_CLI --force >/dev/null
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

# ── 14. defaults to ~/.catalyst/bin even when ~/.local/bin exists (CTL-339) ─
HOME8="$SCRATCH/home8"
mkdir -p "$HOME8/.local/bin"
setup_source "$SCRATCH/plugin8/scripts"
run "defaults to ~/.catalyst/bin even when ~/.local/bin exists" bash -c "
  PATH='$HOME8/.catalyst/bin:$HOME8/.local/bin:/usr/bin:/bin' HOME='$HOME8' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin8/scripts' \
    $INSTALL_CLI > '$SCRATCH/out8' 2>&1
  [[ -L '$HOME8/.catalyst/bin/catalyst-events' ]] \\
    && [[ ! -e '$HOME8/.local/bin/catalyst-events' ]]
"

# ── 14b. CATALYST_BIN_DIR env var overrides default ────────────────────────
HOME8B="$SCRATCH/home8b"
BIN8B="$SCRATCH/custom8b"
setup_source "$SCRATCH/plugin8b/scripts"
run "CATALYST_BIN_DIR env var overrides default" bash -c "
  PATH='$BIN8B:/usr/bin:/bin' HOME='$HOME8B' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin8b/scripts' CATALYST_BIN_DIR='$BIN8B' \
    $INSTALL_CLI > '$SCRATCH/out8b' 2>&1
  [[ -L '$BIN8B/catalyst-events' ]]
"

# ── 14c. CATALYST_BIN_DIR takes precedence over CATALYST_CLI_BIN_DIR ───────
HOME8C="$SCRATCH/home8c"
BIN8C_NEW="$SCRATCH/new8c"
BIN8C_OLD="$SCRATCH/old8c"
setup_source "$SCRATCH/plugin8c/scripts"
run "CATALYST_BIN_DIR wins over CATALYST_CLI_BIN_DIR" bash -c "
  PATH='$BIN8C_NEW:/usr/bin:/bin' HOME='$HOME8C' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin8c/scripts' \
    CATALYST_BIN_DIR='$BIN8C_NEW' CATALYST_CLI_BIN_DIR='$BIN8C_OLD' \
    $INSTALL_CLI > '$SCRATCH/out8c' 2>&1
  [[ -L '$BIN8C_NEW/catalyst-events' && ! -e '$BIN8C_OLD/catalyst-events' ]]
"

# ── 15. CATALYST_CLI_BIN_DIR still honored when CATALYST_BIN_DIR unset ─────
HOME9="$SCRATCH/home9"
BIN9="$SCRATCH/legacy9"
setup_source "$SCRATCH/plugin9/scripts"
run "CATALYST_CLI_BIN_DIR backward compat still works" bash -c "
  PATH='$BIN9:/usr/bin:/bin' HOME='$HOME9' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin9/scripts' CATALYST_CLI_BIN_DIR='$BIN9' \
    $INSTALL_CLI > '$SCRATCH/out9' 2>&1
  [[ -L '$BIN9/catalyst-events' ]]
"

# ── 16. --bin-dir overrides default ────────────────────────────────────────
HOME10="$SCRATCH/home10"
mkdir -p "$HOME10/.local/bin"
BIN10="$SCRATCH/custom-bin10"
setup_source "$SCRATCH/plugin10/scripts"
run "--bin-dir overrides default" bash -c "
  PATH='$BIN10:/usr/bin:/bin' HOME='$HOME10' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin10/scripts' \
    $INSTALL_CLI --bin-dir '$BIN10' > '$SCRATCH/out10' 2>&1
  [[ -L '$BIN10/catalyst-events' && ! -e '$HOME10/.local/bin/catalyst-events' ]]
"

# ── 17. --bin-dir requires an argument ─────────────────────────────────────
run "--bin-dir without arg fails" expect_exit 2 bash -c "
  $INSTALL_CLI --bin-dir
"

# ── 18. PATH bootstrap appends to .zshrc when bin dir not on PATH (CTL-339) ─
HOME18="$SCRATCH/home18"
mkdir -p "$HOME18"
echo "# original rc" > "$HOME18/.zshrc"
BIN18="$HOME18/.catalyst/bin"
setup_source "$SCRATCH/plugin18/scripts"
run "PATH bootstrap appends export line to ~/.zshrc" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME18' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin18/scripts' CATALYST_BIN_DIR='$BIN18' \
    $INSTALL_CLI > '$SCRATCH/out18' 2>&1
  grep -qF 'Added by catalyst install-cli.sh' '$HOME18/.zshrc' \\
    && grep -qF 'export PATH=\"$BIN18:\$PATH\"' '$HOME18/.zshrc'
"
run "PATH bootstrap exits 0 after appending" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME18.rerun' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin18/scripts' \
    CATALYST_BIN_DIR='$HOME18.rerun/.catalyst/bin' \
    $INSTALL_CLI >/dev/null 2>&1
"
run "PATH bootstrap is idempotent — no duplicate rc lines on re-run" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME18' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin18/scripts' CATALYST_BIN_DIR='$BIN18' \
    $INSTALL_CLI > '$SCRATCH/out18b' 2>&1
  count=\$(grep -cF 'Added by catalyst install-cli.sh' '$HOME18/.zshrc')
  [[ \"\$count\" = '1' ]]
"

# ── 19. PATH bootstrap targets ~/.bashrc when SHELL=bash ────────────────────
HOME19="$SCRATCH/home19"
mkdir -p "$HOME19"
echo "# original rc" > "$HOME19/.bashrc"
BIN19="$HOME19/.catalyst/bin"
setup_source "$SCRATCH/plugin19/scripts"
run "PATH bootstrap appends to ~/.bashrc when SHELL=bash" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME19' SHELL=/bin/bash \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin19/scripts' CATALYST_BIN_DIR='$BIN19' \
    $INSTALL_CLI > '$SCRATCH/out19' 2>&1
  grep -qF 'Added by catalyst install-cli.sh' '$HOME19/.bashrc' \\
    && grep -qF 'export PATH=\"$BIN19:\$PATH\"' '$HOME19/.bashrc'
"

# ── 19b. PATH bootstrap uses fish syntax when SHELL=fish ────────────────────
HOME19F="$SCRATCH/home19f"
mkdir -p "$HOME19F"
BIN19F="$HOME19F/.catalyst/bin"
setup_source "$SCRATCH/plugin19f/scripts"
run "PATH bootstrap uses set -gx for fish" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME19F' SHELL=/usr/local/bin/fish \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin19f/scripts' CATALYST_BIN_DIR='$BIN19F' \
    $INSTALL_CLI > '$SCRATCH/out19f' 2>&1
  grep -qF 'Added by catalyst install-cli.sh' '$HOME19F/.config/fish/config.fish' \\
    && grep -qE 'set -gx PATH \"$BIN19F\"' '$HOME19F/.config/fish/config.fish'
"

# ── 19c. PATH bootstrap does NOT modify rc when bin dir already on PATH ─────
HOME19C="$SCRATCH/home19c"
mkdir -p "$HOME19C"
echo "# pristine rc" > "$HOME19C/.zshrc"
BIN19C="$HOME19C/.catalyst/bin"
setup_source "$SCRATCH/plugin19c/scripts"
run "PATH bootstrap skips rc edit when already on PATH" bash -c "
  PATH='$BIN19C:/usr/bin:/bin' HOME='$HOME19C' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin19c/scripts' CATALYST_BIN_DIR='$BIN19C' \
    $INSTALL_CLI > '$SCRATCH/out19c' 2>&1
  ! grep -qF 'Added by catalyst install-cli.sh' '$HOME19C/.zshrc'
"

# ── 20. Stale alias detection — warns about ~/.zshrc with a catalyst-* alias ─
HOME20="$SCRATCH/home20"
mkdir -p "$HOME20"
cat > "$HOME20/.zshrc" <<'RC'
# misc setup
alias catalyst-comms=/Users/old/code/catalyst/plugins/dev/scripts/catalyst-comms
RC
BIN20="$HOME20/.catalyst/bin"
setup_source "$SCRATCH/plugin20/scripts"
run "warns about stale alias in ~/.zshrc" bash -c "
  PATH='$BIN20:/usr/bin:/bin' HOME='$HOME20' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin20/scripts' CATALYST_CLI_BIN_DIR='$BIN20' \
    $INSTALL_CLI > '$SCRATCH/out20' 2>&1
  grep -qiE 'stale.*alias|alias.*shadow' '$SCRATCH/out20' && grep -qF '.zshrc' '$SCRATCH/out20'
"

# ── 21. No stale aliases → no warning ───────────────────────────────────────
HOME21="$SCRATCH/home21"
mkdir -p "$HOME21"
echo "# clean rc" > "$HOME21/.zshrc"
BIN21="$HOME21/.catalyst/bin"
setup_source "$SCRATCH/plugin21/scripts"
run "no warning when no stale alias" bash -c "
  PATH='$BIN21:/usr/bin:/bin' HOME='$HOME21' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin21/scripts' CATALYST_CLI_BIN_DIR='$BIN21' \
    $INSTALL_CLI > '$SCRATCH/out21' 2>&1
  ! grep -qiE 'stale.*alias|alias.*shadow' '$SCRATCH/out21'
"

# ── 22. No rc files → no warning, no error ──────────────────────────────────
HOME22="$SCRATCH/home22"
mkdir -p "$HOME22"   # NO rc files at all
BIN22="$HOME22/.catalyst/bin"
setup_source "$SCRATCH/plugin22/scripts"
run "no warning when rc files absent" bash -c "
  PATH='$BIN22:/usr/bin:/bin' HOME='$HOME22' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin22/scripts' CATALYST_CLI_BIN_DIR='$BIN22' \
    $INSTALL_CLI > '$SCRATCH/out22' 2>&1
  ! grep -qiE 'stale.*alias' '$SCRATCH/out22'
"

# ── 23. CTL-339: sweeps stale source-repo symlinks at target dir ───────────
HOME23="$SCRATCH/home23"
BIN23="$HOME23/.catalyst/bin"
FAKE_CLONE23="$SCRATCH/fake-clone23/plugins/dev/scripts"
mkdir -p "$BIN23" "$FAKE_CLONE23"
echo '#!/bin/sh' > "$FAKE_CLONE23/catalyst-monitor.sh"
chmod +x "$FAKE_CLONE23/catalyst-monitor.sh"
ln -s "$FAKE_CLONE23/catalyst-monitor.sh" "$BIN23/catalyst-monitor"
setup_source "$SCRATCH/plugin23/scripts"
run "sweeps stale source-repo symlink at \$BIN_DIR" bash -c "
  PATH='$BIN23:/usr/bin:/bin' HOME='$HOME23' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin23/scripts' CATALYST_BIN_DIR='$BIN23' \
    $INSTALL_CLI > '$SCRATCH/out23' 2>&1
  target=\$(readlink '$BIN23/catalyst-monitor')
  [[ \"\$target\" = '$SCRATCH/plugin23/scripts/catalyst-monitor.sh' ]]
"

# ── 24. CTL-339: preserves register-thought / workflow-context source symlinks ─
HOME24="$SCRATCH/home24"
BIN24="$HOME24/.catalyst/bin"
FAKE_CLONE24="$SCRATCH/fake-clone24/plugins/dev/scripts"
mkdir -p "$BIN24" "$FAKE_CLONE24"
echo '#!/bin/sh' > "$FAKE_CLONE24/register-thought.sh"
chmod +x "$FAKE_CLONE24/register-thought.sh"
ln -s "$FAKE_CLONE24/register-thought.sh" "$BIN24/register-thought"
setup_source "$SCRATCH/plugin24/scripts"
run "preserves register-thought source symlink (not catalyst-* prefix)" bash -c "
  PATH='$BIN24:/usr/bin:/bin' HOME='$HOME24' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin24/scripts' CATALYST_BIN_DIR='$BIN24' \
    $INSTALL_CLI > '$SCRATCH/out24' 2>&1 || true
  # register-thought was either replaced by the install loop (since it IS in
  # CLI_ENTRIES) OR preserved if missing from source. The sweep itself must
  # NOT touch it — re-create + verify the sweep alone leaves it.
  rm -f '$BIN24/register-thought'
  ln -s '$FAKE_CLONE24/register-thought.sh' '$BIN24/register-thought'
  # Run a sweep-only scenario: source has no register-thought.sh, so the install
  # loop will skip it, leaving only the sweep behavior to test.
  rm -f '$SCRATCH/plugin24/scripts/register-thought.sh'
  PATH='$BIN24:/usr/bin:/bin' HOME='$HOME24' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin24/scripts' CATALYST_BIN_DIR='$BIN24' \
    $INSTALL_CLI > '$SCRATCH/out24b' 2>&1 || true
  target=\$(readlink '$BIN24/register-thought' 2>/dev/null)
  [[ \"\$target\" = '$FAKE_CLONE24/register-thought.sh' ]]
"

# ── 25. CTL-339: preserves cache-path symlinks at target dir ────────────────
HOME25="$SCRATCH/home25"
BIN25="$HOME25/.catalyst/bin"
FAKE_CACHE25="$HOME25/.claude/plugins/cache/catalyst/catalyst-dev/9.0.0/scripts"
mkdir -p "$BIN25" "$FAKE_CACHE25"
echo '#!/bin/sh' > "$FAKE_CACHE25/catalyst-monitor.sh"
chmod +x "$FAKE_CACHE25/catalyst-monitor.sh"
ln -s "$FAKE_CACHE25/catalyst-monitor.sh" "$BIN25/catalyst-monitor"
# Use a separate non-cache source so install doesn't overwrite this link
setup_source "$SCRATCH/plugin25/scripts"
rm -f "$SCRATCH/plugin25/scripts/catalyst-monitor.sh"   # so install skips it
run "preserves cache-path symlinks at target dir" bash -c "
  PATH='$BIN25:/usr/bin:/bin' HOME='$HOME25' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin25/scripts' CATALYST_BIN_DIR='$BIN25' \
    $INSTALL_CLI > '$SCRATCH/out25' 2>&1 || true
  target=\$(readlink '$BIN25/catalyst-monitor' 2>/dev/null)
  [[ \"\$target\" = '$FAKE_CACHE25/catalyst-monitor.sh' ]]
"

# ── 26. CTL-339: sweeps our shims from ~/.local/bin ─────────────────────────
HOME26="$SCRATCH/home26"
LOCAL26="$HOME26/.local/bin"
BIN26="$HOME26/.catalyst/bin"
mkdir -p "$LOCAL26"
# A wrapper shim with our marker
cat > "$LOCAL26/catalyst-events" <<'WRAP'
#!/usr/bin/env bash
# Auto-generated by catalyst install-cli.sh (version-auto) — do not edit
exec /tmp/old "$@"
WRAP
chmod +x "$LOCAL26/catalyst-events"
# A symlink pointing into /plugins/dev/scripts/
FAKE_CLONE26="$SCRATCH/clone26/plugins/dev/scripts"
mkdir -p "$FAKE_CLONE26"
echo '#!/bin/sh' > "$FAKE_CLONE26/catalyst-comms"
chmod +x "$FAKE_CLONE26/catalyst-comms"
ln -s "$FAKE_CLONE26/catalyst-comms" "$LOCAL26/catalyst-comms"
# An unrelated catalyst-named file (no marker) — must be preserved
echo '#!/usr/bin/env bash' > "$LOCAL26/catalyst-monitor"
echo 'echo "my custom monitor"' >> "$LOCAL26/catalyst-monitor"
chmod +x "$LOCAL26/catalyst-monitor"
setup_source "$SCRATCH/plugin26/scripts"
run "sweeps wrapper shim from ~/.local/bin" bash -c "
  PATH='$BIN26:/usr/bin:/bin' HOME='$HOME26' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin26/scripts' CATALYST_BIN_DIR='$BIN26' \
    $INSTALL_CLI > '$SCRATCH/out26' 2>&1
  [[ ! -e '$LOCAL26/catalyst-events' ]]
"
run "sweeps symlink shim from ~/.local/bin" bash -c "
  [[ ! -e '$LOCAL26/catalyst-comms' ]]
"
run "preserves unrelated catalyst-named files in ~/.local/bin" bash -c "
  [[ -f '$LOCAL26/catalyst-monitor' ]] \\
    && grep -qF 'my custom monitor' '$LOCAL26/catalyst-monitor'
"

# ── 27. CTL-339: ~/.local/bin sweep skipped when target IS ~/.local/bin ─────
HOME27="$SCRATCH/home27"
LOCAL27="$HOME27/.local/bin"
mkdir -p "$LOCAL27"
setup_source "$SCRATCH/plugin27/scripts"
run "no sweep when target is ~/.local/bin (no self-deletion)" bash -c "
  PATH='$LOCAL27:/usr/bin:/bin' HOME='$HOME27' \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin27/scripts' CATALYST_BIN_DIR='$LOCAL27' \
    $INSTALL_CLI > '$SCRATCH/out27' 2>&1
  [[ -L '$LOCAL27/catalyst-events' ]]
"

# ── 28. CTL-339: full idempotency — double-run = identical state ────────────
HOME28="$SCRATCH/home28"
BIN28="$HOME28/.catalyst/bin"
mkdir -p "$HOME28"
echo "# pristine" > "$HOME28/.zshrc"
setup_source "$SCRATCH/plugin28/scripts"
run "first install run completes" bash -c "
  PATH='/usr/bin:/bin' HOME='$HOME28' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin28/scripts' CATALYST_BIN_DIR='$BIN28' \
    $INSTALL_CLI > '$SCRATCH/out28a' 2>&1
"
run "second install run produces identical rc file" bash -c "
  cp '$HOME28/.zshrc' '$SCRATCH/zshrc-after-first'
  PATH='/usr/bin:/bin' HOME='$HOME28' SHELL=/bin/zsh \
    CATALYST_CLI_SOURCE='$SCRATCH/plugin28/scripts' CATALYST_BIN_DIR='$BIN28' \
    $INSTALL_CLI > '$SCRATCH/out28b' 2>&1
  diff -q '$SCRATCH/zshrc-after-first' '$HOME28/.zshrc'
"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "install-cli: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
