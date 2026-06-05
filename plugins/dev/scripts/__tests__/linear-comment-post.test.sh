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

# Test 5: exits non-zero when token mint fails (curl returns error body, no access_token)
cat >"${BIN_DIR}/curl" <<'CURLEOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -q "oauth/token"; then
  printf '{"error":"invalid_client"}'
fi
exit 0
CURLEOF
chmod +x "${BIN_DIR}/curl"

PATH="${BIN_DIR}:$PATH" assert_exit_nonzero \
  "exits non-zero when token mint returns no access_token" \
  bash "$HELPER" "CTL-550" "body"

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

# Test 8: exits non-zero when CATALYST_LINEAR_AGENT_CLIENT_ID not set and no config
unset CATALYST_LINEAR_AGENT_CLIENT_ID
unset CATALYST_LINEAR_AGENT_CLIENT_SECRET

# Run from a dir with no .catalyst/config.json ancestry
assert_exit_nonzero \
  "exits non-zero when no creds and no config file" \
  bash -c "cd /tmp && bash '$HELPER' CTL-550 body"

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

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
