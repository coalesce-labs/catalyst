#!/usr/bin/env bash
# account-rotation-watch.sh — CTL-2145. The durable ACTOR wired to the CTL-1653
# account-status latch.
#
# WHY THIS EXISTS. `account-status-latch.mjs` has emitted `account.status.changed` on
# every ok<->rejected edge since CTL-1653 and writes a durable marker
# (~/catalyst/account-status-latch.json) alongside it. A grep of the broker,
# execution-core, and every other consumer found ZERO handlers and ZERO
# `filter.register` interests for that event. So on 2026-08-21 the active Claude account
# got rate-walled, the transition was faithfully recorded — and nothing rotated. This is
# the consumer that closes that loop.
#
# WHY A StartInterval TICK AND NOT A SUBSCRIBER (D2). The obvious shape — block on
# `catalyst-events wait-for account.status.changed` — reintroduces the precise failure
# mode this ticket exists to remove: a long-lived process owned by whoever started it,
# which on 2026-08-21 outlived its own config as a blind zombie holding deleted inodes.
# Two prior learnings say the same thing (CTL-988: an unsupervised fire-and-forget
# process in a fleet-critical path is a silent SPOF; CTL-1285: a KeepAlive job's
# detached children get reaped). So this is a SHORT-LIVED tick that reads the latch's
# DURABLE state and exits — it "subscribes to the transition" through the state the
# latch already persists, and it cannot zombie because it never lives long enough to.
#
# EDGE, NOT LEVEL. `latched:true` is a LEVEL that stays true for the whole episode. The
# actor rotates on the EDGE — a latch ts strictly newer than the last-acted marker —
# because a level-triggered actor ticking every few minutes would burn every provisioned
# account in one wall.
#
# NO-OP IS NOT FAILURE, AND IS NEVER SILENT. Every declining path (latch absent or
# malformed, already acted, no alternative handle, capped, off/shadow) says which one it
# is. A silent decline and a silent success are indistinguishable, which is how the
# outage stayed invisible for 75 minutes.
#
# Usage:
#   account-rotation-watch.sh            # one tick (what the LaunchAgent runs)
# Env:
#   CATALYST_ACCOUNT_ROTATION   off|shadow|enforce   (default shadow; invalid -> shadow)
#   CATALYST_DIR                runtime root         (default $HOME/catalyst)
#   CLAUDE_ACCOUNTS_ENV         handle source        (default ~/.config/catalyst/claude-accounts.env)
#   ROTATION_HOURLY_CAP         rotations/hour       (default 3)
#   ROTATION_SWITCH_CMD         the switch verb      (default: catalyst-stack claude-account switch)

set -uo pipefail

_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
COORD_SRC="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
COMMS_DIR="${COMMS_DIR:-${CATALYST_DIR}/comms/coord}"
LATCH="${CATALYST_DIR}/account-status-latch.json"
ACCOUNTS_ENV="${CLAUDE_ACCOUNTS_ENV:-${HOME}/.config/catalyst/claude-accounts.env}"
MARKER="${COMMS_DIR}/.account-rotation-acted"
# A SEPARATE marker for shadow's announcement, and the separation is the whole point.
# Shadow must satisfy two properties that one marker cannot hold at once: announce each
# edge ONCE (not once per tick for the whole multi-hour wall), and never CONSUME the edge
# (or an operator who flips to enforce after reading the dry run finds nothing left to act
# on — a dry run that silently disarms the real thing). Two markers, two questions:
# `.account-rotation-acted` is "did we rotate", `.account-rotation-announced` is "did we
# already say we would". Only enforce ever writes the former.
ANNOUNCED="${COMMS_DIR}/.account-rotation-announced"
ROTATIONS="${COMMS_DIR}/.rotations"
CUR="${COMMS_DIR}/fleet-account.current"
EVENTS_DIR="${CATALYST_DIR}/events"
ROTATION_WINDOW_SECONDS=3600
ROTATION_HOURLY_CAP="${ROTATION_HOURLY_CAP:-3}"

log() { echo "$(date '+%H:%M:%S') account-rotation: $*"; }
warn() { echo "$(date '+%H:%M:%S') account-rotation: $*" >&2; }

# ─── rolling-window cap (shared with lane-relaunch.sh) ───────────────────────
WINDOW_LIB="${COORD_SRC}/lib/rotation-window.sh"
if [[ ! -r "$WINDOW_LIB" ]]; then
  warn "FATAL: missing ${WINDOW_LIB} — refusing to rotate without the circuit breaker"
  exit 1
fi
# shellcheck source=lib/rotation-window.sh
. "$WINDOW_LIB"

# ─── mode ────────────────────────────────────────────────────────────────────
#
# env -> .catalyst/config.json -> shadow. An unrecognized value degrades to SHADOW and
# says so; it must never fall through to a lower-precedence source, because an operator
# mistyping a rollback would then be silently re-armed by a stale `enforce` sitting in
# config (the CTL-1531 short-circuit lesson, same reasoning: a typo must not arm a
# mutation).
_config_mode() {
  local dir="$PWD" cfg=""
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -f "$dir/.catalyst/config.json" ]]; then cfg="$dir/.catalyst/config.json"; break; fi
    dir="$(dirname "$dir")"
  done
  [[ -n "$cfg" ]] && command -v jq >/dev/null 2>&1 || { printf ''; return 0; }
  jq -r '.catalyst.accountRotation.mode // empty' "$cfg" 2>/dev/null || printf ''
}

_resolve_mode() {
  local candidate
  for candidate in "${CATALYST_ACCOUNT_ROTATION:-}" "$(_config_mode)"; do
    case "$candidate" in
      off | shadow | enforce)
        printf '%s' "$candidate"
        return 0
        ;;
      "") ;;
      *)
        warn "CATALYST_ACCOUNT_ROTATION='${candidate}' is not one of off|shadow|enforce — falling back to 'shadow' (NOT to any lower-precedence value)"
        printf 'shadow'
        return 0
        ;;
    esac
  done
  printf 'shadow'
}

MODE="$(_resolve_mode)"

if [[ "$MODE" == "off" ]]; then
  log "mode=off — no-op (rotation disabled)"
  exit 0
fi

# ─── event emission ──────────────────────────────────────────────────────────
#
# `account.*` is NOT a broker-protected namespace (CTL-1142) — account.ratelimit.sampled
# and account.status.changed already live there — so these names need no contract change.
#
# The LaunchAgent runs THIS file from the pristine scripts clone, where ../lib is present.
# The materialized copy under ~/catalyst/comms/coord does NOT have it, so resolution is a
# short ladder whose last rung reads the .coord-source-dir breadcrumb that
# materialize-coord-kit.sh writes beside the baked kit — it records the coord SOURCE dir,
# so this rung resolves `../lib/canonical-event.sh` against it exactly as rung 1 does
# against the running file. (That rung had no writer anywhere in the repo until CTL-2145's
# remediation: it could never fire, which made the ladder advertise a fallback that could
# not succeed.) A genuine miss is LOUD: an event we cannot emit is reported on stderr
# (which rides the agent's own .log) rather than skipped in silence. The load-bearing
# record is the durable marker plus these log lines; the event is the dashboard's copy.
_resolve_canonical_lib() {
  local c
  for c in \
    "${COORD_SRC}/../lib/canonical-event.sh" \
    "${CATALYST_DEV_SCRIPTS:-/nonexistent}/lib/canonical-event.sh" \
    "$([[ -r "${COMMS_DIR}/.coord-source-dir" ]] && printf '%s/../lib/canonical-event.sh' "$(cat "${COMMS_DIR}/.coord-source-dir" 2>/dev/null)")"; do
    [[ -n "$c" && -r "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

_emit() { # $1 event name, $2 severity, $3 message, $4 payload json
  local name="$1" severity="$2" message="$3" payload="$4" lib line
  if ! lib="$(_resolve_canonical_lib)"; then
    warn "event ${name} NOT emitted — canonical-event.sh is unresolvable from ${COORD_SRC} (the tick itself was unaffected)"
    return 0
  fi
  command -v jq >/dev/null 2>&1 || {
    warn "event ${name} NOT emitted — jq is unavailable (the tick itself was unaffected)"
    return 0
  }
  # shellcheck source=/dev/null
  . "$lib" 2>/dev/null || {
    warn "event ${name} NOT emitted — could not source ${lib}"
    return 0
  }
  line="$(build_canonical_line \
    --ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --severity "$severity" \
    --service catalyst.account-rotation \
    --event-name "$name" \
    --entity account \
    --action rotation \
    --message "$message" \
    --payload-json "$payload" 2>/dev/null)" || line=""
  [[ -n "$line" ]] || {
    warn "event ${name} NOT emitted — canonical line could not be built"
    return 0
  }
  # NO `2>/dev/null` on this call: the append primitive's refused-line / failed-dd
  # WARNING is its entire loud-failure contract (CTL-1809), and a caller that mutes it
  # turns a dropped event back into a silent one. `|| true` is fine — the emit is
  # best-effort — but the reason stays audible in the agent's log.
  canonical_jsonl_append "$EVENTS_DIR" "$line" || true
}

# ─── read the latch ──────────────────────────────────────────────────────────
#
# THREE-VALUED, and the third value is the point. "Could not look" (absent, unreadable,
# malformed) is reported as INCONCLUSIVE and is never collapsed into "no edge" — a tick
# that cannot read the latch has learned nothing, and reporting that as a quiet healthy
# tick is precisely the false-clean this repo keeps getting bitten by.
if [[ ! -f "$LATCH" ]]; then
  log "INCONCLUSIVE: no account-status latch at ${LATCH} — cannot tell a healthy account from a walled one; no rotation"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  log "INCONCLUSIVE: jq unavailable — cannot read ${LATCH}; no rotation"
  exit 0
fi
LATCHED="$(jq -r 'if .latched == true then "true" elif .latched == false then "false" else "" end' "$LATCH" 2>/dev/null || true)"
LATCH_TS="$(jq -r 'if (.ts | type) == "number" then (.ts | floor | tostring) else "" end' "$LATCH" 2>/dev/null || true)"
if [[ -z "$LATCHED" || -z "$LATCH_TS" ]]; then
  log "INCONCLUSIVE: ${LATCH} is unreadable or malformed (latched='${LATCHED}' ts='${LATCH_TS}') — no rotation"
  exit 0
fi

mkdir -p "$COMMS_DIR" 2>/dev/null || true
LAST_ACTED="$(cat "$MARKER" 2>/dev/null || true)"
[[ "$LAST_ACTED" =~ ^[0-9]+$ ]] || LAST_ACTED=0

# ─── recovered: re-arm for the next episode ─────────────────────────────────
if [[ "$LATCHED" == "false" ]]; then
  # Advance the marker to the recovery ts so a LATER trip (a strictly newer ts) reads as
  # a fresh edge. Without this the actor would be armed only once ever.
  if [[ "$MODE" == "enforce" ]]; then
    printf '%s\n' "$LATCH_TS" >"$MARKER" 2>/dev/null || warn "could not advance the marker at ${MARKER}"
  fi
  log "account status is OK (recovered at ts=${LATCH_TS}) — no rotation needed; re-armed for the next episode"
  exit 0
fi

# ─── edge guard ─────────────────────────────────────────────────────────────
if [[ "$LATCH_TS" -le "$LAST_ACTED" ]]; then
  log "already acted on this episode (latch ts=${LATCH_TS} <= last-acted ${LAST_ACTED}) — no edge, no rotation"
  exit 0
fi

# ─── select the next handle (D6) ────────────────────────────────────────────
#
# Round-robin: start AFTER the currently-active (i.e. walled) handle and wrap, skipping
# the walled one. Selection is deliberately mechanical — the HEALTH check lives in the
# switch verb itself, which probes the target's token auth before flipping anything
# (catalyst-stack's `claude-account switch` -> _ca_probe_handle_ok). Re-implementing a
# probe here would be a second, divergent opinion about the same question.
#
# SECRETS HYGIENE: `grep -oE` on the key prefix only — no token VALUE is ever captured
# into a variable, printed, or logged.
#
# ⚠️ DELIBERATE NARROWING (plan D6): both readers below match `acct[0-9]+`, while
# catalyst-stack's canonical parser (_ca_parse_active_handle_stream) matches the wider
# `[A-Za-z0-9_]+`. A provisioned handle NOT named acctN is therefore invisible here: it is
# never a rotation TARGET, and when it is the ACTIVE (walled) handle _active_handle
# returns empty and _next_handle falls back to the first handle — still a rotation AWAY
# from the walled account, never a wrong one. That is the intended scope: this actor
# rotates the fleet's acctN pool (the shape materialize-coord-kit.sh generates launchers
# for, and the only shape provisioned today), and widening it is a change to what the kit
# manages, not a bug fix. Recorded here so the divergence from the canonical parser reads
# as a decision rather than as an oversight the next reader "fixes" in passing.
_handles() {
  [[ -f "$ACCOUNTS_ENV" ]] || return 0
  grep -oE '^CLAUDE_TOKEN_acct[0-9]+=' "$ACCOUNTS_ENV" 2>/dev/null |
    sed -E 's/^CLAUDE_TOKEN_(acct[0-9]+)=$/\1/' |
    awk '!seen[$0]++'
}

_active_handle() {
  local h=""
  if [[ -f "$ACCOUNTS_ENV" ]]; then
    h="$(grep -m1 -oE '_catalyst_active_token="\$CLAUDE_TOKEN_acct[0-9]+"' "$ACCOUNTS_ENV" 2>/dev/null |
      sed -E 's/.*CLAUDE_TOKEN_(acct[0-9]+)".*/\1/')"
  fi
  # The SOPS selector is authoritative for "which account Claude is actually using".
  # fleet-account.current is only a fallback: it is the LANE launcher pointer, which the
  # two-pointer note in the architecture doc warns must not be conflated with it.
  [[ -z "$h" && -f "$CUR" ]] && h="$(tr -d '[:space:]' <"$CUR" 2>/dev/null)"
  printf '%s' "$h"
}

HANDLES="$(_handles)"
ACTIVE="$(_active_handle)"
HANDLE_COUNT="$(printf '%s\n' "$HANDLES" | grep -c . || true)"

if [[ -z "$HANDLES" ]]; then
  log "INCONCLUSIVE: no CLAUDE_TOKEN_acctN handles found in ${ACCOUNTS_ENV} — cannot select a rotation target; no rotation (marker NOT advanced, so this edge is still live)"
  exit 0
fi
if [[ "$HANDLE_COUNT" -lt 2 ]]; then
  log "INCONCLUSIVE: only ${HANDLE_COUNT} handle provisioned (${HANDLES}) — the walled account is the only one there is; no rotation (marker NOT advanced, so provisioning another account later still acts on this edge)"
  exit 0
fi

# _next_handle ACTIVE — the handle after ACTIVE in file order, wrapping; never ACTIVE.
# With ACTIVE unknown (no selector, no pointer) it falls back to the FIRST handle, which
# is a defensible target rather than a refusal — but the refusal above already covers the
# only case where no target exists at all.
_next_handle() {
  printf '%s\n' "$HANDLES" | awk -v active="$1" '
    { h[NR] = $0 }
    END {
      if (NR == 0) exit
      idx = 0
      for (i = 1; i <= NR; i++) if (h[i] == active) idx = i
      if (idx == 0) { print h[1]; exit }
      print h[(idx % NR) + 1]
    }'
}

NEXT="$(_next_handle "$ACTIVE")"
if [[ -z "$NEXT" || "$NEXT" == "$ACTIVE" ]]; then
  log "INCONCLUSIVE: could not select a handle other than the walled one (active='${ACTIVE}', handles=$(printf '%s' "$HANDLES" | tr '\n' ' ')) — no rotation"
  exit 0
fi

# ─── rolling-window cap ─────────────────────────────────────────────────────
COUNT="$(cw_count_in_window "$ROTATIONS" "$ROTATION_WINDOW_SECONDS")"
if [[ "$COUNT" -ge "$ROTATION_HOURLY_CAP" ]]; then
  log "CAPPED — ${COUNT} rotations in the last hour (cap ${ROTATION_HOURLY_CAP}); refusing to rotate ${ACTIVE} -> ${NEXT} until the window ages out"
  _emit "account.rotation.capped" WARN "account rotation capped" \
    "$(jq -nc --arg from "$ACTIVE" --arg to "$NEXT" --argjson count "$COUNT" --argjson cap "$ROTATION_HOURLY_CAP" \
      '{from:$from,to:$to,rotations_in_window:$count,cap:$cap,mode:"'"$MODE"'"}' 2>/dev/null || echo null)"
  exit 0
fi

# ─── shadow ─────────────────────────────────────────────────────────────────
#
# Shadow NEVER touches the ACT marker. Advancing it would consume the edge without acting
# on it, so a later flip to `enforce` — the exact move a dry run exists to justify — would
# find nothing to do, mid-wall. A dry run that silently disarms the real thing is worse
# than no dry run at all.
#
# It does advance its OWN announce marker, so the intent is stated once per edge rather
# than once per tick. Without that, a StartInterval agent re-logs an identical line (and
# re-emits an identical event) for every tick of a multi-hour wall — the count-exactly /
# warn-sparsely discipline CTL-1817/CTL-1823 landed for the same reason. The two markers
# are independent: announcing consumes nothing.
if [[ "$MODE" != "enforce" ]]; then
  LAST_ANNOUNCED="$(cat "$ANNOUNCED" 2>/dev/null || true)"
  [[ "$LAST_ANNOUNCED" =~ ^[0-9]+$ ]] || LAST_ANNOUNCED=0
  if [[ "$LATCH_TS" -le "$LAST_ANNOUNCED" ]]; then
    log "mode=${MODE} — already acted (announced) on this episode (latch ts=${LATCH_TS} <= last-announced ${LAST_ANNOUNCED}); the edge is still LIVE for a later flip to enforce"
    exit 0
  fi
  log "mode=${MODE} — WOULD rotate ${ACTIVE} -> ${NEXT} on this rejected edge (latch ts=${LATCH_TS}); mutating nothing"
  _emit "account.rotation.would-switch" INFO "would rotate the active Claude account" \
    "$(jq -nc --arg from "$ACTIVE" --arg to "$NEXT" --arg ts "$LATCH_TS" --arg mode "$MODE" \
      '{from:$from,to:$to,latch_ts:$ts,mode:$mode}' 2>/dev/null || echo null)"
  # Best-effort: a marker we cannot write costs a repeated announcement, never a wrong
  # rotation, so it must not fail the tick.
  printf '%s\n' "$LATCH_TS" >"$ANNOUNCED" 2>/dev/null ||
    warn "could not advance the announce marker at ${ANNOUNCED} — this edge will be re-announced next tick"
  exit 0
fi

# ─── enforce ────────────────────────────────────────────────────────────────
#
# Record the attempt BEFORE calling the verb, so a switch that itself fails or hangs
# still counts toward the cap — a broken verb must not become an unbounded tight retry
# (lane-relaunch.sh's rule, same reason).
cw_record_attempt "$ROTATIONS"
log "rotating ${ACTIVE} -> ${NEXT} (rejected edge at latch ts=${LATCH_TS}, attempt $((COUNT + 1))/${ROTATION_HOURLY_CAP} this hour)"

# The sanctioned operator-grade verb: it validates the handle, probes its token auth,
# flips the SOPS `_catalyst_active_token` selector, re-materializes claude-accounts.env,
# and restarts the stack. Reusing it is what keeps this actor out of the SOPS mechanics.
read -r -a SWITCH_ARGV <<<"${ROTATION_SWITCH_CMD:-catalyst-stack claude-account switch}"
SWITCH_OUT="$("${SWITCH_ARGV[@]}" "$NEXT" --yes 2>&1)"
SWITCH_RC=$?

if [[ $SWITCH_RC -ne 0 ]]; then
  # Leave BOTH the marker and fleet-account.current untouched: the edge stays live so the
  # next tick retries it, and the two pointers never disagree about which account is
  # active. The cap (already incremented above) is what bounds that retry.
  warn "switch FAILED (rc=${SWITCH_RC}) rotating ${ACTIVE} -> ${NEXT} — marker NOT advanced, so the next tick retries this edge (bounded by the ${ROTATION_HOURLY_CAP}/hour cap)"
  printf '%s\n' "$SWITCH_OUT" | sed 's/^/  | /' >&2
  _emit "account.rotation.failed" ERROR "account rotation failed" \
    "$(jq -nc --arg from "$ACTIVE" --arg to "$NEXT" --argjson rc "$SWITCH_RC" --arg ts "$LATCH_TS" \
      '{from:$from,to:$to,rc:$rc,latch_ts:$ts}' 2>/dev/null || echo null)"
  exit 1
fi

# Drive the SECOND pointer (D3). These are two genuinely different things — the SOPS
# selector says which token Claude uses; fleet-account.current says which launcher
# lane-relaunch.sh picks — and they must not be conflated, but they must agree.
if printf '%s\n' "$NEXT" >"$CUR" 2>/dev/null; then
  log "fleet-account.current -> ${NEXT} (lane-relaunch.sh will use launch-on-${NEXT}.sh)"
else
  warn "rotated to ${NEXT} but could NOT write ${CUR} — lanes will keep relaunching on the OLD account's launcher"
fi

printf '%s\n' "$LATCH_TS" >"$MARKER" 2>/dev/null ||
  warn "rotated to ${NEXT} but could NOT advance the marker at ${MARKER} — the next tick may rotate again on the same edge (bounded by the cap)"

log "rotated ${ACTIVE} -> ${NEXT}"
_emit "account.rotation.switched" INFO "rotated the active Claude account" \
  "$(jq -nc --arg from "$ACTIVE" --arg to "$NEXT" --arg ts "$LATCH_TS" \
    '{from:$from,to:$to,latch_ts:$ts,mode:"enforce"}' 2>/dev/null || echo null)"
exit 0
