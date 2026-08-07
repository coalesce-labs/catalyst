#!/usr/bin/env bash
# Shell tests for plugins/dev/scripts/lib/catalyst-runtime-root.sh (CTL-1628 Phase A2).
# Run: bash plugins/dev/scripts/__tests__/catalyst-runtime-root.test.sh
#
# Hermetic: every test runs in a fresh bash subshell with HOME pointed at a
# scratch dir and CATALYST_DEV_SCRIPTS/CLAUDE_PLUGIN_ROOT unset, so nothing
# here depends on (or can pollute) the real ~/.claude or the invoking shell's
# env. Mirrors catalyst-version.test.sh's fixture-tree + subshell pattern.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-runtime-root.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
# Resolve to the physical path: on macOS $TMPDIR (hence mktemp's output) is
# under /var, a symlink to /private/var — the lib's `cd DIR && pwd` resolves
# symlinks, so comparing against the un-resolved $SCRATCH would spuriously
# fail the cwd-fallback assertion below.
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; shift; [ "$#" -gt 0 ] && printf '    %s\n' "$@"; }

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected: [$expected]" "actual:   [$actual]"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass "$label"
  else
    fail "$label" "expected to contain: $needle" "actual: $haystack"
  fi
}

# make_dev_scripts_dir DIR — creates DIR with the sentinel check-project-setup.sh
# so catalyst_dev_scripts considers it valid.
make_dev_scripts_dir() {
  mkdir -p "$1"
  : > "$1/check-project-setup.sh"
}

# run_lib CWD HOME_DIR REQUESTING_PLUGIN — sources the lib and calls
# catalyst_dev_scripts in a fresh bash subshell with CWD/HOME pinned to
# scratch dirs (never the real invoking shell's), CATALYST_DEV_SCRIPTS and
# CLAUDE_PLUGIN_ROOT unset. Prints "<exit-code>|<resolved-path-or-empty>".
run_lib() {
  local cwd="$1" home="$2" req="${3:-}"
  ( cd "$cwd" && env -i \
      HOME="$home" \
      PATH="$PATH" \
      LIB="$LIB" \
      REQ="$req" \
      bash -c '
        unset CATALYST_DEV_SCRIPTS CLAUDE_PLUGIN_ROOT
        # shellcheck disable=SC1090
        . "$LIB"
        catalyst_dev_scripts "$REQ" >/dev/null 2>&1
        printf "%s|%s" "$?" "${CATALYST_DEV_SCRIPTS:-}"
      '
  )
}

echo "catalyst-runtime-root.sh tests"
echo ""

mkdir -p "$SCRATCH/empty-home" "$SCRATCH/empty-cwd"

# ─── catalyst_dev_scripts: env var already valid ───────────────────────────
DEV="$SCRATCH/env-valid/somewhere/scripts"
make_dev_scripts_dir "$DEV"
OUT=$(cd "$SCRATCH/empty-cwd" && env -i HOME="$SCRATCH/empty-home" PATH="$PATH" \
  CATALYST_DEV_SCRIPTS="$DEV" LIB="$LIB" bash -c '
    unset CLAUDE_PLUGIN_ROOT
    # shellcheck disable=SC1090
    . "$LIB"
    catalyst_dev_scripts >/dev/null 2>&1
    printf "%s|%s" "$?" "${CATALYST_DEV_SCRIPTS:-}"
  ')
assert_eq "${OUT%%|*}" "0" "env override: return 0"
assert_eq "${OUT#*|}" "$DEV" "env override: resolves to \$CATALYST_DEV_SCRIPTS"

# ─── catalyst_dev_scripts: sibling in a source checkout ────────────────────
ROOT="$SCRATCH/sibling"
PLUGIN="$ROOT/plugins/foundry"
DEV="$ROOT/plugins/dev/scripts"
mkdir -p "$PLUGIN"
make_dev_scripts_dir "$DEV"
OUT=$(run_lib "$SCRATCH/empty-cwd" "$SCRATCH/empty-home" "$PLUGIN")
assert_eq "${OUT%%|*}" "0" "sibling probe: return 0"
assert_eq "${OUT#*|}" "$DEV" "sibling probe: resolves <plugin>/../dev/scripts"

# ─── catalyst_dev_scripts: repo-root cwd fallback ───────────────────────────
ROOT="$SCRATCH/cwd-fallback"
DEV="$ROOT/plugins/dev/scripts"
make_dev_scripts_dir "$DEV"
OUT=$(run_lib "$ROOT" "$SCRATCH/empty-home" "")
assert_eq "${OUT%%|*}" "0" "cwd fallback: return 0"
assert_eq "${OUT#*|}" "$DEV" "cwd fallback: resolves ./plugins/dev/scripts"

# ─── catalyst_dev_scripts: marketplace glob picks NEWEST version (sort -V) ──
MKT_HOME="$SCRATCH/mkt-home"
make_dev_scripts_dir "$MKT_HOME/.claude/plugins/marketplaces/catalyst-old/plugins/dev/scripts"
make_dev_scripts_dir "$MKT_HOME/.claude/plugins/marketplaces/catalyst-v9/plugins/dev/scripts"
NEWEST_MKT="$MKT_HOME/.claude/plugins/marketplaces/catalyst-v10/plugins/dev/scripts"
make_dev_scripts_dir "$NEWEST_MKT"
OUT=$(run_lib "$SCRATCH/empty-cwd" "$MKT_HOME" "")
assert_eq "${OUT%%|*}" "0" "marketplace glob: return 0"
assert_eq "${OUT#*|}" "$NEWEST_MKT" "marketplace glob: sort -V picks v10 over v9 (numeric, not lexical)"

# ─── catalyst_dev_scripts: cache glob picks NEWEST version ──────────────────
CACHE_HOME="$SCRATCH/cache-home"
make_dev_scripts_dir "$CACHE_HOME/.claude/plugins/cache/catalyst/catalyst-dev/1.2.0/scripts"
NEWEST_CACHE="$CACHE_HOME/.claude/plugins/cache/catalyst/catalyst-dev/1.10.0/scripts"
make_dev_scripts_dir "$NEWEST_CACHE"
OUT=$(run_lib "$SCRATCH/empty-cwd" "$CACHE_HOME" "")
assert_eq "${OUT%%|*}" "0" "cache glob: return 0"
assert_eq "${OUT#*|}" "$NEWEST_CACHE" "cache glob: sort -V picks 1.10.0 over 1.2.0 (numeric, not lexical)"

# ─── catalyst_dev_scripts: marketplace glob skips a partial newest install ──
# CTL-1628 A2 post-merge fix: the newest candidate (catalyst-v2, no sentinel
# — a partial/broken install) must NOT sink the whole rung; the resolver
# should fall back to the next-newest VALID candidate (catalyst-v1).
MKT_PARTIAL_HOME="$SCRATCH/mkt-partial-home"
VALID_MKT="$MKT_PARTIAL_HOME/.claude/plugins/marketplaces/catalyst-v1/plugins/dev/scripts"
make_dev_scripts_dir "$VALID_MKT"
mkdir -p "$MKT_PARTIAL_HOME/.claude/plugins/marketplaces/catalyst-v2/plugins/dev/scripts"  # no sentinel file
OUT=$(run_lib "$SCRATCH/empty-cwd" "$MKT_PARTIAL_HOME" "")
assert_eq "${OUT%%|*}" "0" "marketplace glob: partial newest — return 0"
assert_eq "${OUT#*|}" "$VALID_MKT" "marketplace glob: partial newest (v2) skipped, falls back to valid v1"

# ─── catalyst_dev_scripts: cache glob skips a partial newest install ────────
CACHE_PARTIAL_HOME="$SCRATCH/cache-partial-home"
VALID_CACHE="$CACHE_PARTIAL_HOME/.claude/plugins/cache/catalyst/catalyst-dev/1.0.0/scripts"
make_dev_scripts_dir "$VALID_CACHE"
mkdir -p "$CACHE_PARTIAL_HOME/.claude/plugins/cache/catalyst/catalyst-dev/2.0.0/scripts"  # no sentinel file
OUT=$(run_lib "$SCRATCH/empty-cwd" "$CACHE_PARTIAL_HOME" "")
assert_eq "${OUT%%|*}" "0" "cache glob: partial newest — return 0"
assert_eq "${OUT#*|}" "$VALID_CACHE" "cache glob: partial newest (2.0.0) skipped, falls back to valid 1.0.0"

# ─── catalyst_dev_scripts: total miss is LOUD (stderr) and returns 1 ────────
OUT=$(cd "$SCRATCH/empty-cwd" && env -i HOME="$SCRATCH/empty-home" PATH="$PATH" LIB="$LIB" bash -c '
  unset CATALYST_DEV_SCRIPTS CLAUDE_PLUGIN_ROOT
  # shellcheck disable=SC1090
  . "$LIB"
  ERR=$(catalyst_dev_scripts 2>&1 >/dev/null)
  printf "%s|%s" "$?" "$ERR"
')
assert_eq "${OUT%%|*}" "1" "total miss: return 1"
assert_contains "${OUT#*|}" "requires the 'catalyst-dev' plugin" "total miss: LOUD actionable stderr message"
assert_contains "${OUT#*|}" "CATALYST_DEV_SCRIPTS=" "total miss: stderr names the env-var escape hatch"

# ─── catalyst_plugin_root: walks up to first ancestor with both files ───────
ROOT="$SCRATCH/plugin-root"
PLUGIN="$ROOT/plugins/dev"
DEEP="$PLUGIN/scripts/lib"
mkdir -p "$DEEP" "$PLUGIN/.claude-plugin"
: > "$PLUGIN/version.txt"
: > "$PLUGIN/.claude-plugin/plugin.json"
OUT=$(env -i PATH="$PATH" LIB="$LIB" DEEP="$DEEP" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"
  RESULT="$(catalyst_plugin_root "$DEEP")"
  printf "%s|%s" "$?" "$RESULT"
')
assert_eq "${OUT#*|}" "$PLUGIN" "plugin_root: walks up to the version.txt+plugin.json ancestor"
assert_eq "${OUT%%|*}" "0" "plugin_root: return 0 on hit"

# ─── catalyst_plugin_root: miss returns 1, prints nothing ──────────────────
LONE="$SCRATCH/no-plugin-root/a/b/c"
mkdir -p "$LONE"
OUT=$(env -i PATH="$PATH" LIB="$LIB" LONE="$LONE" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"
  RESULT="$(catalyst_plugin_root "$LONE")"
  printf "%s|%s" "$?" "$RESULT"
')
assert_eq "${OUT%%|*}" "1" "plugin_root miss: return 1"
assert_eq "${OUT#*|}" "" "plugin_root miss: prints nothing"

# ─── catalyst_runtime_layout: classifies marketplace ────────────────────────
LAYOUT_HOME1="$SCRATCH/layout-home1"
DIR="$LAYOUT_HOME1/.claude/plugins/marketplaces/catalyst/plugins/dev/scripts"
mkdir -p "$DIR"
OUT=$(env -i HOME="$LAYOUT_HOME1" PATH="$PATH" LIB="$LIB" DIR="$DIR" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"; catalyst_runtime_layout "$DIR"
')
assert_eq "$OUT" "marketplace" "runtime_layout: classifies marketplaces/*/plugins/dev/scripts"

# ─── catalyst_runtime_layout: classifies cache ──────────────────────────────
LAYOUT_HOME2="$SCRATCH/layout-home2"
DIR="$LAYOUT_HOME2/.claude/plugins/cache/catalyst/catalyst-dev/1.0.0/scripts"
mkdir -p "$DIR"
OUT=$(env -i HOME="$LAYOUT_HOME2" PATH="$PATH" LIB="$LIB" DIR="$DIR" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"; catalyst_runtime_layout "$DIR"
')
assert_eq "$OUT" "cache" "runtime_layout: classifies cache/*/catalyst-dev/*/scripts"

# ─── catalyst_runtime_layout: classifies source-checkout (real repo) ────────
OUT=$(env -i HOME="$SCRATCH/empty-home" PATH="$PATH" LIB="$LIB" DIR="${REPO_ROOT}/plugins/dev/scripts" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"; catalyst_runtime_layout "$DIR"
')
assert_eq "$OUT" "source-checkout" "runtime_layout: classifies this repo's own plugins/dev/scripts"

# ─── catalyst_runtime_layout: unknown for an arbitrary non-git dir ──────────
DIR="$SCRATCH/plain-dir"
mkdir -p "$DIR"
OUT=$(env -i HOME="$SCRATCH/empty-home" PATH="$PATH" LIB="$LIB" DIR="$DIR" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"; catalyst_runtime_layout "$DIR"
')
assert_eq "$OUT" "unknown" "runtime_layout: unknown for an arbitrary non-catalyst dir"

# ─── catalyst_runtime_layout: absent dir → unknown, never errors ───────────
OUT=$(env -i HOME="$SCRATCH/empty-home" PATH="$PATH" LIB="$LIB" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"
  RESULT="$(catalyst_runtime_layout "/nonexistent-dir-$$")"
  printf "%s|%s" "$RESULT" "$?"
')
assert_eq "${OUT%%|*}" "unknown" "runtime_layout: absent dir classifies unknown"
assert_eq "${OUT#*|}" "0" "runtime_layout: never fails (always returns 0)"

# ─── idempotent-source guard: sourcing twice does not redefine/break ───────
OUT=$(env -i PATH="$PATH" LIB="$LIB" bash -c '
  # shellcheck disable=SC1090
  . "$LIB"
  # shellcheck disable=SC1090
  . "$LIB"
  type catalyst_dev_scripts >/dev/null 2>&1 && echo "ok"
')
assert_eq "$OUT" "ok" "idempotent source: sourcing twice leaves functions intact"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
