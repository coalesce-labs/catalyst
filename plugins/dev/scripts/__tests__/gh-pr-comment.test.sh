#!/usr/bin/env bash
# gh-pr-comment.test.sh — tests for plugins/dev/scripts/lib/gh-pr-comment.sh (CTL-1496).
# Run: bash plugins/dev/scripts/__tests__/gh-pr-comment.test.sh
#
# Pattern: routed `gh` stub + pass()/fail() counters, modelled after
# orchestrate-resolve-fixed-threads.test.sh.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/gh-pr-comment.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; return 0; }

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  mkdir -p "${SCRATCH}/bin"

  COMMENT_LOG="${SCRATCH}/comment.log"
  : > "$COMMENT_LOG"
  export COMMENT_LOG

  # Stubbed gh: routes by command shape; logs `pr comment` calls.
  cat > "${SCRATCH}/bin/gh" <<'STUB'
#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == *"repo view"* ]]; then
  echo '{"nameWithOwner":"test-org/test-repo"}'
elif [[ "$ARGS" == *"pr comment"* ]]; then
  echo "COMMENT_CALLED $ARGS" >> "$COMMENT_LOG"
  exit 0
elif [[ "$ARGS" == *"issues/"*"/comments"* || "$ARGS" == *"issue"*"comments"* ]]; then
  # Return existing comments fixture (default: empty).
  if [[ -n "${GH_EXISTING_COMMENTS_FIXTURE:-}" && -f "${GH_EXISTING_COMMENTS_FIXTURE}" ]]; then
    cat "${GH_EXISTING_COMMENTS_FIXTURE}"
  else
    echo "[]"
  fi
elif [[ "$ARGS" == *"pr view"* || "$ARGS" == *"issue view"* ]]; then
  echo '{"number":42}'
else
  echo "stub gh: unexpected: $ARGS" >&2
  exit 99
fi
STUB
  chmod +x "${SCRATCH}/bin/gh"
  export CATALYST_GH_PR_COMMENT_GH_BIN="${SCRATCH}/bin/gh"
}

scratch_teardown() {
  rm -rf "${SCRATCH:-}"
  unset COMMENT_LOG CATALYST_GH_PR_COMMENT_GH_BIN GH_EXISTING_COMMENTS_FIXTURE SCRATCH
}

# ── Test 1: posts comment body and exits 0 ────────────────────────────────────
scratch_setup

if bash "$HELPER" 42 "hello from catalyst" 2>/dev/null; then
  if grep -q "COMMENT_CALLED" "$COMMENT_LOG"; then
    pass "posts comment body via gh pr comment and exits 0"
  else
    fail "posts comment body via gh pr comment and exits 0" "gh pr comment not called"
  fi
else
  fail "posts comment body via gh pr comment and exits 0" "exited non-zero"
fi

scratch_teardown

# ── Test 2: --idempotent skips re-post when body already present ──────────────
scratch_setup

EXISTING_FIXTURE="${SCRATCH}/existing-comments.json"
printf '[{"body":"@codex review","user":{"login":"catalyst[bot]"}}]' > "$EXISTING_FIXTURE"
export GH_EXISTING_COMMENTS_FIXTURE="$EXISTING_FIXTURE"

if bash "$HELPER" 42 "@codex review" --idempotent 2>/dev/null; then
  if ! grep -q "COMMENT_CALLED" "$COMMENT_LOG"; then
    pass "--idempotent: skips posting when body already in last comments"
  else
    fail "--idempotent: skips posting when body already in last comments" "gh pr comment was called anyway"
  fi
else
  fail "--idempotent: skips posting when body already in last comments" "exited non-zero"
fi

scratch_teardown

# ── Test 3: --idempotent posts when body is NOT in existing comments ──────────
scratch_setup

EXISTING_FIXTURE="${SCRATCH}/existing-comments.json"
printf '[{"body":"some other comment","user":{"login":"ryan"}}]' > "$EXISTING_FIXTURE"
export GH_EXISTING_COMMENTS_FIXTURE="$EXISTING_FIXTURE"

if bash "$HELPER" 42 "@codex review" --idempotent 2>/dev/null; then
  if grep -q "COMMENT_CALLED" "$COMMENT_LOG"; then
    pass "--idempotent: posts when body not already present"
  else
    fail "--idempotent: posts when body not already present" "gh pr comment not called"
  fi
else
  fail "--idempotent: posts when body not already present" "exited non-zero"
fi

scratch_teardown

# ── Test 4: gh failure → non-zero exit, message on stderr ────────────────────
scratch_setup

cat > "${SCRATCH}/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh: network error" >&2
exit 1
STUB
chmod +x "${SCRATCH}/bin/gh"

STDERR_OUT="$(bash "$HELPER" 42 "hello" 2>&1 >/dev/null)" || EXIT=$?
if [[ "${EXIT:-0}" -ne 0 ]]; then
  pass "gh failure → non-zero exit"
else
  fail "gh failure → non-zero exit" "exited 0 despite gh error"
fi

scratch_teardown

# ── Test 5: missing PR number arg → usage error (non-zero) ───────────────────
scratch_setup

if bash "$HELPER" 2>/dev/null; then
  fail "missing PR number arg → usage error" "exited 0"
else
  pass "missing PR number arg → usage error"
fi

scratch_teardown

# ── Test 6: --idempotent existing-comment fetch failure → fail-closed ─────────
# A transient gh api hiccup must NOT fall through to a post (double-comment
# spam) — it fails closed (no post) and exits non-zero (CTL-1496).
scratch_setup

cat > "${SCRATCH}/bin/gh" <<'STUB'
#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == *"repo view"* ]]; then
  echo '{"nameWithOwner":"test-org/test-repo"}'
elif [[ "$ARGS" == *"pr comment"* ]]; then
  echo "COMMENT_CALLED $ARGS" >> "$COMMENT_LOG"
  exit 0
elif [[ "$ARGS" == *"issues/"*"/comments"* ]]; then
  echo "gh api: 502 Bad Gateway" >&2
  exit 1
else
  echo "stub gh: unexpected: $ARGS" >&2
  exit 99
fi
STUB
chmod +x "${SCRATCH}/bin/gh"

EXIT=0
bash "$HELPER" 42 "@codex review" --idempotent 2>/dev/null || EXIT=$?
if [[ "$EXIT" -ne 0 ]] && ! grep -q "COMMENT_CALLED" "$COMMENT_LOG"; then
  pass "--idempotent: fetch failure fails closed (no post, non-zero exit)"
else
  fail "--idempotent: fetch failure fails closed (no post, non-zero exit)" \
    "exit=${EXIT}, comment_log=$(cat "$COMMENT_LOG")"
fi

scratch_teardown

# ── Test 7: non-numeric PR number → rejected (non-zero) ──────────────────────
scratch_setup

if bash "$HELPER" "42; rm -rf /" "body" 2>/dev/null; then
  fail "non-numeric PR number → rejected" "exited 0 on non-numeric PR arg"
else
  pass "non-numeric PR number → rejected"
fi

scratch_teardown

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
