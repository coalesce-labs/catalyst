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
printf '{"catalyst":{"linearReplica":"on"}}\n' > "$CATALYST_LAYER2_CONFIG_FILE"; OUT="$(cloud_sync_verify_report --json)"
check "legacy read flag reports on" jq -e '(.checks[] | select(.name=="read-flag")).status == "PASS"' <<<"$OUT"

fixture badactivate; : > "$CATALYST_REPLICA_DB"; printf '{"keep":true}\n' > "$CATALYST_LAYER2_CONFIG_FILE"; BEFORE="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"; cmd_activate_replica >/dev/null 2>&1; EC=$?; AFTER="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"
check "activate refuses invalid seed" test "$EC" -ne 0
check "refusal leaves config unchanged" test "$BEFORE" = "$AFTER"

fixture activate; seed_db; sqlite3 "$CATALYST_REPLICA_DB" "INSERT INTO issues VALUES('1'); INSERT INTO sync_meta VALUES('cursor','abc');"; touch "$CATALYST_REPLICA_DB.writer.lock"; printf '{"keep":true}\n' > "$CATALYST_LAYER2_CONFIG_FILE"; cmd_activate_replica >/dev/null
check "activate merges mode" jq -e '.keep == true and .catalyst.linearReplica.mode == "on"' "$CATALYST_LAYER2_CONFIG_FILE"
check "activate preserves secret config mode" test "$(portable_stat_mode "$CATALYST_LAYER2_CONFIG_FILE")" = "0600"
BEFORE="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"; cmd_activate_replica --dry-run >/dev/null; AFTER="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"
check "dry-run changes nothing" test "$BEFORE" = "$AFTER"

# CAT-21 Codex P1: --dry-run used to print the WHOLE merged Layer-2 document, which
# is where this machine's API tokens live. The runbook recommends the command, so
# that discloses every secret to whatever captured stdout (agent transcript, CI log,
# terminal recording, support paste). It must preview only the subtree it changes.
printf '{"keep":true,"catalyst":{"linear":{"apiToken":"lin_api_DRYRUNSECRET"}}}\n' > "$CATALYST_LAYER2_CONFIG_FILE"
DRY_OUT="$(cmd_activate_replica --dry-run 2>/dev/null)"
check "dry-run does not print Layer-2 secrets" bash -c '! grep -q DRYRUNSECRET <<<"$1"' _ "$DRY_OUT"
check "dry-run still previews the replica change" bash -c 'jq -e ".catalyst.linearReplica.mode == \"on\"" <<<"$1" >/dev/null' _ "$DRY_OUT"

printf '{"catalyst":{"linearReplica":"off","token":"keep-secret"},"keep":true}\n' > "$CATALYST_LAYER2_CONFIG_FILE"
cmd_activate_replica >/dev/null
check "activate normalizes legacy mode without clobbering config" jq -e '.keep == true and .catalyst.token == "keep-secret" and .catalyst.linearReplica.mode == "on"' "$CATALYST_LAYER2_CONFIG_FILE"

rm -f "$CATALYST_LAYER2_CONFIG_FILE"
cmd_activate_replica >/dev/null
check "activate creates secret config with restrictive mode" test "$(portable_stat_mode "$CATALYST_LAYER2_CONFIG_FILE")" = "0600"

printf '{malformed\n' > "$CATALYST_LAYER2_CONFIG_FILE"; BEFORE="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"; cmd_activate_replica >/dev/null 2>&1; EC=$?; AFTER="$(shasum "$CATALYST_LAYER2_CONFIG_FILE")"
check "activate refuses malformed existing config" test "$EC" -ne 0
check "malformed config remains unchanged" test "$BEFORE" = "$AFTER"

check "docs mention verify" grep -q 'catalyst-stack verify-cloud-sync' "$(cd "$TEST_DIR/../../../.." && pwd)/website/src/content/docs/reference/configuration.md"
check "docs mention activate" grep -q 'catalyst-stack activate-replica' "$(cd "$TEST_DIR/../../../.." && pwd)/website/src/content/docs/reference/configuration.md"

echo; if ((FAILURES)); then echo "FAIL: $FAILURES failed, $PASSES passed"; exit 1; fi; echo "OK: $PASSES passed"
