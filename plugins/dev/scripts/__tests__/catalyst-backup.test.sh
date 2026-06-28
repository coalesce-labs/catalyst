#!/usr/bin/env bash
# Shell tests for `catalyst-backup` (CTL-1369 PR2).
#
# Runs the CLI as a SUBPROCESS against a sandbox HOME (every path is env-overridable), so the
# real ~/.config / ~/Library / ~/catalyst are never touched. Exercises backup capture (incl.
# a real sqlite .backup + graceful handling of absent artifacts + secret perms), list, and
# restore (happy path, no-clobber, --force, --dry-run) into a SEPARATE target sandbox.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-backup.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="${SCRIPT_DIR}/../catalyst-backup"

FAILURES=0
PASSES=0
ok()   { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq()       { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
expect_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else fail "$1" "'$2' lacks '$3'"; fi; }
expect_file()     { if [[ -f "$2" ]]; then ok "$1"; else fail "$1" "missing file: $2"; fi; }
expect_absent()   { if [[ ! -e "$2" ]]; then ok "$1"; else fail "$1" "should not exist: $2"; fi; }
# GNU stat uses `-c %a`; BSD/macOS stat uses `-f %Lp`. Try GNU first (on BSD `-c` errors out;
# on GNU `-f` means file-system status and would wrongly succeed) so we get mode bits on both.
perms() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

command -v jq >/dev/null 2>&1 || { echo "jq required for these tests — skipping"; exit 0; }

# ── sandbox: a fake SOURCE node with all artifacts present ─────────────────────
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/.config/catalyst" "$SB/.config/humanlayer" "$SB/LaunchAgents" "$SB/catalyst/execution-core"

printf '{"catalyst":{"node":{"class":"developer"},"host":{"name":"testbox"},"secretToken":"sk-XYZ"}}\n' > "$SB/.config/catalyst/config.json"
printf 'CATALYST_CLOUD=token-abc\n' > "$SB/.config/catalyst/cluster.env"
printf '{"humanlayer":{"apiKey":"hl-secret"}}\n' > "$SB/.config/humanlayer/humanlayer.json"
printf '<plist>stack</plist>\n'   > "$SB/LaunchAgents/ai.coalesce.catalyst-stack.plist"
printf '<plist>updater</plist>\n' > "$SB/LaunchAgents/ai.coalesce.catalyst-updater.plist"
printf '<plist>other</plist>\n'   > "$SB/LaunchAgents/com.example.other.plist"   # must NOT be captured
printf '{"orchestrators":[]}\n'   > "$SB/catalyst/state.json"
printf '{"teams":{}}\n'           > "$SB/catalyst/execution-core/registry.json"
# a real sqlite db so `.backup` exercises the WAL-safe path
sqlite3 "$SB/catalyst/catalyst.db" "CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES('s1'),('s2');" 2>/dev/null
# NOTE: cluster-cloud.json intentionally absent → must be handled gracefully

# env that points the CLI at the sandbox source node
src_env() {
  CATALYST_DIR="$SB/catalyst" \
  CATALYST_LAYER2_CONFIG_FILE="$SB/.config/catalyst/config.json" \
  CATALYST_LAUNCHAGENTS_DIR="$SB/LaunchAgents" \
  CATALYST_HUMANLAYER_CONFIG="$SB/.config/humanlayer/humanlayer.json" \
  CATALYST_DB_FILE="$SB/catalyst/catalyst.db" \
  CATALYST_BACKUPS_DIR="$SB/backups" \
  CATALYST_ASSUME_NO_DAEMONS=1 \
  "$@"
}

echo "catalyst-backup — backup capture"
BUNDLE="$(src_env "$BACKUP" backup --label test 2>/dev/null | tail -1)"
expect_eq "backup prints a bundle path" "yes" "$([[ -d "$BUNDLE" ]] && echo yes || echo no)"
expect_file "manifest.json written"            "$BUNDLE/manifest.json"
expect_file "config.json captured"             "$BUNDLE/config/config.json"
expect_file "cluster.env captured"             "$BUNDLE/config/cluster.env"
expect_absent "absent cluster-cloud.json not captured (graceful)" "$BUNDLE/config/cluster-cloud.json"
expect_file "humanlayer creds captured"        "$BUNDLE/humanlayer/humanlayer.json"
expect_file "stack plist captured"             "$BUNDLE/launchagents/ai.coalesce.catalyst-stack.plist"
expect_file "updater plist captured"           "$BUNDLE/launchagents/ai.coalesce.catalyst-updater.plist"
expect_absent "non-catalyst plist NOT captured" "$BUNDLE/launchagents/com.example.other.plist"
expect_file "catalyst.db captured"             "$BUNDLE/runtime/catalyst.db"
expect_file "state.json captured"              "$BUNDLE/runtime/state.json"
expect_file "registry.json captured"           "$BUNDLE/runtime/registry.json"

echo "catalyst-backup — default verb (bare + via router = create a backup)"
BARE="$(src_env "$BACKUP" 2>/dev/null | tail -1)"
expect_eq "bare 'catalyst-backup' creates a backup" "yes" "$([[ -f "$BARE/manifest.json" ]] && echo yes || echo no)"
ROUTER="${SCRIPT_DIR}/../catalyst"
if [[ -x "$ROUTER" ]]; then
  RB="$(src_env "$ROUTER" backup 2>/dev/null | tail -1)"
  expect_eq "'catalyst backup' (router auto-delegate) creates a backup" "yes" "$([[ -f "$RB/manifest.json" ]] && echo yes || echo no)"
  RL="$(src_env "$ROUTER" backup list --json 2>/dev/null | jq 'length' 2>/dev/null)"
  expect_eq "'catalyst backup list' (router) lists bundles" "yes" "$([[ "${RL:-0}" -ge 1 ]] && echo yes || echo no)"
else
  ok "router delegation (router not present — skipped)"
fi

echo "catalyst-backup — manifest + db integrity"
expect_eq "manifest nodeClass"  "developer" "$(jq -r .nodeClass "$BUNDLE/manifest.json")"
# >=8 deterministic artifacts (the launchctl snapshot is macOS-only + best-effort, so don't pin exact)
CCOUNT="$(jq '.captured|length' "$BUNDLE/manifest.json")"
expect_eq "manifest captured >= 8 required artifacts" "yes" "$([[ "${CCOUNT:-0}" -ge 8 ]] && echo yes || echo no)"
expect_eq "backed-up db is a valid sqlite snapshot" "2" "$(sqlite3 "$BUNDLE/runtime/catalyst.db" 'SELECT count(*) FROM sessions' 2>/dev/null)"

echo "catalyst-backup — secret perms (bundle 0700, secret files 0600)"
expect_eq "bundle dir is 0700"        "700" "$(perms "$BUNDLE")"
expect_eq "config.json is 0600"       "600" "$(perms "$BUNDLE/config/config.json")"
expect_eq "humanlayer.json is 0600"   "600" "$(perms "$BUNDLE/humanlayer/humanlayer.json")"

echo "catalyst-backup — list"
expect_contains "list shows the bundle"        "$(src_env "$BACKUP" list 2>/dev/null)" "$BUNDLE"
LCOUNT="$(src_env "$BACKUP" list --json 2>/dev/null | jq 'length')"
expect_eq "list --json returns >=1 bundle"     "yes" "$([[ "${LCOUNT:-0}" -ge 1 ]] && echo yes || echo no)"
expect_eq "list --json includes the bundle"    "1" "$(src_env "$BACKUP" list --json 2>/dev/null | jq --arg p "$BUNDLE" '[.[]|select(.path==$p)]|length')"

# ── restore into a SEPARATE empty target node ─────────────────────────────────
TB="$SB/target"
mkdir -p "$TB/.config/catalyst" "$TB/.config/humanlayer" "$TB/LaunchAgents" "$TB/catalyst/execution-core"
tgt_env() {
  CATALYST_DIR="$TB/catalyst" \
  CATALYST_LAYER2_CONFIG_FILE="$TB/.config/catalyst/config.json" \
  CATALYST_LAUNCHAGENTS_DIR="$TB/LaunchAgents" \
  CATALYST_HUMANLAYER_CONFIG="$TB/.config/humanlayer/humanlayer.json" \
  CATALYST_DB_FILE="$TB/catalyst/catalyst.db" \
  CATALYST_BACKUPS_DIR="$TB/backups" \
  CATALYST_ASSUME_NO_DAEMONS=1 \
  "$@"
}

echo "catalyst-backup — restore (happy path into empty target)"
tgt_env "$BACKUP" restore "$BUNDLE" >/dev/null 2>&1
expect_file "config.json restored"   "$TB/.config/catalyst/config.json"
expect_file "humanlayer restored"    "$TB/.config/humanlayer/humanlayer.json"
expect_file "db restored"            "$TB/catalyst/catalyst.db"
expect_file "registry restored"      "$TB/catalyst/execution-core/registry.json"
expect_file "updater plist restored" "$TB/LaunchAgents/ai.coalesce.catalyst-updater.plist"
expect_contains "restored config content matches" "$(cat "$TB/.config/catalyst/config.json")" "sk-XYZ"
expect_eq "restored db queryable" "2" "$(sqlite3 "$TB/catalyst/catalyst.db" 'SELECT count(*) FROM sessions' 2>/dev/null)"

echo "catalyst-backup — restore no-clobber + --force"
printf 'PRE-EXISTING\n' > "$TB/.config/catalyst/config.json"
tgt_env "$BACKUP" restore "$BUNDLE" >/dev/null 2>&1
expect_eq "no-clobber: existing config left intact" "PRE-EXISTING" "$(cat "$TB/.config/catalyst/config.json")"
tgt_env "$BACKUP" restore "$BUNDLE" --force >/dev/null 2>&1
expect_contains "--force overwrites existing config" "$(cat "$TB/.config/catalyst/config.json")" "sk-XYZ"

echo "catalyst-backup — restore --dry-run writes nothing"
TB2="$SB/target2"; mkdir -p "$TB2/.config/catalyst"
CATALYST_DIR="$TB2/catalyst" CATALYST_LAYER2_CONFIG_FILE="$TB2/.config/catalyst/config.json" \
  CATALYST_HUMANLAYER_CONFIG="$TB2/.config/humanlayer/humanlayer.json" CATALYST_DB_FILE="$TB2/catalyst/catalyst.db" \
  CATALYST_LAUNCHAGENTS_DIR="$TB2/LaunchAgents" CATALYST_ASSUME_NO_DAEMONS=1 \
  "$BACKUP" restore "$BUNDLE" --dry-run >/dev/null 2>&1
expect_absent "dry-run wrote no config" "$TB2/.config/catalyst/config.json"

echo "catalyst-backup — restore rejects a non-bundle"
rc=0; tgt_env "$BACKUP" restore "$SB/not-a-bundle" >/dev/null 2>&1 || rc=$?
expect_eq "restore non-bundle ⇒ non-zero" "1" "$rc"

# NB: these inject failure via read-only DIR mode bits, which uid 0 ignores — so skip under root.
if [[ "$(id -u)" != "0" ]]; then
  echo "catalyst-backup — backup FAILS LOUDLY when a present source can't be captured"
  RO="$SB/ro-bundle"; mkdir -p "$RO/config"; chmod 500 "$RO/config"
  rc=0; out="$(src_env "$BACKUP" backup --out "$RO" 2>&1)" || rc=$?
  chmod 700 "$RO/config" 2>/dev/null || true
  expect_eq "uncapturable present source ⇒ non-zero exit" "yes" "$([[ "$rc" -ne 0 ]] && echo yes || echo no)"
  expect_contains "backup reports INCOMPLETE" "$out" "INCOMPLETE"

  echo "catalyst-backup — restore FAILS LOUDLY when a dest can't be written"
  RT="$SB/ro-target"; mkdir -p "$RT/.config/catalyst"; chmod 500 "$RT/.config/catalyst"
  rc=0
  out="$(CATALYST_DIR="$RT/c" CATALYST_LAYER2_CONFIG_FILE="$RT/.config/catalyst/config.json" \
    CATALYST_HUMANLAYER_CONFIG="$RT/hl.json" CATALYST_DB_FILE="$RT/c/x.db" CATALYST_LAUNCHAGENTS_DIR="$RT/LA" \
    CATALYST_ASSUME_NO_DAEMONS=1 "$BACKUP" restore "$BUNDLE" 2>&1)" || rc=$?
  chmod 700 "$RT/.config/catalyst" 2>/dev/null || true
  expect_eq "unwritable dest ⇒ non-zero exit" "yes" "$([[ "$rc" -ne 0 ]] && echo yes || echo no)"
  expect_contains "restore reports INCOMPLETE" "$out" "INCOMPLETE"
else
  ok "loud-fail injection tests (skipped under root — dir mode bits don't block uid 0)"
fi

echo "catalyst-backup — captures per-project config-<key>.json secrets (Codex P1)"
printf '{"linear":{"token":"lin_secret"}}\n' > "$SB/.config/catalyst/config-CTL.json"
PB="$(src_env "$BACKUP" backup 2>/dev/null | tail -1)"
expect_file "per-project config-CTL.json captured" "$PB/config/config-CTL.json"
expect_eq "config-CTL.json is 0600" "600" "$(perms "$PB/config/config-CTL.json")"
rm -f "$SB/.config/catalyst/config-CTL.json"

echo "catalyst-backup — restore rejects a malformed manifest (no captured array)"
BAD="$SB/bad-bundle"; mkdir -p "$BAD"; printf '{"schemaVersion":1}\n' > "$BAD/manifest.json"
rc=0; tgt_env "$BACKUP" restore "$BAD" >/dev/null 2>&1 || rc=$?
expect_eq "malformed manifest ⇒ non-zero" "yes" "$([[ "$rc" -ne 0 ]] && echo yes || echo no)"

echo "catalyst-backup — restore fails when a manifest-listed file is missing from the bundle"
MB="$SB/missing-bundle"; cp -R "$BUNDLE" "$MB"; rm -f "$MB/runtime/state.json"
TM="$SB/missing-target"; mkdir -p "$TM"
rc=0
out="$(CATALYST_DIR="$TM/c" CATALYST_LAYER2_CONFIG_FILE="$TM/.config/catalyst/config.json" \
  CATALYST_HUMANLAYER_CONFIG="$TM/hl.json" CATALYST_DB_FILE="$TM/c/x.db" CATALYST_LAUNCHAGENTS_DIR="$TM/LA" \
  CATALYST_ASSUME_NO_DAEMONS=1 "$BACKUP" restore "$MB" 2>&1)" || rc=$?
expect_eq "manifest-listed-but-missing ⇒ non-zero" "yes" "$([[ "$rc" -ne 0 ]] && echo yes || echo no)"
expect_contains "restore flags the missing artifact" "$out" "missing"

echo "catalyst-backup — restore fails on a non-regular-file dest (dir at a config path)"
DD="$SB/dir-target"; mkdir -p "$DD/.config/catalyst/config.json"  # config.json is a DIRECTORY
rc=0
CATALYST_DIR="$DD/c" CATALYST_LAYER2_CONFIG_FILE="$DD/.config/catalyst/config.json" \
  CATALYST_HUMANLAYER_CONFIG="$DD/hl.json" CATALYST_DB_FILE="$DD/c/x.db" CATALYST_LAUNCHAGENTS_DIR="$DD/LA" \
  CATALYST_ASSUME_NO_DAEMONS=1 "$BACKUP" restore "$BUNDLE" --force >/dev/null 2>&1 || rc=$?
expect_eq "dir-at-dest ⇒ non-zero (no mv-into-dir)" "yes" "$([[ "$rc" -ne 0 ]] && echo yes || echo no)"

echo "catalyst-backup — daemons_running fails SAFE (sourced helpers)"
# shellcheck disable=SC1090
source "$BACKUP"
# simulate pgrep being unavailable (empty PATH in a subshell) → must fail safe = "assume live"
rc=0
# shellcheck disable=SC2123
( unset CATALYST_ASSUME_NO_DAEMONS; PATH=/var/empty; daemons_running ) 2>/dev/null || rc=$?
expect_eq "no pgrep ⇒ assume LIVE (rc 0)" "0" "$rc"
rc=0; CATALYST_ASSUME_NO_DAEMONS=1 daemons_running || rc=$?
expect_eq "ASSUME_NO_DAEMONS=1 ⇒ not running (rc 1)" "1" "$rc"

echo
echo "──────────────────────────────────────────"
echo "catalyst-backup.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
