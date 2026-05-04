#!/usr/bin/env bash
# Shell tests for setup-webhooks.sh --add-repo (CTL-216).
#
# Verifies that --add-repo merges into .catalyst/config.json (Layer 1) under
# catalyst.monitor.github.watchRepos, with dedup and format validation.
# When invoked in --add-repo-only mode (no other intent), the script must NOT
# touch the smee channel, secret, or call out to the network — we stub `curl`
# and `openssl` to fail loudly so the test fails if the script accidentally
# enters normal setup mode.
#
# Run: bash plugins/dev/scripts/__tests__/setup-webhooks.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/plugins/dev/scripts/setup-webhooks.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Per-test fake $HOME + project tree. Build a stub-bin dir that hard-fails
# `curl` and `openssl` so any --add-repo-only invocation that accidentally
# falls through to channel/secret provisioning is caught.
make_test_env() {
  local name="$1"
  local dir="${SCRATCH}/${name}"
  mkdir -p "${dir}/home/.config/catalyst"
  mkdir -p "${dir}/project/.catalyst"
  mkdir -p "${dir}/stubbin"
  cat > "${dir}/stubbin/curl" <<'EOF'
#!/usr/bin/env bash
echo "FAIL: curl invoked during --add-repo-only mode" >&2
exit 87
EOF
  cat > "${dir}/stubbin/openssl" <<'EOF'
#!/usr/bin/env bash
# `openssl` is needed only for fresh secret generation. Hard-fail to catch
# accidental fall-through from --add-repo-only into normal setup.
echo "FAIL: openssl invoked during --add-repo-only mode" >&2
exit 87
EOF
  chmod +x "${dir}/stubbin/curl" "${dir}/stubbin/openssl"
  echo "$dir"
}

# Run setup-webhooks.sh with a fake $HOME, fake project cwd, stubbed
# curl/openssl on PATH. Real `jq` from the host PATH is preserved.
run_setup() {
  local env_dir="$1"; shift
  ( cd "${env_dir}/project" && \
    HOME="${env_dir}/home" \
    XDG_CONFIG_HOME="${env_dir}/home/.config" \
    PATH="${env_dir}/stubbin:${PATH}" \
    bash "$SETUP" "$@" )
}

# Read .catalyst.monitor.github.watchRepos from a project config as JSON array.
read_watch_repos() {
  local path="$1"
  jq -c '.catalyst.monitor.github.watchRepos // []' "$path"
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

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    return 1
  fi
}

# ─── Test 1 — single --add-repo bootstraps watchRepos array ──────────────────
test_single_add() {
  local env; env=$(make_test_env t1)
  run_setup "$env" --add-repo coalesce-labs/catalyst >/dev/null 2>&1
  local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "single add" '["coalesce-labs/catalyst"]' "$got"
}

# ─── Test 2 — multiple --add-repo flags in one invocation ──────────────────
test_multiple_adds() {
  local env; env=$(make_test_env t2)
  run_setup "$env" \
    --add-repo coalesce-labs/catalyst \
    --add-repo coalesce-labs/adva >/dev/null 2>&1
  local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "multiple adds" \
    '["coalesce-labs/catalyst","coalesce-labs/adva"]' "$got"
}

# ─── Test 3 — repeated invocations dedupe (idempotent) ─────────────────────
test_idempotent() {
  local env; env=$(make_test_env t3)
  run_setup "$env" --add-repo coalesce-labs/catalyst >/dev/null 2>&1
  run_setup "$env" --add-repo coalesce-labs/catalyst >/dev/null 2>&1
  run_setup "$env" --add-repo coalesce-labs/catalyst >/dev/null 2>&1
  local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "idempotent" '["coalesce-labs/catalyst"]' "$got"
}

# ─── Test 4 — invalid format rejected with non-zero exit ────────────────────
test_invalid_format() {
  local env; env=$(make_test_env t4)
  if run_setup "$env" --add-repo "not-a-slash" > "${SCRATCH}/t4.out" 2>&1; then
    echo "expected non-zero exit, got zero" >&2
    cat "${SCRATCH}/t4.out" >&2
    return 1
  fi
  # Ensure config wasn't touched on validation failure.
  if [[ -f "${env}/project/.catalyst/config.json" ]]; then
    local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
    expect_eq "no config write on invalid input" '[]' "$got"
  fi
}

# ─── Test 5 — empty owner or repo rejected ─────────────────────────────────
test_empty_parts_rejected() {
  local env; env=$(make_test_env t5)
  if run_setup "$env" --add-repo "/missing-owner" > /dev/null 2>&1; then
    echo "expected non-zero for /missing-owner" >&2
    return 1
  fi
  if run_setup "$env" --add-repo "missing-repo/" > /dev/null 2>&1; then
    echo "expected non-zero for missing-repo/" >&2
    return 1
  fi
  if run_setup "$env" --add-repo "a/b/c" > /dev/null 2>&1; then
    echo "expected non-zero for a/b/c (extra slash)" >&2
    return 1
  fi
}

# ─── Test 6 — preserves an existing webhookSecretEnv field ─────────────────
test_preserves_other_fields() {
  local env; env=$(make_test_env t6)
  cat > "${env}/project/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "monitor": {
      "github": {
        "webhookSecretEnv": "MY_SECRET"
      }
    }
  }
}
EOF
  run_setup "$env" --add-repo a/b >/dev/null 2>&1
  local secret_env
  secret_env=$(jq -r '.catalyst.monitor.github.webhookSecretEnv' \
    "${env}/project/.catalyst/config.json")
  expect_eq "webhookSecretEnv preserved" "MY_SECRET" "$secret_env"
  local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "watchRepos added" '["a/b"]' "$got"
}

# ─── Test 7 — --add-repo only mode never invokes curl/openssl ──────────────
# The stubbin/curl and stubbin/openssl exit 87. If the script falls through
# to channel/secret setup, the run_setup invocation will return 87 and
# write a FAIL message to the output file. We assert the run succeeded AND
# the FAIL marker is absent.
test_no_network_in_add_only_mode() {
  local env; env=$(make_test_env t7)
  if ! run_setup "$env" --add-repo a/b > "${SCRATCH}/t7.out" 2>&1; then
    echo "expected --add-repo only mode to succeed" >&2
    cat "${SCRATCH}/t7.out" >&2
    return 1
  fi
  if grep -q "FAIL: curl\|FAIL: openssl" "${SCRATCH}/t7.out"; then
    echo "--add-repo only mode unexpectedly hit curl/openssl" >&2
    cat "${SCRATCH}/t7.out" >&2
    return 1
  fi
}

# ─── Test 8 — preserves order of insertion across runs ─────────────────────
test_insertion_order() {
  local env; env=$(make_test_env t8)
  run_setup "$env" --add-repo a/first >/dev/null 2>&1
  run_setup "$env" --add-repo b/second >/dev/null 2>&1
  run_setup "$env" --add-repo c/third >/dev/null 2>&1
  local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "insertion order" '["a/first","b/second","c/third"]' "$got"
}

# ─── Test 9 — --linear-secret-env writes to project config (CTL-210) ────────
test_linear_secret_env() {
  local env; env=$(make_test_env t9)
  run_setup "$env" --linear-secret-env MY_LINEAR_SECRET >/dev/null 2>&1
  local got
  got=$(jq -r '.catalyst.monitor.linear.webhookSecretEnv' \
    "${env}/project/.catalyst/config.json")
  expect_eq "linear secret env name" "MY_LINEAR_SECRET" "$got"
}

# ─── Test 10 — --linear-secret-env only mode never invokes curl/openssl ─────
test_linear_no_network() {
  local env; env=$(make_test_env t10)
  if ! run_setup "$env" --linear-secret-env CATALYST_LINEAR_WEBHOOK_SECRET \
      > "${SCRATCH}/t10.out" 2>&1; then
    echo "expected --linear-secret-env only mode to succeed" >&2
    cat "${SCRATCH}/t10.out" >&2
    return 1
  fi
  if grep -q "FAIL: curl\|FAIL: openssl" "${SCRATCH}/t10.out"; then
    echo "--linear-secret-env only mode unexpectedly hit curl/openssl" >&2
    cat "${SCRATCH}/t10.out" >&2
    return 1
  fi
}

# ─── Test 11 — invalid env-var name rejected ────────────────────────────────
test_linear_invalid_env_name() {
  local env; env=$(make_test_env t11)
  # lowercase letters are not valid in env-var names per our schema
  if run_setup "$env" --linear-secret-env "lowercase_name" \
      > "${SCRATCH}/t11.out" 2>&1; then
    echo "expected non-zero exit for lowercase env-var name" >&2
    cat "${SCRATCH}/t11.out" >&2
    return 1
  fi
  # Starts-with-digit is also invalid.
  if run_setup "$env" --linear-secret-env "1FOO" > /dev/null 2>&1; then
    echo "expected non-zero exit for leading-digit env-var name" >&2
    return 1
  fi
}

# ─── Test 12 — combining --add-repo and --linear-secret-env in one run ──────
test_combined_flags() {
  local env; env=$(make_test_env t12)
  run_setup "$env" \
    --add-repo coalesce-labs/catalyst \
    --linear-secret-env CATALYST_LINEAR_WEBHOOK_SECRET >/dev/null 2>&1

  local repos
  repos=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "watchRepos written" '["coalesce-labs/catalyst"]' "$repos" || return 1

  local linear_env
  linear_env=$(jq -r '.catalyst.monitor.linear.webhookSecretEnv' \
    "${env}/project/.catalyst/config.json")
  expect_eq "linear env preserved" "CATALYST_LINEAR_WEBHOOK_SECRET" "$linear_env"
}

# Replace the strict-failure curl stub with a GraphQL-aware one. Used by tests
# that exercise --linear-register, which dispatches to setup-linear-webhook.sh
# and legitimately needs curl to run. openssl remains strict-failure so an
# unintended fall-through into GitHub-side setup still trips the test.
install_graphql_curl_stub() {
  local env_dir="$1"
  mkdir -p "${env_dir}/curl-fixtures"
  cat > "${env_dir}/curl-fixtures/list.json" <<'EOF'
{"data":{"webhooks":{"nodes":[]}}}
EOF
  cat > "${env_dir}/curl-fixtures/create.json" <<'EOF'
{"data":{"webhookCreate":{"success":true,"webhook":{"id":"wh-test","secret":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef","enabled":true,"url":"https://example.com/api/webhook/linear"}}}}
EOF
  cat > "${env_dir}/stubbin/curl" <<EOF
#!/usr/bin/env bash
body=\$(cat 2>/dev/null || true)
log="${env_dir}/curl-requests.log"
fixture_dir="${env_dir}/curl-fixtures"
{ echo "---REQUEST---"; echo "args: \$*"; echo "body: \$body"; } >> "\$log"
if [[ "\$body" == *"webhookCreate"* ]]; then op="create"
elif [[ "\$body" == *"webhookDelete"* ]]; then op="delete"
elif [[ "\$body" == *"webhooks"* ]]; then op="list"
else op="unknown"
fi
fixture="\${fixture_dir}/\${op}.json"
[[ -f "\$fixture" ]] && cat "\$fixture" || echo '{"data":{}}'
exit 0
EOF
  chmod +x "${env_dir}/stubbin/curl"
}

seed_layer1_layer2_for_linear() {
  local env_dir="$1"
  cat > "${env_dir}/project/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": {
      "teamKey": "TEST",
      "teamId": "00000000-0000-0000-0000-000000000001"
    }
  }
}
EOF
  cat > "${env_dir}/home/.config/catalyst/config-test-project.json" <<'EOF'
{ "linear": { "apiToken": "lin_api_test" } }
EOF
}

# ─── Test 13 — --linear-register requires --webhook-url ─────────────────────
test_linear_register_requires_webhook_url() {
  local env; env=$(make_test_env t13)
  if run_setup "$env" --linear-register > "${SCRATCH}/t13.out" 2>&1; then
    echo "expected non-zero exit when --linear-register has no --webhook-url" >&2
    return 1
  fi
  if ! grep -qi "webhook-url" "${SCRATCH}/t13.out"; then
    echo "error should mention --webhook-url" >&2
    cat "${SCRATCH}/t13.out" >&2
    return 1
  fi
  # No curl/openssl call should have happened.
  if grep -q "FAIL: curl\|FAIL: openssl" "${SCRATCH}/t13.out"; then
    echo "validation failure should reject before any network call" >&2
    return 1
  fi
}

# ─── Test 14 — --webhook-url with non-https rejected ────────────────────────
test_webhook_url_must_be_https() {
  local env; env=$(make_test_env t14)
  if run_setup "$env" --linear-register --webhook-url "http://example.com" \
      > "${SCRATCH}/t14.out" 2>&1; then
    echo "expected non-zero exit for http:// URL" >&2
    return 1
  fi
  if grep -q "FAIL: curl\|FAIL: openssl" "${SCRATCH}/t14.out"; then
    echo "validation failure should reject before any network call" >&2
    return 1
  fi
}

# ─── Test 15 — --linear-register only mode skips GitHub setup ───────────────
test_linear_register_only_skips_github() {
  local env; env=$(make_test_env t15)
  install_graphql_curl_stub "$env"
  seed_layer1_layer2_for_linear "$env"

  if ! run_setup "$env" --linear-register \
        --webhook-url https://example.com/api/webhook/linear \
      > "${SCRATCH}/t15.out" 2>&1; then
    echo "expected --linear-register only mode to succeed" >&2
    cat "${SCRATCH}/t15.out" >&2
    return 1
  fi

  # openssl is still strict-failure: GitHub setup must NOT have run.
  if grep -q "FAIL: openssl" "${SCRATCH}/t15.out"; then
    echo "GitHub setup unexpectedly ran in --linear-register only mode" >&2
    cat "${SCRATCH}/t15.out" >&2
    return 1
  fi

  # Helper script should have been dispatched (curl request logged).
  if [[ ! -s "${env}/curl-requests.log" ]]; then
    echo "expected helper to issue at least one GraphQL request" >&2
    return 1
  fi
  if ! grep -q "webhookCreate" "${env}/curl-requests.log"; then
    echo "expected helper to call webhookCreate" >&2
    return 1
  fi
}

# ─── Test 16 — combining --add-repo + --linear-register ─────────────────────
test_combined_add_repo_and_linear_register() {
  local env; env=$(make_test_env t16)
  install_graphql_curl_stub "$env"
  seed_layer1_layer2_for_linear "$env"

  if ! run_setup "$env" --add-repo coalesce-labs/catalyst \
        --linear-register \
        --webhook-url https://example.com/api/webhook/linear \
      > "${SCRATCH}/t16.out" 2>&1; then
    echo "expected combined invocation to succeed" >&2
    cat "${SCRATCH}/t16.out" >&2
    return 1
  fi

  # watchRepos should be written.
  local got; got=$(read_watch_repos "${env}/project/.catalyst/config.json")
  expect_eq "watchRepos written in combined mode" \
    '["coalesce-labs/catalyst"]' "$got" || return 1

  # Helper should have been dispatched.
  if ! grep -q "webhookCreate" "${env}/curl-requests.log"; then
    echo "expected helper to call webhookCreate in combined mode" >&2
    return 1
  fi

  # GitHub setup must NOT have run (--add-repo + --linear-register are both
  # "only intent" flags so SKIP_GITHUB_SETUP applies).
  if grep -q "FAIL: openssl" "${SCRATCH}/t16.out"; then
    echo "GitHub channel/secret setup unexpectedly ran" >&2
    cat "${SCRATCH}/t16.out" >&2
    return 1
  fi
}

# ─── Test 17 — --linear-register and --linear-deregister are mutex (CTL-238) ──
test_linear_register_deregister_mutex() {
  local env; env=$(make_test_env t17)
  if run_setup "$env" --linear-register --linear-deregister --webhook-url https://x/ \
       > "${SCRATCH}/t17.out" 2>&1; then
    echo "expected non-zero exit for register + deregister combination" >&2
    cat "${SCRATCH}/t17.out" >&2
    return 1
  fi
  if ! grep -q "mutually exclusive" "${SCRATCH}/t17.out"; then
    echo "expected mutex error message" >&2
    cat "${SCRATCH}/t17.out" >&2
    return 1
  fi
}

# ─── Test 18 — --linear-deregister only-mode skips GitHub setup (CTL-238) ───
test_linear_deregister_only_skips_github_setup() {
  local env; env=$(make_test_env t18)
  # Run will likely fail (no Layer 2 record present) but the point of this
  # test is that setup-webhooks.sh did NOT run smee channel provisioning —
  # i.e., the FAIL: curl/openssl marker from the smee channel call never
  # appears in the output.
  run_setup "$env" --linear-deregister > "${SCRATCH}/t18.out" 2>&1 || true
  if grep -q "FAIL: curl invoked during --add-repo-only mode\|FAIL: openssl" "${SCRATCH}/t18.out"; then
    echo "--linear-deregister only-mode unexpectedly hit smee channel setup" >&2
    cat "${SCRATCH}/t18.out" >&2
    return 1
  fi
}

# ─── Run all ──────────────────────────────────────────────────────────────
echo "Running setup-webhooks --add-repo tests…"
run "single add bootstraps watchRepos" test_single_add
run "multiple adds in one invocation" test_multiple_adds
run "repeated adds are idempotent (dedup)" test_idempotent
run "invalid format rejected" test_invalid_format
run "empty owner/repo parts rejected" test_empty_parts_rejected
run "preserves existing webhookSecretEnv" test_preserves_other_fields
run "no network in --add-repo only mode" test_no_network_in_add_only_mode
run "preserves insertion order across runs" test_insertion_order
run "--linear-secret-env writes config" test_linear_secret_env
run "--linear-secret-env only mode no network" test_linear_no_network
run "--linear-secret-env invalid name rejected" test_linear_invalid_env_name
run "combined --add-repo + --linear-secret-env" test_combined_flags
run "--linear-register requires --webhook-url" test_linear_register_requires_webhook_url
run "--webhook-url must be https://" test_webhook_url_must_be_https
run "--linear-register only mode skips GitHub setup" test_linear_register_only_skips_github
run "combined --add-repo + --linear-register" test_combined_add_repo_and_linear_register
run "--linear-register/-deregister mutex" test_linear_register_deregister_mutex
run "--linear-deregister only-mode skips GitHub setup" test_linear_deregister_only_skips_github_setup

echo
echo "Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
