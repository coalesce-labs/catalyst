#!/usr/bin/env bash
# Shell tests for setup-linear-webhook.sh (CTL-238).
#
# CTL-238 adds Layer 2 record persistence for Linear webhook registration:
# after webhookCreate succeeds, the helper writes
# catalyst.monitor.linear.{webhookId,webhookUrl,registeredAt,resourceTypes}
# to ~/.config/catalyst/config.json. Re-running with the same URL no-ops
# based on the local record (no Linear API call). --linear-deregister
# reads the local record to call webhookDelete and clears it.
#
# Test approach: stub `curl` with a script that:
#   • routes by GraphQL query name (parses stdin JSON .query)
#   • returns a canned response for each operation
#   • appends each call to ${CURL_LOG} for assertions on call count
#
# Lives separately from setup-linear-webhook.test.sh (CTL-224's tests)
# because the two files use different curl-stub strategies — main's tests
# route via fixture files in `curl-fixtures/`, this file routes via
# STUB_RESPONSE_* env vars. Both pass against the same helper.
#
# Run: bash plugins/dev/scripts/__tests__/setup-linear-webhook-layer2.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/setup-linear-webhook.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# ─── Test environment builder ──────────────────────────────────────────────
# Builds: ${SCRATCH}/${name}/{home/.config/catalyst, project/.catalyst, stubbin}
# - .catalyst/config.json pre-seeded with projectKey + linear.teamId
# - ~/.config/catalyst/config-${PROJECT_KEY}.json pre-seeded with linear.apiToken
# - stubbin/curl: routes by GraphQL query name; logs to ${CURL_LOG}
make_test_env() {
  local name="$1"
  local dir="${SCRATCH}/${name}"
  mkdir -p "${dir}/home/.config/catalyst"
  mkdir -p "${dir}/project/.catalyst"
  mkdir -p "${dir}/stubbin"

  # Layer 1 config: projectKey + teamId
  cat > "${dir}/project/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": {
      "teamId": "11111111-2222-3333-4444-555555555555"
    }
  }
}
EOF

  # Layer 2 secrets: linear.apiToken
  cat > "${dir}/home/.config/catalyst/config-test-project.json" <<'EOF'
{
  "linear": {
    "apiToken": "test_lin_api_token_xxxxxxxxxxxxxxxx"
  }
}
EOF

  # Curl stub. Routes by .query string.
  cat > "${dir}/stubbin/curl" <<'EOF'
#!/usr/bin/env bash
# Read entire stdin (the JSON payload curl was sent via -d @-).
PAYLOAD=$(cat)
QUERY=$(printf '%s' "$PAYLOAD" | jq -r '.query // ""' 2>/dev/null)
[ -n "${CURL_LOG:-}" ] && {
  case "$QUERY" in
    *webhookCreate*) echo "create" >> "$CURL_LOG" ;;
    *webhookDelete*) echo "delete" >> "$CURL_LOG" ;;
    *webhooks*) echo "list" >> "$CURL_LOG" ;;
    *) echo "unknown" >> "$CURL_LOG" ;;
  esac
}
case "$QUERY" in
  *webhookCreate*)
    cat "${STUB_RESPONSE_CREATE:-/dev/null}"
    ;;
  *webhookDelete*)
    cat "${STUB_RESPONSE_DELETE:-/dev/null}"
    ;;
  *webhooks*)
    cat "${STUB_RESPONSE_LIST:-/dev/null}"
    ;;
  *)
    echo "STUB CURL: unknown query: $QUERY" >&2
    exit 87
    ;;
esac
EOF
  chmod +x "${dir}/stubbin/curl"

  echo "$dir"
}

# Run the helper script with fake $HOME, project cwd, and stubbed curl.
run_helper() {
  local env_dir="$1"; shift
  ( cd "${env_dir}/project" && \
    HOME="${env_dir}/home" \
    XDG_CONFIG_HOME="${env_dir}/home/.config" \
    PATH="${env_dir}/stubbin:${PATH}" \
    CURL_LOG="${env_dir}/curl-calls.log" \
    STUB_RESPONSE_LIST="${STUB_RESPONSE_LIST:-/dev/null}" \
    STUB_RESPONSE_CREATE="${STUB_RESPONSE_CREATE:-/dev/null}" \
    STUB_RESPONSE_DELETE="${STUB_RESPONSE_DELETE:-/dev/null}" \
    bash "$HELPER" "$@" )
}

# Read the Linear Layer 2 record as compact JSON ("" if absent).
read_layer2() {
  local env_dir="$1"
  local path="${env_dir}/home/.config/catalyst/config.json"
  [[ -f "$path" ]] || { echo ""; return 0; }
  jq -c '.catalyst.monitor.linear // empty' "$path" 2>/dev/null
}

# Count calls of a given type ("list", "create", "delete") in the log.
count_calls() {
  local env_dir="$1" type="$2"
  local log="${env_dir}/curl-calls.log"
  [[ -f "$log" ]] || { echo 0; return 0; }
  # grep -c prints the count and exits non-zero when count is 0; using `|| true`
  # would still preserve the printed "0" but we'd re-echo. Capture once instead.
  local n
  n=$(grep -c "^${type}$" "$log" 2>/dev/null || true)
  echo "${n:-0}"
}

# Total curl calls (any type).
total_calls() {
  local env_dir="$1"
  local log="${env_dir}/curl-calls.log"
  [[ -f "$log" ]] || { echo 0; return 0; }
  wc -l < "$log" | tr -d ' '
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

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "expected ($label): $expected" >&2
    echo "actual:   $actual" >&2
    return 1
  fi
}

# ─── Canned GraphQL responses ──────────────────────────────────────────────
# Each test sets up which response files curl will return for which operation.

write_response_create_success() {
  local file="$1" id="$2" url="$3"
  cat > "$file" <<EOF
{
  "data": {
    "webhookCreate": {
      "success": true,
      "webhook": {
        "id": "$id",
        "secret": "secret_$id",
        "enabled": true,
        "url": "$url"
      }
    }
  }
}
EOF
}

write_response_delete_success() {
  local file="$1"
  cat > "$file" <<'EOF'
{ "data": { "webhookDelete": { "success": true } } }
EOF
}

write_response_list_empty() {
  local file="$1"
  cat > "$file" <<'EOF'
{ "data": { "webhooks": { "nodes": [] } } }
EOF
}

write_response_list_one() {
  local file="$1" id="$2" url="$3"
  cat > "$file" <<EOF
{
  "data": {
    "webhooks": {
      "nodes": [
        { "id": "$id", "url": "$url", "label": "Catalyst orch-monitor", "enabled": true }
      ]
    }
  }
}
EOF
}

# ─── Test 1 — fresh registration writes Layer 2 record ─────────────────────
test_register_writes_layer2_record() {
  local env; env=$(make_test_env t1)
  local CR_RESP="${env}/create.json" LIST_RESP="${env}/list.json"
  write_response_create_success "$CR_RESP" "w1" "https://foo.test/api/webhook/linear"
  write_response_list_empty "$LIST_RESP"
  STUB_RESPONSE_CREATE="$CR_RESP" \
  STUB_RESPONSE_LIST="$LIST_RESP" \
  run_helper "$env" --webhook-url "https://foo.test/api/webhook/linear" >/dev/null 2>&1 || return 1

  local rec; rec=$(read_layer2 "$env")
  [[ -n "$rec" ]] || { echo "Layer 2 record missing"; return 1; }
  local id; id=$(printf '%s' "$rec" | jq -r '.webhookId')
  local url; url=$(printf '%s' "$rec" | jq -r '.webhookUrl')
  local ts; ts=$(printf '%s' "$rec" | jq -r '.registeredAt')
  local rt; rt=$(printf '%s' "$rec" | jq -c '.resourceTypes')
  expect_eq "webhookId" "w1" "$id" || return 1
  expect_eq "webhookUrl" "https://foo.test/api/webhook/linear" "$url" || return 1
  # ISO-8601 UTC timestamp shape
  if ! [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    echo "registeredAt malformed: $ts"; return 1
  fi
  expect_eq "resourceTypes" '["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]' "$rt" || return 1
}

# ─── Test 2 — idempotent re-run with same URL: no API call ─────────────────
test_idempotent_rerun_no_api_call() {
  local env; env=$(make_test_env t2)
  # Pre-seed Layer 2 record.
  cat > "${env}/home/.config/catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "monitor": {
      "linear": {
        "webhookId": "w1",
        "webhookUrl": "https://foo.test/api/webhook/linear",
        "registeredAt": "2026-05-04T20:00:00Z",
        "resourceTypes": ["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]
      }
    }
  }
}
EOF
  # Run with same URL; no STUB_RESPONSE_* set so any curl call returns empty.
  run_helper "$env" --webhook-url "https://foo.test/api/webhook/linear" >/dev/null 2>&1 || return 1

  local n; n=$(total_calls "$env")
  expect_eq "total curl calls" "0" "$n" || return 1

  # Layer 2 record unchanged — webhookId still w1.
  local id; id=$(read_layer2 "$env" | jq -r '.webhookId')
  expect_eq "record unchanged" "w1" "$id" || return 1
}

# ─── Test 3 — different URL without --force errors ─────────────────────────
test_rerun_different_url_errors_without_force() {
  local env; env=$(make_test_env t3)
  cat > "${env}/home/.config/catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "monitor": {
      "linear": {
        "webhookId": "w1",
        "webhookUrl": "https://foo.test/api/webhook/linear",
        "registeredAt": "2026-05-04T20:00:00Z",
        "resourceTypes": ["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]
      }
    }
  }
}
EOF
  if run_helper "$env" --webhook-url "https://bar.test/api/webhook/linear" \
       > "${SCRATCH}/t3.out" 2>&1; then
    echo "expected non-zero exit when re-registering different URL without --force" >&2
    cat "${SCRATCH}/t3.out" >&2
    return 1
  fi
  # Record must be unchanged.
  local id; id=$(read_layer2 "$env" | jq -r '.webhookId')
  expect_eq "record unchanged" "w1" "$id" || return 1
  # No Linear API call should happen.
  local n; n=$(total_calls "$env")
  expect_eq "total curl calls" "0" "$n" || return 1
}

# ─── Test 4 — --force overwrites: delete old, create new ───────────────────
test_force_overwrites_layer2_record() {
  local env; env=$(make_test_env t4)
  cat > "${env}/home/.config/catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "monitor": {
      "linear": {
        "webhookId": "w1",
        "webhookUrl": "https://foo.test/api/webhook/linear",
        "registeredAt": "2026-05-04T20:00:00Z",
        "resourceTypes": ["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]
      }
    }
  }
}
EOF
  local DEL_RESP="${env}/del.json" CR_RESP="${env}/cr.json"
  write_response_delete_success "$DEL_RESP"
  write_response_create_success "$CR_RESP" "w2" "https://bar.test/api/webhook/linear"
  STUB_RESPONSE_DELETE="$DEL_RESP" \
  STUB_RESPONSE_CREATE="$CR_RESP" \
  run_helper "$env" --webhook-url "https://bar.test/api/webhook/linear" --force \
    >/dev/null 2>&1 || return 1

  local id; id=$(read_layer2 "$env" | jq -r '.webhookId')
  local url; url=$(read_layer2 "$env" | jq -r '.webhookUrl')
  expect_eq "webhookId now w2" "w2" "$id" || return 1
  expect_eq "webhookUrl now bar" "https://bar.test/api/webhook/linear" "$url" || return 1

  # Exactly one delete + one create. NO list call (Layer 2 short-circuit avoids it).
  expect_eq "delete count" "1" "$(count_calls "$env" delete)" || return 1
  expect_eq "create count" "1" "$(count_calls "$env" create)" || return 1
  expect_eq "list count" "0" "$(count_calls "$env" list)" || return 1
}

# ─── Test 5 — --deregister uses Layer 2 ID and clears record ───────────────
test_deregister_uses_layer2_id() {
  local env; env=$(make_test_env t5)
  cat > "${env}/home/.config/catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "monitor": {
      "linear": {
        "webhookId": "w1",
        "webhookUrl": "https://foo.test/api/webhook/linear",
        "registeredAt": "2026-05-04T20:00:00Z",
        "resourceTypes": ["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]
      }
    }
  }
}
EOF
  # Pre-seed the secret file so we can verify it's removed.
  echo "old_secret" > "${env}/home/.config/catalyst/linear-webhook-secret"

  local DEL_RESP="${env}/del.json"
  write_response_delete_success "$DEL_RESP"
  STUB_RESPONSE_DELETE="$DEL_RESP" \
  run_helper "$env" --deregister >/dev/null 2>&1 || return 1

  # Layer 2 record cleared.
  local rec; rec=$(read_layer2 "$env")
  [[ -z "$rec" || "$rec" == "null" ]] || { echo "Layer 2 record not cleared: $rec"; return 1; }

  # Secret file removed.
  if [[ -f "${env}/home/.config/catalyst/linear-webhook-secret" ]]; then
    echo "linear-webhook-secret should be removed"
    return 1
  fi

  # Exactly one delete call.
  expect_eq "delete count" "1" "$(count_calls "$env" delete)" || return 1
  expect_eq "list count" "0" "$(count_calls "$env" list)" || return 1
}

# ─── Test 6 — --deregister with no record errors ───────────────────────────
test_deregister_no_record_errors() {
  local env; env=$(make_test_env t6)
  if run_helper "$env" --deregister > "${SCRATCH}/t6.out" 2>&1; then
    echo "expected non-zero exit when deregister has no record" >&2
    cat "${SCRATCH}/t6.out" >&2
    return 1
  fi
  # No curl call attempted.
  local n; n=$(total_calls "$env")
  expect_eq "total curl calls" "0" "$n" || return 1
}

# ─── Test 7 — fall back to API when Layer 2 missing (no existing webhook) ──
test_register_falls_back_to_api_when_layer2_missing() {
  local env; env=$(make_test_env t7)
  local LIST_RESP="${env}/list.json" CR_RESP="${env}/cr.json"
  write_response_list_empty "$LIST_RESP"
  write_response_create_success "$CR_RESP" "w1" "https://foo.test/api/webhook/linear"
  STUB_RESPONSE_LIST="$LIST_RESP" \
  STUB_RESPONSE_CREATE="$CR_RESP" \
  run_helper "$env" --webhook-url "https://foo.test/api/webhook/linear" \
    >/dev/null 2>&1 || return 1

  # Layer 2 record now populated.
  local id; id=$(read_layer2 "$env" | jq -r '.webhookId')
  expect_eq "webhookId" "w1" "$id" || return 1

  # API was called: list + create (no Layer 2 short-circuit available).
  expect_eq "list count" "1" "$(count_calls "$env" list)" || return 1
  expect_eq "create count" "1" "$(count_calls "$env" create)" || return 1
}

# ─── Test 8 — fall back to API list-dedup when Layer 2 missing but URL exists ──
test_register_falls_back_to_api_dedup_when_layer2_missing() {
  local env; env=$(make_test_env t8)
  local LIST_RESP="${env}/list.json"
  write_response_list_one "$LIST_RESP" "wOld" "https://foo.test/api/webhook/linear"
  STUB_RESPONSE_LIST="$LIST_RESP" \
  run_helper "$env" --webhook-url "https://foo.test/api/webhook/linear" \
    >/dev/null 2>&1 || return 1

  # No create call (existing reused), no delete.
  expect_eq "list count" "1" "$(count_calls "$env" list)" || return 1
  expect_eq "create count" "0" "$(count_calls "$env" create)" || return 1
  expect_eq "delete count" "0" "$(count_calls "$env" delete)" || return 1

  # Layer 2 record written with the discovered ID; resourceTypes omitted
  # because we couldn't observe them from a list response.
  local rec; rec=$(read_layer2 "$env")
  local id; id=$(printf '%s' "$rec" | jq -r '.webhookId')
  local url; url=$(printf '%s' "$rec" | jq -r '.webhookUrl')
  expect_eq "webhookId from list" "wOld" "$id" || return 1
  expect_eq "webhookUrl from list" "https://foo.test/api/webhook/linear" "$url" || return 1
  # resourceTypes should be absent (we don't fabricate them).
  local has_rt; has_rt=$(printf '%s' "$rec" | jq 'has("resourceTypes")')
  expect_eq "resourceTypes absent" "false" "$has_rt" || return 1
}

# ─── Run all ──────────────────────────────────────────────────────────────
echo "Running setup-linear-webhook tests…"
run "register writes Layer 2 record" test_register_writes_layer2_record
run "idempotent re-run makes no API call" test_idempotent_rerun_no_api_call
run "different URL without --force errors" test_rerun_different_url_errors_without_force
run "--force deletes old + creates new" test_force_overwrites_layer2_record
run "--deregister clears Layer 2 + secret" test_deregister_uses_layer2_id
run "--deregister with no record errors" test_deregister_no_record_errors
run "Layer 2 missing → API list+create" test_register_falls_back_to_api_when_layer2_missing
run "Layer 2 missing → API list dedup" test_register_falls_back_to_api_dedup_when_layer2_missing

echo
echo "Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
