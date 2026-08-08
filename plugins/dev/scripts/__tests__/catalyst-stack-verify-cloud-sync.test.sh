#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$SCRIPT_DIR"
STACK="$(cd "${SCRIPT_DIR}/.." && pwd)/catalyst-stack"
TMP_ROOT="$(mktemp -d)"; trap 'rm -rf "$TMP_ROOT"' EXIT
source "$STACK"
FAILURES=0; PASSES=0
check() { local n="$1"; shift; if "$@"; then PASSES=$((PASSES+1)); echo "  PASS: $n"; else FAILURES=$((FAILURES+1)); echo "  FAIL: $n"; fi; }
fixture() {
  local n="$1"; export HOME="$TMP_ROOT/$n" CATALYST_DIR="$TMP_ROOT/$n/catalyst" CATALYST_REPLICA_DB="$TMP_ROOT/$n/catalyst/catalyst-replica.db" CATALYST_LAYER2_CONFIG_FILE="$TMP_ROOT/$n/config.json" CATALYST_CLOUD_SYNC_TEST_MODE=1
  mkdir -p "$HOME/.config/catalyst" "$CATALYST_DIR"
  printf 'export CATALYST_CLOUD_TOKEN=test-secret\n' > "$HOME/.config/catalyst/cloud-sync.env"; chmod 600 "$HOME/.config/catalyst/cloud-sync.env"
}
seed_db() {
  sqlite3 "$CATALYST_REPLICA_DB" 'CREATE TABLE issues(id TEXT); CREATE TABLE issue_labels(id TEXT); CREATE TABLE labels(id TEXT); CREATE TABLE relations(id TEXT); CREATE TABLE projects(id TEXT); CREATE TABLE sync_meta(key TEXT,value TEXT);'
  truncate -s 65536 "$CATALYST_REPLICA_DB"
}

fixture absent; OUT="$(cloud_sync_verify_report --json)"
check "absent db fails" jq -e '.ok == false and (.checks[] | select(.name=="replica-db").status)=="FAIL"' <<<"$OUT"
check "absent reason" jq -e '.first_failure == "replica db absent"' <<<"$OUT"

fixture empty; : > "$CATALYST_REPLICA_DB"; OUT="$(cloud_sync_verify_report --json)"
check "zero-byte db fails db/schema/rows" jq -e '[.checks[] | select(.name=="replica-db" or .name=="schema" or .name=="rows") | .status] == ["FAIL","FAIL","FAIL"]' <<<"$OUT"

fixture norows; seed_db; OUT="$(cloud_sync_verify_report --json)"
check "schema passes with six tables" jq -e '(.checks[] | select(.name=="schema").status)=="PASS"' <<<"$OUT"
check "zero issues fails rows" jq -e '(.checks[] | select(.name=="rows").status)=="FAIL"' <<<"$OUT"

fixture nolock; seed_db; sqlite3 "$CATALYST_REPLICA_DB" "INSERT INTO issues VALUES('1'); INSERT INTO sync_meta VALUES('cursor','abc');"; OUT="$(cloud_sync_verify_report --json)"
check "missing lock fails" jq -e '(.checks[] | select(.name=="writer-lock").status)=="FAIL"' <<<"$OUT"

fixture stale; seed_db; sqlite3 "$CATALYST_REPLICA_DB" "INSERT INTO issues VALUES('1'); INSERT INTO sync_meta VALUES('cursor','abc');"; touch -t 202001010000 "$CATALYST_REPLICA_DB.writer.lock"; OUT="$(cloud_sync_verify_report --json)"
check "stale lock fails" jq -e '(.checks[] | select(.name=="writer-lock").status)=="FAIL"' <<<"$OUT"

fixture nocursor; seed_db; sqlite3 "$CATALYST_REPLICA_DB" "INSERT INTO issues VALUES('1');"; touch "$CATALYST_REPLICA_DB.writer.lock"; OUT="$(cloud_sync_verify_report --json)"
check "empty cursor fails" jq -e '(.checks[] | select(.name=="seed-cursor").status)=="FAIL"' <<<"$OUT"

fixture happy; seed_db; sqlite3 "$CATALYST_REPLICA_DB" "INSERT INTO issues VALUES('1'); INSERT INTO sync_meta VALUES('cursor','abc');"; touch "$CATALYST_REPLICA_DB.writer.lock"; OUT="$(cloud_sync_verify_report --json)"
check "happy fixture passes" jq -e '.ok == true and (.checks|length) >= 8' <<<"$OUT"
cloud_sync_verify_report --strict >/dev/null; check "strict happy exit zero" test "$?" -eq 0

fixture badactivate; : > "$CATALYST_REPLICA_DB"; printf '{"keep":true}\n' > "$CATALYST_LAYER2_CONFIG_FILE"; BEFORE="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"; cmd_activate_replica >/dev/null 2>&1; EC=$?; AFTER="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"
check "activate refuses invalid seed" test "$EC" -ne 0
check "refusal leaves config unchanged" test "$BEFORE" = "$AFTER"

fixture activate; seed_db; sqlite3 "$CATALYST_REPLICA_DB" "INSERT INTO issues VALUES('1'); INSERT INTO sync_meta VALUES('cursor','abc');"; touch "$CATALYST_REPLICA_DB.writer.lock"; printf '{"keep":true}\n' > "$CATALYST_LAYER2_CONFIG_FILE"; cmd_activate_replica >/dev/null
check "activate merges mode" jq -e '.keep == true and .catalyst.linearReplica.mode == "on"' "$CATALYST_LAYER2_CONFIG_FILE"
BEFORE="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"; cmd_activate_replica --dry-run >/dev/null; AFTER="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"
check "dry-run changes nothing" test "$BEFORE" = "$AFTER"

check "docs mention verify" grep -q 'catalyst-stack verify-cloud-sync' "$(cd "$TEST_DIR/../../../.." && pwd)/website/src/content/docs/reference/configuration.md"
check "docs mention activate" grep -q 'catalyst-stack activate-replica' "$(cd "$TEST_DIR/../../../.." && pwd)/website/src/content/docs/reference/configuration.md"

echo; if ((FAILURES)); then echo "FAIL: $FAILURES failed, $PASSES passed"; exit 1; fi; echo "OK: $PASSES passed"
