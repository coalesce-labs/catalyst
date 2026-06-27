#!/usr/bin/env bash
# Shell tests for the top-level `catalyst` router (CTL-1369; absorbs CTL-1353).
#
# The router is SOURCED (its dispatch is guarded by BASH_SOURCE[0]==$0, so sourcing defines
# the helpers without running a command). Dispatch is exercised by overriding the two seams
# `resolve_tool` (where a catalyst-<x> tool resolves) and `run_tool` (the exec), so NO real
# tool runs, no process is replaced, and no daemon/network/mutation happens. The `class`
# verb is tested against a temp Layer-2 config; `version` against the real plugin manifest.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-router.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER="${SCRIPT_DIR}/../catalyst"

FAILURES=0
PASSES=0

ok()   { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; echo "    $2"; }

expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then ok "$name"; else fail "$name" "expected '$expected' got '$actual'"; fi
}
expect_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then ok "$name"; else fail "$name" "'$haystack' does not contain '$needle'"; fi
}

# Source the router (guard keeps dispatch from firing).
# shellcheck disable=SC1090
source "$ROUTER"

# ─── Dispatch seams: capture instead of exec ──────────────────────────────────
CAPTURED=""
run_tool() { CAPTURED="$*"; return 0; }
# Fake every catalyst-<x> as resolvable to "catalyst-<x>" so routing is deterministic.
resolve_tool() { printf 'catalyst-%s' "$1"; return 0; }

route() { CAPTURED=""; dispatch "$@" >/dev/null 2>&1; printf '%s' "$CAPTURED"; }

echo "catalyst router — curated lifecycle verb routing"
expect_eq "start → catalyst-stack start"            "catalyst-stack start --foo"        "$(route start --foo)"
expect_eq "stop → catalyst-stack stop"              "catalyst-stack stop"               "$(route stop)"
expect_eq "restart → catalyst-stack restart"        "catalyst-stack restart"            "$(route restart)"
expect_eq "status → catalyst-stack status"          "catalyst-stack status"             "$(route status)"
expect_eq "doctor → catalyst-doctor"                "catalyst-doctor --json"            "$(route doctor --json)"
expect_eq "update → catalyst-stack hotpatch"        "catalyst-stack hotpatch"           "$(route update)"
expect_eq "drain → catalyst-execution-core drain"   "catalyst-execution-core drain --off" "$(route drain --off)"
expect_eq "install → catalyst-install install"      "catalyst-install install --class developer" "$(route install --class developer)"
expect_eq "uninstall → catalyst-install uninstall"  "catalyst-install uninstall"        "$(route uninstall)"
expect_eq "reinstall → catalyst-install reinstall"  "catalyst-install reinstall"        "$(route reinstall)"

echo "catalyst router — component auto-delegation (catalyst <x> → catalyst-<x>)"
expect_eq "broker → catalyst-broker"                "catalyst-broker tail"              "$(route broker tail)"
expect_eq "monitor → catalyst-monitor"              "catalyst-monitor"                  "$(route monitor)"
expect_eq "events → catalyst-events"                "catalyst-events wait-for x"        "$(route events wait-for x)"

echo "catalyst router — unknown command (no curated verb, no catalyst-<x>)"
# Re-point resolve_tool to FAIL so the not-found path is exercised.
resolve_tool() { return 1; }
unknown_rc=0
unknown_err="$(dispatch frobnicate 2>&1 >/dev/null)" || unknown_rc=$?
expect_eq "unknown command exits non-zero" "127" "$unknown_rc"
expect_contains "unknown command explains itself" "$unknown_err" "unknown command: frobnicate"
# Restore the resolvable seam.
resolve_tool() { printf 'catalyst-%s' "$1"; return 0; }

echo "catalyst router — help / usage"
help_out="$(dispatch help 2>&1)"
expect_contains "help lists Lifecycle group"  "$help_out" "Lifecycle:"
expect_contains "help lists Components group" "$help_out" "Components"
bare_out="$(dispatch 2>&1)"
expect_contains "bare catalyst prints usage"  "$bare_out" "Usage: catalyst <command>"

echo "catalyst router — version"
# NB: sourcing the router reassigned SCRIPT_DIR to the scripts dir, so the manifest is one
# level up from here (plugins/dev/.claude-plugin/), exactly where plugin_version() reads it.
manifest="${SCRIPT_DIR}/../.claude-plugin/plugin.json"
if [[ -r "$manifest" ]] && command -v jq >/dev/null 2>&1; then
  expect_eq "version matches the plugin manifest" "$(jq -r .version "$manifest")" "$(plugin_version)"
else
  ok "version (manifest/jq unavailable — skipped)"
fi

echo "catalyst router — installed-as-symlink resolution (exec through a symlink)"
# install-cli.sh installs the router as a DIRECT symlink from a local checkout; the router
# must resolve through it so SCRIPT_DIR finds the manifest + lib/host-identity.sh (regression
# guard: a bare dirname made `version` print 'unknown' and `class` mis-source the resolver).
if [[ -r "$manifest" ]] && command -v jq >/dev/null 2>&1; then
  SYMBIN="$(mktemp -d)"
  ln -s "$ROUTER" "$SYMBIN/catalyst"
  expect_eq "version resolves through a symlink (not 'unknown')" "$(jq -r .version "$manifest")" "$("$SYMBIN/catalyst" version 2>/dev/null)"
  if "$SYMBIN/catalyst" help 2>&1 | grep -q "Lifecycle:"; then ok "help resolves through a symlink"; else fail "help resolves through a symlink" "grouped usage missing"; fi
  rm -rf "$SYMBIN"
else
  ok "symlink resolution (manifest/jq unavailable — skipped)"
fi

echo "catalyst router — class show/set against a temp Layer-2 config"
TMP_CFG="$(mktemp -t catalyst-router-cfg.XXXXXX)"
cleanup() { rm -f "$TMP_CFG" "$TMP_CFG".* 2>/dev/null || true; }
trap cleanup EXIT
export CATALYST_LAYER2_CONFIG_FILE="$TMP_CFG"

if command -v jq >/dev/null 2>&1; then
  printf '{}\n' > "$TMP_CFG"
  # show: unset env, empty config ⇒ default worker
  unset CATALYST_NODE_CLASS
  show_out="$(cmd_class 2>&1)"
  expect_contains "class show (unset) ⇒ worker default" "$show_out" "node class: worker"

  # set: valid value writes Layer-2 atomically
  set_rc=0; set_out="$(cmd_class developer 2>&1)" || set_rc=$?
  expect_eq "class set valid ⇒ rc 0" "0" "$set_rc"
  expect_eq "class set writes catalyst.node.class" "developer" "$(jq -r '.catalyst.node.class' "$TMP_CFG")"
  expect_contains "class set advises restart" "$set_out" "catalyst restart"

  # show after set reflects the configured value
  expect_contains "class show reflects Layer-2 value" "$(cmd_class 2>&1)" "node class: developer"

  # set must PRESERVE every other Layer-2 key (it's a targeted merge, not a clobber)
  printf '{"catalyst":{"host":{"name":"mini"},"cluster":{"x":1}},"other":true}\n' > "$TMP_CFG"
  cmd_class worker >/dev/null 2>&1
  expect_eq "class set preserves catalyst.host.name"  "mini" "$(jq -r '.catalyst.host.name' "$TMP_CFG")"
  expect_eq "class set preserves catalyst.cluster.x"  "1"    "$(jq -r '.catalyst.cluster.x' "$TMP_CFG")"
  expect_eq "class set preserves unrelated top key"   "true" "$(jq -r '.other' "$TMP_CFG")"
  expect_eq "class set still wrote the new class"     "worker" "$(jq -r '.catalyst.node.class' "$TMP_CFG")"

  # invalid value rejected, config untouched (assert against the pre-attempt value, so the
  # test is independent of which valid class the config happened to hold beforehand)
  before_invalid="$(jq -r '.catalyst.node.class' "$TMP_CFG")"
  bad_rc=0; bad_out="$(cmd_class bogus 2>&1)" || bad_rc=$?
  expect_eq "class set invalid ⇒ rc 2" "2" "$bad_rc"
  expect_contains "class set invalid explains valid set" "$bad_out" "valid: developer, worker, monitor"
  expect_eq "class set invalid leaves config unchanged" "$before_invalid" "$(jq -r '.catalyst.node.class' "$TMP_CFG")"

  # no-clobber: a malformed config is NOT overwritten on set
  printf 'this is not json\n' > "$TMP_CFG"
  clobber_rc=0; cmd_class worker >/dev/null 2>&1 || clobber_rc=$?
  expect_eq "class set on malformed config ⇒ rc 3" "3" "$clobber_rc"
  expect_eq "malformed config left untouched" "this is not json" "$(cat "$TMP_CFG")"

  # mv failure must FAIL CLOSED, not lie: override the mv seam to fail, assert rc 3 + NO
  # success line (regression guard for the silent-success bug the adversarial review caught).
  printf '{}\n' > "$TMP_CFG"
  mv() { return 1; }
  mvfail_rc=0; mvfail_out="$(cmd_class developer 2>&1)" || mvfail_rc=$?
  unset -f mv
  expect_eq "class set: mv failure ⇒ rc 3" "3" "$mvfail_rc"
  expect_contains "class set: mv failure reports the failure" "$mvfail_out" "failed to write"
  if [[ "$mvfail_out" != *"node class set to"* ]]; then ok "class set: mv failure prints NO success line"; else fail "class set: mv failure prints NO success line" "leaked: $mvfail_out"; fi

  # show: an unparseable config is flagged (not silently rendered as 'unset ⇒ worker')
  printf 'not json at all {\n' > "$TMP_CFG"
  expect_contains "class show: unparseable config flagged" "$(cmd_class 2>&1)" "UNPARSEABLE"

  # empty / whitespace-only config must PERSIST the class (jq-on-empty emits nothing → would
  # otherwise write an empty file and lie about success)
  printf '' > "$TMP_CFG"
  empty_rc=0; cmd_class developer >/dev/null 2>&1 || empty_rc=$?
  expect_eq "class set on empty config ⇒ rc 0" "0" "$empty_rc"
  expect_eq "class set on empty config persists the value" "developer" "$(jq -r '.catalyst.node.class' "$TMP_CFG")"
  printf '   \n' > "$TMP_CFG"
  cmd_class worker >/dev/null 2>&1
  expect_eq "class set on whitespace config persists the value" "worker" "$(jq -r '.catalyst.node.class' "$TMP_CFG")"
else
  ok "class show/set (jq unavailable — skipped)"
fi

echo
echo "──────────────────────────────────────────"
echo "catalyst-router.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
