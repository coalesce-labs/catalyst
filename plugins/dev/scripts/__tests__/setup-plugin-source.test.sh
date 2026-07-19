#!/usr/bin/env bash
# Shell tests for setup-plugin-source.sh: provisions a pristine main-only
# plugin-source checkout, registers it as catalyst.orchestration.pluginDirs in the
# machine config (CTL-992), and — the skills-dir-plugin migration — points every
# session type Claude Code resolves plugins for at that same live checkout via
# user-scope ~/.claude/skills symlinks, retiring the interactive `claude()`
# --plugin-dir wrapper and (full mode) the version-keyed `catalyst` marketplace.
# The pluginDirs machine-config key STAYS: the daemon / SDK / Codex executors load
# plugins from it (the Agent SDK does not auto-load ~/.claude/skills plugins).
# Idempotent; refuses linked worktrees and non-main branches.
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

# A stub `claude` so the marketplace-retirement CLI calls are deterministic and
# never touch the tester's real plugin state: it reports an empty plugin +
# marketplace list, so uninstall / marketplace-remove are never reached. The jq
# enabledPlugins-clearing path (which needs no `claude`) still runs for real.
STUBBIN="${SCRATCH}/stubbin"
mkdir -p "$STUBBIN"
cat > "${STUBBIN}/claude" <<'STUB'
#!/usr/bin/env bash
# args: plugin list | plugin marketplace list|remove | plugin uninstall <p> -y
if [[ "${1:-}" == "plugin" ]]; then
  case "${2:-}" in
    list) exit 0 ;;                       # nothing installed
    marketplace) exit 0 ;;                # `marketplace list` empty; `remove` no-op
    uninstall) exit 0 ;;
  esac
fi
exit 0
STUB
chmod +x "${STUBBIN}/claude"

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

# make_origin NAME → bare origin.git with plugins/dev + plugins/pm seeded (each
# with a .claude-plugin/plugin.json carrying its own `name`); sets ORIGIN, SEED.
# Two plugins so the skills-dir cases can assert EVERY plugin is symlinked (keyed
# by manifest name, not dir name — catalyst-dev/catalyst-pm, not dev/pm).
make_origin() {
  local base="${SCRATCH}/orig_$1"
  mkdir -p "${base}/seed"
  $GITC -C "${base}/seed" init -q
  mkdir -p "${base}/seed/plugins/dev/.claude-plugin" "${base}/seed/plugins/pm/.claude-plugin"
  echo '{"name":"catalyst-dev","version":"1.0.0"}' \
    > "${base}/seed/plugins/dev/.claude-plugin/plugin.json"
  echo '{"name":"catalyst-pm","version":"1.0.0"}' \
    > "${base}/seed/plugins/pm/.claude-plugin/plugin.json"
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
# Passes --no-interactive-wrapper so the pluginDirs-registration tests stay in the
# git-reconstructable path (no rc-file / marketplace cutover). Skills-dir + cutover
# behavior is covered by the *_hb cases below (isolated $HOME + stub `claude`).
# HOME is ALSO isolated here: --no-interactive-wrapper still creates the (reversible)
# ~/.claude/skills symlinks, so without an isolated HOME these config-focused cases
# would clobber the tester's real ~/.claude/skills. Each run gets a fresh throwaway.
run_setup() {
  local mcfg="$1" path_arg="$2" url="$3"; shift 3
  local rh; rh="$(mktemp -d "${SCRATCH}/rh.XXXXXX")"
  env PATH="$REAL_PATH" CATALYST_MACHINE_CONFIG="$mcfg" GIT_TERMINAL_PROMPT=0 \
    HOME="$rh" \
    bash "$SETUP" --path "$path_arg" --repo-url "$url" --no-interactive-wrapper "$@"
}

# run_setup_hb — isolated HOME/ZDOTDIR/SHELL, stub `claude` prepended to PATH, and
# (by default) FULL cutover mode, so the skills-dir symlinks + wrapper removal +
# marketplace retirement run against a throwaway home instead of the tester's real
# state. Pass --no-interactive-wrapper as an extra arg to exercise acquire mode.
run_setup_hb() {
  local home="$1" shell="$2" mcfg="$3" path_arg="$4" url="$5"; shift 5
  env PATH="${STUBBIN}:$REAL_PATH" CATALYST_MACHINE_CONFIG="$mcfg" GIT_TERMINAL_PROMPT=0 \
    HOME="$home" ZDOTDIR="$home" SHELL="$shell" \
    bash "$SETUP" --path "$path_arg" --repo-url "$url" "$@"
}

# A verbatim copy of the managed wrapper block markers, for seeding a legacy rc.
legacy_wrapper_block() {
  cat <<'BLK'
# >>> catalyst plugin-source (managed) >>>
claude() {
  command claude --plugin-dir /whatever "$@"
}
# <<< catalyst plugin-source (managed) <<<
BLK
}

echo "setup-plugin-source tests"

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

# ── 9. skills-dir symlinks created for EVERY plugin; NO wrapper installed ────
make_origin skzsh
MCFG9="${SCRATCH}/mcfg9.json"
HOME9="${SCRATCH}/home9"; mkdir -p "$HOME9"
CO9="${SCRATCH}/co9"
t9() {
  run_setup_hb "$HOME9" "/bin/zsh" "$MCFG9" "$CO9" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ -L "${HOME9}/.claude/skills/catalyst-dev" ]] || return 1
  [[ -L "${HOME9}/.claude/skills/catalyst-pm" ]] || return 1
  [[ "$(readlink "${HOME9}/.claude/skills/catalyst-dev")" == "${CO9}/plugins/dev" ]] || return 1
  [[ "$(readlink "${HOME9}/.claude/skills/catalyst-pm")" == "${CO9}/plugins/pm" ]] || return 1
  # the script no longer installs the interactive --plugin-dir wrapper
  ! { [[ -f "${HOME9}/.zshrc" ]] && grep -q ">>> catalyst plugin-source" "${HOME9}/.zshrc"; }
}
check "creates ~/.claude/skills symlinks for every plugin; installs no wrapper" t9

# ── 10. skills-dir symlinks idempotent + repoint a stale link ───────────────
make_origin skidem
MCFG10="${SCRATCH}/mcfg10.json"
HOME10="${SCRATCH}/home10"; mkdir -p "$HOME10"
CO10="${SCRATCH}/co10"
t10() {
  run_setup_hb "$HOME10" "/bin/zsh" "$MCFG10" "$CO10" "$ORIGIN" >/dev/null 2>&1 || return 1
  # rerun: still exactly one correct symlink each (idempotent, no dup/error)
  run_setup_hb "$HOME10" "/bin/zsh" "$MCFG10" "$CO10" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(readlink "${HOME10}/.claude/skills/catalyst-dev")" == "${CO10}/plugins/dev" ]] || return 1
  # point it somewhere stale, rerun → repointed to the correct target
  ln -sfn /tmp/stale "${HOME10}/.claude/skills/catalyst-dev"
  run_setup_hb "$HOME10" "/bin/zsh" "$MCFG10" "$CO10" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(readlink "${HOME10}/.claude/skills/catalyst-dev")" == "${CO10}/plugins/dev" ]]
}
check "skills-dir symlinks are idempotent and repoint a stale link" t10

# ── 11. --no-interactive-wrapper: symlinks + pluginDirs, but NO cutover ──────
make_origin acquire
MCFG11="${SCRATCH}/mcfg11.json"
HOME11="${SCRATCH}/home11"; mkdir -p "${HOME11}/.claude"
legacy_wrapper_block > "${HOME11}/.zshrc"                       # pre-existing wrapper
printf '%s\n' '{"enabledPlugins":{"catalyst-dev@catalyst":true,"other@x":true}}' \
  > "${HOME11}/.claude/settings.json"
CO11="${SCRATCH}/co11"
t11() {
  run_setup_hb "$HOME11" "/bin/zsh" "$MCFG11" "$CO11" "$ORIGIN" --no-interactive-wrapper >/dev/null 2>&1 || return 1
  # symlinks + pluginDirs DID run (reconstructable path)
  [[ -L "${HOME11}/.claude/skills/catalyst-dev" ]] || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG11")" == "${CO11}/plugins/dev" ]] || return 1
  # cutover was SKIPPED: wrapper block untouched, enablement not cleared
  grep -q ">>> catalyst plugin-source" "${HOME11}/.zshrc" || return 1
  [[ "$(jq -r '.enabledPlugins["catalyst-dev@catalyst"]' "${HOME11}/.claude/settings.json")" == "true" ]]
}
check "--no-interactive-wrapper does symlinks+pluginDirs but skips the cutover" t11

# ── 12. full mode strips a legacy wrapper block, preserving a symlinked rc ───
make_origin wraprm
MCFG12="${SCRATCH}/mcfg12.json"
HOME12="${SCRATCH}/home12"; mkdir -p "${HOME12}/dotfiles"
{ printf '# managed by dotfiles\n'; legacy_wrapper_block; } > "${HOME12}/dotfiles/zshrc"
ln -s "${HOME12}/dotfiles/zshrc" "${HOME12}/.zshrc"
CO12="${SCRATCH}/co12"
t12() {
  run_setup_hb "$HOME12" "/bin/zsh" "$MCFG12" "$CO12" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ -L "${HOME12}/.zshrc" ]] || return 1                                   # still a symlink
  [[ "$(grep -c '>>> catalyst plugin-source' "${HOME12}/.zshrc")" == "0" ]] || return 1  # block removed
  grep -q "managed by dotfiles" "${HOME12}/dotfiles/zshrc"                  # wrote through the link
}
check "full mode removes the legacy wrapper block, preserving a symlinked rc" t12

# ── 13. read-only rc carrying a wrapper block: non-fatal; symlinks still set ─
make_origin wrapro
MCFG13="${SCRATCH}/mcfg13.json"
HOME13="${SCRATCH}/home13"; mkdir -p "$HOME13"
legacy_wrapper_block > "${HOME13}/.zshrc"; chmod 0444 "${HOME13}/.zshrc"
CO13="${SCRATCH}/co13"
t13() {
  # A read-only rc must NOT abort before/around the essential config + symlink work.
  run_setup_hb "$HOME13" "/bin/zsh" "$MCFG13" "$CO13" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(jq -r '.catalyst.orchestration.pluginDirs' "$MCFG13")" == "${CO13}/plugins/dev" ]] || return 1
  [[ -L "${HOME13}/.claude/skills/catalyst-dev" ]]
}
check "read-only rc with a wrapper block is non-fatal; pluginDirs+symlinks set" t13

# ── 14. an existing non-symlink at the skills path is left untouched ─────────
make_origin skconflict
MCFG14="${SCRATCH}/mcfg14.json"
HOME14="${SCRATCH}/home14"; mkdir -p "${HOME14}/.claude/skills/catalyst-dev"
printf 'user file\n' > "${HOME14}/.claude/skills/catalyst-dev/keep.txt"
CO14="${SCRATCH}/co14"
t14() {
  run_setup_hb "$HOME14" "/bin/zsh" "$MCFG14" "$CO14" "$ORIGIN" >/dev/null 2>&1 || return 1
  # the pre-existing non-symlink dir is untouched (never clobbered)
  [[ ! -L "${HOME14}/.claude/skills/catalyst-dev" ]] || return 1
  [[ -f "${HOME14}/.claude/skills/catalyst-dev/keep.txt" ]] || return 1
  # the other plugin still gets its symlink
  [[ -L "${HOME14}/.claude/skills/catalyst-pm" ]]
}
check "an existing non-symlink at ~/.claude/skills/<name> is left untouched" t14

# ── 15. full mode clears catalyst-*@catalyst from user-scope enabledPlugins ──
make_origin mktclear
MCFG15="${SCRATCH}/mcfg15.json"
HOME15="${SCRATCH}/home15"; mkdir -p "${HOME15}/.claude"
printf '%s\n' '{"enabledPlugins":{"catalyst-dev@catalyst":true,"catalyst-pm@catalyst":true,"other@x":true}}' \
  > "${HOME15}/.claude/settings.json"
CO15="${SCRATCH}/co15"
t15() {
  run_setup_hb "$HOME15" "/bin/zsh" "$MCFG15" "$CO15" "$ORIGIN" >/dev/null 2>&1 || return 1
  [[ "$(jq -r '.enabledPlugins["catalyst-dev@catalyst"] // "gone"' "${HOME15}/.claude/settings.json")" == "gone" ]] || return 1
  [[ "$(jq -r '.enabledPlugins["catalyst-pm@catalyst"] // "gone"' "${HOME15}/.claude/settings.json")" == "gone" ]] || return 1
  # unrelated enablement preserved
  [[ "$(jq -r '.enabledPlugins["other@x"]' "${HOME15}/.claude/settings.json")" == "true" ]]
}
check "full mode clears catalyst-*@catalyst from user-scope enabledPlugins" t15

echo ""
TOTAL=$((PASSES + FAILURES))
echo "setup-plugin-source: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
