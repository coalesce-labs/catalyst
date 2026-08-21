#!/usr/bin/env bash
# Shell tests for `catalyst-stack verify-node` (CTL-1355).
#
# Exercises the PASS/FAIL/WARN/SKIP decision logic of the PURE verdict helpers
# (_vn_v_*) with injected data, the read-replica extractor over a temp config, and
# the end-to-end cmd_verify_node decision per class by OVERRIDING the probe seams
# (_vn_resolve / _vn_broker_running / _vn_exec_core_running / _vn_monitor_running /
# _vn_read_replica_base / _vn_drained / _vn_updater_ec / _vu_read_pull_owner) inside
# isolating subshells. NO real adoption / daemon / network / mutation — catalyst-stack
# is SOURCED (its dispatch is guarded by BASH_SOURCE[0]==$0, so sourcing runs no command).
#
# Run: bash plugins/dev/scripts/__tests__/verify-node.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="${SCRIPT_DIR}/../catalyst-stack"

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES + 1))
  echo "  PASS: $name"
}

fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES + 1))
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

# status_of "STATUS|detail" → "STATUS" (the first field a verdict helper echoes).
status_of() { printf '%s' "${1%%|*}"; }

# Source the script (guarded dispatch → no side effects) to reach the helpers.
# shellcheck disable=SC1090
source "$STACK"

# ── _vn_v_node_class (class match; inferred ⇒ WARN, mismatch ⇒ FAIL) ──────────
expect_eq "node-class: developer explicit → PASS" "PASS" "$(status_of "$(_vn_v_node_class developer developer false env)")"
expect_eq "node-class: worker inferred → WARN"     "WARN" "$(status_of "$(_vn_v_node_class worker worker true default)")"
expect_eq "node-class: worker explicit → PASS"     "PASS" "$(status_of "$(_vn_v_node_class worker worker false layer2)")"
expect_eq "node-class: mismatch → FAIL"            "FAIL" "$(status_of "$(_vn_v_node_class developer worker false default)")"

# ── _vn_v_daemon_down (developer expects the work daemon DOWN) ────────────────
expect_eq "daemon-down: running → FAIL"            "FAIL" "$(status_of "$(_vn_v_daemon_down broker yes)")"
expect_eq "daemon-down: stopped → PASS"            "PASS" "$(status_of "$(_vn_v_daemon_down broker no)")"
# The developer-running-worker-daemons FAIL must name the condition (the AC wording).
case "$(_vn_v_daemon_down execution-core yes)" in
  *"running worker daemons"*) ok "daemon-down: FAIL detail names 'running worker daemons'" ;;
  *) fail "daemon-down: FAIL detail" "missing 'running worker daemons'" ;;
esac

# ── _vn_v_daemon_up (worker expects the daemon UP) ───────────────────────────
expect_eq "daemon-up: running → PASS"              "PASS" "$(status_of "$(_vn_v_daemon_up broker yes)")"
expect_eq "daemon-up: stopped → FAIL"              "FAIL" "$(status_of "$(_vn_v_daemon_up broker no)")"

# ── _vn_v_updater (developer plugin freshness == verify-updater all-green) ────
expect_eq "updater: ec=0 → PASS"                   "PASS" "$(status_of "$(_vn_v_updater 0)")"
expect_eq "updater: ec=1 → FAIL"                   "FAIL" "$(status_of "$(_vn_v_updater 1)")"

# ── _vn_v_read_replica (CTL-1346 read-source per class) ──────────────────────
expect_eq "read-replica: worker unset → PASS"      "PASS" "$(status_of "$(_vn_v_read_replica worker '')")"
expect_eq "read-replica: worker remote → PASS"     "PASS" "$(status_of "$(_vn_v_read_replica worker http://mini:7400)")"
expect_eq "read-replica: developer unset → FAIL"   "FAIL" "$(status_of "$(_vn_v_read_replica developer '')")"
expect_eq "read-replica: developer localhost → FAIL" "FAIL" "$(status_of "$(_vn_v_read_replica developer http://127.0.0.1:7400)")"
expect_eq "read-replica: developer localhost-name → FAIL" "FAIL" "$(status_of "$(_vn_v_read_replica developer http://localhost:7400)")"
expect_eq "read-replica: developer remote → PASS"  "PASS" "$(status_of "$(_vn_v_read_replica developer http://mini:7400)")"
# #2: a whitespace-padded URL is trimmed before grading — padded localhost still FAILs,
# a padded empty still reads as unset (FAIL for a developer).
expect_eq "read-replica: developer padded-localhost → FAIL" "FAIL" "$(status_of "$(_vn_v_read_replica developer ' http://localhost:7400 ')")"
expect_eq "read-replica: developer padded-127 → FAIL" "FAIL" "$(status_of "$(_vn_v_read_replica developer '  http://127.0.0.1:7400')")"
expect_eq "read-replica: developer whitespace-only → FAIL" "FAIL" "$(status_of "$(_vn_v_read_replica developer '   ')")"
expect_eq "read-replica: developer padded-remote → PASS" "PASS" "$(status_of "$(_vn_v_read_replica developer '  http://mini:7400  ')")"

# ── _vn_v_worker_owner <env_owner> <config_owner> (broker, not updater, owns the pull) ──
# Single-arg calls feed env_owner (which takes precedence), exercising the normalize logic.
expect_eq "worker-owner: updater → FAIL"           "FAIL" "$(status_of "$(_vn_v_worker_owner updater)")"
expect_eq "worker-owner: broker → PASS"            "PASS" "$(status_of "$(_vn_v_worker_owner broker)")"
expect_eq "worker-owner: unset → PASS"             "PASS" "$(status_of "$(_vn_v_worker_owner '')")"
# F4: the owner is trim+lowercase normalized, so case/whitespace variants still FAIL.
expect_eq "worker-owner: Updater → FAIL"           "FAIL" "$(status_of "$(_vn_v_worker_owner Updater)")"
expect_eq "worker-owner: UPDATER → FAIL"           "FAIL" "$(status_of "$(_vn_v_worker_owner UPDATER)")"
expect_eq "worker-owner: ' updater ' → FAIL"       "FAIL" "$(status_of "$(_vn_v_worker_owner ' updater ')")"
# #4: the env CATALYST_PLUGIN_PULL_OWNER WINS over the config (mirrors resolvePluginPullOwner).
expect_eq "worker-owner: env=updater beats config=broker → FAIL" "FAIL" "$(status_of "$(_vn_v_worker_owner updater broker)")"
expect_eq "worker-owner: env=broker beats config=updater → PASS" "PASS" "$(status_of "$(_vn_v_worker_owner broker updater)")"
expect_eq "worker-owner: env empty → config=updater FAILs"       "FAIL" "$(status_of "$(_vn_v_worker_owner '' updater)")"
expect_eq "worker-owner: env empty → config=broker PASSes"       "PASS" "$(status_of "$(_vn_v_worker_owner '' broker)")"

# ── _vn_v_dev_no_work (a developer must not pick up work) ────────────────────
# 4th arg = roster_source. A CONFIRMED source grades; an unknown/fail-open one WARNs (F3).
expect_eq "dev-no-work: drained → PASS"            "PASS" "$(status_of "$(_vn_v_dev_no_work yes yes yes cluster-repo)")"
expect_eq "dev-no-work: out-of-roster → PASS"      "PASS" "$(status_of "$(_vn_v_dev_no_work no no no cluster-repo)")"
expect_eq "dev-no-work: multi-host + not drained → FAIL" "FAIL" "$(status_of "$(_vn_v_dev_no_work yes yes no cluster-repo)")"
expect_eq "dev-no-work: single-host + not drained → WARN" "WARN" "$(status_of "$(_vn_v_dev_no_work yes no no single-host)")"
# F3: a fail-open / unconfirmed roster cannot be trusted as out-of-roster → WARN, not PASS.
expect_eq "dev-no-work: roster_source=unknown → WARN"   "WARN" "$(status_of "$(_vn_v_dev_no_work no no no unknown)")"
expect_eq "dev-no-work: roster_source='-' → WARN"       "WARN" "$(status_of "$(_vn_v_dev_no_work no no no '-')")"
# F3: an unverified roster never HARD-FAILs (it is unknown, not a confirmed multi-host).
expect_eq "dev-no-work: unknown roster never FAILs"     "WARN" "$(status_of "$(_vn_v_dev_no_work yes yes no unknown)")"
# F3: boot-drain is genuinely safe even when the roster is unknown.
expect_eq "dev-no-work: drained wins over unknown roster" "PASS" "$(status_of "$(_vn_v_dev_no_work yes yes yes unknown)")"

# ── _vn_v_cloud_sync (CTL-1736: LOCAL replica writer freshness, developer) ────
expect_eq "cloud-sync: fresh → PASS"    "PASS" "$(status_of "$(_vn_v_cloud_sync fresh)")"
expect_eq "cloud-sync: stale → FAIL"    "FAIL" "$(status_of "$(_vn_v_cloud_sync stale)")"
expect_eq "cloud-sync: unseeded → WARN" "WARN" "$(status_of "$(_vn_v_cloud_sync unseeded)")"
expect_eq "cloud-sync: idle → PASS"     "PASS" "$(status_of "$(_vn_v_cloud_sync idle)")"
expect_eq "cloud-sync: unknown → WARN"  "WARN" "$(status_of "$(_vn_v_cloud_sync bogus)")"

# _cloud_sync_state classification via injected leaf seams (each in an isolating subshell).
( _cs_agent_installed() { return 0; }; _cs_token_present() { return 0; }
  _cs_lock_age() { echo 10; }; _cs_cursor_seeded() { return 0; }
  expect_eq "state: adopted+young+seeded → fresh" "fresh" "$(_cloud_sync_state)" )
( _cs_agent_installed() { return 0; }; _cs_token_present() { return 0; }
  _cs_lock_age() { echo 999999; }; _cs_cursor_seeded() { return 0; }
  expect_eq "state: adopted+old-lock → stale" "stale" "$(_cloud_sync_state)" )
( _cs_agent_installed() { return 0; }; _cs_token_present() { return 0; }
  _cs_lock_age() { echo ""; }; _cs_cursor_seeded() { return 1; }
  expect_eq "state: adopted+no-lock → unseeded" "unseeded" "$(_cloud_sync_state)" )
( _cs_agent_installed() { return 0; }; _cs_token_present() { return 0; }
  _cs_lock_age() { echo 10; }; _cs_cursor_seeded() { return 1; }
  expect_eq "state: adopted+seeded-fail → unseeded" "unseeded" "$(_cloud_sync_state)" )
( _cs_agent_installed() { return 1; }; _cs_token_present() { return 1; }
  expect_eq "state: no-agent+no-token → idle" "idle" "$(_cloud_sync_state)" )

# ── _vn_read_replica_base extractor (env override + Layer-2 baseUrl) ──────────
SCRATCH="$(mktemp -d)"
CFG="${SCRATCH}/config.json"
printf '%s\n' '{"catalyst":{"readReplica":{"baseUrl":"http://worker-host:7400"}}}' > "$CFG"
expect_eq "extract: read-replica from Layer-2" "http://worker-host:7400" "$(unset CATALYST_MONITOR_URL; _vn_read_replica_base "$CFG")"
expect_eq "extract: read-replica env override wins" "http://override:9000" "$(CATALYST_MONITOR_URL=http://override:9000 _vn_read_replica_base "$CFG")"
expect_eq "extract: read-replica unset → empty"     "" "$(unset CATALYST_MONITOR_URL; _vn_read_replica_base "${SCRATCH}/nope.json")"
# #1: with NO cfg arg, the Layer-2 file is resolved from CATALYST_LAYER2_CONFIG_FILE — the
# SAME path _vn_resolve uses — so an overridden Layer-2 location is honored for read-source.
expect_eq "extract: read-replica honors CATALYST_LAYER2_CONFIG_FILE" "http://worker-host:7400" \
  "$(unset CATALYST_MONITOR_URL; CATALYST_LAYER2_CONFIG_FILE="$CFG" _vn_read_replica_base)"

# ── End-to-end cmd_verify_node per class (seams injected in isolating subshells) ──
# Each subshell redefines the probe seams locally, so cmd_verify_node grades injected
# state with NO real adoption / daemon / network call. $? after $(...) is the subshell
# (= cmd_verify_node) exit code.

# Unrecognized explicit class (recognized=false) → a single hard FAIL naming raw (CTL-1344).
UNREC_OUT="$(
  _vn_resolve() { printf 'monitor\tenv\tfalse\tfalse\tdevelopr\tno\tno\tunknown\tlaptop'; }
  cmd_verify_node --json 2>/dev/null
)"; UNREC_EC=$?
expect_eq "cmd: unrecognized exits non-zero" "1" "$UNREC_EC"
expect_eq "cmd: unrecognized verdict=fail"   "fail" "$(printf '%s' "$UNREC_OUT" | jq -r '.verdict')"
expect_eq "cmd: unrecognized node_class=monitor" "monitor" "$(printf '%s' "$UNREC_OUT" | jq -r '.node_class')"
expect_eq "cmd: unrecognized single check"   "1" "$(printf '%s' "$UNREC_OUT" | jq -r '.checks | length')"
expect_eq "cmd: unrecognized check FAIL"     "FAIL" "$(printf '%s' "$UNREC_OUT" | jq -r '.checks[0].status')"
if printf '%s' "$UNREC_OUT" | jq -r '.checks[0].detail' | grep -q 'developr'; then
  ok "cmd: unrecognized detail names the raw value"
else
  fail "cmd: unrecognized detail" "missing raw value 'developr'"
fi

# Developer with the broker UP → FAIL (developer running worker daemons).
DEVBROKER_OUT="$(
  _vn_resolve()             { printf 'developer\tenv\tfalse\ttrue\t-\tno\tno\tcluster-repo\tlaptop'; }
  _vn_broker_running()      { echo yes; }
  _vn_exec_core_running()   { echo no; }
  _vn_monitor_running()     { echo no; }
  _vn_event_mirror_running(){ echo yes; }
  _vn_read_replica_base()   { echo 'http://mini:7400'; }
  _vn_updater_ec()          { echo 0; }
  _vn_drained()             { echo no; }
  cmd_verify_node --json 2>/dev/null
)"; DEVBROKER_EC=$?
expect_eq "cmd: developer+broker exits non-zero" "1" "$DEVBROKER_EC"
expect_eq "cmd: developer+broker verdict=fail"   "fail" "$(printf '%s' "$DEVBROKER_OUT" | jq -r '.verdict')"
expect_eq "cmd: developer+broker node_class"     "developer" "$(printf '%s' "$DEVBROKER_OUT" | jq -r '.node_class')"
expect_eq "cmd: developer+broker broker-stopped FAIL" "FAIL" \
  "$(printf '%s' "$DEVBROKER_OUT" | jq -r '.checks[] | select(.name=="broker-stopped") | .status')"

# Healthy developer (daemonless, out-of-roster, remote read-source, updater green,
# event-mirror alive) → PASS.
HEALTHYDEV_OUT="$(
  _vn_resolve()             { printf 'developer\tlayer2\tfalse\ttrue\t-\tno\tno\tcluster-repo\tlaptop'; }
  _vn_broker_running()      { echo no; }
  _vn_exec_core_running()   { echo no; }
  _vn_monitor_running()     { echo no; }
  _vn_event_mirror_running(){ echo yes; }
  _vn_read_replica_base()   { echo 'http://mini:7400'; }
  _vn_updater_ec()          { echo 0; }
  _vn_drained()             { echo no; }
  _vn_cloud_sync_state()    { echo idle; }
  cmd_verify_node --json 2>/dev/null
)"; HEALTHYDEV_EC=$?
expect_eq "cmd: healthy developer exits zero" "0" "$HEALTHYDEV_EC"
expect_eq "cmd: healthy developer verdict=pass" "pass" "$(printf '%s' "$HEALTHYDEV_OUT" | jq -r '.verdict')"
expect_eq "cmd: healthy developer 0 required failures" "0" "$(printf '%s' "$HEALTHYDEV_OUT" | jq -r '.required_failures')"
expect_eq "cmd: healthy developer event-mirror-running PASS" "PASS" \
  "$(printf '%s' "$HEALTHYDEV_OUT" | jq -r '.checks[] | select(.name=="event-mirror-running") | .status')"
# CTL-1736: the replica-writer-local check is wired into the developer rubric, is
# advisory (required=false so a legitimately idle laptop never flips the run), and
# maps idle → PASS end-to-end (closes the wiring-line coverage gap left by the
# pure-helper cases above).
expect_eq "cmd: healthy developer replica-writer-local PASS" "PASS" \
  "$(printf '%s' "$HEALTHYDEV_OUT" | jq -r '.checks[] | select(.name=="replica-writer-local") | .status')"
expect_eq "cmd: healthy developer replica-writer-local advisory" "false" \
  "$(printf '%s' "$HEALTHYDEV_OUT" | jq -r '.checks[] | select(.name=="replica-writer-local") | .required')"

# CTL-1662: developer with event-mirror DEAD → FAIL (the doctor blind spot this closes).
DEVNOMIRROR_OUT="$(
  _vn_resolve()             { printf 'developer\tlayer2\tfalse\ttrue\t-\tno\tno\tcluster-repo\tlaptop'; }
  _vn_broker_running()      { echo no; }
  _vn_exec_core_running()   { echo no; }
  _vn_monitor_running()     { echo no; }
  _vn_event_mirror_running(){ echo no; }
  _vn_read_replica_base()   { echo 'http://mini:7400'; }
  _vn_updater_ec()          { echo 0; }
  _vn_drained()             { echo no; }
  cmd_verify_node --json 2>/dev/null
)"; DEVNOMIRROR_EC=$?
expect_eq "cmd: developer+dead-mirror exits non-zero" "1" "$DEVNOMIRROR_EC"
expect_eq "cmd: developer+dead-mirror verdict=fail"   "fail" "$(printf '%s' "$DEVNOMIRROR_OUT" | jq -r '.verdict')"
expect_eq "cmd: developer+dead-mirror event-mirror-running FAIL" "FAIL" \
  "$(printf '%s' "$DEVNOMIRROR_OUT" | jq -r '.checks[] | select(.name=="event-mirror-running") | .status')"

# Worker missing a daemon (execution-core DOWN) → FAIL.
WORKERMISS_OUT="$(
  _vn_resolve()           { printf 'worker\tlayer2\tfalse\ttrue\t-\tyes\tno\tsingle-host\tlaptop'; }
  _vn_broker_running()    { echo yes; }
  _vn_exec_core_running() { echo no; }
  _vn_monitor_running()   { echo yes; }
  _vu_read_pull_owner()   { echo broker; }
  cmd_verify_node --json 2>/dev/null
)"; WORKERMISS_EC=$?
expect_eq "cmd: worker missing daemon exits non-zero" "1" "$WORKERMISS_EC"
expect_eq "cmd: worker missing daemon verdict=fail"   "fail" "$(printf '%s' "$WORKERMISS_OUT" | jq -r '.verdict')"
expect_eq "cmd: worker exec-core-running FAIL" "FAIL" \
  "$(printf '%s' "$WORKERMISS_OUT" | jq -r '.checks[] | select(.name=="exec-core-running") | .status')"

# Inferred worker (class unset) → node-class WARN, NOT a hard FAIL; with the daemons up
# the run still verdicts PASS (WARN never fails the run).
INFWORKER_OUT="$(
  _vn_resolve()           { printf 'worker\tdefault\ttrue\ttrue\t-\tyes\tno\tsingle-host\tlaptop'; }
  _vn_broker_running()    { echo yes; }
  _vn_exec_core_running() { echo yes; }
  _vn_monitor_running()   { echo yes; }
  _vu_read_pull_owner()   { echo broker; }
  cmd_verify_node --json 2>/dev/null
)"; INFWORKER_EC=$?
expect_eq "cmd: inferred worker exits zero" "0" "$INFWORKER_EC"
expect_eq "cmd: inferred worker verdict=pass" "pass" "$(printf '%s' "$INFWORKER_OUT" | jq -r '.verdict')"
expect_eq "cmd: inferred worker node-class WARN" "WARN" \
  "$(printf '%s' "$INFWORKER_OUT" | jq -r '.checks[] | select(.name=="node-class") | .status')"
expect_eq "cmd: inferred worker warn count >=1" "1" \
  "$(printf '%s' "$INFWORKER_OUT" | jq -r 'if .counts.warn >= 1 then 1 else 0 end')"
if printf '%s' "$INFWORKER_OUT" | jq -r '.checks[] | select(.name=="node-class") | .detail' | grep -qi 'not explicitly set'; then
  ok "cmd: inferred worker WARN detail mentions 'not explicitly set'"
else
  fail "cmd: inferred worker WARN detail" "missing 'not explicitly set'"
fi

# Monitor class → STUB: node.class PASS + a loud WARN stub note (NOT a pass gate), no
# worker/developer checks. The WARN never bumps required-failures, so exit stays 0 (F5) —
# but the output can no longer be mistaken for a verified-healthy verdict.
MONITOR_OUT="$(
  _vn_resolve() { printf 'monitor\tlayer2\tfalse\ttrue\tmonitor\tno\tno\tcluster-repo\tmon-host'; }
  cmd_verify_node --json 2>/dev/null
)"; MONITOR_EC=$?
expect_eq "cmd: monitor stub exits zero" "0" "$MONITOR_EC"
expect_eq "cmd: monitor node_class=monitor" "monitor" "$(printf '%s' "$MONITOR_OUT" | jq -r '.node_class')"
expect_eq "cmd: monitor verdict=pass (stub is not a failure)" "pass" "$(printf '%s' "$MONITOR_OUT" | jq -r '.verdict')"
expect_eq "cmd: monitor profile-stub WARN (not a quiet SKIP)" "WARN" \
  "$(printf '%s' "$MONITOR_OUT" | jq -r '.checks[] | select(.name=="profile-stub") | .status')"
expect_eq "cmd: monitor warn count >=1" "1" \
  "$(printf '%s' "$MONITOR_OUT" | jq -r 'if .counts.warn >= 1 then 1 else 0 end')"
if printf '%s' "$MONITOR_OUT" | jq -r '.checks[] | select(.name=="profile-stub") | .detail' | grep -qi 'NOT a pass gate'; then
  ok "cmd: monitor stub detail says 'NOT a pass gate'"
else
  fail "cmd: monitor stub detail" "missing 'NOT a pass gate'"
fi
expect_eq "cmd: monitor has no broker check" "0" \
  "$(printf '%s' "$MONITOR_OUT" | jq -r '[.checks[] | select(.name=="broker-running" or .name=="broker-stopped")] | length')"

# ── F2/F6: the "-" empty-field sentinel keeps the 9 TAB columns aligned ───────
# A genuinely empty field collapses under `IFS=$'\t' read` (tab is IFS-whitespace) and
# shifts every later column. _vn_resolve emits "-" for empties; assert a line with a "-"
# raw still parses the roster fields into the RIGHT variables (cmd_verify_node's read).
_vn_parse_assert() {
  local p_class p_source p_inferred p_recognized p_raw p_inroster p_multi p_rsrc p_self
  IFS=$'\t' read -r p_class p_source p_inferred p_recognized p_raw p_inroster p_multi p_rsrc p_self <<<"$1"
  expect_eq "parse: class"        "developer"    "$p_class"
  expect_eq "parse: recognized"   "true"         "$p_recognized"
  expect_eq "parse: raw sentinel" "-"            "$p_raw"
  expect_eq "parse: in_roster"    "yes"          "$p_inroster"
  expect_eq "parse: multi_host"   "yes"          "$p_multi"
  expect_eq "parse: roster_src"   "cluster-repo" "$p_rsrc"
  expect_eq "parse: self"         "laptop"       "$p_self"
}
_vn_parse_assert "$(printf 'developer\tlayer2\tfalse\ttrue\t-\tyes\tyes\tcluster-repo\tlaptop')"

# ── F1: the bash fallback resolves the class for REAL (bun/config.mjs unavailable) ──
# Force `command -v bun` to report bun missing so the REAL _vn_resolve takes its BASH
# fallback (the daemonless-developer case). A typo'd class must NOT slip through as a clean
# worker PASS — it resolves recognized=false and cmd_verify_node hard-FAILs (CTL-1344).
nobun() { command() { [[ "$1" == "-v" && "$2" == "bun" ]] && return 1; builtin command "$@"; }; }

# developr (typo) → class=monitor (most restrictive), recognized=false, raw preserved.
NOBUN_TYPO_LINE="$( nobun; CATALYST_NODE_CLASS=developr _vn_resolve )"
expect_eq "fallback: typo class=monitor"      "monitor"  "$(printf '%s' "$NOBUN_TYPO_LINE" | cut -f1)"
expect_eq "fallback: typo recognized=false"   "false"    "$(printf '%s' "$NOBUN_TYPO_LINE" | cut -f4)"
expect_eq "fallback: typo raw=developr"       "developr" "$(printf '%s' "$NOBUN_TYPO_LINE" | cut -f5)"
expect_eq "fallback: typo roster_src=unknown" "unknown"  "$(printf '%s' "$NOBUN_TYPO_LINE" | cut -f8)"

# developer (valid) → class=developer, source=env, recognized — NOT a blind worker.
NOBUN_DEV_LINE="$( nobun; CATALYST_NODE_CLASS=developer _vn_resolve )"
expect_eq "fallback: developer class=developer" "developer" "$(printf '%s' "$NOBUN_DEV_LINE" | cut -f1)"
expect_eq "fallback: developer source=env"      "env"       "$(printf '%s' "$NOBUN_DEV_LINE" | cut -f2)"
expect_eq "fallback: developer inferred=false"  "false"     "$(printf '%s' "$NOBUN_DEV_LINE" | cut -f3)"
expect_eq "fallback: developer recognized=true" "true"      "$(printf '%s' "$NOBUN_DEV_LINE" | cut -f4)"

# absent class → worker default, recognized, inferred (CTL-1344: absent ⇒ worker ⇒ zero change).
NOBUN_ABSENT_LINE="$( nobun; unset CATALYST_NODE_CLASS; CATALYST_LAYER2_CONFIG_FILE="${SCRATCH}/nope.json" _vn_resolve )"
expect_eq "fallback: absent class=worker"    "worker"  "$(printf '%s' "$NOBUN_ABSENT_LINE" | cut -f1)"
expect_eq "fallback: absent source=default"  "default" "$(printf '%s' "$NOBUN_ABSENT_LINE" | cut -f2)"
expect_eq "fallback: absent inferred=true"   "true"    "$(printf '%s' "$NOBUN_ABSENT_LINE" | cut -f3)"
expect_eq "fallback: absent recognized=true" "true"    "$(printf '%s' "$NOBUN_ABSENT_LINE" | cut -f4)"
expect_eq "fallback: absent raw sentinel"    "-"       "$(printf '%s' "$NOBUN_ABSENT_LINE" | cut -f5)"

# End-to-end: with no bun, a typo'd class FAILs cmd_verify_node (NOT a worker PASS). The
# unrecognized branch short-circuits BEFORE any probe seam, so this stays read-only.
NOBUN_TYPO_OUT="$( nobun; CATALYST_NODE_CLASS=developr cmd_verify_node --json 2>/dev/null )"; NOBUN_TYPO_EC=$?
expect_eq "fallback: no-bun typo exits non-zero"     "1"       "$NOBUN_TYPO_EC"
expect_eq "fallback: no-bun typo verdict=fail"       "fail"    "$(printf '%s' "$NOBUN_TYPO_OUT" | jq -r '.verdict')"
expect_eq "fallback: no-bun typo node_class=monitor" "monitor" "$(printf '%s' "$NOBUN_TYPO_OUT" | jq -r '.node_class')"
expect_eq "fallback: no-bun typo single check"       "1"       "$(printf '%s' "$NOBUN_TYPO_OUT" | jq -r '.checks | length')"
if printf '%s' "$NOBUN_TYPO_OUT" | jq -r '.checks[0].detail' | grep -q 'developr'; then
  ok "fallback: no-bun typo detail names raw 'developr'"
else
  fail "fallback: no-bun typo detail" "missing raw 'developr'"
fi

# #3: the fallback trim is PURE bash (not xargs), so a value containing a quote is preserved
# as the raw (xargs would error on the unmatched quote) and resolves recognized=false.
NOBUN_QUOTE_LINE="$( nobun; CATALYST_NODE_CLASS='wo"rker' _vn_resolve )"
expect_eq "fallback: quoted value class=monitor"    "monitor"  "$(printf '%s' "$NOBUN_QUOTE_LINE" | cut -f1)"
expect_eq "fallback: quoted value recognized=false" "false"    "$(printf '%s' "$NOBUN_QUOTE_LINE" | cut -f4)"
expect_eq "fallback: quoted value raw preserved"    'wo"rker'  "$(printf '%s' "$NOBUN_QUOTE_LINE" | cut -f5)"

# #5: a PRESENT non-string Layer-2 node.class (false) is an explicit misconfiguration, NOT
# absence — recognized=false (NOT a clean worker), and cmd_verify_node hard-FAILs.
CFG_FALSE="${SCRATCH}/config-false.json"
printf '%s\n' '{"catalyst":{"node":{"class":false}}}' > "$CFG_FALSE"
NOBUN_FALSE_LINE="$( nobun; unset CATALYST_NODE_CLASS; CATALYST_LAYER2_CONFIG_FILE="$CFG_FALSE" _vn_resolve )"
expect_eq "fallback: layer2 false class=monitor"    "monitor"      "$(printf '%s' "$NOBUN_FALSE_LINE" | cut -f1)"
expect_eq "fallback: layer2 false source=layer2"    "layer2"       "$(printf '%s' "$NOBUN_FALSE_LINE" | cut -f2)"
expect_eq "fallback: layer2 false recognized=false" "false"        "$(printf '%s' "$NOBUN_FALSE_LINE" | cut -f4)"
expect_eq "fallback: layer2 false raw=<non-string>" "<non-string>" "$(printf '%s' "$NOBUN_FALSE_LINE" | cut -f5)"

NOBUN_FALSE_OUT="$( nobun; unset CATALYST_NODE_CLASS; CATALYST_LAYER2_CONFIG_FILE="$CFG_FALSE" cmd_verify_node --json 2>/dev/null )"; NOBUN_FALSE_EC=$?
expect_eq "fallback: layer2 false exits non-zero"     "1"       "$NOBUN_FALSE_EC"
expect_eq "fallback: layer2 false verdict=fail"       "fail"    "$(printf '%s' "$NOBUN_FALSE_OUT" | jq -r '.verdict')"
expect_eq "fallback: layer2 false node_class=monitor" "monitor" "$(printf '%s' "$NOBUN_FALSE_OUT" | jq -r '.node_class')"

# ── CTL-1678: _vn_drained honors CATALYST_DRAIN_DISABLED; _vn_drain_disabled ──
# A drain-disabled worker admits new work, so _vn_drained must report `no` even
# when the physical flag file exists (truthful — the override neutralizes it).
DRAIN_SCRATCH="$(mktemp -d)"
mkdir -p "${DRAIN_SCRATCH}/execution-core"
: > "${DRAIN_SCRATCH}/execution-core/drain"   # physical flag present
# CTL-1678 (Codex P2): the probes now source the machine-local execution-core.env so the
# durable override is visible. Point CATALYST_EXECUTION_CORE_ENV at controlled files:
# an EMPTY one (sourcing is a no-op → the ambient/prefix vars decide) keeps the legacy
# cases hermetic regardless of the host's real ~/.config/catalyst/execution-core.env; an
# OVERRIDE one proves the file-sourced value reaches the probe.
DRAIN_ENV_EMPTY="$(mktemp)"
DRAIN_ENV_OVERRIDE="$(mktemp)"
printf 'export CATALYST_DRAIN_DISABLED=1\n' > "$DRAIN_ENV_OVERRIDE"

# flag present + override set → no (override wins)
expect_eq "_vn_drained: flag present + DRAIN_DISABLED=1 → no" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" CATALYST_DRAIN_DISABLED=1 _vn_drained )"
# flag present + env unset → yes (unchanged legacy behavior)
expect_eq "_vn_drained: flag present + env unset → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED; source "'"$STACK"'"; _vn_drained' )"
# boot-drained + env unset → yes (unchanged)
expect_eq "_vn_drained: boot-drained + env unset → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="${DRAIN_SCRATCH}/absent" CATALYST_BOOT_DRAINED=1 bash -c 'unset CATALYST_DRAIN_DISABLED; source "'"$STACK"'"; _vn_drained' )"
# Codex P2 (finding #3): boot-drain is AUTHORITATIVE — BOTH BOOT_DRAINED=1 and
# DRAIN_DISABLED=1 present → drained=yes (matches config.mjs isDrainDisabled, which
# returns false under boot-drain). The pre-fix Bash mirror returned `no` here.
expect_eq "_vn_drained: boot-drained + DRAIN_DISABLED=1 → yes (boot wins)" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" CATALYST_BOOT_DRAINED=1 CATALYST_DRAIN_DISABLED=1 _vn_drained )"
# Codex P2 (finding #2): the durable override lives ONLY in execution-core.env (ambient
# unset) → the probe sources it and reports the neutralized flag as `no`.
expect_eq "_vn_drained: flag present + override in env-file (ambient unset) → no" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_OVERRIDE" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drained' )"

# _vn_drain_disabled: yes iff CATALYST_DRAIN_DISABLED == "1" AND not boot-drained
expect_eq "_vn_drain_disabled: =1 → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DRAIN_DISABLED=1 _vn_drain_disabled )"
expect_eq "_vn_drain_disabled: =0 → no"  "no"  \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DRAIN_DISABLED=0 _vn_drain_disabled )"
expect_eq "_vn_drain_disabled: unset → no" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" bash -c 'unset CATALYST_DRAIN_DISABLED; source "'"$STACK"'"; _vn_drain_disabled' )"
# Codex P2 (finding #3): boot-drain neutralizes the override → _vn_drain_disabled reports
# `no` even with DRAIN_DISABLED=1 (mirrors config.mjs isDrainDisabled).
expect_eq "_vn_drain_disabled: boot-drained + DRAIN_DISABLED=1 → no" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_BOOT_DRAINED=1 CATALYST_DRAIN_DISABLED=1 _vn_drain_disabled )"
# Codex P2 (finding #2): override from the env-file (ambient unset) → yes.
expect_eq "_vn_drain_disabled: override in env-file (ambient unset) → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_OVERRIDE" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drain_disabled' )"

# _vn_v_drain_disabled verdict helper (advisory PASS either way)
expect_eq "_vn_v_drain_disabled: yes → PASS" "PASS" "$(status_of "$(_vn_v_drain_disabled yes)")"
expect_eq "_vn_v_drain_disabled: no → PASS"  "PASS" "$(status_of "$(_vn_v_drain_disabled no)")"
case "$(_vn_v_drain_disabled yes)" in
  *"ignores the drain flag"*) ok "_vn_v_drain_disabled: yes detail names 'ignores the drain flag'" ;;
  *) fail "_vn_v_drain_disabled: yes detail" "missing 'ignores the drain flag'" ;;
esac

# ── CTL-1678 (Codex round-3 P1): a LIVE daemon's boot snapshot beats the env file ──
# The overrides are restart-only; when daemon-runtime-env.json exists and its pid is
# alive, the probes must answer from it and ignore the (possibly newer) env file.
RT_MARKER="${DRAIN_SCRATCH}/execution-core/daemon-runtime-env.json"
# Round-4 P2: the marker is trusted only when its pid is ALSO the live daemon of record
# (daemon.pid), so a recycled pid cannot re-certify a crashed daemon's snapshot.
RT_PIDFILE="${DRAIN_SCRATCH}/execution-core/daemon.pid"
echo "$$" > "$RT_PIDFILE"
# Live marker (this test shell's pid), no override captured at boot — the env file's
# post-restart CATALYST_DRAIN_DISABLED=1 must NOT flip the answer.
printf '{"pid":%s,"startedAt":"x","drainDisabled":false,"bootDrained":false}\n' "$$" > "$RT_MARKER"
expect_eq "_vn_drained: live marker no-override beats env-file override → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_OVERRIDE" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drained' )"
expect_eq "_vn_drain_disabled: live marker no-override beats env-file override → no" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_OVERRIDE" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drain_disabled' )"
# Live marker WITH the override, empty env file — the running daemon ignores the flag.
printf '{"pid":%s,"startedAt":"x","drainDisabled":true,"bootDrained":false}\n' "$$" > "$RT_MARKER"
expect_eq "_vn_drained: live marker override, flag present → no" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drained' )"
expect_eq "_vn_drain_disabled: live marker override → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drain_disabled' )"
# Dead-pid marker → stale, fall back to the env file (which carries the override).
_dead_pid="$(bash -c 'echo $$')"   # that shell has exited; its pid is dead
printf '{"pid":%s,"startedAt":"x","drainDisabled":false,"bootDrained":false}\n' "$_dead_pid" > "$RT_MARKER"
echo "$_dead_pid" > "$RT_PIDFILE"
expect_eq "_vn_drain_disabled: dead-pid marker → env-file fallback → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_OVERRIDE" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED; source "'"$STACK"'"; _vn_drain_disabled' )"

# Round-6 P2: the marker's RECORDED pidFile is honored even when the caller did not
# inherit EXECUTION_CORE_PID_FILE — otherwise a relocated-pid-file host rejects every
# valid snapshot and silently falls back to the mutable env file.
RT_RELOCATED="${DRAIN_SCRATCH}/relocated.pid"
echo "$$" > "$RT_RELOCATED"
printf '{"pid":%s,"pidFile":"%s","startedAt":"x","drainDisabled":true,"bootDrained":false}\n' "$$" "$RT_RELOCATED" > "$RT_MARKER"
rm -f "$RT_PIDFILE"   # the DEFAULT path does not exist; only the recorded one does
expect_eq "_vn_drain_disabled: recorded pidFile honored without env inheritance" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED EXECUTION_CORE_PID_FILE; source "'"$STACK"'"; _vn_drain_disabled' )"
expect_eq "_vn_drained: recorded pidFile honored, flag present but ignored" "no" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED EXECUTION_CORE_PID_FILE; source "'"$STACK"'"; _vn_drained' )"
# "pidFile":null (daemon started without --pid-file) falls through to the env/default chain.
echo "$$" > "$RT_PIDFILE"
printf '{"pid":%s,"pidFile":null,"startedAt":"x","drainDisabled":true,"bootDrained":false}\n' "$$" > "$RT_MARKER"
expect_eq "_vn_drain_disabled: pidFile:null falls back to the default path" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_EMPTY" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED EXECUTION_CORE_PID_FILE; source "'"$STACK"'"; _vn_drain_disabled' )"

# Round-4 P2: alive pid, but daemon.pid names a DIFFERENT daemon → marker untrusted,
# fall back to the env file (which carries the override).
printf '{"pid":%s,"startedAt":"x","drainDisabled":false,"bootDrained":false}\n' "$$" > "$RT_MARKER"
echo "999999" > "$RT_PIDFILE"
expect_eq "_vn_drain_disabled: pid-not-of-record → env-file fallback → yes" "yes" \
  "$( CATALYST_EXECUTION_CORE_ENV="$DRAIN_ENV_OVERRIDE" CATALYST_DIR="$DRAIN_SCRATCH" bash -c 'unset CATALYST_DRAIN_DISABLED CATALYST_BOOT_DRAINED EXECUTION_CORE_PID_FILE; source "'"$STACK"'"; _vn_drain_disabled' )"

rm -rf "$DRAIN_SCRATCH"
rm -f "$DRAIN_ENV_EMPTY" "$DRAIN_ENV_OVERRIDE"

rm -rf "$SCRATCH"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
