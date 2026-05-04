#!/usr/bin/env bash
# Shell tests for setup-linear-webhook.sh (CTL-224).
#
# Verifies that the helper script:
#   - Issues a single webhookCreate mutation when no matching webhook exists
#   - Detects an existing webhook and no-ops (idempotent) — case-insensitive URL match
#   - Errors when --webhook-url is missing or not https://
#   - Errors when Layer 2 secrets file is missing (.linear.apiToken)
#   - Errors when Layer 1 catalyst.linear.teamId is missing
#   - With --force, calls webhookDelete then webhookCreate in order
#   - Persists webhook secret to ~/.config/catalyst/linear-webhook-secret with mode 600
#   - Includes the canonical 6 resourceTypes in the create mutation, with
#     IssueRelation absent
#   - Returns non-zero on Linear GraphQL error responses
#   - Prints the export line on stdout for the user to add to shell rc
#
# Run: bash plugins/dev/scripts/__tests__/setup-linear-webhook.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/setup-linear-webhook.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Build a per-test fake $HOME + project tree, plus a stubbed curl that:
#   - reads the GraphQL request body from stdin (set via `-d @-` in the helper)
#   - logs the body to ${env_dir}/curl-requests.log
#   - returns a canned response from ${env_dir}/curl-fixtures/${op}.json based
#     on which mutation/query the body contains
#   - exits 0 unless ${env_dir}/curl-fixtures/EXIT_CODE exists and is non-zero
#
# openssl is also stubbed; the helper does not need it (Linear generates the
# secret server-side), so any invocation is a regression — fail loudly.
make_test_env() {
  local name="$1"
  local dir="${SCRATCH}/${name}"
  mkdir -p "${dir}/home/.config/catalyst"
  mkdir -p "${dir}/project/.catalyst"
  mkdir -p "${dir}/stubbin"
  mkdir -p "${dir}/curl-fixtures"

  # Smart curl stub: discriminates GraphQL operation by request-body substring.
  cat > "${dir}/stubbin/curl" <<EOF
#!/usr/bin/env bash
body=\$(cat)
log="${dir}/curl-requests.log"
fixture_dir="${dir}/curl-fixtures"

{
  echo "---REQUEST---"
  echo "args: \$*"
  echo "body: \$body"
} >> "\$log"

if [[ "\$body" == *"webhookCreate"* ]]; then op="create"
elif [[ "\$body" == *"webhookDelete"* ]]; then op="delete"
elif [[ "\$body" == *"webhooks"* ]]; then op="list"
else op="unknown"
fi

fixture="\${fixture_dir}/\${op}.json"
if [[ -f "\$fixture" ]]; then
  cat "\$fixture"
else
  echo '{"data":{}}'
fi

if [[ -f "\${fixture_dir}/EXIT_CODE" ]]; then
  exit "\$(cat "\${fixture_dir}/EXIT_CODE")"
fi
exit 0
EOF
  chmod +x "${dir}/stubbin/curl"

  cat > "${dir}/stubbin/openssl" <<'EOF'
#!/usr/bin/env bash
echo "FAIL: openssl invoked unexpectedly during setup-linear-webhook" >&2
exit 87
EOF
  chmod +x "${dir}/stubbin/openssl"

  echo "$dir"
}

# Pre-populate Layer 1 (catalyst.linear.teamId, catalyst.projectKey) and
# Layer 2 (linear.apiToken) so most tests don't need to repeat the boilerplate.
seed_configs() {
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
{
  "linear": {
    "apiToken": "lin_api_test_token_123"
  }
}
EOF
}

# Write a list-webhooks fixture: empty result (no existing matches).
fixture_empty_list() {
  local env_dir="$1"
  cat > "${env_dir}/curl-fixtures/list.json" <<'EOF'
{"data":{"webhooks":{"nodes":[]}}}
EOF
}

# Write a list-webhooks fixture with a matching URL.
fixture_existing_list() {
  local env_dir="$1" url="$2" id="${3:-existing-webhook-id}"
  jq -nc --arg url "$url" --arg id "$id" \
    '{data:{webhooks:{nodes:[{id:$id,url:$url,label:"old",enabled:true}]}}}' \
    > "${env_dir}/curl-fixtures/list.json"
}

# Write a webhookCreate success fixture.
fixture_create_success() {
  local env_dir="$1"
  cat > "${env_dir}/curl-fixtures/create.json" <<'EOF'
{"data":{"webhookCreate":{"success":true,"webhook":{"id":"new-webhook-id","secret":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","enabled":true,"url":"https://example.com/api/webhook/linear","resourceTypes":["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]}}}}
EOF
}

# Write a webhookDelete success fixture.
fixture_delete_success() {
  local env_dir="$1"
  cat > "${env_dir}/curl-fixtures/delete.json" <<'EOF'
{"data":{"webhookDelete":{"success":true}}}
EOF
}

# Run the helper with fake $HOME, project cwd, and stubbed PATH.
run_helper() {
  local env_dir="$1"; shift
  ( cd "${env_dir}/project" && \
    HOME="${env_dir}/home" \
    XDG_CONFIG_HOME="${env_dir}/home/.config" \
    PATH="${env_dir}/stubbin:${PATH}" \
    bash "$HELPER" "$@" )
}

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

# ─── Test 1 — fresh registration creates webhook + persists secret mode 600 ──
test_fresh_registration() {
  local env; env=$(make_test_env t1)
  seed_configs "$env"
  fixture_empty_list "$env"
  fixture_create_success "$env"

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
    > "${SCRATCH}/t1.out" 2>&1 || {
    echo "expected helper to succeed" >&2
    cat "${SCRATCH}/t1.out" >&2
    return 1
  }

  # Secret persisted at ~/.config/catalyst/linear-webhook-secret
  local secret_path="${env}/home/.config/catalyst/linear-webhook-secret"
  if [[ ! -f "$secret_path" ]]; then
    echo "secret file not created at $secret_path" >&2
    return 1
  fi

  local content
  content=$(cat "$secret_path")
  if [[ "$content" != "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" ]]; then
    echo "secret content mismatch: got $content" >&2
    return 1
  fi

  # File mode is 600 (0600 octal). %A on macOS gives 0600 / on Linux %a gives 600.
  local mode
  if mode=$(stat -f '%Lp' "$secret_path" 2>/dev/null); then
    :
  else
    mode=$(stat -c '%a' "$secret_path" 2>/dev/null)
  fi
  if [[ "$mode" != "600" ]]; then
    echo "expected mode 600, got $mode" >&2
    return 1
  fi

  # webhookCreate was called
  if ! grep -q "webhookCreate" "${env}/curl-requests.log"; then
    echo "webhookCreate not called" >&2
    cat "${env}/curl-requests.log" >&2
    return 1
  fi
}

# ─── Test 2 — idempotent re-run: existing webhook detected, no create call ───
test_idempotent_rerun() {
  local env; env=$(make_test_env t2)
  seed_configs "$env"
  fixture_existing_list "$env" "https://example.com/api/webhook/linear"
  fixture_create_success "$env"  # provided but should NOT be triggered

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
    > "${SCRATCH}/t2.out" 2>&1 || {
    echo "expected helper to succeed in idempotent path" >&2
    cat "${SCRATCH}/t2.out" >&2
    return 1
  }

  if grep -q "webhookCreate" "${env}/curl-requests.log"; then
    echo "webhookCreate unexpectedly called on idempotent re-run" >&2
    cat "${env}/curl-requests.log" >&2
    return 1
  fi

  if ! grep -qi "reusing\|existing" "${SCRATCH}/t2.out"; then
    echo "expected 'Reusing existing webhook' message" >&2
    cat "${SCRATCH}/t2.out" >&2
    return 1
  fi
}

# ─── Test 3 — case-insensitive URL match still hits dedup ──────────────────
test_case_insensitive_match() {
  local env; env=$(make_test_env t3)
  seed_configs "$env"
  fixture_existing_list "$env" "HTTPS://Example.COM/api/webhook/linear"
  fixture_create_success "$env"

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
    > "${SCRATCH}/t3.out" 2>&1 || {
    echo "expected helper to succeed" >&2
    cat "${SCRATCH}/t3.out" >&2
    return 1
  }

  if grep -q "webhookCreate" "${env}/curl-requests.log"; then
    echo "case-insensitive match should have deduped" >&2
    return 1
  fi
}

# ─── Test 4 — missing Layer 2 secrets file ──────────────────────────────────
test_missing_layer2_secrets() {
  local env; env=$(make_test_env t4)
  seed_configs "$env"
  rm -f "${env}/home/.config/catalyst/config-test-project.json"

  if run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
      > "${SCRATCH}/t4.out" 2>&1; then
    echo "expected non-zero exit when Layer 2 missing" >&2
    cat "${SCRATCH}/t4.out" >&2
    return 1
  fi

  if ! grep -qi "secrets\|apiToken\|config-test-project" "${SCRATCH}/t4.out"; then
    echo "error message should mention Layer 2 secrets file" >&2
    cat "${SCRATCH}/t4.out" >&2
    return 1
  fi
}

# ─── Test 5 — missing catalyst.linear.teamId in Layer 1 ─────────────────────
test_missing_team_id() {
  local env; env=$(make_test_env t5)
  cat > "${env}/project/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": { "teamKey": "TEST" }
  }
}
EOF
  cat > "${env}/home/.config/catalyst/config-test-project.json" <<'EOF'
{ "linear": { "apiToken": "lin_api_test" } }
EOF

  if run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
      > "${SCRATCH}/t5.out" 2>&1; then
    echo "expected non-zero exit when teamId missing" >&2
    cat "${SCRATCH}/t5.out" >&2
    return 1
  fi

  if ! grep -qi "teamId\|resolve-linear-ids" "${SCRATCH}/t5.out"; then
    echo "error should hint at running resolve-linear-ids.sh" >&2
    cat "${SCRATCH}/t5.out" >&2
    return 1
  fi
}

# ─── Test 6 — --force deletes then recreates ────────────────────────────────
test_force_recreates() {
  local env; env=$(make_test_env t6)
  seed_configs "$env"
  fixture_existing_list "$env" "https://example.com/api/webhook/linear" "old-id"
  fixture_delete_success "$env"
  fixture_create_success "$env"

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear --force \
    > "${SCRATCH}/t6.out" 2>&1 || {
    echo "expected --force to succeed" >&2
    cat "${SCRATCH}/t6.out" >&2
    return 1
  }

  if ! grep -q "webhookDelete" "${env}/curl-requests.log"; then
    echo "expected webhookDelete to be called with --force" >&2
    return 1
  fi
  if ! grep -q "webhookCreate" "${env}/curl-requests.log"; then
    echo "expected webhookCreate to be called after delete" >&2
    return 1
  fi

  # Order check: delete must precede create in the request log.
  local delete_line create_line
  delete_line=$(grep -n "webhookDelete" "${env}/curl-requests.log" | head -1 | cut -d: -f1)
  create_line=$(grep -n "webhookCreate" "${env}/curl-requests.log" | head -1 | cut -d: -f1)
  if [[ -z "$delete_line" || -z "$create_line" || "$delete_line" -gt "$create_line" ]]; then
    echo "expected delete before create, got delete=$delete_line create=$create_line" >&2
    return 1
  fi
}

# ─── Test 7 — invalid (non-https) URL rejected before any network call ──────
test_invalid_url() {
  local env; env=$(make_test_env t7)
  seed_configs "$env"

  if run_helper "$env" --webhook-url http://example.com/api/webhook/linear \
      > "${SCRATCH}/t7.out" 2>&1; then
    echo "expected non-zero exit for http:// URL" >&2
    return 1
  fi

  # No network call should have happened.
  if [[ -s "${env}/curl-requests.log" ]]; then
    echo "no curl call should have been made for invalid URL" >&2
    cat "${env}/curl-requests.log" >&2
    return 1
  fi
}

# ─── Test 8 — Linear GraphQL error response is surfaced ─────────────────────
test_graphql_error_response() {
  local env; env=$(make_test_env t8)
  seed_configs "$env"
  fixture_empty_list "$env"
  cat > "${env}/curl-fixtures/create.json" <<'EOF'
{"errors":[{"message":"Webhook URL is not reachable"}]}
EOF

  if run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
      > "${SCRATCH}/t8.out" 2>&1; then
    echo "expected non-zero exit on GraphQL error" >&2
    cat "${SCRATCH}/t8.out" >&2
    return 1
  fi

  if ! grep -qi "Webhook URL is not reachable\|linear api error" "${SCRATCH}/t8.out"; then
    echo "expected Linear's error text in output" >&2
    cat "${SCRATCH}/t8.out" >&2
    return 1
  fi
}

# ─── Test 9 — secret file mode is exactly 600 ───────────────────────────────
test_secret_file_mode_is_600() {
  local env; env=$(make_test_env t9)
  seed_configs "$env"
  fixture_empty_list "$env"
  fixture_create_success "$env"

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
    > /dev/null 2>&1

  local secret_path="${env}/home/.config/catalyst/linear-webhook-secret"
  if [[ ! -f "$secret_path" ]]; then
    echo "secret file not created" >&2
    return 1
  fi

  local mode
  if mode=$(stat -f '%Lp' "$secret_path" 2>/dev/null); then
    :
  else
    mode=$(stat -c '%a' "$secret_path" 2>/dev/null)
  fi
  if [[ "$mode" != "600" ]]; then
    echo "expected mode 600, got $mode" >&2
    return 1
  fi
}

# ─── Test 10 — resourceTypes in webhookCreate body match canonical 6 ────────
test_resource_types_canonical() {
  local env; env=$(make_test_env t10)
  seed_configs "$env"
  fixture_empty_list "$env"
  fixture_create_success "$env"

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
    > /dev/null 2>&1

  local log="${env}/curl-requests.log"
  for rt in Issue Comment IssueLabel Cycle Reaction Project; do
    if ! grep -q "$rt" "$log"; then
      echo "resourceType '$rt' missing from webhookCreate body" >&2
      cat "$log" >&2
      return 1
    fi
  done
  if grep -q "IssueRelation" "$log"; then
    echo "IssueRelation must NOT be in resourceTypes (Linear doesn't deliver it)" >&2
    return 1
  fi
}

# ─── Test 11 — --webhook-url is required ────────────────────────────────────
test_webhook_url_required() {
  local env; env=$(make_test_env t11)
  seed_configs "$env"

  if run_helper "$env" > "${SCRATCH}/t11.out" 2>&1; then
    echo "expected non-zero exit when --webhook-url missing" >&2
    return 1
  fi

  if ! grep -qi "webhook-url\|usage" "${SCRATCH}/t11.out"; then
    echo "error should mention --webhook-url or usage" >&2
    return 1
  fi
}

# ─── Test 12 — export-line printed on stdout ────────────────────────────────
test_export_line_printed() {
  local env; env=$(make_test_env t12)
  seed_configs "$env"
  fixture_empty_list "$env"
  fixture_create_success "$env"

  run_helper "$env" --webhook-url https://example.com/api/webhook/linear \
    > "${SCRATCH}/t12.out" 2>&1

  if ! grep -q "export CATALYST_LINEAR_WEBHOOK_SECRET=" "${SCRATCH}/t12.out"; then
    echo "expected export CATALYST_LINEAR_WEBHOOK_SECRET=... line on stdout" >&2
    cat "${SCRATCH}/t12.out" >&2
    return 1
  fi
}

# ─── Run all ─────────────────────────────────────────────────────────────
echo "Running setup-linear-webhook tests…"
run "fresh registration creates webhook + persists secret" test_fresh_registration
run "idempotent re-run reuses existing webhook" test_idempotent_rerun
run "case-insensitive URL match deduplicates" test_case_insensitive_match
run "missing Layer 2 secrets errors clearly" test_missing_layer2_secrets
run "missing catalyst.linear.teamId errors clearly" test_missing_team_id
run "--force deletes then recreates in order" test_force_recreates
run "invalid (non-https) URL rejected pre-network" test_invalid_url
run "GraphQL error response surfaces" test_graphql_error_response
run "secret file mode is 600" test_secret_file_mode_is_600
run "resourceTypes match canonical 6" test_resource_types_canonical
run "--webhook-url is required" test_webhook_url_required
run "export line printed on stdout" test_export_line_printed

echo
echo "Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
