#!/usr/bin/env bash
# Shell tests for setup-plugin-source.sh (CTL-992): provisions a pristine
# main-only plugin-source checkout and registers it as
# catalyst.orchestration.pluginDirs in the machine config. Idempotent;
# refuses linked worktrees and non-main branches.
# Run: bash plugins/dev/scripts/__tests__/setup-plugin-source.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/plugins/dev/scripts/setup-plugin-source.sh"
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

# make_origin NAME → bare origin.git with plugins/dev seeded; sets ORIGIN, SEED.
make_origin() {
  local base="${SCRATCH}/orig_$1"
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
  ORIGIN="${base}/origin.git"
  SEED="${base}/seed"
}

advance_origin() {
  echo "v2" > "${SEED}/plugins/dev/marker.txt"
  $GITC -C "${SEED}" commit -qam "update marker"
  $GITC -C "${SEED}" push -q origin main
}

# run_setup MACHINE_CFG PATH_ARG REPO_URL [extra args...]
# Passes --no-interactive-wrapper so the pluginDirs-registration tests never touch
# the tester's real shell rc files. The wrapper behavior is covered separately by
# the wrapper_* cases below (which invoke the script with an isolated $HOME).
run_setup() {
  local mcfg="$1" path_arg="$2" url="$3"; shift 3
  env PATH="$REAL_PATH" CATALYST_MACHINE_CONFIG="$mcfg" GIT_TERMINAL_PROMPT=0 \
    bash "$SETUP" --path "$path_arg" --repo-url "$url" --no-interactive-wrapper "$@"
}

# run_setup_hb — like run_setup but with an isolated HOME/ZDOTDIR/SHELL and WITHOUT
# --no-interactive-wrapper, so the interactive `claude` wrapper install is exercised
# against a throwaway home dir instead of the tester's real rc files.
run_setup_hb() {
  local home="$1" shell="$2" mcfg="$3" path_arg="$4" url="$5"; shift 5
  env PATH="$REAL_PATH" CATALYST_MACHINE_CONFIG="$mcfg" GIT_TERMINAL_PROMPT=0 \
    HOME="$home" ZDOTDIR="$home" SHELL="$shell" \
    bash "$SETUP" --path "$path_arg" --repo-url "$url" "$@"
}

echo "setup-plugin-source (CTL-992) tests"

# ── 1. fresh clone → clones + registers pluginDirs in machine config ────────
make_origin fresh
MCFG1="${SCRATCH}/mcfg1.json"
CO1="${SCRATCH}/co1"
t1() {
  local rc reg head
  run_setup "$MCFG1" "$CO1" "$ORIGIN" >/dev/null 2>&1; rc=$?
  [[ $rc -eq 0 ]] || return 1
  [[ -f "${CO1}/.git/HEAD" || -d "${CO1}/.git" ]] || return 1
  reg="$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG1")"
  [[ "$reg" == "${CO1}/plugins/dev" ]] || return 1
  head="$($GITC -C "$CO1" rev-parse --abbrev-ref HEAD)"
  [[ "$head" == "main" ]]
}
check "fresh clone registers pluginDirs and lands on main" t1

# ── 2. reuse + behind → ff-pulls to v2 ──────────────────────────────────────
make_origin behind
MCFG2="${SCRATCH}/mcfg2.json"
CO2="${SCRATCH}/co2"
$GITC clone -q "$ORIGIN" "$CO2"
advance_origin
t2() {
  run_setup "$MCFG2" "$CO2" "$ORIGIN" >/dev/null 2>&1 || return 1
  grep -q "v2" "${CO2}/plugins/dev/marker.txt"
}
check "reuse of a behind checkout ff-pulls to origin/main" t2

# ── 3. idempotent: second run is a no-op write ──────────────────────────────
make_origin idem
MCFG3="${SCRATCH}/mcfg3.json"
CO3="${SCRATCH}/co3"
t3() {
  run_setup "$MCFG3" "$CO3" "$ORIGIN" >/dev/null 2>&1 || return 1
  local out
  out="$(run_setup "$MCFG3" "$CO3" "$ORIGIN" 2>&1)" || return 1
  grep -qi "already registered" <<<"$out"
}
check "second run with same args reports already-registered" t3

# ── 4. preserves unrelated machine-config keys ──────────────────────────────
make_origin preserve
MCFG4="${SCRATCH}/mcfg4.json"
printf '%s\n' '{"catalyst":{"host":{"name":"x"}},"groq":{"apiKey":"k"}}' > "$MCFG4"
CO4="${SCRATCH}/co4"
t4() {
  run_setup "$MCFG4" "$CO4" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(jq -r '.catalyst.host.name' "$MCFG4")" == "x" ]] || return 1
  [[ "$(jq -r '.groq.apiKey' "$MCFG4")" == "k" ]] || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG4")" == "${CO4}/plugins/dev" ]]
}
check "preserves unrelated machine-config keys" t4

# ── 5. refuses a linked worktree ────────────────────────────────────────────
make_origin linkrefuse
MCFG5="${SCRATCH}/mcfg5.json"
PRIMARY5="${SCRATCH}/primary5"
$GITC clone -q "$ORIGIN" "$PRIMARY5"
$GITC -C "$PRIMARY5" checkout -q -b parking
LINKED5="${SCRATCH}/linked5"
$GITC -C "$PRIMARY5" worktree add -q "$LINKED5" main
t5() {
  local out rc
  out="$(run_setup "$MCFG5" "$LINKED5" "$ORIGIN" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "worktree" <<<"$out"
}
check "refuses a linked worktree as the plugin source" t5

# ── 6. refuses a non-main branch ────────────────────────────────────────────
make_origin branchrefuse
MCFG6="${SCRATCH}/mcfg6.json"
CO6="${SCRATCH}/co6"
$GITC clone -q "$ORIGIN" "$CO6"
$GITC -C "$CO6" checkout -q -b feature
t6() {
  local out rc
  out="$(run_setup "$MCFG6" "$CO6" "$ORIGIN" 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "main" <<<"$out"
}
check "refuses a checkout on a non-main branch" t6

# ── 7. --force re-registers even when already set ───────────────────────────
make_origin forcecase
MCFG7="${SCRATCH}/mcfg7.json"
CO7A="${SCRATCH}/co7a"
CO7B="${SCRATCH}/co7b"
t7() {
  run_setup "$MCFG7" "$CO7A" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG7")" == "${CO7A}/plugins/dev" ]] || return 1
  run_setup "$MCFG7" "$CO7B" "$ORIGIN" --force >/dev/null 2>&1 || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG7")" == "${CO7B}/plugins/dev" ]]
}
check "--force re-registers a new checkout path" t7

# ── 8. creates machine config when absent ───────────────────────────────────
make_origin createcfg
MCFG8="${SCRATCH}/sub/dir/mcfg8.json"   # parent dir does not exist
CO8="${SCRATCH}/co8"
t8() {
  [[ ! -e "$MCFG8" ]] || return 1
  run_setup "$MCFG8" "$CO8" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ -f "$MCFG8" ]] || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG8")" == "${CO8}/plugins/dev" ]]
}
check "creates the machine config (and parent dir) when absent" t8

# ── 9. zsh: interactive wrapper written to ~/.zshrc (isolated HOME) ──────────
make_origin wrapzsh
MCFG9="${SCRATCH}/mcfg9.json"
HOME9="${SCRATCH}/home9"; mkdir -p "$HOME9"
CO9="${SCRATCH}/co9"
t9() {
  run_setup_hb "$HOME9" "/bin/zsh" "$MCFG9" "$CO9" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ -f "${HOME9}/.zshrc" ]] || return 1
  grep -q ">>> catalyst plugin-source" "${HOME9}/.zshrc" || return 1
  # rerun stays idempotent: exactly one managed block.
  run_setup_hb "$HOME9" "/bin/zsh" "$MCFG9" "$CO9" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(grep -c '>>> catalyst plugin-source' "${HOME9}/.zshrc")" == "1" ]]
}
check "zsh: installs idempotent interactive wrapper in ~/.zshrc" t9

# ── 10. bash: interactive wrapper written to ~/.bashrc (isolated HOME) ───────
make_origin wrapbash
MCFG10="${SCRATCH}/mcfg10.json"
HOME10="${SCRATCH}/home10"; mkdir -p "$HOME10"
CO10="${SCRATCH}/co10"
t10() {
  run_setup_hb "$HOME10" "/bin/bash" "$MCFG10" "$CO10" "$ORIGIN" >/dev/null 2>&1 || return 1
  grep -q ">>> catalyst plugin-source" "${HOME10}/.bashrc" || return 1
  [[ ! -e "${HOME10}/.zshrc" ]]
}
check "bash: installs interactive wrapper in ~/.bashrc (not ~/.zshrc)" t10

# ── 11. --no-interactive-wrapper: leaves rc files untouched ──────────────────
make_origin nowrap
MCFG11="${SCRATCH}/mcfg11.json"
HOME11="${SCRATCH}/home11"; mkdir -p "$HOME11"
CO11="${SCRATCH}/co11"
t11() {
  run_setup_hb "$HOME11" "/bin/zsh" "$MCFG11" "$CO11" "$ORIGIN" --no-interactive-wrapper >/dev/null 2>&1 || return 1
  [[ ! -e "${HOME11}/.zshrc" && ! -e "${HOME11}/.bashrc" ]] || return 1
  # config write still happened.
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG11")" == "${CO11}/plugins/dev" ]]
}
check "--no-interactive-wrapper skips rc edit but still registers pluginDirs" t11

# ── 12. symlinked ~/.zshrc (dotfiles repo) preserved on rerun ────────────────
make_origin wrapsymlink
MCFG12="${SCRATCH}/mcfg12.json"
HOME12="${SCRATCH}/home12"; mkdir -p "${HOME12}/dotfiles"
printf '# managed by dotfiles\n' > "${HOME12}/dotfiles/zshrc"
ln -s "${HOME12}/dotfiles/zshrc" "${HOME12}/.zshrc"
CO12="${SCRATCH}/co12"
t12() {
  run_setup_hb "$HOME12" "/bin/zsh" "$MCFG12" "$CO12" "$ORIGIN" >/dev/null 2>&1 || return 1
  run_setup_hb "$HOME12" "/bin/zsh" "$MCFG12" "$CO12" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ -L "${HOME12}/.zshrc" ]] || return 1                       # still a symlink
  [[ "$(grep -c '>>> catalyst plugin-source' "${HOME12}/.zshrc")" == "1" ]] || return 1
  grep -q "managed by dotfiles" "${HOME12}/dotfiles/zshrc"      # wrote through the link
}
check "symlinked ~/.zshrc is preserved (not replaced by a regular file)" t12

# ── 13. read-only ~/.zshrc: wrapper is best-effort, pluginDirs still set ─────
make_origin wrapreadonly
MCFG13="${SCRATCH}/mcfg13.json"
HOME13="${SCRATCH}/home13"; mkdir -p "$HOME13"
printf '# read only\n' > "${HOME13}/.zshrc"; chmod 0444 "${HOME13}/.zshrc"
CO13="${SCRATCH}/co13"
t13() {
  # Under the script's set -e, a read-only rc must NOT abort before the config write.
  run_setup_hb "$HOME13" "/bin/zsh" "$MCFG13" "$CO13" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG13")" == "${CO13}/plugins/dev" ]]
}
check "read-only ~/.zshrc is non-fatal; pluginDirs still registered" t13

echo ""
TOTAL=$((PASSES + FAILURES))
echo "setup-plugin-source: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
