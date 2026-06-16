#!/usr/bin/env bash
# catalyst-cluster-cli.test.sh — CTL-1183 Phase 3 CLI registration + dispatch tests.
# Asserts: (1) install-cli registers catalyst-cluster; (2) the dispatcher exists,
# is executable, prints usage on no args, and rejects unknown sub-commands;
# (3) join-token mints a 64-hex token and prints an armed URL.
# Run: bash plugins/dev/scripts/__tests__/catalyst-cluster-cli.test.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
INSTALL_CLI="${REPO_ROOT}/plugins/dev/scripts/install-cli.sh"
CLUSTER="${REPO_ROOT}/plugins/dev/scripts/catalyst-cluster"
PASS=0; FAIL=0

assert() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    PASS=$((PASS+1))
    echo "PASS: ${desc}"
  else
    FAIL=$((FAIL+1))
    echo "FAIL: ${desc} (cmd: $*)"
  fi
}

# 1. registered in the CLI_ENTRIES allowlist
assert "install-cli registers catalyst-cluster" \
  grep -q '"catalyst-cluster:catalyst-cluster"' "$INSTALL_CLI"

# 2. dispatcher exists and is executable
assert "catalyst-cluster is executable" test -x "$CLUSTER"

# 3. usage printed on no args (exit != 0 is allowed — grep only checks stdout+stderr)
out="$("$CLUSTER" 2>&1 || true)"
if echo "$out" | grep -qi "usage"; then
  PASS=$((PASS+1)); echo "PASS: usage on no args"
else
  FAIL=$((FAIL+1)); echo "FAIL: usage on no args (got: ${out})"
fi

# 4. unknown sub-command prints 'unknown' and exits non-zero
rc=0; out="$("$CLUSTER" bogus 2>&1)" || rc=$?
if echo "$out" | grep -qi "unknown" && [[ $rc -ne 0 ]]; then
  PASS=$((PASS+1)); echo "PASS: unknown sub-command"
else
  FAIL=$((FAIL+1)); echo "FAIL: unknown sub-command (rc=${rc}, out=${out})"
fi

# 5. join-token mints a jt_<64-hex> token + prints the armed URL; listener stubbed via env hook
#    (token format is the CTL-1184 store form: jt_ + 64 hex — see join-token-store.mjs)
out="$(CATALYST_JOIN_LISTENER_CMD=true "$CLUSTER" join-token --port 7401 --ttl 1 2>&1 || true)"
if echo "$out" | grep -Eq 'Join token: jt_[0-9a-f]{64}'; then
  PASS=$((PASS+1)); echo "PASS: join-token prints jt_<64-hex> token"
else
  FAIL=$((FAIL+1)); echo "FAIL: join-token jt_<64-hex> token (got: ${out})"
fi

if echo "$out" | grep -q '/join-bundle'; then
  PASS=$((PASS+1)); echo "PASS: join-token prints /join-bundle URL"
else
  FAIL=$((FAIL+1)); echo "FAIL: join-token /join-bundle URL (got: ${out})"
fi

# 6. --help flag is accepted (same as no args)
rc=0; out="$("$CLUSTER" --help 2>&1)" || rc=$?
if echo "$out" | grep -qi "usage"; then
  PASS=$((PASS+1)); echo "PASS: --help prints usage"
else
  FAIL=$((FAIL+1)); echo "FAIL: --help (got: ${out})"
fi

# CTL-1188: new verbs

# 7. usage lists all seven verbs
out="$("$CLUSTER" --help 2>&1 || true)"
for v in status add remove rename set-anchor drain tune; do
  if echo "$out" | grep -q " $v"; then
    PASS=$((PASS+1)); echo "PASS: usage lists $v"
  else
    FAIL=$((FAIL+1)); echo "FAIL: usage lists $v (got: $(echo "$out" | head -5))"
  fi
done

# 8. status routes via JS (smoke: CATALYST_CONFIG_FILE points at a temp .catalyst)
tmp="$(mktemp -d)"; mkdir -p "$tmp/.catalyst"; printf '["mini"]' > "$tmp/.catalyst/hosts.json"
out="$(CATALYST_CONFIG_FILE="$tmp/.catalyst/config.json" CATALYST_HOST_NAME=mini \
       "$CLUSTER" status --json 2>&1 || true)"
rm -rf "$tmp"
if echo "$out" | grep -q '"hosts"'; then
  PASS=$((PASS+1)); echo "PASS: status --json routes and returns hosts field"
else
  FAIL=$((FAIL+1)); echo "FAIL: status --json (got: ${out})"
fi

# 9. drain rejects a host argument (remote drain is T13 / out of scope)
rc=0; out="$("$CLUSTER" drain some-host 2>&1)" || rc=$?
if echo "$out" | grep -q "T13" && [[ $rc -ne 0 ]]; then
  PASS=$((PASS+1)); echo "PASS: drain rejects host arg with T13 pointer"
else
  FAIL=$((FAIL+1)); echo "FAIL: drain with host arg (rc=${rc}, out=${out})"
fi

echo ""
echo "catalyst-cluster-cli: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] || exit 1
