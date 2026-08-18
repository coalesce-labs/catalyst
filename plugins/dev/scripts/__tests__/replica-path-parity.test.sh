#!/usr/bin/env bash
# Cross-stack parity test for lib/replica-path.mjs vs lib/catalyst-replica-path.sh
# (CTL-1893).
#
# Built on the proven mechanism in __tests__/secret-contract-parity.test.sh and
# __tests__/deployment-mode-parity.test.sh: run identical inputs through both engines and
# compare BOTH against a computed expectation.
#
#   1. THREE-WAY ASSERTION — bash == expected AND node == expected, never merely
#      bash == node. Two engines can agree with each other while both disagree with the
#      spec, which is a false-green on the exact property this file exists to guard. Every
#      row below therefore carries its own expected value, written out by hand.
#   2. NAMED FAILURES ARE COMPARED TOO — "account-absent" and "account-invalid" are part
#      of the contract, not error text. A resolver that fails for the wrong REASON is a
#      failure, because the two reasons route to different operator actions.
#   3. THE DEFAULT-ACCOUNT CONSTANT IS ASSERTED, NOT TRUSTED — it is duplicated across
#      three files (replica-path.mjs, catalyst-replica-path.sh, cloud-sync.mjs) and a
#      silent drift there re-points a whole host.
#
# Every cell runs under `env -i` so a developer's real CATALYST_DIR / CATALYST_REPLICA_DB /
# HOME cannot leak into a fixture and make a row pass for the wrong reason.
#
# Run: bash plugins/dev/scripts/__tests__/replica-path-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SH_LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-replica-path.sh"
JS_LIB="${REPO_ROOT}/plugins/dev/scripts/lib/replica-path.mjs"

FAILURES=0
PASSES=0

ok() { PASSES=$((PASSES + 1)); }
fail() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $1"
  echo "    $2"
}

[ -f "$SH_LIB" ] || { echo "FATAL: missing $SH_LIB"; exit 1; }
[ -f "$JS_LIB" ] || { echo "FATAL: missing $JS_LIB"; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "FATAL: node not on PATH — parity cannot be asserted"; exit 1; }

# run_sh <account> <CATALYST_DIR> <HOME> <CATALYST_REPLICA_DB>
# Emits one line: "<ok|reason>|<value>|<source>|<disagrees>"
run_sh() {
  env -i PATH="$PATH" \
    CATALYST_DIR="$2" HOME="$3" CATALYST_REPLICA_DB="$4" \
    bash -c '
      set -uo pipefail
      # shellcheck disable=SC1090
      . "'"$SH_LIB"'"
      # NOTE: called DIRECTLY, never as $(...) — the named reason lives in a global and a
      # subshell would discard it. This is the contract the library header describes, and
      # exercising it here is deliberate.
      if catalyst_replica_path "$1"; then
        printf "ok|%s|%s|%s\n" "$CATALYST_REPLICA_PATH_VALUE" "$CATALYST_REPLICA_PATH_SOURCE" "$CATALYST_REPLICA_PATH_DISAGREES"
      else
        printf "%s|%s|%s|%s\n" "$CATALYST_REPLICA_PATH_REASON" "$CATALYST_REPLICA_PATH_VALUE" "$CATALYST_REPLICA_PATH_SOURCE" "$CATALYST_REPLICA_PATH_DISAGREES"
      fi
    ' _ "$1" 2>/dev/null
}

run_js() {
  env -i PATH="$PATH" \
    CATALYST_DIR="$2" HOME="$3" CATALYST_REPLICA_DB="$4" ACCOUNT="$1" \
    "$NODE_BIN" --input-type=module -e '
      import { resolveReplicaPath } from "'"$JS_LIB"'";
      const r = resolveReplicaPath({ account: process.env.ACCOUNT, env: process.env });
      if (r.ok) process.stdout.write(`ok|${r.path}|${r.source}|${r.overrideDisagrees ? 1 : 0}\n`);
      else process.stdout.write(`${r.reason}|||0\n`);
    ' 2>/dev/null
}

# ─── the fixture matrix ──────────────────────────────────────────────────────────────
# account | CATALYST_DIR | HOME | CATALYST_REPLICA_DB | EXPECTED
# EXPECTED is hand-written, never derived by running either engine.
run_row() {
  local name="$1" account="$2" dir="$3" home="$4" override="$5" expected="$6"
  local got_sh got_js
  got_sh="$(run_sh "$account" "$dir" "$home" "$override")"
  got_js="$(run_js "$account" "$dir" "$home" "$override")"
  if [ "$got_sh" != "$expected" ]; then
    fail "$name [bash vs expected]" "expected: $expected
    bash got: $got_sh"
  else ok; fi
  if [ "$got_js" != "$expected" ]; then
    fail "$name [node vs expected]" "expected: $expected
    node got: $got_js"
  else ok; fi
}

echo "replica-path parity (CTL-1893)"

run_row "default account keeps the legacy path" \
  "tenant-0" "/c" "/h" "" "ok|/c/catalyst-replica.db|derived-default|0"

run_row "non-default account derives its own file" \
  "tenant-7" "/c" "/h" "" "ok|/c/replicas/tenant-7.db|derived|0"

run_row "CATALYST_DIR absent falls back to HOME/catalyst" \
  "tenant-0" "" "/h" "" "ok|/h/catalyst/catalyst-replica.db|derived-default|0"

run_row "CATALYST_DIR absent, non-default account" \
  "acme.eu-1" "" "/h" "" "ok|/h/catalyst/replicas/acme.eu-1.db|derived|0"

run_row "override is honoured and flagged as disagreeing" \
  "tenant-7" "/c" "/h" "/tmp/x.db" "ok|/tmp/x.db|override|1"

run_row "override that agrees is not a disagreement" \
  "tenant-7" "/c" "/h" "/c/replicas/tenant-7.db" "ok|/c/replicas/tenant-7.db|override-agrees|0"

run_row "override on the default account, disagreeing" \
  "tenant-0" "/c" "/h" "/tmp/x.db" "ok|/tmp/x.db|override|1"

run_row "an EMPTY override is not an override" \
  "tenant-0" "/c" "/h" "" "ok|/c/catalyst-replica.db|derived-default|0"

# Named failures — the reason itself is the contract.
run_row "empty account is account-absent" \
  "" "/c" "/h" "" "account-absent|||0"

run_row "whitespace-only account is account-absent" \
  "   " "/c" "/h" "" "account-absent|||0"

run_row "traversal is account-invalid" \
  "../etc" "/c" "/h" "" "account-invalid|||0"

run_row "a separator is account-invalid" \
  "a/b" "/c" "/h" "" "account-invalid|||0"

run_row "a leading dot is account-invalid" \
  ".hidden" "/c" "/h" "" "account-invalid|||0"

run_row "a leading hyphen is account-invalid (reads as a CLI flag downstream)" \
  "-flag" "/c" "/h" "" "account-invalid|||0"

run_row "an inner space is account-invalid, NOT silently trimmed" \
  "te nant" "/c" "/h" "" "account-invalid|||0"

run_row "a padded-but-real account is account-invalid, NOT silently trimmed" \
  " tenant-0 " "/c" "/h" "" "account-invalid|||0"

# ─── the shared constant, asserted rather than trusted ────────────────────────────────
SH_DEFAULT="$(env -i PATH="$PATH" bash -c '. "'"$SH_LIB"'"; printf "%s" "$CATALYST_REPLICA_DEFAULT_ACCOUNT"')"
JS_DEFAULT="$(env -i PATH="$PATH" "$NODE_BIN" --input-type=module -e '
  import { DEFAULT_ACCOUNT } from "'"$JS_LIB"'";
  process.stdout.write(DEFAULT_ACCOUNT);
')"
CS_DEFAULT="$(/usr/bin/grep -oE 'const DEFAULT_ACCOUNT = "[^"]+"' "${REPO_ROOT}/plugins/dev/scripts/execution-core/cloud-sync.mjs" | head -1 | sed 's/.*"\(.*\)"/\1/')"

for pair in "bash:$SH_DEFAULT" "node:$JS_DEFAULT" "cloud-sync:$CS_DEFAULT"; do
  engine="${pair%%:*}"; value="${pair#*:}"
  if [ "$value" != "tenant-0" ]; then
    fail "DEFAULT_ACCOUNT [$engine]" "expected tenant-0, got '${value}'"
  else ok; fi
done
# Fails CLOSED if the cloud-sync anchor disappears: an empty CS_DEFAULT is caught above as
# a mismatch, so a rename there breaks this test rather than silently skipping it.

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "replica-path parity: ${PASSES} passed, ${FAILURES} FAILED"
  exit 1
fi
echo "replica-path parity: ${PASSES} passed, 0 failed"
