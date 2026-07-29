#!/usr/bin/env bash
# Tests for install-orphan-sweep.sh (CTL-1030 Phase 6).
#
# Run: bash plugins/dev/scripts/__tests__/install-orphan-sweep.test.sh

set -uo pipefail

# PLATFORM GATE. install-orphan-sweep.sh installs a macOS LaunchAgent and refuses
# to run on anything else — on Linux it prints "non-Darwin platform detected" and
# exits 0, so every "should refuse <bad path>" assertion sees rc=0 and fails for a
# reason that has nothing to do with what it tests. Skip LOUDLY rather than let a
# Linux CI job report red on a macOS-only installer.
#
# BE CLEAR ABOUT THE COST: the CI runner is ubuntu, so this suite is SKIPPED there
# and its 38 assertions only really execute on a developer's Mac. That is partial
# coverage, not the "now wired into CI" it might look like from the workflow file.
# Closing it properly needs a macos-latest job.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SKIP: install-orphan-sweep.test.sh requires macOS (installer is a LaunchAgent);"
  echo "      this run was on $(uname -s) — 0 assertions executed."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALLER="${REPO_ROOT}/plugins/dev/scripts/install-orphan-sweep.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Test harness
run() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
  fi
}

run_output() {
  local name="$1" pattern="$2"; shift 2
  local out
  out="$("$@" 2>&1 || true)"
  if echo "$out" | grep -qiE "$pattern"; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (pattern '$pattern' not found in output)"
    echo "    command: $*"
    echo "    output:  $out"
  fi
}

# MOCKBIN setup — fake launchctl and uname
MOCKBIN="${SCRATCH}/mockbin"
mkdir -p "$MOCKBIN"

LAUNCHCTL_LOG="${SCRATCH}/launchctl.log"

cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${LAUNCHCTL_LOG}"
# Accept everything unless the caller sets MOCK_LAUNCHCTL_BOOTOUT_RC
subcmd="${1:-}"
if [[ "$subcmd" == "bootout" && "${MOCK_LAUNCHCTL_BOOTOUT_RC:-0}" != "0" ]]; then
  exit "${MOCK_LAUNCHCTL_BOOTOUT_RC}"
fi
exit 0
EOF
chmod +x "$MOCKBIN/launchctl"

cat > "$MOCKBIN/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then
  echo "${MOCK_UNAME:-Darwin}"
else
  command uname "$@"
fi
EOF
chmod +x "$MOCKBIN/uname"

export PATH="${MOCKBIN}:${PATH}"
export LAUNCHCTL_LOG

# Override HOME so we don't touch the real ~/Library/LaunchAgents
FAKE_HOME="${SCRATCH}/home"
mkdir -p "${FAKE_HOME}/Library/LaunchAgents"
export HOME="$FAKE_HOME"

# ─── I1: installer exists and is executable ───────────────────────────────────
run "I1: install-orphan-sweep.sh exists and is executable" test -x "$INSTALLER"

# ─── I2: --help exits 0 ──────────────────────────────────────────────────────
run "I2: --help exits 0" bash "$INSTALLER" --help

# ─── a NON-EPHEMERAL bake dir, so this suite runs EVERYWHERE ─────────────────
#
# CTL-1306 makes the installer HARD-REFUSE to bake a program path that lives in a
# linked git worktree or a temp dir. Until CTL-1531 round 3 this suite reacted by
# SKIPPING every install assertion whenever it was run from a worktree — i.e.
# exactly where day-to-day development happens — so 7 of its 9 real assertions
# executed only on CI, and it reported "2 passed" as if that were a pass.
#
# A suite that behaves differently depending on where it is checked out is the
# same failure class as an assertion that cannot fail. Fix it at the root:
# construct a bake dir that is genuinely non-ephemeral (not under any temp root,
# and its own git repo so `rev-parse --absolute-git-dir` does NOT report a
# .git/worktrees/ path), hand it to the installer through the CATALYST_FORCE_BAKE_DIR
# seam the installer already exposes for tests, and run the whole suite for real.
#
# The CTL-1306 guard itself is NOT weakened and NOT skipped — it is covered
# end-to-end by the sibling suite __tests__/install-orphan-sweep-guard.test.sh,
# which asserts the refusal for /tmp, /var/folders and a REAL linked worktree.
BAKE_ROOT="${REPO_ROOT}/.tmp-install-orphan-sweep-test.$$"
BAKE_DIR="${BAKE_ROOT}/plugins/dev/scripts"
mkdir -p "${BAKE_DIR}/orch-monitor/dist"
cp "${REPO_ROOT}/plugins/dev/scripts/orch-monitor/dist/ai.coalesce.catalyst-orphan-sweep.plist" \
   "${BAKE_DIR}/orch-monitor/dist/"
touch "${BAKE_DIR}/orphan-sweep.sh"
git init -q "$BAKE_ROOT" >/dev/null 2>&1 || true
trap 'rm -rf "$SCRATCH" "$BAKE_ROOT"' EXIT

export CATALYST_FORCE_BAKE_DIR="$BAKE_DIR"
# Never read the developer's real ~/.config/catalyst/config.json: on a host with
# a registered pristine clone the installer would resolve THAT as BAKE_DIR and
# every path assertion below would silently be about the wrong tree. ($HOME is
# already redirected, but be explicit — the seam exists.)
export CATALYST_LAYER2_CONFIG_FILE=/dev/null

# Fail LOUDLY rather than skipping: if the constructed bake dir is somehow still
# rejected, the assertions below would compare against an unwritten plist.
_ENV_PROBE="$(bash "$INSTALLER" --print-only 2>&1 || true)"
if printf '%s' "$_ENV_PROBE" | grep -q 'refusing to install from an ephemeral path'; then
  echo "  FAIL: the constructed bake dir is still classified as ephemeral:"
  printf '%s\n' "$_ENV_PROBE" | sed 's/^/        /'
  echo "Results: ${PASSES} passed, $((FAILURES + 1)) failed"
  exit 1
fi

# ─── helpers: install with DARWIN forced ──────────────────────────────────────
#
# Run from a NEUTRAL cwd. The installer walks up from $PWD looking for
# .catalyst/config.json, so running from the repo would let the repo's OWN
# sweep.intervalHours / sweep.procWiden leak into I7* and I13* and make those
# assertions depend on a committed file they are not testing.
NEUTRAL_DIR="${SCRATCH}/neutral"
mkdir -p "$NEUTRAL_DIR"
_install() {
  rm -f "$LAUNCHCTL_LOG"
  # stdout silenced: _install is a SETUP step, and its "wrote …/loaded …" chatter
  # would drown the PASS/FAIL lines. Assertions that need the installer's output
  # invoke it directly (run_output).
  ( cd "$NEUTRAL_DIR" && CATALYST_FORCE_OS=Darwin bash "$INSTALLER" "$@" ) >/dev/null
}
# EXPORTED. Without `export`, `${DEST}` still interpolated into the `bash -c`
# strings below (the outer shell expands it) but `_widen_of` — a plain shell
# function — did NOT exist in those subshells: every `$(_widen_of)` expanded to
# "" via a "command not found", so I13c/d/e/f/g/h/j compared "" against 'shadow'
# / 'enforce' and were decided by neither the installer nor the fix under test.
# Exporting both is what makes them real assertions. (orphan-sweep.test.sh:89
# already does this for its own helpers.)
export DEST="${FAKE_HOME}/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist"

# ─── I3: no REPLACE_* tokens in installed plist ───────────────────────────────
_install
run "I3: no REPLACE_WITH_ABSOLUTE token in installed plist" \
  bash -c "! grep -q 'REPLACE_WITH_ABSOLUTE' '${DEST}'"
run "I3b: no REPLACE_HOME token in installed plist" \
  bash -c "! grep -q 'REPLACE_HOME' '${DEST}'"
run "I3c: no REPLACE_START_INTERVAL token in installed plist" \
  bash -c "! grep -q 'REPLACE_START_INTERVAL' '${DEST}'"

# ─── I4: installed plist passes plutil -lint (or SKIP) ───────────────────────
if command -v plutil >/dev/null 2>&1; then
  run "I4: installed plist passes plutil -lint" plutil -lint "$DEST"
else
  echo "  SKIP: I4: plutil not available on this platform"
  PASSES=$((PASSES+1))
fi

# ─── I5: ProgramArguments contains the resolved absolute orphan-sweep.sh path ─
# Asserted against the dir the installer was told to bake (CATALYST_FORCE_BAKE_DIR),
# which is the actual invariant: whatever BAKE_DIR resolves to must appear in the
# plist as an ABSOLUTE program path, with no REPLACE_* token left behind.
run "I5: ProgramArguments references the absolute resolved orphan-sweep.sh" \
  grep -q "${BAKE_DIR}/orphan-sweep.sh" "$DEST"
run "I5b: …and that path is absolute" \
  bash -c "case '${BAKE_DIR}' in /*) exit 0 ;; *) exit 1 ;; esac"

# ─── I6: Standard*Path resolved to $HOME (no REPLACE_HOME) ─────────────────
run "I6: StandardOutPath references real HOME, no REPLACE_HOME" \
  bash -c "grep 'StandardOutPath' -A1 '${DEST}' | grep -q '${FAKE_HOME}'"

# ─── I7: interval map ────────────────────────────────────────────────────────

_install_with_config() {
  local config_json="$1"
  local proj="${SCRATCH}/proj_$RANDOM"
  mkdir -p "${proj}/.catalyst"
  printf '%s\n' "$config_json" > "${proj}/.catalyst/config.json"
  rm -f "$LAUNCHCTL_LOG"
  (cd "$proj" && CATALYST_FORCE_OS=Darwin bash "$INSTALLER")
}

_installed_interval() {
  grep 'StartInterval' -A1 "$DEST" | grep '<integer>' | grep -oE '[0-9]+'
}

_install_with_config '{"catalyst":{"sweep":{"intervalHours":1}}}'
run "I7a: intervalHours=1 -> StartInterval=3600" \
  bash -c "[[ \"$(_installed_interval)\" == '3600' ]]"

_install_with_config '{"catalyst":{"sweep":{"intervalHours":2}}}'
run "I7b: intervalHours=2 -> StartInterval=7200" \
  bash -c "[[ \"$(_installed_interval)\" == '7200' ]]"

_install_with_config '{"catalyst":{"sweep":{"intervalHours":3}}}'
run "I7c: intervalHours=3 -> StartInterval=10800" \
  bash -c "[[ \"$(_installed_interval)\" == '10800' ]]"

# absent: should default to 1 → 3600
_install_with_config '{"catalyst":{}}'
run "I7d: intervalHours absent -> StartInterval=3600 (default)" \
  bash -c "[[ \"$(_installed_interval)\" == '3600' ]]"

# out-of-range 5: clamp to 3 → 10800
_install_with_config '{"catalyst":{"sweep":{"intervalHours":5}}}'
run "I7e: intervalHours=5 (out-of-range) -> clamped to 3 -> StartInterval=10800" \
  bash -c "[[ \"$(_installed_interval)\" == '10800' ]]"

# ─── I8: launchctl invoked as bootout THEN bootstrap ─────────────────────────
rm -f "$LAUNCHCTL_LOG"
_install
BOOTOUT_LINE="$(grep -n 'bootout' "$LAUNCHCTL_LOG" 2>/dev/null | head -1 | cut -d: -f1)"
BOOTSTRAP_LINE="$(grep -n 'bootstrap' "$LAUNCHCTL_LOG" 2>/dev/null | head -1 | cut -d: -f1)"
run "I8a: launchctl bootout was called" bash -c "grep -q 'bootout' '${LAUNCHCTL_LOG}'"
run "I8b: launchctl bootstrap was called" bash -c "grep -q 'bootstrap' '${LAUNCHCTL_LOG}'"
run "I8c: bootout appears before bootstrap in log" \
  bash -c "[[ -n '${BOOTOUT_LINE}' && -n '${BOOTSTRAP_LINE}' && '${BOOTOUT_LINE}' -lt '${BOOTSTRAP_LINE}' ]]"
run "I8d: launchctl called with gui/<uid> domain (not a bare user)" \
  bash -c "grep -qE 'gui/[0-9]+' '${LAUNCHCTL_LOG}'"

# ─── I9: idempotent re-install: second run exits 0, DEST byte-identical ──────
_install
FIRST_HASH="$(md5 -q "$DEST" 2>/dev/null || md5sum "$DEST" 2>/dev/null | awk '{print $1}')"
_install
SECOND_HASH="$(md5 -q "$DEST" 2>/dev/null || md5sum "$DEST" 2>/dev/null | awk '{print $1}')"
run "I9: second install exits 0 and DEST is byte-identical" \
  bash -c "[[ '${FIRST_HASH}' == '${SECOND_HASH}' ]]"

# ─── I10: bootout failure tolerated ─────────────────────────────────────────
run "I10: bootout failure tolerated (bootstrap still runs)" \
  bash -c "MOCK_LAUNCHCTL_BOOTOUT_RC=1 CATALYST_FORCE_OS=Darwin bash '${INSTALLER}' && grep -q 'bootstrap' '${LAUNCHCTL_LOG}'"

# ─── I11: --uninstall boots out + removes DEST, idempotent ──────────────────
_install
rm -f "$LAUNCHCTL_LOG"
run "I11a: --uninstall exits 0" bash -c "CATALYST_FORCE_OS=Darwin bash '${INSTALLER}' --uninstall"
run "I11b: --uninstall removes DEST" bash -c "[[ ! -f '${DEST}' ]]"
run "I11c: --uninstall called launchctl bootout" \
  bash -c "grep -q 'bootout' '${LAUNCHCTL_LOG}'"
# second --uninstall is also safe
run "I11d: second --uninstall is idempotent (exits 0)" \
  bash -c "CATALYST_FORCE_OS=Darwin bash '${INSTALLER}' --uninstall"

# ─── I12: non-macOS -> follow-up notice, exits 0, no launchctl call ─────────
rm -f "$LAUNCHCTL_LOG"
run "I12a: CATALYST_FORCE_OS=linux -> exits 0" \
  bash -c "CATALYST_FORCE_OS=linux bash '${INSTALLER}'"
run "I12b: non-macOS -> no launchctl call" \
  bash -c "[[ ! -s '${LAUNCHCTL_LOG}' ]]"
run_output "I12c: non-macOS -> prints follow-up/notice message" \
  "follow-up|ctf|notice|linux|platform" \
  bash -c "CATALYST_FORCE_OS=linux bash '${INSTALLER}'"

# ─── I13: CTL-1531 — the widened-branch rollout flip SURVIVES reinstallation ─
#
# Codex round 2: the documented enforce flip was "hand-edit the installed
# LaunchAgent", but this installer unconditionally regenerates and replaces that
# plist on every routine `catalyst-stack install-services` run — so the next
# install silently reverted the operator's flip. A rollout knob a routine
# reinstall resets is worse than none. The value now lives in the shipped
# template and is resolved with an explicit precedence.

_widen_of() {   # print the SWEEP_PROC_WIDEN value in the installed plist
  grep -A2 '<key>SWEEP_PROC_WIDEN</key>' "$DEST" 2>/dev/null \
    | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' | head -1
}
# See the DEST note above: without `export -f` the `bash -c` subshells below get
# "_widen_of: command not found" and every I13 value assertion compares "".
export -f _widen_of

# SELF-TEST for the exports. If either the function or DEST fails to cross into a
# `bash -c` subshell, this fails HERE with an obvious message instead of turning
# seven downstream assertions into silent comparisons against "".
_install
run "I13-selftest: _widen_of + DEST are visible inside a 'bash -c' subshell" \
  bash -c '[[ -n "$DEST" && -f "$DEST" && -n "$(_widen_of)" ]]'

# The plist must actually carry the key (a template without it cannot preserve
# anything, which is precisely the shipped bug).
_install
run "I13a: installed plist declares SWEEP_PROC_WIDEN in EnvironmentVariables" \
  bash -c "grep -q '<key>EnvironmentVariables</key>' '${DEST}' && grep -q '<key>SWEEP_PROC_WIDEN</key>' '${DEST}'"
run "I13b: no REPLACE_SWEEP_PROC_WIDEN token left in the installed plist" \
  bash -c "! grep -q 'REPLACE_SWEEP_PROC_WIDEN' '${DEST}'"
run "I13c: a fresh install is DARK by default (ADR-023)" \
  bash -c "[[ \"\$(_widen_of)\" == 'shadow' ]]"

# The flip itself.
rm -f "$DEST"
SWEEP_PROC_WIDEN=enforce _install >/dev/null 2>&1
run "I13d: SWEEP_PROC_WIDEN=enforce at install time is baked into the plist" \
  bash -c "[[ \"\$(_widen_of)\" == 'enforce' ]]"

# THE REGRESSION: a plain reinstall (no env, no config) must PRESERVE it.
_install
run "I13e: a plain reinstall PRESERVES the operator's enforce flip" \
  bash -c "[[ \"\$(_widen_of)\" == 'enforce' ]]"

# …and is still idempotent across further installs.
_install
run "I13f: …and stays enforce across repeated installs" \
  bash -c "[[ \"\$(_widen_of)\" == 'enforce' ]]"

# Rollback is a reinstall with the env var, not a hand-edit.
SWEEP_PROC_WIDEN=shadow _install >/dev/null 2>&1
run "I13g: reinstalling with SWEEP_PROC_WIDEN=shadow rolls the flip back" \
  bash -c "[[ \"\$(_widen_of)\" == 'shadow' ]]"

# A garbage value must never arm the killer.
rm -f "$DEST"
SWEEP_PROC_WIDEN=ENFORCE! _install >/dev/null 2>&1
run "I13h: an unrecognized value falls back to shadow, never enforce" \
  bash -c "[[ \"\$(_widen_of)\" == 'shadow' ]]"
run_output "I13i: …and says so out loud" "falling back to 'shadow'" \
  bash -c "rm -f '${DEST}'; SWEEP_PROC_WIDEN=nonsense CATALYST_FORCE_OS=Darwin bash '${INSTALLER}'"

# config → catalyst.sweep.procWiden, which outranks a stale installed value.
if command -v jq >/dev/null 2>&1; then
  CFG_DIR="${SCRATCH}/cfgrepo"
  mkdir -p "${CFG_DIR}/.catalyst"
  printf '%s\n' '{"catalyst":{"sweep":{"procWiden":"enforce"}}}' > "${CFG_DIR}/.catalyst/config.json"
  rm -f "$DEST"
  ( cd "$CFG_DIR" && CATALYST_FORCE_OS=Darwin bash "$INSTALLER" ) >/dev/null 2>&1
  run "I13j: .catalyst/config.json catalyst.sweep.procWiden is honoured" \
    bash -c "[[ \"\$(_widen_of)\" == 'enforce' ]]"
else
  echo "  SKIP: I13j: jq not available"
  PASSES=$((PASSES+1))
fi

# ─── results ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
