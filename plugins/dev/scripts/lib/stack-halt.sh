#!/usr/bin/env bash
# Durable operator-intent marker for catalyst-stack supervision (CAT-163).
#
# CROSS-FILE GLOBAL (CAT-264): STACK_HALT_STATE is assigned here and in
# stack_halt_active() but read by catalyst-stack after it sources this library.
# It carries why a falsy stack_halt_active returned: absent, expired, and
# malformed all return 1. Do not delete or export it.
# shellcheck disable=SC2034

STACK_HALT_FILE="${CATALYST_DIR:-$HOME/catalyst}/stack-halt.json"
STACK_HALT_TTL_SECS="${CATALYST_STACK_HALT_TTL_SECS:-86400}"
# Tolerance for benign clock jitter between the write and a later read. A
# haltedAt further ahead than this is treated as malformed, not as "age 0".
STACK_HALT_SKEW_SECS="${CATALYST_STACK_HALT_SKEW_SECS:-300}"
STACK_HALT_STATE="absent"
STACK_HALT_AGE_SECS=0
STACK_HALT_HALTED_AT=""
STACK_HALT_REASON=""
STACK_HALT_TTL_EFFECTIVE="$STACK_HALT_TTL_SECS"

stack_halt_write() {
  local reason="${1:-operator requested stop}" dir tmp now host by
  dir="$(dirname "$STACK_HALT_FILE")"; mkdir -p "$dir" || return 1
  tmp="${STACK_HALT_FILE}.tmp.$$"; now="$(date +%s)"
  host="${CATALYST_HOST_NAME:-$(hostname -s 2>/dev/null || hostname)}"
  by="${USER:-$(id -un 2>/dev/null || echo unknown)}"
  jq -nc --argjson haltedAt "$now" --arg host "$host" --arg reason "$reason" \
    --arg by "$by" --argjson ttlSecs "$STACK_HALT_TTL_SECS" \
    '{haltedAt:$haltedAt,host:$host,reason:$reason,by:$by,ttlSecs:$ttlSecs}' > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$STACK_HALT_FILE"
}

stack_halt_clear() { rm -f "$STACK_HALT_FILE"; }

stack_halt_active() {
  STACK_HALT_STATE="absent"; STACK_HALT_AGE_SECS=0; STACK_HALT_HALTED_AT=""; STACK_HALT_REASON=""; STACK_HALT_TTL_EFFECTIVE="$STACK_HALT_TTL_SECS"
  [[ -f "$STACK_HALT_FILE" ]] || return 1
  local now halted ttl
  now="$(date +%s)"; halted="$(jq -r '.haltedAt // empty' "$STACK_HALT_FILE" 2>/dev/null)"
  # Integers only, and never further ahead than the skew allowance:
  #  - a float or non-numeric haltedAt reaching $((now - halted)) is a FATAL bash
  #    arithmetic-expansion error that aborts the CALLING shell, so every
  #    `catalyst-stack status/stop/start --supervised` dies mid-run. jq's
  #    `numbers` filter accepts floats, so it cannot be the gate.
  #  - a future-dated haltedAt would pin the age clamp below at 0 forever, so
  #    `age >= ttl` never fires and the host stays halted indefinitely —
  #    contradicting the documented TTL invariant.
  # Both route into the existing malformed self-heal (rename + treat as absent).
  if [[ ! "$halted" =~ ^-?[0-9]+$ ]] || (( halted > now + STACK_HALT_SKEW_SECS )); then
    STACK_HALT_STATE="malformed"
    # Read-only callers (status/describe) classify but never rename: discarding the
    # operator's halt intent must not be a side effect of merely looking at it.
    [[ "${STACK_HALT_NO_HEAL:-0}" == 1 ]] \
      || mv "$STACK_HALT_FILE" "${STACK_HALT_FILE}.invalid.$(date +%s)" 2>/dev/null || true
    return 1
  fi
  ttl="$(jq -r '.ttlSecs // empty' "$STACK_HALT_FILE")"; [[ "$ttl" =~ ^[0-9]+$ ]] || ttl="$STACK_HALT_TTL_SECS"
  STACK_HALT_TTL_EFFECTIVE="$ttl"
  STACK_HALT_AGE_SECS=$((now - halted)); (( STACK_HALT_AGE_SECS < 0 )) && STACK_HALT_AGE_SECS=0
  STACK_HALT_HALTED_AT="$halted"; STACK_HALT_REASON="$(jq -r '.reason // "operator requested stop"' "$STACK_HALT_FILE")"
  if (( STACK_HALT_AGE_SECS >= ttl )); then STACK_HALT_STATE="expired"; return 1; fi
  STACK_HALT_STATE="active"; return 0
}

stack_halt_describe() {
  local STACK_HALT_NO_HEAL=1
  if stack_halt_active; then
    printf 'halted by operator at epoch %s (reason: %s, %ss remaining)' "$STACK_HALT_HALTED_AT" "$STACK_HALT_REASON" "$((STACK_HALT_TTL_EFFECTIVE - STACK_HALT_AGE_SECS))"
  else
    printf 'active'
  fi
}
