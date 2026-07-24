#!/usr/bin/env bash
# health-responder.sh — Stateless periodic health responder for the supervised
# cloud-sync replica writer (CTL-1509). Complements catalyst-doctor (which only
# DETECTS) with a bounded, local ACT step: when the writer is dead or wedged,
# kickstart its LaunchAgent — at most N times per window — then escalate loudly
# and stop.
#
# Deliberately a SHORT-LIVED launchd StartInterval sweep (the orphan-sweep
# pattern), NOT a long-lived daemon: a watcher daemon can zombie in exactly the
# ways the daemons it guards do; a fresh process every interval cannot. All
# detection is LOCAL (plist / pgrep / lock-file mtime / breadcrumb file) —
# never Linear, never Loki — so the responder keeps working through exactly the
# outages it exists to respond to.
#
# Conditions (any one triggers the bounded kickstart):
#   1. dead-writer  — cloud-sync agent installed (plist on disk) but no
#                     cloud-sync.mjs process. KeepAlive={SuccessfulExit:false}
#                     should have relaunched a crashed writer; if it didn't,
#                     the job is wedged and a kickstart is the fix.
#   2. stale-writer — a cloud-sync.mjs process EXISTS but the writer.lock
#                     heartbeat (SDK rewrites it ~5s, feed-INDEPENDENT — a
#                     quiet Linear feed never stales the lock, only a dead SDK
#                     heartbeat does; see doctor.mjs checkCloudSync) is older
#                     than RESPONDER_LOCK_STALE_SECS. Doctor merely WARNs at
#                     60s (CATALYST_REPLICA_LOCK_STALE_MS); the responder ACTS
#                     only at 900s — the act-threshold is deliberately far
#                     above the detect-threshold so a jittery heartbeat is
#                     never kickstarted.
#   3. no-respawn   — the CTL-1508 self-heal breadcrumb
#                     (~/catalyst/cloud-sync.selfheal.json) says the writer
#                     exited ON PURPOSE expecting a launchd relaunch
#                     (expectRestart:true), but no process came back within
#                     RESPONDER_SELFHEAL_GRACE_SECS. Absent breadcrumb = the
#                     normal case (CTL-1508 ships in parallel); absent or
#                     malformed is silently ignored.
#
# Escalation contract: attempts are timestamped marker files under
# ~/catalyst/.health-responder/. When RESPONDER_MAX_ATTEMPTS kickstarts within
# RESPONDER_ATTEMPT_WINDOW_SECS have not cleared the condition, write the
# one-shot ESCALATED.cloud-sync marker, emit catalyst.responder.escalated
# (fail-open) + an ERROR log line (Alloy ships this log to Loki), and STOP
# kickstarting. The condition clearing (a healthy probe) removes the marker and
# the attempt files, re-arming the responder. Never crash-loops launchctl.
#
# Every run — healthy, acting, escalated, or disabled — ends with exactly one
# grep-stable heartbeat line ("heartbeat status=…"). The stale-copy-reports-
# healthy rule: a dead responder must be distinguishable from a quiet one, so
# silence in ~/catalyst/health-responder.log for > interval means the RESPONDER
# is down, not that everything is fine.
#
# Usage:
#   health-responder.sh [--dry-run] [--help]
#
# Env overrides (all have production defaults):
#   RESPONDER_ENABLED              — kill-switch, default 1 (0 = heartbeat-only no-op)
#   RESPONDER_LOCK_STALE_SECS      — stale-writer threshold, default 900 (15 min)
#   RESPONDER_SELFHEAL_GRACE_SECS  — no-respawn grace after breadcrumb ts, default 120
#   RESPONDER_MAX_ATTEMPTS         — kickstarts per window before escalating, default 3
#   RESPONDER_ATTEMPT_WINDOW_SECS  — attempt-cap window, default 3600 (1 h)
#   RESPONDER_KICKSTART_WAIT_SECS  — post-kickstart settle before re-probe, default 10
#   RESPONDER_STATE_DIR            — marker dir, default ~/catalyst/.health-responder
#   RESPONDER_SELFHEAL_FILE        — breadcrumb path, default ~/catalyst/cloud-sync.selfheal.json
#   RESPONDER_DRY_RUN              — set to 1 or use --dry-run flag
#   RESPONDER_RUN_ID               — default: timestamp-based (set in tests for determinism)
#   CATALYST_REPLICA_DB            — replica db path (lock = <db>.writer.lock),
#                                    default ~/catalyst/catalyst-replica.db
#                                    (mirrors execution-core/config.mjs getReplicaDbPath)
#   CATALYST_LAUNCHAGENTS_DIR      — default ~/Library/LaunchAgents (mirrors doctor.mjs)

set -uo pipefail

# Resolve script dir so sibling scripts (emit-otel-event.sh) are found. APPEND
# to PATH so a test's prepended mock bin still wins (orphan-sweep.sh idiom).
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC
export PATH="${PATH}:${SCRIPT_DIR}"

# ─── arg parsing ────────────────────────────────────────────────────────────

DRY_RUN="${RESPONDER_DRY_RUN:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "health-responder: unknown flag: $1" >&2
      echo "usage: health-responder.sh [--dry-run] [--help]" >&2
      exit 1
      ;;
  esac
done

# ─── config (env-overridable, production defaults) ──────────────────────────

RESPONDER_ENABLED="${RESPONDER_ENABLED:-1}"
RESPONDER_LOCK_STALE_SECS="${RESPONDER_LOCK_STALE_SECS:-900}"
RESPONDER_SELFHEAL_GRACE_SECS="${RESPONDER_SELFHEAL_GRACE_SECS:-120}"
RESPONDER_MAX_ATTEMPTS="${RESPONDER_MAX_ATTEMPTS:-3}"
RESPONDER_ATTEMPT_WINDOW_SECS="${RESPONDER_ATTEMPT_WINDOW_SECS:-3600}"
RESPONDER_KICKSTART_WAIT_SECS="${RESPONDER_KICKSTART_WAIT_SECS:-10}"
# How long the launchctl kickstart subprocess itself may run before being
# killed (Codex P1: a hung launchctl must not wedge the sweep — see the act
# section). Distinct from KICKSTART_WAIT_SECS (the post-kickstart settle).
RESPONDER_KICKSTART_TIMEOUT_SECS="${RESPONDER_KICKSTART_TIMEOUT_SECS:-20}"

# Guard the bounded-action envelope itself (Codex P2): a zero/negative/garbage
# window would prune every attempt marker on each sweep — the counter pins at
# 1, escalation becomes unreachable, and the writer is kickstarted every
# interval forever, defeating the central safety property. Clamp to sane
# values rather than trusting the env.
[[ "$RESPONDER_ATTEMPT_WINDOW_SECS" =~ ^[0-9]+$ && "$RESPONDER_ATTEMPT_WINDOW_SECS" -gt 0 ]] || RESPONDER_ATTEMPT_WINDOW_SECS=3600
[[ "$RESPONDER_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || RESPONDER_MAX_ATTEMPTS=3
[[ "$RESPONDER_KICKSTART_WAIT_SECS" =~ ^[0-9]+$ ]] || RESPONDER_KICKSTART_WAIT_SECS=10
[[ "$RESPONDER_KICKSTART_TIMEOUT_SECS" =~ ^[0-9]+$ && "$RESPONDER_KICKSTART_TIMEOUT_SECS" -gt 0 ]] || RESPONDER_KICKSTART_TIMEOUT_SECS=20
RESPONDER_RUN_ID="${RESPONDER_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RESPONDER_STATE_DIR="${RESPONDER_STATE_DIR:-${HOME}/catalyst/.health-responder}"
RESPONDER_SELFHEAL_FILE="${RESPONDER_SELFHEAL_FILE:-${HOME}/catalyst/cloud-sync.selfheal.json}"

# Target: the supervised cloud-sync replica writer. Label + plist dir + replica
# db path all mirror doctor.mjs checkCloudSync / config.mjs getReplicaDbPath so
# the responder and the doctor can never disagree about WHERE to look.
CLOUD_SYNC_LABEL="ai.coalesce.catalyst-cloud-sync"
CLOUD_SYNC_PLIST="${CATALYST_LAUNCHAGENTS_DIR:-${HOME}/Library/LaunchAgents}/${CLOUD_SYNC_LABEL}.plist"
REPLICA_DB="${CATALYST_REPLICA_DB:-${HOME}/catalyst/catalyst-replica.db}"
WRITER_LOCK="${REPLICA_DB}.writer.lock"
ESCALATED_MARKER="${RESPONDER_STATE_DIR}/ESCALATED.cloud-sync"

# ─── helpers ────────────────────────────────────────────────────────────────

log() { echo "[health-responder ${RESPONDER_RUN_ID}] $*"; }

is_dry() { [[ "$DRY_RUN" == "1" ]]; }

# _mtime <file>: epoch mtime, macOS-first (on GNU/Linux `stat -f` means
# filesystem-stat, hence the ordering — same idiom as orphan-sweep.sh).
# _mtime FILE — epoch mtime, portable. GNU stat FAILS `-f %m` but still prints
# filesystem info to stdout before returning non-zero (Codex P2) — so the BSD
# attempt's output must be validated and DISCARDED on failure, never
# concatenated with the `-c` fallback's output.
_mtime() {
  local out
  if out="$(stat -f %m "$1" 2>/dev/null)" && [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
    return 0
  fi
  out="$(stat -c %Y "$1" 2>/dev/null)" || return 1
  [[ "$out" =~ ^[0-9]+$ ]] || return 1
  echo "$out"
}

# Fail-open telemetry (orphan-sweep idiom): missing binary = silent no-op, and
# a telemetry failure can never fail the responder.
emit_escalated() {
  command -v emit-otel-event.sh >/dev/null 2>&1 || return 0
  emit-otel-event.sh \
    --event "catalyst.responder.escalated" \
    --outcome fail \
    --session-id "$RESPONDER_RUN_ID" \
    --attr "target=cloud-sync" \
    --attr "conditions=${CONDITIONS_CSV}" \
    --attr "attempts=${ATTEMPTS}" \
    --attr "windowSecs=${RESPONDER_ATTEMPT_WINDOW_SECS}" >/dev/null 2>&1 || true
}

# ─── probes (each degrades independently; never aborts the run) ─────────────

# _writer_alive: is a cloud-sync.mjs process running? Basename match, not the
# full dir path — matches the writer and not the launcher (…/cloud-sync/
# launch.sh has no .mjs); mirrors doctor.mjs defaultCloudSyncProcessAlive.
# pgrep failing entirely (rc>1) degrades to "not alive" — a wrong kickstart is
# bounded by the attempt cap; a wrongly-skipped one would leave the writer down.
# Scoped to THIS user's launchd-shaped writer invocation (Codex P2): a bare
# `cloud-sync.mjs` pattern would match an editor (`vim cloud-sync.mjs`), a
# test, or another user's process and mask a genuinely dead supervised writer.
# The launch.sh contract is `exec bun .../execution-core/cloud-sync.mjs`, so
# match that shape, current uid only. (Resolving the exact launchd PID via
# `launchctl print` would put launchctl on the every-sweep detection path —
# deliberately avoided; detection stays passive.)
_writer_alive() { pgrep -U "$(id -u)" -f "bun .*execution-core/cloud-sync\.mjs" >/dev/null 2>&1; }

# _lock_age_secs: seconds since the writer.lock heartbeat, or "" when the lock
# is absent/unreadable. An ABSENT lock is NOT stale — it may mean guard
# disabled / writer never started / older SDK (doctor makes the same call), so
# stale-writer only fires on a PRESENT-but-old lock (the strong "SDK heartbeat
# died" signal; see replica-read.mjs isReplicaFresh).
_lock_age_secs() {
  local m
  m="$(_mtime "$WRITER_LOCK")" || return 0
  [[ "$m" =~ ^[0-9]+$ ]] || return 0
  echo $(( $(date +%s) - m ))
  return 0
}

# _probe_selfheal: parse the CTL-1508 breadcrumb once into two globals —
# SELFHEAL_VALID (1 iff the file exists, parses, and says expectRestart:true)
# and SELFHEAL_AGE (seconds). File-absent = the NORMAL case (CTL-1508 ships in
# parallel); absent/malformed/unparseable → VALID=0, mirroring
# fleet-freeze-alert.mjs hydrate(). Age comes from the breadcrumb's `ts` when
# numeric (epoch s or ms), else the file mtime — so a stale breadcrumb from a
# long-dead self-heal can never suppress detection.
#
# The age is consumed BOTH ways (adversarial-verify refinement):
#   age <= grace → SETTLING: the writer exited on purpose expecting a launchd
#     relaunch that may still be in flight — suppress dead-writer too, or the
#     responder's kickstart -k would race (and kill) a legitimately-settling
#     relaunch. The grace window exists precisely to give launchd that room.
#   age >  grace → the no-respawn condition (the relaunch never came).
_probe_selfheal() {
  SELFHEAL_VALID=0
  SELFHEAL_AGE=""
  [[ -f "$RESPONDER_SELFHEAL_FILE" ]] || return 0
  if ! command -v jq >/dev/null 2>&1; then
    # A breadcrumb EXISTS but can't be parsed — say so (Codex P2 adjacent: the
    # launchd plist now bakes a PATH that resolves homebrew jq, but if jq is
    # genuinely absent the settling hold + no-respawn detection are dark).
    log "WARN: jq not found on PATH — self-heal breadcrumb present but unreadable; settling hold + no-respawn detection disabled this sweep"
    return 0
  fi
  local expect ts now m
  expect="$(jq -r '.expectRestart // empty' "$RESPONDER_SELFHEAL_FILE" 2>/dev/null || true)"
  [[ "$expect" == "true" ]] || return 0
  now="$(date +%s)"
  ts="$(jq -r '.ts // empty' "$RESPONDER_SELFHEAL_FILE" 2>/dev/null || true)"
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    # Heuristic: >11 digits is epoch-ms (Date.now()); normalize to seconds.
    [[ "${#ts}" -gt 11 ]] && ts=$(( ts / 1000 ))
    SELFHEAL_AGE=$(( now - ts ))
  else
    m="$(_mtime "$RESPONDER_SELFHEAL_FILE")"
    [[ "$m" =~ ^[0-9]+$ ]] || return 0
    SELFHEAL_AGE=$(( now - m ))
  fi
  SELFHEAL_VALID=1
  return 0
}

# ─── attempt-cap markers (bounded-kickstart state, survives each short run) ──
#
# Timestamped marker files (attempt.<epoch>.<pid>) under RESPONDER_STATE_DIR,
# pruned past the window on every run — so a success "resets the counter for
# free" as time passes, the CTL-624 cool-down-marker idiom. File-backed (not
# in-memory) because every responder run is a fresh process by design.

_prune_attempts() {
  is_dry && return 0 # dry-run is read-only — stale markers are reported, never pruned
  local f ts now
  now="$(date +%s)"
  for f in "${RESPONDER_STATE_DIR}"/attempt.*; do
    [[ -e "$f" ]] || continue
    ts="${f##*/}"; ts="${ts#attempt.}"; ts="${ts%%.*}"
    # Unparseable marker name → remove it (it can only mis-count).
    [[ "$ts" =~ ^[0-9]+$ ]] || { rm -f "$f"; continue; }
    [[ $(( now - ts )) -gt "$RESPONDER_ATTEMPT_WINDOW_SECS" ]] && rm -f "$f"
  done
  return 0
}

_attempt_count() {
  local n=0 f
  for f in "${RESPONDER_STATE_DIR}"/attempt.*; do
    [[ -e "$f" ]] && n=$((n+1))
  done
  echo "$n"
}

# Returns non-zero when the marker cannot be written (unwritable state dir).
# The caller MUST treat that as cannot-count → cannot-kickstart — fail-SAFE:
# a responder that cannot enforce its own attempt cap must not act at all, or
# an unwritable dir would degrade into unbounded interval-paced kickstarts
# (the exact storm the cap exists to prevent; adversarial-verify caveat).
_record_attempt() {
  : > "${RESPONDER_STATE_DIR}/attempt.$(date +%s).$$" 2>/dev/null
}

_clear_markers() {
  rm -f "${RESPONDER_STATE_DIR}"/attempt.* "$ESCALATED_MARKER" 2>/dev/null || true
}

# ─── heartbeat (the one line every run must emit) ───────────────────────────
#
# Grep-stable contract: `heartbeat status=<S>` plus per-condition flags. Keep
# key=value tokens — Loki-side queries and the bash tests grep these literally.

heartbeat() {
  local status="$1"
  log "heartbeat status=${status} installed=${INSTALLED} alive=${ALIVE} dead_writer=${C_DEAD} stale_lock=${C_STALE} no_respawn=${C_NORESPAWN} attempts=${ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} escalated=${ESCALATED}"
}

# ─── kill-switch ────────────────────────────────────────────────────────────

if [[ "$RESPONDER_ENABLED" != "1" ]]; then
  # Still heartbeat (with zeroed probes) — a disabled responder must be
  # distinguishable from a dead one in the log.
  INSTALLED=0 ALIVE=0 C_DEAD=0 C_STALE=0 C_NORESPAWN=0 ATTEMPTS=0 ESCALATED=0
  heartbeat "disabled"
  exit 0
fi

# Dry-run is READ-ONLY end to end (adversarial-verify caveat): no state-dir
# creation, no marker mutation anywhere — the only dry-run output is log lines.
is_dry || mkdir -p "$RESPONDER_STATE_DIR" 2>/dev/null || true

# ─── detect ─────────────────────────────────────────────────────────────────

INSTALLED=0
[[ -f "$CLOUD_SYNC_PLIST" ]] && INSTALLED=1

ALIVE=0
_writer_alive && ALIVE=1

# Breadcrumb probe first — its grace window modulates the dead-writer
# condition below (SETTLING) and drives no-respawn.
_probe_selfheal
SETTLING=0
[[ "$SELFHEAL_VALID" -eq 1 && "$ALIVE" -eq 0 && "$SELFHEAL_AGE" -le "$RESPONDER_SELFHEAL_GRACE_SECS" ]] && SETTLING=1

# Condition 1: dead-writer. Installed-gated: a node without the cloud-sync
# agent (not on the replica tier) is simply not our patient — do nothing.
# SETTLING-gated: a fresh self-heal breadcrumb means the writer exited on
# purpose expecting a launchd relaunch — kicking now would race/kill it, so
# hold for the grace window (the relaunch either lands, clearing this, or the
# breadcrumb ages into the no-respawn condition).
C_DEAD=0
[[ "$INSTALLED" -eq 1 && "$ALIVE" -eq 0 && "$SETTLING" -eq 0 ]] && C_DEAD=1

# Condition 2: stale-writer (process up, SDK heartbeat dead). Installed-gated
# like the other two (Codex P2): a leftover manual/orphaned matching process
# plus an old lock on a node whose plist was removed must not kickstart an
# unloaded label round after round into a false escalation.
C_STALE=0
if [[ "$INSTALLED" -eq 1 && "$ALIVE" -eq 1 ]]; then
  _LOCK_AGE="$(_lock_age_secs)"
  if [[ -n "$_LOCK_AGE" && "$_LOCK_AGE" -gt "$RESPONDER_LOCK_STALE_SECS" ]]; then
    C_STALE=1
    log "stale-writer: writer.lock heartbeat ${_LOCK_AGE}s old (> ${RESPONDER_LOCK_STALE_SECS}s) — process alive but SDK heartbeat dead"
  fi
fi

# Condition 3: no-respawn after an intentional self-heal exit (CTL-1508).
# Installed-gated like dead-writer (adversarial-verify caveat): a stale
# breadcrumb on a node whose cloud-sync agent was since uninstalled must not
# yield no-op kickstarts + a false escalation — no plist, not our patient.
C_NORESPAWN=0
if [[ "$INSTALLED" -eq 1 && "$ALIVE" -eq 0 && "$SELFHEAL_VALID" -eq 1 && "$SELFHEAL_AGE" -gt "$RESPONDER_SELFHEAL_GRACE_SECS" ]]; then
  C_NORESPAWN=1
  log "no-respawn: self-heal breadcrumb expectRestart=true but no writer came back within ${RESPONDER_SELFHEAL_GRACE_SECS}s"
fi

CONDITION=0
CONDITIONS_CSV=""
[[ "$C_DEAD" -eq 1 ]] && { CONDITION=1; CONDITIONS_CSV="${CONDITIONS_CSV}dead-writer,"; }
[[ "$C_STALE" -eq 1 ]] && { CONDITION=1; CONDITIONS_CSV="${CONDITIONS_CSV}stale-writer,"; }
[[ "$C_NORESPAWN" -eq 1 ]] && { CONDITION=1; CONDITIONS_CSV="${CONDITIONS_CSV}no-respawn,"; }
CONDITIONS_CSV="${CONDITIONS_CSV%,}"

ESCALATED=0
[[ -f "$ESCALATED_MARKER" ]] && ESCALATED=1

_prune_attempts
ATTEMPTS="$(_attempt_count)"

# ─── act ────────────────────────────────────────────────────────────────────

if [[ "$CONDITION" -eq 0 ]]; then
  # Healthy. If we had escalated, the condition clearing re-arms the responder:
  # drop the ESCALATED marker + attempt files so a future incident gets a
  # fresh bounded-attempt budget.
  # Re-arm ONLY on a genuinely healthy probe — settling is NOT health (Codex
  # P1): a crash-looping writer that starts, drops a fresh breadcrumb, and dies
  # again would otherwise clear its own attempt budget every loop, converting
  # the hourly cap into unlimited kickstart batches that never escalate.
  if [[ "$SETTLING" -eq 0 && ( "$ESCALATED" -eq 1 || "$ATTEMPTS" -gt 0 ) ]]; then
    if is_dry; then
      log "[dry-run] would re-arm: clear ${ATTEMPTS} attempt marker(s) + escalated=${ESCALATED} marker"
    else
      _clear_markers
      [[ "$ESCALATED" -eq 1 ]] && log "condition cleared — re-armed (ESCALATED marker + attempt markers removed)"
      ESCALATED=0
      ATTEMPTS=0
    fi
  fi
  if [[ "$SETTLING" -eq 1 ]]; then
    log "settling: self-heal breadcrumb is ${SELFHEAL_AGE}s old (grace ${RESPONDER_SELFHEAL_GRACE_SECS}s) — holding for the expected launchd relaunch"
    heartbeat "settling"
  else
    heartbeat "healthy"
  fi
  exit 0
fi

log "condition active: ${CONDITIONS_CSV}"

if [[ "$ESCALATED" -eq 1 ]]; then
  # Already escalated and the condition persists: hold. The one-shot marker is
  # exactly what prevents a kickstart/escalation storm — a human (or the
  # condition clearing) re-arms us, nothing else.
  heartbeat "escalated"
  exit 0
fi

if [[ "$ATTEMPTS" -ge "$RESPONDER_MAX_ATTEMPTS" ]]; then
  # Cap exhausted and the writer is STILL down — bounded response is over.
  # ERROR-severity line (Alloy ships this log to Loki) + fail-open OTel event,
  # then the one-shot marker so we never re-emit or keep kickstarting.
  if is_dry; then
    log "[dry-run] would escalate: ${ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} kickstarts in ${RESPONDER_ATTEMPT_WINDOW_SECS}s did not clear ${CONDITIONS_CSV}"
    heartbeat "dry-run"
    exit 0
  fi
  if : > "$ESCALATED_MARKER" 2>/dev/null; then
    ESCALATED=1
    emit_escalated
  else
    # One-shot guard unwritable → skip the OTel emit (it would re-fire every
    # sweep); the ERROR log line below still ships via Alloy on each sweep, so
    # the escalation stays visible without becoming an event storm.
    ESCALATED=1
    log "ERROR: cannot write ESCALATED marker under ${RESPONDER_STATE_DIR} — skipping the one-shot OTel emit; fix permissions"
  fi
  log "ERROR: escalated — ${CONDITIONS_CSV} persists after ${ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} kickstarts in ${RESPONDER_ATTEMPT_WINDOW_SECS}s; kickstarting stopped until the condition clears (check ~/catalyst/cloud-sync.log)"
  heartbeat "escalated"
  exit 0
fi

if is_dry; then
  log "[dry-run] would kickstart gui/$(id -u)/${CLOUD_SYNC_LABEL} (${CONDITIONS_CSV})"
  heartbeat "dry-run"
  exit 0
fi

# Bounded kickstart. Record the attempt FIRST so a hung/failed launchctl still
# counts toward the cap (never crash-loop launchctl). kickstart -k kills any
# wedged instance and relaunches; on an unloaded label it fails harmlessly —
# logged, counted, and the cap eventually escalates to a human.
if ! _record_attempt; then
  # Fail-SAFE (unbounded-restart guard): if the attempt cannot be counted the
  # cap cannot bound us — refuse to act, and say so loudly on every sweep.
  log "ERROR: cannot write attempt marker under ${RESPONDER_STATE_DIR} — refusing to kickstart (attempt cap unenforceable); fix permissions"
  heartbeat "degraded"
  exit 0
fi
ATTEMPTS=$((ATTEMPTS+1))
# Bound the launchctl call itself (Codex P1): a hung kickstart — the very
# wedge class this responder exists to break — must not turn the short-lived
# sweep into a silently wedged watcher of its own (launchd will not start the
# next StartInterval run while this one is alive). Background + deadline; no
# `timeout` binary exists on stock macOS.
_KICK_OUT="$(mktemp "${TMPDIR:-/tmp}/responder-kick.XXXXXX")"
launchctl kickstart -k "gui/$(id -u)/${CLOUD_SYNC_LABEL}" > "$_KICK_OUT" 2>&1 &
_KPID=$!
_KRC=""
for (( _i = 0; _i < RESPONDER_KICKSTART_TIMEOUT_SECS; _i++ )); do
  if ! kill -0 "$_KPID" 2>/dev/null; then
    wait "$_KPID"
    _KRC=$?
    break
  fi
  sleep 1
done
if [[ -z "$_KRC" ]]; then
  kill -9 "$_KPID" 2>/dev/null || true
  wait "$_KPID" 2>/dev/null || true
  log "kickstart TIMED OUT after ${RESPONDER_KICKSTART_TIMEOUT_SECS}s for gui/$(id -u)/${CLOUD_SYNC_LABEL} (attempt ${ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} still counted)"
elif [[ "$_KRC" -eq 0 ]]; then
  sed 's/^/  /' "$_KICK_OUT"
  log "kickstarted gui/$(id -u)/${CLOUD_SYNC_LABEL} (attempt ${ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS})"
else
  sed 's/^/  /' "$_KICK_OUT"
  log "kickstart FAILED for gui/$(id -u)/${CLOUD_SYNC_LABEL} — label not loaded? (attempt ${ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} still counted)"
fi
rm -f "$_KICK_OUT"

# Settle, then re-probe so the log says whether the kickstart actually worked.
[[ "$RESPONDER_KICKSTART_WAIT_SECS" -gt 0 ]] && sleep "$RESPONDER_KICKSTART_WAIT_SECS"
if _writer_alive; then
  ALIVE=1
  # For a stale-writer incident the process was alive BEFORE the kickstart, so
  # a process-only probe would always report "recovered" — even if launchctl
  # failed and left the old wedged instance running (Codex P2). Recovery from
  # a stale lock means the SDK heartbeat RESUMED: re-evaluate the lock (a
  # restarted writer rewrites it ~5s; the settle wait covers that).
  _NEW_LOCK_AGE="$(_lock_age_secs)"
  if [[ "$C_STALE" -eq 1 && -n "$_NEW_LOCK_AGE" && "$_NEW_LOCK_AGE" -gt "$RESPONDER_LOCK_STALE_SECS" ]]; then
    log "still-down: process is back but writer.lock heartbeat is still ${_NEW_LOCK_AGE}s stale after kickstart + ${RESPONDER_KICKSTART_WAIT_SECS}s"
    heartbeat "still-down"
  else
    log "recovered: cloud-sync.mjs is back after kickstart"
    heartbeat "recovered"
  fi
else
  log "still-down: no cloud-sync.mjs after kickstart + ${RESPONDER_KICKSTART_WAIT_SECS}s"
  heartbeat "still-down"
fi
exit 0
