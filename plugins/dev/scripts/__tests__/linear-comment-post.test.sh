#!/usr/bin/env bash
# linear-comment-post.test.sh — unit tests for linear-comment-post.sh (CTL-550)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/linear-comment-post.sh"

PASS=0
FAIL=0

assert_exit_zero() {
  local desc="$1"; shift
  local actual_exit=0
  "$@" >/dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq 0 ]]; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc (exit $actual_exit, expected 0)"
    FAIL=$((FAIL+1))
  fi
}

assert_exit_nonzero() {
  local desc="$1"; shift
  local actual_exit=0
  "$@" >/dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -ne 0 ]]; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc (exit 0, expected non-zero)"
    FAIL=$((FAIL+1))
  fi
}

assert_file_exists() {
  local path="$1"
  local desc="$2"
  if [[ -f "$path" ]]; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc (file not found: $path)"
    FAIL=$((FAIL+1))
  fi
}

assert_executable() {
  local path="$1"
  local desc="$2"
  if [[ -x "$path" ]]; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc (not executable: $path)"
    FAIL=$((FAIL+1))
  fi
}

# --- Test 1: script exists and is executable ---
assert_file_exists "$HELPER" "linear-comment-post.sh exists"
assert_executable "$HELPER" "linear-comment-post.sh is executable"

# --- Test 2: exits non-zero with no args ---
assert_exit_nonzero "exits non-zero with no args" bash "$HELPER"

# --- Test 3: exits non-zero with only one arg ---
assert_exit_nonzero "exits non-zero with only ticket arg" bash "$HELPER" "CTL-550"

# --- Test 4-7: stub curl PATH overrides ---
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

BIN_DIR="${TMPDIR_TEST}/bin"
mkdir -p "$BIN_DIR"

# Default linearis stub: fails. Tests that expect linearis to succeed override this
# individually (CTL-1182: fallback contract). Having a failing stub ensures Tests
# 6, 7, 8, etc. still assert non-zero when the app-actor path also fails.
cat >"${BIN_DIR}/linearis" <<'LINEOF'
#!/usr/bin/env bash
exit 1
LINEOF
chmod +x "${BIN_DIR}/linearis"

# Test 4: exits 0 when curl stub returns valid token + issue UUID + comment success
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
# Inspect args to route responses
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  printf '{"access_token":"test_token","token_type":"Bearer"}'
elif printf '%s' "$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":true}}}'
else
  printf '{"data":{"issues":{"nodes":[{"id":"issue-uuid-123"}]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

# Export creds via env (avoids filesystem walk)
export CATALYST_LINEAR_AGENT_CLIENT_ID="test-cid"
export CATALYST_LINEAR_AGENT_CLIENT_SECRET="test-csec"

PATH="${BIN_DIR}:$PATH" assert_exit_zero \
  "exits 0 on successful token + comment post" \
  bash "$HELPER" "CTL-550" "Hello from test"

# Test 5 (CTL-1182): when token mint fails but linearis fallback is available →
# helper now exits 0 (expectation flipped from non-zero). Add a working linearis
# stub and assert it was invoked with `issues discuss CTL-550`.
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -q "oauth/token"; then
  printf '{"error":"invalid_client"}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

LINEARIS_ARGS5="${TMPDIR_TEST}/linearis-args-5.txt"
rm -f "$LINEARIS_ARGS5"
cat >"${BIN_DIR}/linearis" <<LINEOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >"${LINEARIS_ARGS5}"
exit 0
LINEOF
chmod +x "${BIN_DIR}/linearis"

PATH="${BIN_DIR}:$PATH" assert_exit_zero \
  "exits 0 when token mint fails but linearis fallback succeeds (CTL-1182)" \
  bash "$HELPER" "CTL-550" "body"

if grep -q "discuss" "${LINEARIS_ARGS5}" 2>/dev/null && grep -q "CTL-550" "${LINEARIS_ARGS5}" 2>/dev/null; then
  echo "PASS: linearis invoked with 'issues discuss' and ticket"
  PASS=$((PASS+1))
else
  echo "FAIL: linearis not invoked correctly (args: $(cat "${LINEARIS_ARGS5}" 2>/dev/null || echo none))"
  FAIL=$((FAIL+1))
fi

# Reset linearis to fail so subsequent tests keep their non-zero expectations.
cat >"${BIN_DIR}/linearis" <<'LINEOF'
#!/usr/bin/env bash
exit 1
LINEOF
chmod +x "${BIN_DIR}/linearis"

# Test 6: exits non-zero when issue UUID resolution fails (empty nodes)
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  printf '{"access_token":"tok"}'
elif printf '%s' "$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":true}}}'
else
  printf '{"data":{"issues":{"nodes":[]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

PATH="${BIN_DIR}:$PATH" assert_exit_nonzero \
  "exits non-zero when issue not found (empty nodes)" \
  bash "$HELPER" "CTL-550" "body"

# Test 7: exits non-zero when commentCreate returns success: false
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  printf '{"access_token":"tok"}'
elif printf '%s' "$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":false}}}'
else
  printf '{"data":{"issues":{"nodes":[{"id":"uuid-1"}]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

PATH="${BIN_DIR}:$PATH" assert_exit_nonzero \
  "exits non-zero when commentCreate returns success=false" \
  bash "$HELPER" "CTL-550" "body"

# Test 8: exits non-zero when CATALYST_LINEAR_AGENT_CLIENT_ID not set and no config.
# Use PATH="${BIN_DIR}:$PATH" so the failing linearis stub (set above) shadows any
# real linearis installation — ensuring both the app-actor AND linearis paths fail
# and the exit is still non-zero (CTL-1182: only exit 0 when either path succeeds).
unset CATALYST_LINEAR_AGENT_CLIENT_ID
unset CATALYST_LINEAR_AGENT_CLIENT_SECRET

PATH="${BIN_DIR}:$PATH" assert_exit_nonzero \
  "exits non-zero when no creds, no config, and linearis unavailable" \
  bash -c "cd /tmp && PATH='${BIN_DIR}:${PATH}' bash '$HELPER' CTL-550 body"

# Reinstate the success curl stub for the file-resolution back-compat tests.
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  printf '{"access_token":"test_token","token_type":"Bearer"}'
elif printf '%s' "$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":true}}}'
else
  printf '{"data":{"issues":{"nodes":[{"id":"issue-uuid-123"}]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

# Test 9 (CTL-749 back-compat): NEW global path
# ~/.config/catalyst/config.json → catalyst.linear.bot.worker.{clientId,clientSecret}.
# No env creds, no per-team file — must resolve from the global bot.worker key.
NEW_HOME="${TMPDIR_TEST}/home-new"
mkdir -p "${NEW_HOME}/.config/catalyst" "${NEW_HOME}/work"
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"new-cid","clientSecret":"new-csec"}}}}}' \
  >"${NEW_HOME}/.config/catalyst/config.json"
PATH="${BIN_DIR}:$PATH" assert_exit_zero \
  "resolves NEW global catalyst.linear.bot.worker.{clientId,clientSecret}" \
  env HOME="${NEW_HOME}" bash -c "cd '${NEW_HOME}/work' && bash '$HELPER' CTL-550 body"

# Test 10 (CTL-749 back-compat): OLD per-team fallback
# config-<key>.json → catalyst.linear.agent.* resolved via nested .catalyst.projectKey,
# with the global config carrying only the orchestrator placeholder (no bot.worker).
OLD_HOME="${TMPDIR_TEST}/home-old"
mkdir -p "${OLD_HOME}/.config/catalyst" "${OLD_HOME}/repo/.catalyst"
printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":{"clientId":"orch-only"}}}}}' \
  >"${OLD_HOME}/.config/catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"old-cid","clientSecret":"old-csec"}}}}' \
  >"${OLD_HOME}/.config/catalyst/config-catalyst-workspace.json"
printf '%s' '{"catalyst":{"projectKey":"catalyst-workspace"}}' \
  >"${OLD_HOME}/repo/.catalyst/config.json"
PATH="${BIN_DIR}:$PATH" assert_exit_zero \
  "falls back to OLD per-team catalyst.linear.agent.* via nested projectKey" \
  env HOME="${OLD_HOME}" bash -c "cd '${OLD_HOME}/repo' && bash '$HELPER' CTL-550 body"

# Test 11 (CTL-835): the oauth/token mint request carries the scope param.
# Without an explicit scope Linear rejects the mint with 400 invalid_scope and
# the mirror fails open — the comment silently never posts. Stub curl records
# the args it received for the oauth/token call so we can assert scope is present.
export CATALYST_LINEAR_AGENT_CLIENT_ID="test-cid"
export CATALYST_LINEAR_AGENT_CLIENT_SECRET="test-csec"

SCOPE_CAPTURE="${TMPDIR_TEST}/token-args.txt"
cat >"${BIN_DIR}/curl" <<CURLEOF
#!/usr/bin/env bash
ARGS_STR="\$*"
if printf '%s' "\$ARGS_STR" | grep -q "oauth/token"; then
  printf '%s\n' "\$ARGS_STR" >"${SCOPE_CAPTURE}"
  printf '{"access_token":"test_token","token_type":"Bearer"}'
elif printf '%s' "\$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":true}}}'
else
  printf '{"data":{"issues":{"nodes":[{"id":"issue-uuid-123"}]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

PATH="${BIN_DIR}:$PATH" bash "$HELPER" "CTL-550" "body" >/dev/null 2>&1 || true
if grep -q "scope=read,write,comments:create" "${SCOPE_CAPTURE}" 2>/dev/null; then
  echo "PASS: oauth/token mint request includes scope=read,write,comments:create"
  PASS=$((PASS+1))
else
  echo "FAIL: oauth/token mint request missing scope (got: $(cat "${SCOPE_CAPTURE}" 2>/dev/null))"
  FAIL=$((FAIL+1))
fi

# Test 12 (CTL-835): a 400 invalid_scope mint emits a diagnostic carrying the real
# cause (invalid_scope) — no longer silent. With the CTL-1182 fallback in place,
# both the app-actor diagnostic AND the linearis fallback diagnostic may appear, so
# we drop the strict "exactly one line" count and assert only that invalid_scope is
# present and a fallback diagnostic appears (BIN_DIR/linearis exits 1 = both fail).
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  # Emulate `curl -w '\n%{http_code}'`: body + newline + status. -f is NOT used
  # by the helper, so the body is returned even on a 400.
  printf '{"error":"invalid_scope","error_description":"missing scope"}\n400'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

STDERR_OUT="$(PATH="${BIN_DIR}:$PATH" bash "$HELPER" "CTL-550" "body" 2>&1 1>/dev/null || true)"
if printf '%s' "$STDERR_OUT" | grep -q "invalid_scope"; then
  echo "PASS: diagnostic surfaces the invalid_scope cause (CTL-835)"
  PASS=$((PASS+1))
else
  echo "FAIL: diagnostic did not surface invalid_scope (out: ${STDERR_OUT})"
  FAIL=$((FAIL+1))
fi
# CTL-1182: with fallback, stderr also contains a linearis-fallback diagnostic
# (BIN_DIR/linearis exits 1 → both paths fail → fallback diagnostic appears).
if printf '%s' "$STDERR_OUT" | grep -q "linearis"; then
  echo "PASS: fallback diagnostic present in stderr when linearis fails (CTL-1182)"
  PASS=$((PASS+1))
else
  echo "FAIL: no linearis fallback diagnostic in stderr (out: ${STDERR_OUT})"
  FAIL=$((FAIL+1))
fi

# --- Test 13 (CTL-1111): projectKey-absent path emits a loud warning AND still
#     posts via branch 1 (global bot.worker). The warning must name the missing
#     projectKey and go to stderr; it must NOT corrupt the resolved path. ---
NOKEY_HOME="${TMPDIR_TEST}/home-nokey"
mkdir -p "${NOKEY_HOME}/.config/catalyst" "${NOKEY_HOME}/work/sub"
# Global config carries bot.worker so the post still succeeds (branch 1 wins).
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"nk-cid","clientSecret":"nk-csec"}}}}}' \
  >"${NOKEY_HOME}/.config/catalyst/config.json"
unset CATALYST_LINEAR_AGENT_CLIENT_ID CATALYST_LINEAR_AGENT_CLIENT_SECRET 2>/dev/null || true
# Reinstate success curl stub for this test.
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  printf '{"access_token":"test_token","token_type":"Bearer"}'
elif printf '%s' "$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":true}}}'
else
  printf '{"data":{"issues":{"nodes":[{"id":"issue-uuid-123"}]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"
NK_STDERR="$(PATH="${BIN_DIR}:$PATH" env HOME="${NOKEY_HOME}" \
  bash -c "cd '${NOKEY_HOME}/work/sub' && bash '$HELPER' CTL-550 body" 2>&1 1>/dev/null || true)"
NK_EXIT=0
PATH="${BIN_DIR}:$PATH" env HOME="${NOKEY_HOME}" \
  bash -c "cd '${NOKEY_HOME}/work/sub' && bash '$HELPER' CTL-550 body" >/dev/null 2>/dev/null || NK_EXIT=$?
if printf '%s' "$NK_STDERR" | grep -qi "no projectKey"; then
  echo "PASS: projectKey-absent path emits a loud warning naming the missing key"
  PASS=$((PASS+1))
else
  echo "FAIL: projectKey-absent path emitted no warning (stderr: ${NK_STDERR})"
  FAIL=$((FAIL+1))
fi
if [[ "$NK_EXIT" -eq 0 ]]; then
  echo "PASS: projectKey-absent path still posts via global bot.worker (back-compat)"
  PASS=$((PASS+1))
else
  echo "FAIL: projectKey-absent path broke back-compat post (exit $NK_EXIT)"
  FAIL=$((FAIL+1))
fi

# --- Test 14 (CTL-1111): projectKey-PRESENT path must NOT emit the drift warning
#     (guards against the warning over-firing on correctly-configured worktrees). ---
HASKEY_HOME="${TMPDIR_TEST}/home-haskey"
mkdir -p "${HASKEY_HOME}/.config/catalyst" "${HASKEY_HOME}/repo/.catalyst"
printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":{"clientId":"orch-only"}}}}}' \
  >"${HASKEY_HOME}/.config/catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"hk-cid","clientSecret":"hk-csec"}}}}' \
  >"${HASKEY_HOME}/.config/catalyst/config-catalyst-workspace.json"
printf '%s' '{"catalyst":{"projectKey":"catalyst-workspace"}}' \
  >"${HASKEY_HOME}/repo/.catalyst/config.json"
HK_STDERR="$(PATH="${BIN_DIR}:$PATH" env HOME="${HASKEY_HOME}" \
  bash -c "cd '${HASKEY_HOME}/repo' && bash '$HELPER' CTL-550 body" 2>&1 1>/dev/null || true)"
if printf '%s' "$HK_STDERR" | grep -qi "no projectKey"; then
  echo "FAIL: drift warning over-fired on a projectKey-present worktree (stderr: ${HK_STDERR})"
  FAIL=$((FAIL+1))
else
  echo "PASS: no drift warning when projectKey resolves correctly"
  PASS=$((PASS+1))
fi

# ─── CTL-1182: new fallback contract tests ──────────────────────────────────

# Test 15: both app-actor AND linearis fail → exit non-zero
export CATALYST_LINEAR_AGENT_CLIENT_ID="test-cid"
export CATALYST_LINEAR_AGENT_CLIENT_SECRET="test-csec"
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -q "oauth/token"; then
  printf '{"error":"invalid_client"}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"
# BIN_DIR/linearis already exits 1 (reset after Test 5).
PATH="${BIN_DIR}:$PATH" assert_exit_nonzero \
  "exits non-zero when both app-actor and linearis fail (CTL-1182)" \
  bash "$HELPER" "CTL-550" "body"

# Test 16: no linearis on PATH (only curl, which fails) → exit non-zero, app-actor
# diagnostic still present.
NOLIN_BIN="${TMPDIR_TEST}/nolin-bin"
mkdir -p "$NOLIN_BIN"
cat >"${NOLIN_BIN}/curl" <<'CURLEOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -q "oauth/token"; then
  printf '{"error":"invalid_scope","error_description":"missing scope"}\n400'
fi
exit 0
CURLEOF
chmod +x "${NOLIN_BIN}/curl"
# No linearis in NOLIN_BIN.
NOLIN_STDERR="$(PATH="${NOLIN_BIN}:/usr/bin:/bin:/usr/local/bin" \
  bash "$HELPER" "CTL-550" "body" 2>&1 1>/dev/null || true)"
NOLIN_EXIT=0
PATH="${NOLIN_BIN}:/usr/bin:/bin:/usr/local/bin" \
  bash "$HELPER" "CTL-550" "body" >/dev/null 2>/dev/null || NOLIN_EXIT=$?
if [[ "$NOLIN_EXIT" -ne 0 ]]; then
  echo "PASS: exits non-zero when no linearis on PATH and app-actor fails (CTL-1182)"
  PASS=$((PASS+1))
else
  echo "FAIL: expected non-zero, got 0 (linearis may unexpectedly be on PATH)"
  FAIL=$((FAIL+1))
fi
if printf '%s' "$NOLIN_STDERR" | grep -q "invalid_scope"; then
  echo "PASS: app-actor diagnostic still present when linearis unavailable (CTL-1182)"
  PASS=$((PASS+1))
else
  echo "FAIL: app-actor diagnostic missing when linearis unavailable (stderr: ${NOLIN_STDERR})"
  FAIL=$((FAIL+1))
fi

# Test 17: app-actor succeeds → linearis NOT called (no double-post).
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
ARGS_STR="$*"
if printf '%s' "$ARGS_STR" | grep -q "oauth/token"; then
  printf '{"access_token":"test_token","token_type":"Bearer"}'
elif printf '%s' "$ARGS_STR" | grep -q "commentCreate"; then
  printf '{"data":{"commentCreate":{"success":true}}}'
else
  printf '{"data":{"issues":{"nodes":[{"id":"issue-uuid-123"}]}}}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"
LINEARIS_RECORD17="${TMPDIR_TEST}/linearis-record-17.txt"
rm -f "$LINEARIS_RECORD17"
cat >"${BIN_DIR}/linearis" <<LINEOF
#!/usr/bin/env bash
touch "${LINEARIS_RECORD17}"
exit 0
LINEOF
chmod +x "${BIN_DIR}/linearis"

PATH="${BIN_DIR}:$PATH" assert_exit_zero \
  "app-actor success exits 0 (baseline for double-post check, CTL-1182)" \
  bash "$HELPER" "CTL-550" "body"
if [[ ! -f "$LINEARIS_RECORD17" ]]; then
  echo "PASS: linearis NOT called when app-actor succeeds — no double-post (CTL-1182)"
  PASS=$((PASS+1))
else
  echo "FAIL: linearis was called even though app-actor succeeded"
  FAIL=$((FAIL+1))
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
