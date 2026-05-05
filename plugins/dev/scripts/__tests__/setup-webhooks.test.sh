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
#
# Also stubs `gh`. The stub reads scripted responses from $GH_STUB_DIR for
# tests that exercise webhook verification (CTL-254). When $GH_STUB_DIR is
# unset the stub hard-fails (loud signal that gh was called outside intent).
make_test_env() {
  local name="$1"
  local dir="${SCRATCH}/${name}"
  mkdir -p "${dir}/home/.config/catalyst"
  mkdir -p "${dir}/project/.catalyst"
  mkdir -p "${dir}/stubbin"
  mkdir -p "${dir}/gh_stub"
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
  cat > "${dir}/stubbin/gh" <<'EOF'
#!/usr/bin/env bash
# Scriptable gh stub for setup-webhooks tests.
#   GH_STUB_DIR/list-response.json — body returned for `gh api repos/X/hooks` (GET)
#   GH_STUB_DIR/post-response.json — body returned for `gh api -X POST repos/X/hooks`
#   GH_STUB_DIR/list-exit         — exit code for GET (default 0)
#   GH_STUB_DIR/post-exit         — exit code for POST (default 0)
#   GH_STUB_DIR/calls.log         — append-only call log
if [[ -z "${GH_STUB_DIR:-}" ]]; then
  echo "FAIL: gh invoked but GH_STUB_DIR is unset (test setup error)" >&2
  exit 88
fi
echo "$*" >> "${GH_STUB_DIR}/calls.log"
# `gh api -X POST repos/X/hooks ...`
if [[ "$1" == "api" && "$2" == "-X" && "$3" == "POST" && "$4" == repos/*/hooks ]]; then
  cat "${GH_STUB_DIR}/post-response.json" 2>/dev/null || echo '{"id":1}'
  exit "$(cat "${GH_STUB_DIR}/post-exit" 2>/dev/null || echo 0)"
fi
# `gh api repos/X/hooks` (GET)
if [[ "$1" == "api" && "$2" == repos/*/hooks ]]; then
  cat "${GH_STUB_DIR}/list-response.json" 2>/dev/null || echo "[]"
  exit "$(cat "${GH_STUB_DIR}/list-exit" 2>/dev/null || echo 0)"
fi
echo "stub: unhandled gh call: $*" >&2
exit 1
EOF
  chmod +x "${dir}/stubbin/curl" "${dir}/stubbin/openssl" "${dir}/stubbin/gh"
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

# ─── Tests 19-25 — GitHub webhook verification + --register-github-hooks (CTL-254)
#
# `run_setup_full` exercises the normal-setup path while keeping the test
# isolated from the network: $CATALYST_SMEE_CHANNEL is set so curl is never
# called, and the secret file is pre-seeded so openssl is never called.
# `gh` is the only allowed external command, scripted via $GH_STUB_DIR.
run_setup_full() {
  local env_dir="$1"; shift
  ( cd "${env_dir}/project" && \
    HOME="${env_dir}/home" \
    XDG_CONFIG_HOME="${env_dir}/home/.config" \
    PATH="${env_dir}/stubbin:${PATH}" \
    GH_STUB_DIR="${env_dir}/gh_stub" \
    CATALYST_SMEE_CHANNEL="https://smee.io/test-channel" \
    bash "$SETUP" "$@" )
}

# Pre-seed a secret file so the script's openssl-rand path is skipped.
seed_secret() {
  local env="$1"
  echo "deadbeef" > "${env}/home/.config/catalyst/webhook-secret"
  chmod 600 "${env}/home/.config/catalyst/webhook-secret"
}

# Pre-populate watchRepos so the verifier has something to iterate.
seed_watch_repos() {
  local env="$1"; shift
  local repos_json; repos_json=$(printf '%s\n' "$@" | jq -R . | jq -s .)
  cat > "${env}/project/.catalyst/config.json" <<EOF
{ "catalyst": { "monitor": { "github": { "watchRepos": ${repos_json} } } } }
EOF
}

# ─── Test 19 — verifier reports already-registered hook ────────────────────
test_verifier_reports_existing() {
  local env; env=$(make_test_env t19)
  seed_secret "$env"
  seed_watch_repos "$env" "acme/api"
  cat > "${env}/gh_stub/list-response.json" <<'EOF'
[{"id":42,"config":{"url":"https://smee.io/test-channel","content_type":"json"}}]
EOF
  if ! run_setup_full "$env" > "${SCRATCH}/t19.out" 2>&1; then
    echo "expected setup to succeed" >&2
    cat "${SCRATCH}/t19.out" >&2
    return 1
  fi
  if ! grep -q "already registered" "${SCRATCH}/t19.out"; then
    echo "expected output to mention 'already registered'" >&2
    cat "${SCRATCH}/t19.out" >&2
    return 1
  fi
  if grep -q "^api -X POST" "${env}/gh_stub/calls.log"; then
    echo "expected no POST to be issued when hook already exists" >&2
    cat "${env}/gh_stub/calls.log" >&2
    return 1
  fi
}

# ─── Test 20 — verifier warns when hook missing and flag absent ────────────
test_verifier_warns_missing_without_flag() {
  local env; env=$(make_test_env t20)
  seed_secret "$env"
  seed_watch_repos "$env" "acme/api"
  echo "[]" > "${env}/gh_stub/list-response.json"
  if ! run_setup_full "$env" > "${SCRATCH}/t20.out" 2>&1; then
    echo "expected setup to succeed (a missing hook is a warning, not an error)" >&2
    cat "${SCRATCH}/t20.out" >&2
    return 1
  fi
  if ! grep -q "no webhook registered" "${SCRATCH}/t20.out"; then
    echo "expected output to mention 'no webhook registered'" >&2
    cat "${SCRATCH}/t20.out" >&2
    return 1
  fi
  if grep -q "^api -X POST" "${env}/gh_stub/calls.log"; then
    echo "expected no POST without --register-github-hooks" >&2
    cat "${env}/gh_stub/calls.log" >&2
    return 1
  fi
}

# ─── Test 21 — --register-github-hooks creates the missing hook ────────────
test_registers_when_flag_set() {
  local env; env=$(make_test_env t21)
  seed_secret "$env"
  seed_watch_repos "$env" "acme/api"
  echo "[]" > "${env}/gh_stub/list-response.json"
  echo '{"id":99}' > "${env}/gh_stub/post-response.json"
  if ! run_setup_full "$env" --register-github-hooks > "${SCRATCH}/t21.out" 2>&1; then
    echo "expected setup to succeed" >&2
    cat "${SCRATCH}/t21.out" >&2
    return 1
  fi
  if ! grep -q "webhook registered" "${SCRATCH}/t21.out"; then
    echo "expected output to mention 'webhook registered'" >&2
    cat "${SCRATCH}/t21.out" >&2
    return 1
  fi
  if ! grep -q "^api -X POST repos/acme/api/hooks" "${env}/gh_stub/calls.log"; then
    echo "expected POST to repos/acme/api/hooks" >&2
    cat "${env}/gh_stub/calls.log" >&2
    return 1
  fi
  if ! grep -q "config\[url\]=https://smee.io/test-channel" "${env}/gh_stub/calls.log"; then
    echo "expected POST to include config[url]=<smee channel>" >&2
    cat "${env}/gh_stub/calls.log" >&2
    return 1
  fi
  if ! grep -q "events\[\]=pull_request" "${env}/gh_stub/calls.log"; then
    echo "expected POST to include events[]=pull_request" >&2
    cat "${env}/gh_stub/calls.log" >&2
    return 1
  fi
}

# ─── Test 22 — --register-github-hooks is idempotent (no POST if hook exists)
test_register_idempotent() {
  local env; env=$(make_test_env t22)
  seed_secret "$env"
  seed_watch_repos "$env" "acme/api"
  cat > "${env}/gh_stub/list-response.json" <<'EOF'
[{"id":42,"config":{"url":"https://smee.io/test-channel"}}]
EOF
  if ! run_setup_full "$env" --register-github-hooks > "${SCRATCH}/t22.out" 2>&1; then
    echo "expected setup to succeed" >&2
    cat "${SCRATCH}/t22.out" >&2
    return 1
  fi
  if grep -q "^api -X POST" "${env}/gh_stub/calls.log"; then
    echo "expected no POST when hook already registered (idempotent)" >&2
    cat "${env}/gh_stub/calls.log" >&2
    return 1
  fi
}

# ─── Test 23 — --add-repo only mode does NOT call gh ───────────────────────
# In this mode the script must not touch the network at all (CTL-216 contract).
# Our gh stub fails loudly when invoked without GH_STUB_DIR set; we point PATH
# at the stubbin (so `gh` resolves to it) but leave GH_STUB_DIR unset.
test_add_repo_only_no_gh_calls() {
  local env; env=$(make_test_env t23)
  if ! run_setup "$env" --add-repo a/b > "${SCRATCH}/t23.out" 2>&1; then
    echo "expected --add-repo only mode to succeed without invoking gh" >&2
    cat "${SCRATCH}/t23.out" >&2
    return 1
  fi
  if grep -q "FAIL: gh invoked" "${SCRATCH}/t23.out"; then
    echo "--add-repo only mode unexpectedly invoked gh" >&2
    cat "${SCRATCH}/t23.out" >&2
    return 1
  fi
}

# ─── Tests 24-25 — config templates carry the canonical monitor block (CTL-254)
test_example_template_has_monitor_block() {
  local file="${REPO_ROOT}/.claude/config.example.json"
  local secret_env watch_repos linear_env comment
  secret_env=$(jq -r '.catalyst.monitor.github.webhookSecretEnv' "$file")
  watch_repos=$(jq -c '.catalyst.monitor.github.watchRepos' "$file")
  linear_env=$(jq -r '.catalyst.monitor.linear.webhookSecretEnv' "$file")
  comment=$(jq -r '.catalyst.monitor."$comment" // ""' "$file")
  expect_eq "example.json github.webhookSecretEnv" "CATALYST_WEBHOOK_SECRET" "$secret_env" || return 1
  expect_eq "example.json linear.webhookSecretEnv" "CATALYST_LINEAR_WEBHOOK_SECRET" "$linear_env" || return 1
  if [[ "$watch_repos" == "null" ]]; then
    echo "example.json watchRepos must be present" >&2
    return 1
  fi
  if [[ -z "$comment" ]] || ! echo "$comment" | grep -q "Layer 2"; then
    echo "example.json must have a \$comment mentioning Layer 2 for smeeChannel" >&2
    echo "got: $comment" >&2
    return 1
  fi
}

test_template_has_monitor_block() {
  local file="${REPO_ROOT}/.claude/config.template.json"
  local secret_env watch_repos linear_env comment
  secret_env=$(jq -r '.catalyst.monitor.github.webhookSecretEnv' "$file")
  watch_repos=$(jq -c '.catalyst.monitor.github.watchRepos' "$file")
  linear_env=$(jq -r '.catalyst.monitor.linear.webhookSecretEnv' "$file")
  comment=$(jq -r '.catalyst.monitor."$comment" // ""' "$file")
  expect_eq "template.json github.webhookSecretEnv" "CATALYST_WEBHOOK_SECRET" "$secret_env" || return 1
  expect_eq "template.json linear.webhookSecretEnv" "CATALYST_LINEAR_WEBHOOK_SECRET" "$linear_env" || return 1
  expect_eq "template.json watchRepos shape" "[]" "$watch_repos" || return 1
  if [[ -z "$comment" ]] || ! echo "$comment" | grep -q "Layer 2"; then
    echo "template.json must have a \$comment mentioning Layer 2 for smeeChannel" >&2
    echo "got: $comment" >&2
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
run "verifier reports already-registered hook" test_verifier_reports_existing
run "verifier warns missing hook (no flag)" test_verifier_warns_missing_without_flag
run "--register-github-hooks creates missing hook" test_registers_when_flag_set
run "--register-github-hooks is idempotent" test_register_idempotent
run "no gh calls in --add-repo only mode" test_add_repo_only_no_gh_calls
run "config.example.json has monitor block" test_example_template_has_monitor_block
run "config.template.json has monitor block" test_template_has_monitor_block

echo
echo "Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
