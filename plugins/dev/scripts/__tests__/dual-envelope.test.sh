#!/usr/bin/env bash
# Shell tests for the CTL-1795 bash half of the v1→superset dual envelope:
#   lib/canonical-event.sh   canonical_dual_envelope_line / canonical_merge_v1 / canonical_note_v1_only
#   lib/emit-reap-intent.sh  the bash reap-intent producer
#   catalyst-session.sh      agent.checkin / agent.checkout (Ruling 2 — the census missed these)
#
# Plus the cross-stack ATTR_MAP parity check: the bash mirror _CE_FLAT_ATTR_JQ vs the JS
# registry FLAT_ATTRIBUTE_MAP. Bash cannot import an ESM constant, so the two are hand-written
# mirrors and this is what keeps them honest.
#
# Run: bash plugins/dev/scripts/__tests__/dual-envelope.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIB="${SCRIPTS_DIR}/lib/canonical-event.sh"

# shellcheck disable=SC1090
source "$LIB"

FAILURES=0
PASSES=0

ok() {
  PASSES=$((PASSES + 1))
  echo "  PASS: $1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $1"
  echo "    $2"
}

expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then ok "$name"; else fail "$name" "expected '$expected' got '$actual'"; fi
}

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq unavailable — the canonical path under test requires it by design (CTL-1795 Ruling 3)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== canonical_dual_envelope_line ==="

V1='{"ts":"2026-08-13T10:00:00Z","event":"phase.terminal.reap-requested","ticket":"CTL-1795","phase":"implement","bg_job_id":"abc12345","reason":"terminal-signal"}'
LINE="$(canonical_dual_envelope_line "$V1")"

# ONE line, not two — a v1 line plus a separate v2 twin would be double-routed by every
# consumer using the v1-first getEventName extractor.
expect_eq "emits exactly one line" "1" "$(printf '%s' "$LINE" | grep -c '' || true)"

# The load-bearing invariant: both readers of the SAME line resolve the SAME name.
expect_eq "top-level event survives" "phase.terminal.reap-requested" \
  "$(printf '%s' "$LINE" | jq -r '.event')"
expect_eq "attributes carry event.name" "phase.terminal.reap-requested" \
  "$(printf '%s' "$LINE" | jq -r '.attributes["event.name"]')"
expect_eq "the two extractors agree" "true" \
  "$(printf '%s' "$LINE" | jq -r '(.event) == (.attributes["event.name"])')"

# Existing v1 consumers must be untouched — the reaper reads e.ticket / e.bg_job_id / e.reason.
expect_eq "v1 field ticket preserved" "CTL-1795" "$(printf '%s' "$LINE" | jq -r '.ticket')"
expect_eq "v1 field bg_job_id preserved" "abc12345" "$(printf '%s' "$LINE" | jq -r '.bg_job_id')"
expect_eq "v1 field reason preserved" "terminal-signal" "$(printf '%s' "$LINE" | jq -r '.reason')"

# ATTR_MAP promotion, matching otel-forward's normalizeFlatEvent.
expect_eq "ticket promoted to attribute" "CTL-1795" \
  "$(printf '%s' "$LINE" | jq -r '.attributes["catalyst.worker.ticket"]')"
expect_eq "phase promoted to attribute" "implement" \
  "$(printf '%s' "$LINE" | jq -r '.attributes["catalyst.worker.phase"]')"
expect_eq "bg_job_id promoted to attribute" "abc12345" \
  "$(printf '%s' "$LINE" | jq -r '.attributes["catalyst.worker.bg_job_id"]')"
expect_eq "unmapped field lands in body.payload" "terminal-signal" \
  "$(printf '%s' "$LINE" | jq -r '.body.payload.reason')"
expect_eq "ts is never duplicated into payload" "null" \
  "$(printf '%s' "$LINE" | jq -r '.body.payload.ts // "null"')"

# One timestamp, adopted verbatim from v1.
expect_eq "canonical ts adopts the v1 ts" "2026-08-13T10:00:00Z" "$(printf '%s' "$LINE" | jq -r '.ts')"
expect_eq "observedTs matches ts" "true" "$(printf '%s' "$LINE" | jq -r '.ts == .observedTs')"
expect_eq "body.message is non-empty" "phase.terminal.reap-requested" \
  "$(printf '%s' "$LINE" | jq -r '.body.message')"
expect_eq "resource is present" "catalyst.execution-core" \
  "$(printf '%s' "$LINE" | jq -r '.resource["service.name"]')"

# The superset line must NOT trip the legacy rotation (which keys on has("attributes")).
expect_eq "has attributes, so canonical_jsonl_append will not rotate" "true" \
  "$(printf '%s' "$LINE" | jq -r 'has("attributes")')"

# A flat field cannot displace event.name even when it maps onto that key.
SPOOF='{"ts":"2026-08-13T10:00:00Z","event":"real.name","event.name":"spoofed"}'
expect_eq "a flat field cannot displace event.name" "real.name" \
  "$(canonical_dual_envelope_line "$SPOOF" | jq -r '.attributes["event.name"]')"

echo "=== canonical_dual_envelope_line — fails CLOSED ==="

if canonical_dual_envelope_line '{"ts":"x"}' >/dev/null 2>&1; then
  fail "nameless record rejected" "expected non-zero exit"
else
  ok "nameless record rejected"
fi
if canonical_dual_envelope_line '{"ts":"x","event":""}' >/dev/null 2>&1; then
  fail "empty-name record rejected" "expected non-zero exit"
else
  ok "empty-name record rejected"
fi
if canonical_dual_envelope_line '{"ts":"x","event":"e.v","attributes":{}}' >/dev/null 2>&1; then
  fail "already-canonical record rejected" "expected non-zero exit (no double-wrap)"
else
  ok "already-canonical record rejected"
fi
if canonical_dual_envelope_line 'not json' >/dev/null 2>&1; then
  fail "unparseable record rejected" "expected non-zero exit"
else
  ok "unparseable record rejected"
fi

echo "=== canonical_note_v1_only — the declared-asymmetry breadcrumb ==="

BREADCRUMB_OUT="$(
  unset CATALYST_EVENT_ENVELOPE_V1_ONLY __CE_V1_ONLY_WARNED
  canonical_note_v1_only "jq-missing:test" 2>&1
  canonical_note_v1_only "jq-missing:test" 2>&1 # second call must be silent
  printf 'FLAG=%s REASON=%s\n' "${CATALYST_EVENT_ENVELOPE_V1_ONLY:-}" "${CATALYST_EVENT_ENVELOPE_V1_ONLY_REASON:-}"
)"
expect_eq "warns exactly once per process" "1" "$(printf '%s\n' "$BREADCRUMB_OUT" | grep -c 'RAW v1 event envelope' || true)"
expect_eq "sets the env breadcrumb" "FLAG=1 REASON=jq-missing:test" \
  "$(printf '%s\n' "$BREADCRUMB_OUT" | tail -n 1)"

echo "=== cross-stack ATTR_MAP parity (bash mirror vs the JS registry) ==="

# Parse FLAT_ATTRIBUTE_MAP out of the JS source and compare it, as a SET, to the bash mirror.
# Anchored on the declaration so a rename fails CLOSED rather than silently comparing nothing.
JS_SRC="${SCRIPTS_DIR}/execution-core/lib/canonical-event.mjs"
if [[ ! -r "$JS_SRC" ]]; then
  fail "JS registry readable" "missing $JS_SRC"
else
  JS_PAIRS="$(
    awk '/^export const FLAT_ATTRIBUTE_MAP = Object.freeze\(\{/{f=1;next} f&&/^\}\);/{exit} f' "$JS_SRC" |
      sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\):[[:space:]]*"\([^"]*\)".*$/\1=\2/p' | sort
  )"
  SH_PAIRS="$(printf '%s' "$_CE_FLAT_ATTR_JQ" | jq -r 'to_entries[] | "\(.key)=\(.value)"' | sort)"
  # Positive control: the instrument must actually find rows, or "they match" is vacuous
  # (two empty sets are equal). Six is the registry's real size.
  expect_eq "parity instrument extracted the JS rows (positive control)" "6" \
    "$(printf '%s\n' "$JS_PAIRS" | grep -c '=' || true)"
  if [[ "$JS_PAIRS" == "$SH_PAIRS" ]]; then
    ok "bash _CE_FLAT_ATTR_JQ matches JS FLAT_ATTRIBUTE_MAP exactly"
  else
    fail "bash _CE_FLAT_ATTR_JQ matches JS FLAT_ATTRIBUTE_MAP exactly" \
      "$(printf 'js:\n%s\nsh:\n%s\n' "$JS_PAIRS" "$SH_PAIRS")"
  fi
fi

echo "=== lib/emit-reap-intent.sh emits the superset line ==="

REAP_DIR="$TMP/reap-events"
mkdir -p "$REAP_DIR"
(
  export CATALYST_EVENTS_DIR="$REAP_DIR"
  # shellcheck disable=SC1090
  . "${SCRIPTS_DIR}/lib/emit-reap-intent.sh"
  emit_reap_intent phase.yield.reap-requested --ticket CTL-1795 --phase implement --bg-job-id abc12345
)
REAP_FILE="${REAP_DIR}/$(date -u +%Y-%m).jsonl"
if [[ ! -f "$REAP_FILE" ]]; then
  fail "emit_reap_intent wrote an event" "no file at $REAP_FILE"
else
  expect_eq "emit_reap_intent wrote exactly one line" "1" "$(grep -c '' "$REAP_FILE" || true)"
  REAP_LINE="$(head -n 1 "$REAP_FILE")"
  expect_eq "emit_reap_intent keeps the v1 event field" "phase.yield.reap-requested" \
    "$(printf '%s' "$REAP_LINE" | jq -r '.event')"
  expect_eq "emit_reap_intent keeps the v1 ticket field" "CTL-1795" \
    "$(printf '%s' "$REAP_LINE" | jq -r '.ticket')"
  expect_eq "emit_reap_intent now carries attributes.event.name" "phase.yield.reap-requested" \
    "$(printf '%s' "$REAP_LINE" | jq -r '.attributes["event.name"]')"
  expect_eq "emit_reap_intent promotes ticket to the mapped attribute" "CTL-1795" \
    "$(printf '%s' "$REAP_LINE" | jq -r '.attributes["catalyst.worker.ticket"]')"
fi

echo "=== catalyst-session.sh agent.checkin / agent.checkout (Ruling 2) ==="

SESSION_SH="${SCRIPTS_DIR}/catalyst-session.sh"
if [[ ! -x "$SESSION_SH" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
  echo "  SKIP: catalyst-session.sh not runnable here (needs sqlite3)"
else
  SESS_HOME="$TMP/sess"
  mkdir -p "$SESS_HOME"
  SID="$(CATALYST_DIR="$SESS_HOME" "$SESSION_SH" start --skill phase-implement --ticket CTL-1795 2>/dev/null | tail -n 1)"
  SESS_FILE="${SESS_HOME}/events/$(date -u +%Y-%m).jsonl"
  if [[ -z "$SID" || ! -f "$SESS_FILE" ]]; then
    fail "catalyst-session.sh start emitted events" "sid='$SID' file='$SESS_FILE'"
  else
    CHECKIN="$(jq -c 'select((.event // .attributes["event.name"]) == "agent.checkin")' "$SESS_FILE" | head -n 1)"
    if [[ -z "$CHECKIN" ]]; then
      fail "agent.checkin emitted" "no agent.checkin line in $SESS_FILE"
    else
      expect_eq "agent.checkin keeps top-level event" "agent.checkin" "$(printf '%s' "$CHECKIN" | jq -r '.event')"
      expect_eq "agent.checkin now carries attributes.event.name" "agent.checkin" \
        "$(printf '%s' "$CHECKIN" | jq -r '.attributes["event.name"]')"
      # getEventPayload reads `.detail` FIRST, so the broker's behaviour is unchanged …
      expect_eq "agent.checkin keeps .detail for the broker" "$SID" \
        "$(printf '%s' "$CHECKIN" | jq -r '.detail.session_id')"
      # … and body.payload is the SAME object, so the follow-up v1 removal is a no-op there.
      expect_eq "agent.checkin body.payload equals detail" "true" \
        "$(printf '%s' "$CHECKIN" | jq -r '.body.payload == .detail')"
      expect_eq "agent.checkin is one line per emit" "1" \
        "$(jq -c 'select((.event // .attributes["event.name"]) == "agent.checkin")' "$SESS_FILE" | grep -c '' || true)"
    fi

    CATALYST_DIR="$SESS_HOME" "$SESSION_SH" end "$SID" --status done >/dev/null 2>&1
    CHECKOUT="$(jq -c 'select((.event // .attributes["event.name"]) == "agent.checkout")' "$SESS_FILE" | head -n 1)"
    if [[ -z "$CHECKOUT" ]]; then
      fail "agent.checkout emitted" "no agent.checkout line in $SESS_FILE"
    else
      expect_eq "agent.checkout keeps top-level event" "agent.checkout" "$(printf '%s' "$CHECKOUT" | jq -r '.event')"
      expect_eq "agent.checkout now carries attributes.event.name" "agent.checkout" \
        "$(printf '%s' "$CHECKOUT" | jq -r '.attributes["event.name"]')"
      expect_eq "agent.checkout body.payload equals detail" "true" \
        "$(printf '%s' "$CHECKOUT" | jq -r '.body.payload == .detail')"
      expect_eq "agent.checkout is one line per emit" "1" \
        "$(jq -c 'select((.event // .attributes["event.name"]) == "agent.checkout")' "$SESS_FILE" | grep -c '' || true)"
    fi
  fi
fi

echo
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ "$FAILURES" -eq 0 ]] || exit 1
