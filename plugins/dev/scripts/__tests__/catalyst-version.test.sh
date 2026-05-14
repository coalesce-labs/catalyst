#!/usr/bin/env bash
# Shell tests for plugins/dev/scripts/lib/catalyst-version.sh (CTL-390).
# Run: bash plugins/dev/scripts/__tests__/catalyst-version.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-version.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Each test seeds a fake plugin tree under $SCRATCH/<name>/plugins/dev/ and
# invokes the helper via a freshly-sourced subshell. The subshell sets
# BASH_SOURCE so the helper resolves the fake plugin root.

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    actual:"
    printf '%s\n' "$haystack" | sed 's/^/      /'
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    must NOT contain: $needle"
    echo "    actual:"
    printf '%s\n' "$haystack" | sed 's/^/      /'
  else
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  fi
}

# Build a fake plugin tree.
#   $1 = scratch subdir name
#   $2 = version.txt contents (use "" to skip the file)
#   $3 = commit.txt contents (use "" to skip the file)
#   $4 = "git" to create a .git dir at the tree root, "" otherwise
# Echoes the fake script path so the test can pass it to the helper.
make_fake_plugin() {
  local name="$1" version="$2" commit="$3" git_flag="$4"
  local root="$SCRATCH/$name"
  local plugin="$root/plugins/dev"
  mkdir -p "$plugin/.claude-plugin" "$plugin/scripts/lib"
  echo '{"name":"catalyst-dev","version":"x"}' > "$plugin/.claude-plugin/plugin.json"
  [[ -n "$version" ]] && printf '%s\n' "$version" > "$plugin/version.txt"
  [[ -n "$commit"  ]] && printf '%s\n' "$commit"  > "$plugin/commit.txt"
  if [[ "$git_flag" == "git" ]]; then
    git -C "$root" init --quiet --initial-branch=test-branch 2>/dev/null || git -C "$root" init --quiet
    git -C "$root" config user.email "t@t" 2>/dev/null
    git -C "$root" config user.name  "t"   2>/dev/null
    git -C "$root" checkout -B test-branch --quiet 2>/dev/null || true
    : > "$root/seed"
    git -C "$root" add seed 2>/dev/null
    git -C "$root" commit --quiet -m "seed" 2>/dev/null
  fi
  # The "script" is a no-op file inside scripts/. Tests pass its path to
  # catalyst_print_version as the second arg.
  local fake="$plugin/scripts/catalyst-fake"
  : > "$fake"
  echo "$fake"
}

run_helper() {
  local cli_name="$1" fake_script="$2"
  # shellcheck disable=SC1090
  ( . "$HELPER" && catalyst_print_version "$cli_name" "$fake_script" )
}

echo "catalyst-version tests"

# ── 1. version.txt + commit.txt present, no .git → embedded commit ─────────
fake=$(make_fake_plugin t1 "9.2.0" "abc123def456" "")
out=$(run_helper "catalyst-events" "$fake")
assert_contains "$out" "catalyst-events 9.2.0" "t1: prints version line"
assert_contains "$out" "commit: abc123def456"  "t1: prints embedded commit"
assert_not_contains "$out" "local:" "t1: no local: prefix when no .git"

# ── 2. version.txt present, commit.txt absent, no .git → commit: unknown ───
fake=$(make_fake_plugin t2 "9.2.0" "" "")
out=$(run_helper "catalyst-broker" "$fake")
assert_contains "$out" "catalyst-broker 9.2.0" "t2: prints version line"
assert_contains "$out" "commit: unknown" "t2: falls back to commit: unknown"

# ── 3. .git ancestor present → local: commit with branch ────────────────────
if command -v git >/dev/null 2>&1; then
  fake=$(make_fake_plugin t3 "9.2.0" "" "git")
  out=$(run_helper "catalyst-hud" "$fake")
  assert_contains "$out" "catalyst-hud 9.2.0" "t3: prints version line"
  assert_contains "$out" "commit: local:" "t3: prefixes commit with local:"
  assert_contains "$out" "worktree: test-branch" "t3: includes worktree branch"
else
  echo "  SKIP: t3 (git not available)"
fi

# ── 4. version.txt missing → version: unknown ───────────────────────────────
fake=$(make_fake_plugin t4 "" "abc123" "")
out=$(run_helper "catalyst-events" "$fake")
assert_contains "$out" "catalyst-events unknown" "t4: version unknown when version.txt missing"

# ── 5. whitespace trimmed in version.txt and commit.txt ─────────────────────
fake=$(make_fake_plugin t5 "  9.2.0  " "  abc123  " "")
out=$(run_helper "catalyst-comms" "$fake")
assert_contains "$out" "catalyst-comms 9.2.0" "t5: version whitespace trimmed"
assert_contains "$out" "commit: abc123" "t5: commit whitespace trimmed"

# macOS resolves /var → /private/var; resolve expected paths the same way the
# helper does so the equality holds on both Linux and macOS.
_realpath() { cd -P "$1" 2>/dev/null && pwd; }

# ── 6. source: line points to plugin root in non-git case ───────────────────
fake=$(make_fake_plugin t6 "9.2.0" "abc123" "")
out=$(run_helper "catalyst-events" "$fake")
plugin_root=$(_realpath "${SCRATCH}/t6/plugins/dev")
assert_contains "$out" "source: ${plugin_root}" "t6: source line points to plugin root"

# ── 7. source: line points to script dir in local-source case ──────────────
if command -v git >/dev/null 2>&1; then
  fake=$(make_fake_plugin t7 "9.2.0" "" "git")
  out=$(run_helper "catalyst-events" "$fake")
  script_dir=$(_realpath "${SCRATCH}/t7/plugins/dev/scripts")
  assert_contains "$out" "source: ${script_dir}" "t7: source is script dir when local"
fi

# ── 8. .git takes priority over commit.txt (worktree wins) ──────────────────
if command -v git >/dev/null 2>&1; then
  fake=$(make_fake_plugin t8 "9.2.0" "embedded-sha" "git")
  out=$(run_helper "catalyst-events" "$fake")
  assert_contains "$out" "commit: local:" "t8: .git overrides commit.txt"
  assert_not_contains "$out" "embedded-sha" "t8: embedded ignored when .git present"
fi

# ── 9. exit 0 ──────────────────────────────────────────────────────────────
fake=$(make_fake_plugin t9 "9.2.0" "abc" "")
if run_helper "catalyst-events" "$fake" > /dev/null; then
  PASSES=$((PASSES + 1)); echo "  PASS: t9: exit 0"
else
  FAILURES=$((FAILURES + 1)); echo "  FAIL: t9: exit non-zero"
fi

# ── 10. integration: invoke real catalyst-events --version ─────────────────
# Verifies the early --version branch we inject into each CLI works end-to-end
# from the actual installed scripts (sources lib/catalyst-version.sh, prints,
# exits 0 — without touching the script's regular argv parsing).
EVENTS_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-events"
if [[ -x "$EVENTS_SCRIPT" ]]; then
  out=$("$EVENTS_SCRIPT" --version 2>&1)
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    PASSES=$((PASSES + 1)); echo "  PASS: t10: catalyst-events --version exits 0"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: t10: exit=$rc"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
  assert_contains "$out" "catalyst-events " "t10: prints catalyst-events line"
  assert_contains "$out" "commit: "         "t10: prints commit line"
  assert_contains "$out" "source: "         "t10: prints source line"

  # -V short form
  out_short=$("$EVENTS_SCRIPT" -V 2>&1)
  assert_contains "$out_short" "catalyst-events " "t10: -V short form works"
else
  echo "  SKIP: t10 (catalyst-events not executable)"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
