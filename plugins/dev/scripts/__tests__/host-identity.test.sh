#!/usr/bin/env bash
# Shell tests for plugins/dev/scripts/lib/host-identity.sh.
# Validates bash host-identity primitives and cross-stack equality with node.
#
# Run: bash plugins/dev/scripts/__tests__/host-identity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/host-identity.sh"

# shellcheck disable=SC1090
source "$LIB"

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
}

fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  echo "    $detail"
}

expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$name"
  else
    fail "$name" "expected '$expected' got '$actual'"
  fi
}

# __host_name_from strips .local suffix
expect_eq "host_name strips .local" \
  "my-mac" "$(__host_name_from 'my-mac.local')"

# __host_name_from leaves non-.local hostnames intact
expect_eq "host_name no-op without .local" \
  "my-mac" "$(__host_name_from 'my-mac')"

# CATALYST_HOST_NAME override wins
expect_eq "CATALYST_HOST_NAME override" \
  "alias-1" "$(CATALYST_HOST_NAME='alias-1' catalyst_host_name)"

# catalyst_host_name without override strips .local from real hostname
ACTUAL_HOST="$(catalyst_host_name)"
if [[ -n "$ACTUAL_HOST" ]]; then
  ok "catalyst_host_name returns non-empty string"
else
  fail "catalyst_host_name non-empty" "got empty string"
fi

# .local not in the result
if [[ "$ACTUAL_HOST" != *".local" ]]; then
  ok "catalyst_host_name result has no .local suffix"
else
  fail "catalyst_host_name strips .local" "got '$ACTUAL_HOST'"
fi

# host.id is sha256[:16] of the resolved host.name
EXPECTED_ID="$(printf '%s' 'my-mac' | shasum -a 256 | cut -c1-16)"
ACTUAL_ID="$(__host_id_from 'my-mac')"
expect_eq "host_id derivation is sha256[:16]" "$EXPECTED_ID" "$ACTUAL_ID"

# host.id is exactly 16 hex chars
if [[ ${#ACTUAL_ID} -eq 16 && "$ACTUAL_ID" =~ ^[0-9a-f]+$ ]]; then
  ok "host_id is 16 hex chars"
else
  fail "host_id format" "got '$ACTUAL_ID' (len ${#ACTUAL_ID})"
fi

# catalyst_host_id deterministic
ID1="$(CATALYST_HOST_NAME='stable-host' catalyst_host_id)"
ID2="$(CATALYST_HOST_NAME='stable-host' catalyst_host_id)"
expect_eq "catalyst_host_id deterministic" "$ID1" "$ID2"

# Different host names produce different IDs
ID_A="$(__host_id_from 'host-a')"
ID_B="$(__host_id_from 'host-b')"
if [[ "$ID_A" != "$ID_B" ]]; then
  ok "different hostnames produce different host.id"
else
  fail "different hostnames differ" "both produced '$ID_A'"
fi

# CATALYST_HOST_NAME override flows through to host.id
ID_ALIAS="$(CATALYST_HOST_NAME='alias-1' catalyst_host_id)"
ID_ALIAS_DIRECT="$(__host_id_from 'alias-1')"
expect_eq "CATALYST_HOST_NAME override flows to host.id" "$ID_ALIAS_DIRECT" "$ID_ALIAS"

# Cross-stack equality: bash and node must produce the same host.id for the same input
CROSS_HOST="ci-runner-7"
BASH_ID="$(__host_id_from "$CROSS_HOST")"
EC_LIB="${REPO_ROOT}/plugins/dev/scripts/execution-core/lib/host-identity.mjs"
if command -v node >/dev/null 2>&1 && [[ -f "$EC_LIB" ]]; then
  NODE_ID="$(node --input-type=module <<EOF
import { hostId } from "${EC_LIB}";
process.stdout.write(hostId({ raw: "${CROSS_HOST}" }));
EOF
)"
  expect_eq "cross-stack host.id equality (bash == node)" "$BASH_ID" "$NODE_ID"
else
  echo "  SKIP: cross-stack test (node not available or lib missing: $EC_LIB)"
fi

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
