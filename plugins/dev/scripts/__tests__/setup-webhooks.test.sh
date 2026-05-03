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

echo
echo "Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
