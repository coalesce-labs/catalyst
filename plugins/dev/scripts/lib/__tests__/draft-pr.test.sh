#!/usr/bin/env bash
# Tests for lib/draft-pr.sh — CTL-709.
# Exercises draft_pr_push, draft_pr_ensure, draft_pr_promote, and draft_pr_enabled
# against a real git fixture (bare origin + clone) and controlled gh/git PATH stubs.
#
# Run: bash plugins/dev/scripts/lib/__tests__/draft-pr.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DRAFT_PR_LIB="${LIB_DIR}/draft-pr.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t draft-pr-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"
  else fail "$label — expected '$expected', got '$actual'"; fi
}

assert_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" == *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' not in '$body'"; fi
}

assert_not_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" != *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' unexpectedly present"; fi
}

assert_file() {
  local path="$1" label="$2"
  if [[ -f "$path" ]]; then pass "$label"
  else fail "$label — file missing: $path"; fi
}

# ─── Fixture builder ──────────────────────────────────────────────────────────

new_fixture() {
  local tag="$1"
  local origin="${SCRATCH}/${tag}/origin.git"
  local work="${SCRATCH}/${tag}/work"
  git init --quiet --bare -b main "${origin}"
  git clone --quiet "${origin}" "${work}"
  (
    cd "${work}"
    printf 'base\n' > base.txt
    git add base.txt
    git commit --quiet -m "initial"
    git push --quiet origin main
    git checkout --quiet -b feature
    printf 'work\n' > work.txt
    git add work.txt
    git commit --quiet -m "feat: work commit"
  )
  ORIGIN="${origin}"
  WORK="${work}"
}

# ─── gh stubs ─────────────────────────────────────────────────────────────────

# install_gh_stub_no_pr <bin_dir> <log_file>
# gh pr view exits non-zero (no existing PR).
# gh pr create --draft succeeds with canned output.
# gh pr create (no --draft) also succeeds.
install_gh_stub_no_pr() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  exit 1
fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  IS_DRAFT=false
  for arg in "\$@"; do [[ "\$arg" == "--draft" ]] && IS_DRAFT=true; done
  if [[ "\$IS_DRAFT" == "true" ]]; then
    echo "https://github.com/test/repo/pull/42"
    exit 0
  else
    echo "https://github.com/test/repo/pull/43"
    exit 0
  fi
fi
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  echo '{"defaultBranchRef":{"name":"main"}}'
  exit 0
fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"
}

# install_gh_stub_existing_pr <bin_dir> <log_file> [is_draft]
# gh pr view returns an existing open PR (idempotent).
install_gh_stub_existing_pr() {
  local bin_dir="$1" log_file="$2" is_draft="${3:-true}"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  cat <<JSON
{"number":99,"url":"https://github.com/test/repo/pull/99","isDraft":${is_draft}}
JSON
  exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  echo "gh stub: create unexpectedly called" >&2
  exit 1
fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"
}

# install_gh_stub_draft_rejected <bin_dir> <log_file>
# gh pr create --draft fails; gh pr create (no --draft) succeeds.
install_gh_stub_draft_rejected() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  exit 1
fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  IS_DRAFT=false
  for arg in "\$@"; do [[ "\$arg" == "--draft" ]] && IS_DRAFT=true; done
  if [[ "\$IS_DRAFT" == "true" ]]; then
    echo "draft PRs not supported" >&2
    exit 1
  fi
  echo "https://github.com/test/repo/pull/44"
  exit 0
fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"
}

# install_gh_stub_create_fails <bin_dir> <log_file>
# gh pr view exits non-zero; both create attempts fail.
install_gh_stub_create_fails() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then exit 1; fi
if [[ "\$1" == "pr" && "\$2" == "create" ]]; then
  echo "create failed" >&2; exit 1
fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"
}

# install_gh_stub_promote <bin_dir> <log_file> [is_draft]
# gh pr view returns JSON; gh pr ready succeeds.
install_gh_stub_promote() {
  local bin_dir="$1" log_file="$2" is_draft="${3:-true}"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  cat <<JSON
{"number":55,"isDraft":${is_draft}}
JSON
  exit 0
fi
if [[ "\$1" == "pr" && "\$2" == "ready" ]]; then
  exit 0
fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"
}

# install_gh_stub_no_pr_for_promote <bin_dir> <log_file>
# gh pr view exits non-zero (no PR for promote).
install_gh_stub_no_pr_for_promote() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "\$@" >> "\$LOG"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then exit 1; fi
exit 0
STUB
  chmod +x "${bin_dir}/gh"
}

# ─── git push stubs ───────────────────────────────────────────────────────────

# install_git_stub_push_fail <bin_dir> <log_file>
# Real git for everything except push (which fails).
install_git_stub_push_fail() {
  local bin_dir="$1" log_file="$2"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "git \$*" >> "\$LOG"
for arg in "\$@"; do
  if [[ "\$arg" == "push" ]]; then
    echo "git push failed (stub)" >&2; exit 1
  fi
done
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# install_git_stub_logging <bin_dir> <log_file>
# Logs every git invocation as `git $*` (one line), then exec's real git.
install_git_stub_logging() {
  local bin_dir="$1" log_file="$2"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "git \$*" >> "\$LOG"
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# ─── Library file check ───────────────────────────────────────────────────────
echo "Suite 0: library file exists + zsh-safe"
assert_file "$DRAFT_PR_LIB" "lib/draft-pr.sh exists"
if [[ -f "$DRAFT_PR_LIB" ]]; then
  # Zsh-safe: sourcing under zsh gives access to all four functions.
  ZSH_CHECK="$(zsh -c "source '${DRAFT_PR_LIB}' && type draft_pr_push && type draft_pr_ensure && type draft_pr_promote && type draft_pr_enabled" 2>&1)"
  if echo "$ZSH_CHECK" | grep -qE 'not found|error|Error'; then
    fail "lib is zsh-safe (type all functions) — got: $ZSH_CHECK"
  else
    pass "lib is zsh-safe (all four functions defined under zsh)"
  fi
fi

# ─── Suite 1: draft_pr_push ───────────────────────────────────────────────────
echo ""
echo "Suite 1: draft_pr_push"

# 1a: push with no upstream — runs `git push -u origin HEAD`; returns 0.
echo "1a: push with no upstream → git push -u origin HEAD; returns 0"
new_fixture p1a
P1A_LOG="${SCRATCH}/p1a.log"
(
  cd "$WORK"
  # shellcheck source=../draft-pr.sh
  source "$DRAFT_PR_LIB"
  draft_pr_push >"${P1A_LOG}.stdout" 2>"${P1A_LOG}.stderr"
  echo "$?" > "${P1A_LOG}.exit"
)
assert_eq "0" "$(cat "${P1A_LOG}.exit")" "1a: draft_pr_push returns 0 (first push)"
# After push, upstream should be set.
UPSTREAM_P1A="$(git -C "$WORK" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo '')"
if [[ -n "$UPSTREAM_P1A" ]]; then
  pass "1a: upstream tracking set after push"
else
  fail "1a: upstream tracking should be set after push"
fi

# 1b: push with upstream already set — runs plain `git push`; returns 0.
echo "1b: push with upstream set → git push; returns 0"
# P1A WORK now has upstream set from 1a.
P1B_LOG="${SCRATCH}/p1b.log"
(
  cd "$WORK"
  source "$DRAFT_PR_LIB"
  draft_pr_push >"${P1B_LOG}.stdout" 2>"${P1B_LOG}.stderr"
  echo "$?" > "${P1B_LOG}.exit"
)
assert_eq "0" "$(cat "${P1B_LOG}.exit")" "1b: draft_pr_push returns 0 (subsequent push)"

# 1c: push failure — returns non-zero, prints warning, does NOT exit caller.
echo "1c: push failure → non-zero return + warning, caller not killed"
new_fixture p1c
P1C_BIN="${SCRATCH}/p1c-bin"
P1C_LOG="${SCRATCH}/p1c.log"
install_git_stub_push_fail "$P1C_BIN" "$P1C_LOG"
P1C_RESULT=0
(
  cd "$WORK"
  PATH="${P1C_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push >/dev/null 2>"${P1C_LOG}.stderr"
  RC=$?
  set -e
  echo "$RC" > "${P1C_LOG}.exit"
  echo "caller_survived" >> "${P1C_LOG}.exit"
) || true
assert_file "${P1C_LOG}.exit" "1c: exit file written (caller survived)"
if [[ -f "${P1C_LOG}.exit" ]]; then
  P1C_EXIT="$(head -1 "${P1C_LOG}.exit")"
  if [[ "$P1C_EXIT" != "0" ]]; then pass "1c: push failure returns non-zero"
  else fail "1c: push failure should return non-zero"; fi
  if grep -q "caller_survived" "${P1C_LOG}.exit"; then pass "1c: caller survives push failure"
  else fail "1c: caller should survive push failure"; fi
fi
if grep -q "push.*failed\|failed.*continuing" "${P1C_LOG}.stderr" 2>/dev/null; then
  pass "1c: warning printed to stderr on failure"
else
  fail "1c: warning to stderr — got: $(cat "${P1C_LOG}.stderr" 2>/dev/null)"
fi

# 1d: no-upstream push carries core.hooksPath=/dev/null
echo "1d: no-upstream push carries core.hooksPath=/dev/null"
new_fixture p1d
P1D_BIN="${SCRATCH}/p1d-bin"; P1D_LOG="${SCRATCH}/p1d.log"
install_git_stub_logging "$P1D_BIN" "$P1D_LOG"
(
  cd "$WORK"
  PATH="${P1D_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_push >/dev/null 2>&1
) || true
if grep -E 'push .*-u origin HEAD' "$P1D_LOG" 2>/dev/null | grep -q 'core\.hooksPath=/dev/null'; then
  pass "1d: no-upstream push suppresses local pre-push hooks"
else
  fail "1d: no-upstream push must include core.hooksPath=/dev/null — log: $(cat "$P1D_LOG" 2>/dev/null)"
fi

# 1e: upstream-set push carries core.hooksPath=/dev/null
echo "1e: upstream-set push carries core.hooksPath=/dev/null"
new_fixture p1e
(cd "$WORK" && git push -u origin HEAD --quiet)
P1E_BIN="${SCRATCH}/p1e-bin"; P1E_LOG="${SCRATCH}/p1e.log"
install_git_stub_logging "$P1E_BIN" "$P1E_LOG"
(
  cd "$WORK"
  PATH="${P1E_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_push >/dev/null 2>&1
) || true
if grep -q 'core\.hooksPath=/dev/null' "$P1E_LOG" 2>/dev/null; then
  pass "1e: upstream push suppresses local pre-push hooks"
else
  fail "1e: upstream push must include core.hooksPath=/dev/null — log: $(cat "$P1E_LOG" 2>/dev/null)"
fi

# 1f: blocking pre-push hook → draft_pr_push still returns 0
echo "1f: blocking pre-push hook → draft_pr_push still returns 0"
new_fixture p1f
mkdir -p "${WORK}/.localhooks"
printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/.localhooks/pre-push"
chmod +x "${WORK}/.localhooks/pre-push"
git -C "$WORK" config core.hooksPath "${WORK}/.localhooks"
(
  cd "$WORK"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push >/dev/null 2>&1
  echo "$?" > "${SCRATCH}/p1f.exit"
) || true
assert_eq "0" "$(cat "${SCRATCH}/p1f.exit" 2>/dev/null)" "1f: draft_pr_push succeeds despite blocking pre-push hook"

# ─── Suite 2: draft_pr_ensure ─────────────────────────────────────────────────
echo ""
echo "Suite 2: draft_pr_ensure"

# 2a: no existing PR → creates draft; echoes number<TAB>url<TAB>true
echo "2a: no existing PR → creates draft PR; echoes number<TAB>url<TAB>true"
new_fixture p2a
(cd "$WORK" && git push -u origin HEAD --quiet)
P2A_BIN="${SCRATCH}/p2a-bin"
P2A_LOG="${SCRATCH}/p2a.log"
install_gh_stub_no_pr "$P2A_BIN" "$P2A_LOG"
P2A_OUT=""
P2A_RC=0
P2A_OUT="$(
  cd "$WORK"
  PATH="${P2A_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_ensure "main" "CTL-709" 2>/dev/null
)" || P2A_RC=$?
P2A_NUM="$(printf '%s' "$P2A_OUT" | cut -f1)"
P2A_URL="$(printf '%s' "$P2A_OUT" | cut -f2)"
P2A_DRAFT="$(printf '%s' "$P2A_OUT" | cut -f3)"
assert_eq "0" "$P2A_RC" "2a: draft_pr_ensure returns 0"
if [[ -n "$P2A_NUM" ]]; then pass "2a: echoes PR number"
else fail "2a: echoes PR number — got '$P2A_OUT'"; fi
if [[ -n "$P2A_URL" ]]; then pass "2a: echoes PR url"
else fail "2a: echoes PR url — got '$P2A_OUT'"; fi
assert_eq "true" "$P2A_DRAFT" "2a: isDraft=true for draft PR"
# Assert --draft was passed to gh pr create
if grep -q '\-\-draft' "$P2A_LOG" 2>/dev/null; then pass "2a: --draft flag passed to gh pr create"
else fail "2a: --draft flag in gh call — log: $(cat "$P2A_LOG" 2>/dev/null)"; fi
# Assert no Claude attribution in body
if grep -q 'Co-Authored-By\|Generated with' "$P2A_LOG" 2>/dev/null; then
  fail "2a: body must NOT contain Co-Authored-By or Generated with"
else
  pass "2a: body contains no Claude attribution"
fi

# 2b: existing open PR → idempotent; no create call; echoes existing number/url/isDraft
echo "2b: existing open PR → idempotent; no gh pr create"
new_fixture p2b
(cd "$WORK" && git push -u origin HEAD --quiet)
P2B_BIN="${SCRATCH}/p2b-bin"
P2B_LOG="${SCRATCH}/p2b.log"
install_gh_stub_existing_pr "$P2B_BIN" "$P2B_LOG" "true"
P2B_OUT=""
P2B_OUT="$(
  cd "$WORK"
  PATH="${P2B_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_ensure "main" "CTL-709" 2>/dev/null
)"
P2B_NUM="$(printf '%s' "$P2B_OUT" | cut -f1)"
assert_eq "99" "$P2B_NUM" "2b: returns existing PR number (99)"
if grep -q 'create' "$P2B_LOG" 2>/dev/null; then
  fail "2b: gh pr create must NOT be invoked — log: $(cat "$P2B_LOG")"
else
  pass "2b: gh pr create NOT invoked (idempotent)"
fi

# 2c: --draft rejected → retries without --draft; echoes isDraft=false
echo "2c: --draft rejected → fallback to non-draft PR; echoes isDraft=false"
new_fixture p2c
(cd "$WORK" && git push -u origin HEAD --quiet)
P2C_BIN="${SCRATCH}/p2c-bin"
P2C_LOG="${SCRATCH}/p2c.log"
install_gh_stub_draft_rejected "$P2C_BIN" "$P2C_LOG"
P2C_OUT=""
P2C_RC=0
P2C_OUT="$(
  cd "$WORK"
  PATH="${P2C_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_ensure "main" "CTL-709" 2>/dev/null
)" || P2C_RC=$?
P2C_DRAFT="$(printf '%s' "$P2C_OUT" | cut -f3)"
assert_eq "0" "$P2C_RC" "2c: returns 0 after fallback"
assert_eq "false" "$P2C_DRAFT" "2c: isDraft=false after fallback"
# Both calls should appear in log
if grep -q '\-\-draft' "$P2C_LOG" 2>/dev/null; then pass "2c: first attempt used --draft"
else fail "2c: first attempt should use --draft — log: $(cat "$P2C_LOG")"; fi

# 2d: both create attempts fail → returns non-zero; echoes nothing; prints warning
echo "2d: both create attempts fail → non-zero; no output; warning to stderr"
new_fixture p2d
(cd "$WORK" && git push -u origin HEAD --quiet)
P2D_BIN="${SCRATCH}/p2d-bin"
P2D_LOG="${SCRATCH}/p2d.log"
install_gh_stub_create_fails "$P2D_BIN" "$P2D_LOG"
P2D_OUT=""
P2D_RC=0
P2D_OUT="$(
  cd "$WORK"
  PATH="${P2D_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_ensure "main" "CTL-709" 2>/dev/null
)" || P2D_RC=$?
if [[ "$P2D_RC" != "0" ]]; then pass "2d: returns non-zero on both-fail"
else fail "2d: should return non-zero — got rc=$P2D_RC, out='$P2D_OUT'"; fi
if [[ -z "$P2D_OUT" ]]; then pass "2d: echoes nothing on both-fail"
else fail "2d: should echo nothing — got '$P2D_OUT'"; fi

# 2e: gh absent → returns non-zero + warning; no abort
echo "2e: gh absent → non-zero + warning; caller not killed"
new_fixture p2e
P2E_EMPTY_BIN="${SCRATCH}/p2e-empty-bin"
mkdir -p "$P2E_EMPTY_BIN"
P2E_RC=0
(
  cd "$WORK"
  PATH="${P2E_EMPTY_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_ensure "main" "CTL-709" >/dev/null 2>/dev/null
  P2E_RC=$?
  echo "$P2E_RC" > "${SCRATCH}/p2e.exit"
  echo "caller_survived" >> "${SCRATCH}/p2e.exit"
) || true
if [[ -f "${SCRATCH}/p2e.exit" ]]; then
  P2E_EXIT="$(head -1 "${SCRATCH}/p2e.exit")"
  if [[ "$P2E_EXIT" != "0" ]]; then pass "2e: gh absent → non-zero"
  else fail "2e: gh absent should return non-zero"; fi
  if grep -q "caller_survived" "${SCRATCH}/p2e.exit"; then pass "2e: caller survives gh-absent"
  else fail "2e: caller should survive"; fi
fi

# ─── Suite 3: draft_pr_promote ────────────────────────────────────────────────
echo ""
echo "Suite 3: draft_pr_promote"

# 3a: PR isDraft=true → calls gh pr ready; returns 0.
echo "3a: isDraft=true → gh pr ready; returns 0"
new_fixture p3a
P3A_BIN="${SCRATCH}/p3a-bin"
P3A_LOG="${SCRATCH}/p3a.log"
install_gh_stub_promote "$P3A_BIN" "$P3A_LOG" "true"
P3A_RC=0
(
  cd "$WORK"
  PATH="${P3A_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_promote >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p3a.exit"
) || true
assert_eq "0" "$(cat "${SCRATCH}/p3a.exit" 2>/dev/null)" "3a: draft_pr_promote returns 0"
if grep -q 'ready' "$P3A_LOG" 2>/dev/null; then pass "3a: gh pr ready called"
else fail "3a: gh pr ready should be called — log: $(cat "$P3A_LOG")"; fi

# 3b: PR isDraft=false → no gh pr ready; returns 0 (idempotent).
echo "3b: isDraft=false → no gh pr ready; returns 0"
new_fixture p3b
P3B_BIN="${SCRATCH}/p3b-bin"
P3B_LOG="${SCRATCH}/p3b.log"
install_gh_stub_promote "$P3B_BIN" "$P3B_LOG" "false"
(
  cd "$WORK"
  PATH="${P3B_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_promote >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p3b.exit"
) || true
assert_eq "0" "$(cat "${SCRATCH}/p3b.exit" 2>/dev/null)" "3b: draft_pr_promote returns 0 (already ready)"
if grep -q 'ready' "$P3B_LOG" 2>/dev/null; then
  fail "3b: gh pr ready must NOT be called when already ready"
else
  pass "3b: gh pr ready NOT called (idempotent)"
fi

# 3c: no PR found → returns non-zero; warning; no abort.
echo "3c: no PR found → non-zero + warning; caller survives"
new_fixture p3c
P3C_BIN="${SCRATCH}/p3c-bin"
P3C_LOG="${SCRATCH}/p3c.log"
install_gh_stub_no_pr_for_promote "$P3C_BIN" "$P3C_LOG"
(
  cd "$WORK"
  PATH="${P3C_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_promote >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p3c.exit"
  echo "caller_survived" >> "${SCRATCH}/p3c.exit"
) || true
P3C_EXIT="$(head -1 "${SCRATCH}/p3c.exit" 2>/dev/null || echo '')"
if [[ "$P3C_EXIT" != "0" ]]; then pass "3c: no-PR returns non-zero"
else fail "3c: no-PR should return non-zero"; fi
if grep -q "caller_survived" "${SCRATCH}/p3c.exit" 2>/dev/null; then pass "3c: caller survives no-PR"
else fail "3c: caller should survive"; fi

# ─── Suite 4: draft_pr_enabled ────────────────────────────────────────────────
echo ""
echo "Suite 4: draft_pr_enabled"

# Source the lib once for this suite.
# shellcheck source=../draft-pr.sh
source "$DRAFT_PR_LIB"

# 4a: no config file → true (default-on).
echo "4a: no config file → true (default)"
P4A_OUT="$(CATALYST_CONFIG_PATH="/nonexistent/config.json" draft_pr_enabled 2>/dev/null)"
assert_eq "true" "$P4A_OUT" "4a: absent config → enabled=true (default-on)"

# 4b: config with key absent → true.
echo "4b: config with key absent → true"
P4B_CONFIG="${SCRATCH}/p4b-config.json"
printf '{"catalyst":{"orchestration":{}}}\n' > "$P4B_CONFIG"
P4B_OUT="$(CATALYST_CONFIG_PATH="$P4B_CONFIG" draft_pr_enabled 2>/dev/null)"
assert_eq "true" "$P4B_OUT" "4b: key absent in config → enabled=true"

# 4c: explicit false → false.
echo "4c: explicit false → false"
P4C_CONFIG="${SCRATCH}/p4c-config.json"
printf '{"catalyst":{"orchestration":{"draftPr":{"enabled":false}}}}\n' > "$P4C_CONFIG"
P4C_OUT="$(CATALYST_CONFIG_PATH="$P4C_CONFIG" draft_pr_enabled 2>/dev/null)"
assert_eq "false" "$P4C_OUT" "4c: explicit false → enabled=false"

# 4d: explicit true → true.
echo "4d: explicit true → true"
P4D_CONFIG="${SCRATCH}/p4d-config.json"
printf '{"catalyst":{"orchestration":{"draftPr":{"enabled":true}}}}\n' > "$P4D_CONFIG"
P4D_OUT="$(CATALYST_CONFIG_PATH="$P4D_CONFIG" draft_pr_enabled 2>/dev/null)"
assert_eq "true" "$P4D_OUT" "4d: explicit true → enabled=true"

# ─── Suite 5: draft_pr_title (CTL-783) ───────────────────────────────────────
echo ""
echo "Suite 5: draft_pr_title"

# Source once for all Suite 5 tests.
source "$DRAFT_PR_LIB"

# 5a: conventional subject without ticket → ticket injected after the prefix colon
echo "5a: conventional subject without ticket → ticket injected"
P5A_OUT="$(draft_pr_title "CTL-783" "feat(dev): add early draft open" 2>/dev/null)"
assert_eq "feat(dev): CTL-783 add early draft open" "$P5A_OUT" "5a: ticket injected after prefix"

# 5b: subject already contains ticket → unchanged
echo "5b: subject already contains ticket → unchanged"
P5B_OUT="$(draft_pr_title "CTL-783" "feat(dev): CTL-783 add early draft open" 2>/dev/null)"
assert_eq "feat(dev): CTL-783 add early draft open" "$P5B_OUT" "5b: unchanged when ticket already present"

# 5c: bang variant preserved
echo "5c: bang variant preserved"
P5C_OUT="$(draft_pr_title "CTL-783" "feat(dev)!: break things" 2>/dev/null)"
assert_eq "feat(dev)!: CTL-783 break things" "$P5C_OUT" "5c: bang variant preserved"

# 5d: scopeless conventional subject
echo "5d: scopeless conventional subject"
P5D_OUT="$(draft_pr_title "CTL-783" "fix: a bug" 2>/dev/null)"
assert_eq "fix: CTL-783 a bug" "$P5D_OUT" "5d: scopeless prefix → ticket injected"

# 5e: non-conventional subject → "<ticket>: <subject>"
echo "5e: non-conventional subject → ticket: subject"
P5E_OUT="$(draft_pr_title "CTL-783" "add early draft open" 2>/dev/null)"
assert_eq "CTL-783: add early draft open" "$P5E_OUT" "5e: non-conventional → ticket: subject"

# 5f: empty ticket → subject unchanged
echo "5f: empty ticket → subject unchanged"
P5F_OUT="$(draft_pr_title "" "feat(dev): add X" 2>/dev/null)"
assert_eq "feat(dev): add X" "$P5F_OUT" "5f: empty ticket → subject unchanged"

# 5g: empty subject → echoes ticket
echo "5g: empty subject → echoes ticket"
P5G_OUT="$(draft_pr_title "CTL-783" "" 2>/dev/null)"
assert_eq "CTL-783" "$P5G_OUT" "5g: empty subject → echoes ticket"

# 5i: multiple colons in subject → split on FIRST colon only (pins design decision)
echo "5i: multiple colons → split on first colon only"
P5I_OUT="$(draft_pr_title "CTL-783" "chore: a: b: c" 2>/dev/null)"
assert_eq "chore: CTL-783 a: b: c" "$P5I_OUT" "5i: multi-colon subject splits on first colon"

# 5j: uppercase type prefix is NOT conventional → falls through to "<ticket>: <subject>"
echo "5j: uppercase type prefix → non-conventional fallback"
P5J_OUT="$(draft_pr_title "CTL-783" "Feat(dev): uppercase type" 2>/dev/null)"
assert_eq "CTL-783: Feat(dev): uppercase type" "$P5J_OUT" "5j: uppercase prefix treated as non-conventional"

# 5h: zsh-safe — draft_pr_title accessible under zsh
echo "5h: zsh-safe — draft_pr_title accessible under zsh"
ZSH5H="$(zsh -c "source '${DRAFT_PR_LIB}' && type draft_pr_title" 2>&1)"
if echo "$ZSH5H" | grep -qE 'not found|error|Error'; then
  fail "5h: draft_pr_title not accessible under zsh — got: $ZSH5H"
else
  pass "5h: draft_pr_title accessible under zsh"
fi

# Extend Suite 0 zsh check to include draft_pr_title
ZSH_CHECK5="$(zsh -c "source '${DRAFT_PR_LIB}' && type draft_pr_title && draft_pr_title 'CTL-783' 'feat(dev): add X'" 2>&1)"
if echo "$ZSH_CHECK5" | grep -q 'feat(dev): CTL-783 add X'; then
  pass "5h: draft_pr_title produces correct output under zsh"
else
  fail "5h: draft_pr_title zsh output — got: $ZSH_CHECK5"
fi

# Suite 2 extension: draft_pr_ensure routes through draft_pr_title
echo ""
echo "Suite 2 (ext): draft_pr_ensure uses draft_pr_title for --title argument"
new_fixture p2ext
(cd "$WORK" && git push -u origin HEAD --quiet)
P2EXT_BIN="${SCRATCH}/p2ext-bin"
P2EXT_LOG="${SCRATCH}/p2ext.log"
install_gh_stub_no_pr "$P2EXT_BIN" "$P2EXT_LOG"
(
  cd "$WORK"
  PATH="${P2EXT_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  draft_pr_ensure "main" "CTL-709" 2>/dev/null
) || true
# The gh stub logs all args one-per-line; find --title then check the following line
TITLE_LINE="$(awk '/^--title$/{found=1; next} found{print; exit}' "$P2EXT_LOG" 2>/dev/null || true)"
if [[ "$TITLE_LINE" == "feat: CTL-709 work commit" ]]; then
  pass "Suite 2 ext: draft_pr_ensure routes through draft_pr_title (got: $TITLE_LINE)"
else
  fail "Suite 2 ext: draft_pr_ensure --title should be 'feat: CTL-709 work commit', got: '$TITLE_LINE'"
fi

# ─── Suite 6: draft_pr_push_verify + draft_pr_head_oid (CTL-1051) ─────────────
echo ""
echo "Suite 6: draft_pr_push_verify and draft_pr_head_oid"

# 6a: fast-forward push — no prior remote ref; returns 0, echoes HEAD sha, origin == HEAD.
echo "6a: fast-forward push → returns 0, echoes HEAD sha, origin/feature == HEAD"
new_fixture pv-ff
(
  cd "$WORK"
  source "$DRAFT_PR_LIB"
  set +e
  out="$(draft_pr_push_verify 2>/dev/null)"; rc=$?
  set -e
  echo "$rc" > "${SCRATCH}/pv-ff.exit"
  echo "$out" > "${SCRATCH}/pv-ff.out"
  git rev-parse HEAD > "${SCRATCH}/pv-ff.local"
  git rev-parse origin/feature > "${SCRATCH}/pv-ff.remote" 2>/dev/null || echo "" > "${SCRATCH}/pv-ff.remote"
) || true
assert_eq "0" "$(cat "${SCRATCH}/pv-ff.exit" 2>/dev/null)" "6a: push_verify ff returns 0"
assert_eq "$(cat "${SCRATCH}/pv-ff.local")" "$(cat "${SCRATCH}/pv-ff.out")" "6a: push_verify ff echoes HEAD sha"
assert_eq "$(cat "${SCRATCH}/pv-ff.local")" "$(cat "${SCRATCH}/pv-ff.remote")" "6a: origin/feature == HEAD after ff"

# 6b: non-fast-forward (rebase/amend) — plain push fails; force-with-lease succeeds;
#     rc==0, origin/feature advances to HEAD.
echo "6b: non-fast-forward (rebase) → force-with-lease; rc==0; origin advanced"
new_fixture pv-nff
(
  cd "$WORK"
  git -c core.hooksPath=/dev/null push -u origin HEAD >/dev/null 2>&1   # commit A on origin
  git commit --quiet --amend -m "feat: amended work commit"              # diverge → commit B
  source "$DRAFT_PR_LIB"
  set +e
  out="$(draft_pr_push_verify 2>/dev/null)"; rc=$?
  set -e
  echo "$rc" > "${SCRATCH}/pv-nff.exit"
  git rev-parse HEAD > "${SCRATCH}/pv-nff.local"
  git rev-parse origin/feature > "${SCRATCH}/pv-nff.remote" 2>/dev/null || echo "" > "${SCRATCH}/pv-nff.remote"
) || true
assert_eq "0" "$(cat "${SCRATCH}/pv-nff.exit" 2>/dev/null)" "6b: push_verify rebase returns 0 (force-with-lease)"
assert_eq "$(cat "${SCRATCH}/pv-nff.local")" "$(cat "${SCRATCH}/pv-nff.remote")" "6b: origin/feature advanced to HEAD"

# 6c: detached HEAD — fail-closed; returns non-zero; echoes nothing.
echo "6c: detached HEAD → fail-closed; rc!=0; no output"
new_fixture pv-detached
(
  cd "$WORK"
  git checkout --quiet --detach HEAD
  source "$DRAFT_PR_LIB"
  set +e
  out="$(draft_pr_push_verify 2>/dev/null)"; rc=$?
  set -e
  echo "$rc" > "${SCRATCH}/pv-det.exit"
  echo "$out" > "${SCRATCH}/pv-det.out"
) || true
DET_EXIT="$(cat "${SCRATCH}/pv-det.exit" 2>/dev/null)"
DET_OUT="$(cat "${SCRATCH}/pv-det.out" 2>/dev/null)"
if [[ "$DET_EXIT" != "0" ]]; then pass "6c: push_verify detached HEAD returns non-zero"
else fail "6c: detached HEAD should return non-zero — got rc=$DET_EXIT"; fi
if [[ -z "$DET_OUT" ]]; then pass "6c: push_verify detached HEAD echoes nothing"
else fail "6c: detached HEAD should echo nothing — got '$DET_OUT'"; fi

# 6d: draft_pr_head_oid reads PR.headRefOid from gh stub.
echo "6d: draft_pr_head_oid reads PR.headRefOid"
P6D_BIN="${SCRATCH}/hoid/bin"
mkdir -p "$P6D_BIN"
cat > "${P6D_BIN}/gh" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "view" ]]; then echo "deadbeefcafe"; exit 0; fi
exit 1
STUB
chmod +x "${P6D_BIN}/gh"
(
  source "$DRAFT_PR_LIB"
  out="$(PATH="${P6D_BIN}:$PATH" draft_pr_head_oid 2>/dev/null)"
  echo "$out" > "${SCRATCH}/hoid.out"
) || true
assert_eq "deadbeefcafe" "$(cat "${SCRATCH}/hoid.out" 2>/dev/null)" "6d: head_oid echoes PR.headRefOid"

# ─── Suite 7: CTL-1119 — workflow-scope rejection detection (Phase 1 & 2) ──────
echo ""
echo "Suite 7: workflow-scope push rejection detection (CTL-1119)"

# Stub that emits the GitHub workflow-scope rejection on stderr and exits non-zero.
install_git_stub_workflow_scope_reject() {
  local bin_dir="$1" log_file="$2"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "git \$*" >> "\$LOG"
for arg in "\$@"; do
  if [[ "\$arg" == "push" ]]; then
    printf 'refusing to allow an OAuth App to create or update workflow without workflow scope\n' >&2
    exit 1
  fi
done
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# Stub: plain push fails with workflow-scope error; force-with-lease also fails the same way.
install_git_stub_workflow_scope_reject_both() {
  local bin_dir="$1" log_file="$2"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "git \$*" >> "\$LOG"
for arg in "\$@"; do
  if [[ "\$arg" == "push" ]]; then
    printf 'refusing to allow an OAuth App to create or update workflow without workflow scope\n' >&2
    exit 1
  fi
done
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# Stub: push fails with generic (non-scope) error.
install_git_stub_generic_push_fail() {
  local bin_dir="$1" log_file="$2"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
printf '%s\n' "git \$*" >> "\$LOG"
for arg in "\$@"; do
  if [[ "\$arg" == "push" ]]; then
    printf 'error: failed to push some refs to origin\n' >&2
    exit 1
  fi
done
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# Fixture builder with a .github/workflows/ commit.
new_fixture_workflow() {
  local tag="$1"
  local origin="${SCRATCH}/${tag}/origin.git"
  local work="${SCRATCH}/${tag}/work"
  git init --quiet --bare -b main "${origin}"
  git clone --quiet "${origin}" "${work}"
  (
    cd "${work}"
    printf 'base\n' > base.txt
    git add base.txt
    git commit --quiet -m "initial"
    git push --quiet origin main
    git checkout --quiet -b feature
    mkdir -p .github/workflows
    cat > .github/workflows/ci.yml <<'WORKFLOW'
on: [push]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps: []
WORKFLOW
    git add .github/workflows/ci.yml
    git commit --quiet -m "feat: add CI workflow"
  )
  ORIGIN="${origin}"
  WORK="${work}"
}

# 7a: draft_pr_diff_touches_workflows — positive (workflow file in diff)
echo "7a: draft_pr_diff_touches_workflows → 0 when .github/workflows/ in diff"
new_fixture_workflow p7a
(
  cd "$WORK"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_diff_touches_workflows "main" >/dev/null 2>&1
  echo "$?" > "${SCRATCH}/p7a.exit"
) || true
assert_eq "0" "$(cat "${SCRATCH}/p7a.exit" 2>/dev/null)" "7a: detects workflow file in diff (returns 0)"

# 7b: draft_pr_diff_touches_workflows — negative (no workflow file)
echo "7b: draft_pr_diff_touches_workflows → 1 when no .github/workflows/ in diff"
new_fixture p7b
(
  cd "$WORK"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_diff_touches_workflows "main" >/dev/null 2>&1
  echo "$?" > "${SCRATCH}/p7b.exit"
) || true
P7B_EXIT="$(cat "${SCRATCH}/p7b.exit" 2>/dev/null || echo '')"
if [[ "$P7B_EXIT" != "0" ]]; then pass "7b: no workflow file → returns 1 (non-zero)"
else fail "7b: should return non-zero when no workflow file — got rc=$P7B_EXIT"; fi

# 7c: draft_pr_push_verify returns 3 when push is rejected with workflow-scope error
echo "7c: draft_pr_push_verify returns 3 for workflow-scope rejection"
new_fixture p7c
P7C_BIN="${SCRATCH}/p7c-bin"; P7C_LOG="${SCRATCH}/p7c.log"
install_git_stub_workflow_scope_reject "$P7C_BIN" "$P7C_LOG"
(
  cd "$WORK"
  PATH="${P7C_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push_verify >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p7c.exit"
) || true
assert_eq "3" "$(cat "${SCRATCH}/p7c.exit" 2>/dev/null)" "7c: workflow-scope rejection → rc=3"

# 7d: draft_pr_push_verify returns 1 (not 3) for a generic push failure
echo "7d: draft_pr_push_verify returns 1 for generic (non-workflow-scope) push failure"
new_fixture p7d
P7D_BIN="${SCRATCH}/p7d-bin"; P7D_LOG="${SCRATCH}/p7d.log"
install_git_stub_generic_push_fail "$P7D_BIN" "$P7D_LOG"
(
  cd "$WORK"
  PATH="${P7D_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push_verify >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p7d.exit"
) || true
assert_eq "1" "$(cat "${SCRATCH}/p7d.exit" 2>/dev/null)" "7d: generic push failure → rc=1 (not 3)"

# 7e: draft_pr_push (fail-open) still returns 1 even on workflow-scope error
echo "7e: draft_pr_push (fail-open) returns 1 even on workflow-scope error"
new_fixture p7e
P7E_BIN="${SCRATCH}/p7e-bin"; P7E_LOG="${SCRATCH}/p7e.log"
install_git_stub_workflow_scope_reject "$P7E_BIN" "$P7E_LOG"
(
  cd "$WORK"
  PATH="${P7E_BIN}:${PATH}"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p7e.exit"
) || true
P7E_EXIT="$(cat "${SCRATCH}/p7e.exit" 2>/dev/null || echo '')"
if [[ "$P7E_EXIT" != "0" ]]; then pass "7e: draft_pr_push fail-open returns non-zero on workflow-scope error"
else fail "7e: draft_pr_push should return non-zero — got rc=$P7E_EXIT"; fi

# ─── Suite 8: CATALYST_WORKFLOW_GITHUB_TOKEN routing (Phase 2) ─────────────────
echo ""
echo "Suite 8: CATALYST_WORKFLOW_GITHUB_TOKEN routing (CTL-1119 Phase 2)"

# Stub: first plain push emits workflow-scope error (exits 1); token-routed push
# detects env vars proving the token was used and succeeds (exits 0).
# Records credential env to a log file for assertion.
install_git_stub_token_routing() {
  local bin_dir="$1" log_file="$2" cred_log="$3"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
CREDLOG="${cred_log}"
IS_PUSH=false
for arg in "\$@"; do [[ "\$arg" == "push" ]] && IS_PUSH=true && break; done
if [[ "\$IS_PUSH" == "true" ]]; then
  if [[ -n "\${GIT_CONFIG_KEY_1:-}" ]]; then
    # Token-routed push: log and fall through to real git (local bare origin, no HTTPS auth needed).
    printf 'token_routed\n' >> "\$CREDLOG"
  else
    # Plain push without token: emit workflow-scope rejection and fail.
    printf 'refusing to allow an OAuth App to create or update workflow without workflow scope\n' >&2
    exit 1
  fi
fi
printf '%s\n' "git \$*" >> "\$LOG"
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# Stub for non-workflow branch: plain push always succeeds; record credential env.
install_git_stub_plain_push_ok() {
  local bin_dir="$1" log_file="$2" cred_log="$3"
  local real_git
  real_git="$(command -v git)"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/git" <<STUB
#!/usr/bin/env bash
LOG="${log_file}"
CREDLOG="${cred_log}"
IS_PUSH=false
for arg in "\$@"; do [[ "\$arg" == "push" ]] && IS_PUSH=true && break; done
if [[ "\$IS_PUSH" == "true" ]]; then
  if [[ -n "\${GIT_CONFIG_KEY_1:-}" ]]; then
    printf 'token_routed\n' >> "\$CREDLOG"
  else
    printf 'plain_push\n' >> "\$CREDLOG"
  fi
fi
printf '%s\n' "git \$*" >> "\$LOG"
exec "${real_git}" "\$@"
STUB
  chmod +x "${bin_dir}/git"
}

# 8a: CATALYST_WORKFLOW_GITHUB_TOKEN set + workflow diff → token-routed push; rc=0
echo "8a: CATALYST_WORKFLOW_GITHUB_TOKEN set → token-routed push succeeds for workflow branch"
new_fixture_workflow p8a
P8A_BIN="${SCRATCH}/p8a-bin"; P8A_LOG="${SCRATCH}/p8a.log"; P8A_CRED="${SCRATCH}/p8a.cred"
install_git_stub_token_routing "$P8A_BIN" "$P8A_LOG" "$P8A_CRED"
(
  cd "$WORK"
  PATH="${P8A_BIN}:${PATH}"
  export CATALYST_WORKFLOW_GITHUB_TOKEN="ghp_testworkflowtoken"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push_verify >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p8a.exit"
  unset CATALYST_WORKFLOW_GITHUB_TOKEN
) || true
assert_eq "0" "$(cat "${SCRATCH}/p8a.exit" 2>/dev/null)" "8a: token-routed push → rc=0"
if grep -q 'token_routed' "${P8A_CRED}" 2>/dev/null; then
  pass "8a: override credential (GIT_CONFIG_KEY env) was used"
else
  fail "8a: override credential should have been used — cred log: $(cat "${P8A_CRED}" 2>/dev/null)"
fi

# 8b: CATALYST_WORKFLOW_GITHUB_TOKEN set but NO workflow file in diff → plain push, token NOT used
echo "8b: CATALYST_WORKFLOW_GITHUB_TOKEN set but non-workflow branch → normal credential used"
new_fixture p8b
P8B_BIN="${SCRATCH}/p8b-bin"; P8B_LOG="${SCRATCH}/p8b.log"; P8B_CRED="${SCRATCH}/p8b.cred"
install_git_stub_plain_push_ok "$P8B_BIN" "$P8B_LOG" "$P8B_CRED"
(
  cd "$WORK"
  PATH="${P8B_BIN}:${PATH}"
  export CATALYST_WORKFLOW_GITHUB_TOKEN="ghp_testworkflowtoken"
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push_verify >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p8b.exit"
  unset CATALYST_WORKFLOW_GITHUB_TOKEN
) || true
assert_eq "0" "$(cat "${SCRATCH}/p8b.exit" 2>/dev/null)" "8b: non-workflow branch → rc=0"
if grep -q 'token_routed' "${P8B_CRED}" 2>/dev/null; then
  fail "8b: token routing must NOT be used for non-workflow branch"
else
  pass "8b: non-workflow branch uses normal credential (no token routing)"
fi

# 8c: CATALYST_WORKFLOW_GITHUB_TOKEN NOT set + workflow-scope rejection → rc=3 (escalation path)
echo "8c: no CATALYST_WORKFLOW_GITHUB_TOKEN + workflow-scope rejection → rc=3"
new_fixture p8c
P8C_BIN="${SCRATCH}/p8c-bin"; P8C_LOG="${SCRATCH}/p8c.log"
install_git_stub_workflow_scope_reject_both "$P8C_BIN" "$P8C_LOG"
(
  cd "$WORK"
  PATH="${P8C_BIN}:${PATH}"
  unset CATALYST_WORKFLOW_GITHUB_TOKEN 2>/dev/null || true
  source "$DRAFT_PR_LIB"
  set +e
  draft_pr_push_verify >/dev/null 2>/dev/null
  echo "$?" > "${SCRATCH}/p8c.exit"
) || true
assert_eq "3" "$(cat "${SCRATCH}/p8c.exit" 2>/dev/null)" "8c: no token + workflow rejection → rc=3 (escalation)"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "draft-pr: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
