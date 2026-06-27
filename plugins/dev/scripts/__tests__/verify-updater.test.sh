#!/usr/bin/env bash
# Shell tests for `catalyst-stack verify-updater` (CTL-1349).
#
# Exercises the PASS/FAIL/SKIP decision logic of the PURE verdict helpers (_vu_v_*)
# with injected data, plus the side-effecting EXTRACTORS (_vu_x_*) against temp
# updater.log + event-log fixtures. NO real adoption is performed — catalyst-stack is
# SOURCED (its dispatch is guarded by BASH_SOURCE[0]==$0, so sourcing runs no command).
#
# Run: bash plugins/dev/scripts/__tests__/verify-updater.test.sh

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

# ── Check 1: _vu_v_agent (launchd agent loaded + live pid) ───────────────────
expect_eq "agent: no plist → FAIL (not adopted)"  "FAIL" "$(status_of "$(_vu_v_agent no '')")"
expect_eq "agent: plist + live pid → PASS"         "PASS" "$(status_of "$(_vu_v_agent yes 12345)")"
expect_eq "agent: plist + pid '-' → FAIL"          "FAIL" "$(status_of "$(_vu_v_agent yes '-')")"
expect_eq "agent: plist + pid '0' → FAIL"          "FAIL" "$(status_of "$(_vu_v_agent yes 0)")"
expect_eq "agent: plist + empty pid → FAIL"        "FAIL" "$(status_of "$(_vu_v_agent yes '')")"

# ── Check 2: _vu_v_owner (pluginPullOwner flipped to updater; Layer-2 only, V5) ───
# 1-arg signature: the verify shell's CATALYST_PLUGIN_PULL_OWNER is NOT read (it governs
# the broker's runtime, not this process), so only the persisted Layer-2 value decides.
expect_eq "owner: config=updater → PASS"           "PASS" "$(status_of "$(_vu_v_owner updater)")"
expect_eq "owner: config=broker → FAIL"            "FAIL" "$(status_of "$(_vu_v_owner broker)")"
expect_eq "owner: config unset → FAIL"             "FAIL" "$(status_of "$(_vu_v_owner '')")"

# ── Check 3: _vu_v_head (HEAD == origin/main, the verified-pulling proof) ─────
expect_eq "head: HEAD==origin → PASS"              "PASS" "$(status_of "$(_vu_v_head /r abcdef12 abcdef12)")"
expect_eq "head: HEAD!=origin → FAIL"              "FAIL" "$(status_of "$(_vu_v_head /r abcdef12 99999999)")"
expect_eq "head: empty shas → FAIL"                "FAIL" "$(status_of "$(_vu_v_head /r '' '')")"

# ── Check 4: _vu_v_hb_fresh (heartbeat freshness AND current launchd pid, V3) ──
# 5-arg signature: <now_s> <last_ms> <last_pid> <agent_pid> <window>. A fresh heartbeat
# whose pid != the current launchd pid is from a prior/zombie instance → FAIL.
NOW="$(date +%s)"
FRESH_MS="$(( (NOW - 10) * 1000 ))"
STALE_MS="$(( (NOW - 5000) * 1000 ))"
HB_PID=4242
expect_eq "hb: fresh + matching pid → PASS"        "PASS" "$(status_of "$(_vu_v_hb_fresh "$NOW" "$FRESH_MS" "$HB_PID" "$HB_PID" 600)")"
expect_eq "hb: fresh + pid mismatch → FAIL"        "FAIL" "$(status_of "$(_vu_v_hb_fresh "$NOW" "$FRESH_MS" 1111 2222 600)")"
expect_eq "hb: stale beyond window → FAIL"         "FAIL" "$(status_of "$(_vu_v_hb_fresh "$NOW" "$STALE_MS" "$HB_PID" "$HB_PID" 600)")"
expect_eq "hb: missing → FAIL"                     "FAIL" "$(status_of "$(_vu_v_hb_fresh "$NOW" '' "$HB_PID" "$HB_PID" 600)")"
expect_eq "hb: non-numeric → FAIL"                 "FAIL" "$(status_of "$(_vu_v_hb_fresh "$NOW" 'null' "$HB_PID" "$HB_PID" 600)")"

# ── Check 5: _vu_v_refresh (a RECENT clean refresh in updater.log, V4/V1) ─────
# 5-arg signature: <now_s> <time_ms> <roots> <failed> <window>. A stale-good refresh
# (age >= window) FAILs even though roots>0/failed=0 — a stopped updater can't pass on a
# boot-time refresh while the broker keeps the checkout fresh.
expect_eq "refresh: fresh roots=2 failed=0 → PASS" "PASS" "$(status_of "$(_vu_v_refresh "$NOW" "$FRESH_MS" 2 0 600)")"
expect_eq "refresh: stale → FAIL (updater stopped)" "FAIL" "$(status_of "$(_vu_v_refresh "$NOW" "$STALE_MS" 2 0 600)")"
expect_eq "refresh: roots=0 → FAIL (no-op)"        "FAIL" "$(status_of "$(_vu_v_refresh "$NOW" "$FRESH_MS" 0 0 600)")"
expect_eq "refresh: failed=1 → FAIL"               "FAIL" "$(status_of "$(_vu_v_refresh "$NOW" "$FRESH_MS" 2 1 600)")"
expect_eq "refresh: no line → FAIL"                "FAIL" "$(status_of "$(_vu_v_refresh "$NOW" '' '' '' 600)")"

# ── Check 6: _vu_v_event_hb (recent class-stamped node.updater.heartbeat) ─────
expect_eq "event-hb: fresh + class → PASS"         "PASS" "$(status_of "$(_vu_v_event_hb "$NOW" "$FRESH_MS" developer 600)")"
expect_eq "event-hb: missing class → FAIL"         "FAIL" "$(status_of "$(_vu_v_event_hb "$NOW" "$FRESH_MS" '' 600)")"
expect_eq "event-hb: no event → FAIL"              "FAIL" "$(status_of "$(_vu_v_event_hb "$NOW" '' '' 600)")"
expect_eq "event-hb: stale → FAIL"                 "FAIL" "$(status_of "$(_vu_v_event_hb "$NOW" "$STALE_MS" developer 600)")"

# ── Check 7: _vu_v_checkout (plugin.checkout.* attribution; not required) ─────
expect_eq "checkout: updater evt + class → PASS"   "PASS" "$(status_of "$(_vu_v_checkout plugin.checkout.updated developer '')")"
expect_eq "checkout: broker drift → FAIL"          "FAIL" "$(status_of "$(_vu_v_checkout '' '' plugin.checkout.drift)")"
expect_eq "checkout: updater evt no class → FAIL"  "FAIL" "$(status_of "$(_vu_v_checkout plugin.checkout.updated '' '')")"
expect_eq "checkout: nothing → SKIP (neutral)"     "SKIP" "$(status_of "$(_vu_v_checkout '' '' '')")"
# Drift wins even if an updater event also exists (SLA miss is the louder signal).
expect_eq "checkout: drift wins over updater evt"  "FAIL" "$(status_of "$(_vu_v_checkout plugin.checkout.updated developer plugin.checkout.drift)")"

# ── Extractors over temp fixtures ────────────────────────────────────────────
SCRATCH="$(mktemp -d)"
LOG="${SCRATCH}/updater.log"
EV="${SCRATCH}/events.jsonl"

# updater.log — pino JSON lines (heartbeat marker + a clean refresh line). pino stamps
# every line with .time and .pid; the heartbeat marker carries the launchd pid (HB_PID).
{
  printf '%s\n' "{\"level\":30,\"time\":${FRESH_MS},\"pid\":${HB_PID},\"name\":\"updater\",\"hb\":true,\"component\":\"updater\",\"msg\":\"daemon heartbeat\"}"
  printf '%s\n' "{\"level\":30,\"time\":${FRESH_MS},\"pid\":${HB_PID},\"name\":\"updater\",\"reason\":\"poll\",\"roots\":2,\"pulled\":0,\"changed\":0,\"failed\":0,\"refresh_duration_ms\":12,\"catalyst.node.class\":\"developer\",\"msg\":\"updater: refresh (CTL-1350)\"}"
} > "$LOG"

IFS=$'\t' read -r XH_MS XH_PID <<<"$(_vu_x_last_heartbeat_ms "$LOG")"
expect_eq "extract: last heartbeat ms"  "$FRESH_MS" "$XH_MS"
expect_eq "extract: last heartbeat pid" "$HB_PID"   "$XH_PID"

IFS=$'\t' read -r XR_TIME XR_ROOTS XR_FAILED <<<"$(_vu_x_last_refresh "$LOG")"
expect_eq "extract: refresh time"   "$FRESH_MS" "$XR_TIME"
expect_eq "extract: refresh roots"  "2" "$XR_ROOTS"
expect_eq "extract: refresh failed" "0" "$XR_FAILED"

# Missing log → extractors return empty (and verdicts FAIL), never error.
expect_eq "extract: missing log → empty heartbeat" "" "$(_vu_x_last_heartbeat_ms "${SCRATCH}/nope.log")"

# event log — node.updater.heartbeat + an updater plugin.checkout.* + a broker drift.
{
  printf '%s\n' "{\"resource\":{\"service.name\":\"catalyst.updater\",\"catalyst.node.class\":\"developer\"},\"attributes\":{\"event.name\":\"node.updater.heartbeat\"},\"body\":{\"payload\":{\"epoch\":${FRESH_MS},\"roots\":2}}}"
  printf '%s\n' "{\"resource\":{\"service.name\":\"catalyst.updater\",\"catalyst.node.class\":\"developer\"},\"attributes\":{\"event.name\":\"plugin.checkout.updated\"},\"body\":{\"payload\":{\"checkout\":\"/r\",\"old_sha\":\"a\",\"new_sha\":\"b\"}}}"
  printf '%s\n' "{\"resource\":{\"service.name\":\"catalyst.broker\"},\"attributes\":{\"event.name\":\"plugin.checkout.drift\"},\"body\":{\"payload\":{\"checkout\":\"/r\"}}}"
} > "$EV"

IFS=$'\t' read -r XE_EPOCH XE_CLASS <<<"$(_vu_x_event_heartbeat "$EV")"
expect_eq "extract: event-hb epoch" "$FRESH_MS" "$XE_EPOCH"
expect_eq "extract: event-hb class" "developer" "$XE_CLASS"

IFS=$'\t' read -r XC_EVT XC_CLS <<<"$(_vu_x_checkout_updater "$EV")"
expect_eq "extract: updater checkout evt" "plugin.checkout.updated" "$XC_EVT"
expect_eq "extract: updater checkout class" "developer" "$XC_CLS"

expect_eq "extract: broker drift evt" "plugin.checkout.drift" "$(_vu_x_checkout_broker_drift "$EV")"

# An event log with NO plugin.checkout.* → both checkout extractors empty (→ verdict SKIP).
EV2="${SCRATCH}/events2.jsonl"
printf '%s\n' "{\"resource\":{\"service.name\":\"catalyst.updater\",\"catalyst.node.class\":\"monitor\"},\"attributes\":{\"event.name\":\"node.updater.heartbeat\"},\"body\":{\"payload\":{\"epoch\":${FRESH_MS}}}}" > "$EV2"
expect_eq "extract: no checkout events → empty updater" "" "$(_vu_x_checkout_updater "$EV2")"
expect_eq "extract: no checkout events → empty drift"   "" "$(_vu_x_checkout_broker_drift "$EV2")"
expect_eq "extract: monitor-class event-hb"  "monitor" "$(IFS=$'\t' read -r _e c <<<"$(_vu_x_event_heartbeat "$EV2")"; printf '%s' "$c")"

# ── Check 3 fetch-failure (V2): a swallowed `git fetch` must NOT pass ─────────
# Inject a real checkout whose `origin main` fetch fails (unreachable remote). A stale
# tracking ref must NOT be compared and falsely report "at origin/main" — Check 3 must
# record FAIL (freshness UNVERIFIED). Drive _vu_check_head_origin via CATALYST_PLUGIN_DIRS
# so resolve_plugin_dirs points it at our fixture, in a subshell that isolates the globals.
FF_ROOT="${SCRATCH}/ff-checkout"
mkdir -p "$FF_ROOT"
git -C "$FF_ROOT" init -q
git -C "$FF_ROOT" remote add origin "file://${SCRATCH}/no-such-remote-$$.git"
FF_VERDICT="$(
  export CATALYST_PLUGIN_DIRS="$FF_ROOT"
  VU_JSON="no"
  VU_NAMES=(); VU_TIERS=(); VU_REQUIRED=(); VU_STATUSES=(); VU_DETAILS=(); VU_FAIL_REQUIRED=0
  _vu_check_head_origin >/dev/null 2>&1
  printf '%s|%s' "${VU_STATUSES[0]:-NONE}" "${VU_DETAILS[0]:-}"
)"
expect_eq "checkout-fresh: fetch failure → FAIL" "FAIL" "${FF_VERDICT%%|*}"
case "$FF_VERDICT" in
  *"git fetch failed"*) ok "checkout-fresh: fetch failure detail (freshness UNVERIFIED)" ;;
  *) fail "checkout-fresh: fetch failure detail" "got: $FF_VERDICT" ;;
esac

# ── End-to-end decision: not-adopted node emits a non-zero exit (no real agent) ──
# Drive cmd_verify_updater with the plist forced absent + Tier-2 skipped. It must
# report "not adopted" via Check 1 and exit non-zero, touching nothing.
UPDATER_AGENT_PLIST="${SCRATCH}/absent.plist"   # guaranteed-absent
VU_OUT="$(cmd_verify_updater --no-e2e 2>/dev/null)"; VU_EC=$?
expect_eq "cmd: not-adopted exits non-zero" "1" "$VU_EC"
if printf '%s' "$VU_OUT" | grep -q "not adopted"; then
  ok "cmd: not-adopted output mentions 'not adopted'"
else
  fail "cmd: not-adopted output" "missing 'not adopted' marker"
fi

# Same path with --json must produce parseable JSON with adopted=false, verdict=fail.
VU_JSON_OUT="$(cmd_verify_updater --json --no-e2e 2>/dev/null)"
expect_eq "cmd: --json adopted=false" "false" "$(printf '%s' "$VU_JSON_OUT" | jq -r '.adopted')"
expect_eq "cmd: --json verdict=fail"  "fail"  "$(printf '%s' "$VU_JSON_OUT" | jq -r '.verdict')"
expect_eq "cmd: --json check1 FAIL"   "FAIL"  "$(printf '%s' "$VU_JSON_OUT" | jq -r '.checks[0].status')"

rm -rf "$SCRATCH"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
