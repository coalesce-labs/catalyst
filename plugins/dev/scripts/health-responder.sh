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
# A SECOND supervised target rides the same sweep (CTL-1518): the
# com.catalyst.agent host-metrics sampler (it died on mini-2 and launchd left it
# dead for 10 days). Its block runs BEFORE the cloud-sync detect — the cloud-sync
# act path `exit 0`s at several points, so a block after it is unreachable — and
# is fully inert on nodes without the agent plist. Staleness is the age of the
# agent's breadcrumb (~/catalyst/catalyst-agent.heartbeat, refreshed each --once
# tick), falling back to the plist install-mtime when the breadcrumb is absent.
# Same bounded-kickstart + one-shot-escalation + re-arm contract, with its OWN
# agent-scoped markers / heartbeat line / OTel escalate.
#
# Env overrides (all have production defaults):
#   RESPONDER_ENABLED              — kill-switch, default 1 (0 = heartbeat-only no-op)
#   RESPONDER_AGENT_ENABLED        — agent sub-kill-switch, default 1 (0 = agent block off)
#   RESPONDER_AGENT_STALE_SECS     — agent breadcrumb/plist staleness threshold, default 900
#   RESPONDER_LOCK_STALE_SECS      — stale-writer threshold, default 900 (15 min)
#   RESPONDER_SELFHEAL_GRACE_SECS  — no-respawn grace after breadcrumb ts, default 120
#   RESPONDER_MAX_ATTEMPTS         — kickstarts per window before escalating, default 3
#   RESPONDER_ATTEMPT_WINDOW_SECS  — attempt-cap window, default 3600 (1 h)
#   RESPONDER_KICKSTART_WAIT_SECS  — post-kickstart settle before re-probe, default 10
#   RESPONDER_STATE_DIR            — marker dir, default ~/catalyst/.health-responder
#   RESPONDER_SELFHEAL_FILE        — breadcrumb path, default ~/catalyst/cloud-sync.selfheal.json
#   RESPONDER_TOKEN_FILE           — cloud-sync token file whose presence turns an
#                                    exit-0 down writer from "idle by design" into
#                                    the failed-bounce fault (CTL-1510 item 0),
#                                    default ~/.config/catalyst/cloud-sync.env
#   RESPONDER_SWEEP_LOCK_STALE_SECS — crashed-sweep lock breaker age, default 300
#   RESPONDER_DRY_RUN              — set to 1 or use --dry-run flag
#   RESPONDER_RUN_ID               — default: timestamp-based (set in tests for determinism)
#   CATALYST_REPLICA_DB            — replica db path (lock = <db>.writer.lock),
#                                    default ~/catalyst/catalyst-replica.db
#                                    (mirrors execution-core/config.mjs getReplicaDbPath)
#   CATALYST_LAUNCHAGENTS_DIR      — default ~/Library/LaunchAgents (mirrors doctor.mjs)

set -uo pipefail
# Ignore SIGPIPE (CTL-1510 item 5 hardening): a caller piping this script
# through `grep -q`/`head` (as this suite's own tests do, and as an operator
# debugging by hand might) closes its end of the pipe as soon as it matches —
# the NEXT `echo`/`log` write then raises SIGPIPE. Bash's default SIGPIPE
# disposition kills the process immediately on an uncaught write signal,
# which skips the sweep-lock-release EXIT trap entirely (confirmed live: the
# lock survived across three piped invocations in a row). Writes already
# don't check their return status, so a silently-failed write to a closed
# pipe is exactly as harmless as before — the difference is the process now
# always reaches its EXIT trap and releases the lock.
trap '' PIPE

# Resolve script dir so sibling scripts (emit-otel-event.sh) are found. APPEND
# to PATH so a test's prepended mock bin still wins (orphan-sweep.sh idiom).
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC
export PATH="${PATH}:${SCRIPT_DIR}"

# CTL-1616 PR5: the secret-contract bash mirror — sourced here (once, at script load, NOT
# inside the bounded token-resolution path) so _token_provisioned's pure-bash fallback ladder
# (below) can call catalyst_secret_cloud_token_name instead of hand-rolling its own jq-based
# ladder. SAFE to source unconditionally: the file is pure function/array definitions at
# source time (idempotent-load-guarded, no subprocess/network/jq call happens until a function
# is actually invoked) — it cannot itself hang or wedge the sweep the way an unbounded `bun`
# subprocess could (see _resolve_token_env_via_bun's own bounding below).
# shellcheck source=lib/catalyst-secret-contract.sh
source "${SCRIPT_DIR}/lib/catalyst-secret-contract.sh"

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

# Validate every numeric knob through ONE helper, in the ONLY safe order
# (Codex rounds 2-4): digits-regex first (garbage → default; a bare [[ -gt ]]
# on a non-numeric would die as a set -u unbound-variable before the
# heartbeat), then $((10#…)) base-10 normalization (a zero-padded "08" is
# OCTAL to bash arithmetic — comparing BEFORE normalizing both octal-errors
# AND silently swaps a valid override for the default), and only then the
# range floor (a zero/negative window would prune every marker each sweep,
# pinning the counter at 1 and kickstarting forever).
_num() { # _num VALUE DEFAULT MIN — echoes the validated base-10 value
  local v="$1" d="$2" min="$3"
  [[ "$v" =~ ^[0-9]+$ ]] || { echo "$d"; return 0; }
  v=$((10#$v))
  (( v >= min )) || { echo "$d"; return 0; }
  echo "$v"
}
RESPONDER_ATTEMPT_WINDOW_SECS="$(_num "$RESPONDER_ATTEMPT_WINDOW_SECS" 3600 1)"
RESPONDER_MAX_ATTEMPTS="$(_num "$RESPONDER_MAX_ATTEMPTS" 3 0)"
RESPONDER_KICKSTART_WAIT_SECS="$(_num "$RESPONDER_KICKSTART_WAIT_SECS" 10 0)"
RESPONDER_KICKSTART_TIMEOUT_SECS="$(_num "$RESPONDER_KICKSTART_TIMEOUT_SECS" 20 1)"
RESPONDER_LOCK_STALE_SECS="$(_num "$RESPONDER_LOCK_STALE_SECS" 900 1)"
RESPONDER_SELFHEAL_GRACE_SECS="$(_num "$RESPONDER_SELFHEAL_GRACE_SECS" 120 0)"
# Second-target (com.catalyst.agent) knobs (CTL-1518). ENABLED is a string
# compare; STALE_SECS goes through the same validate-then-floor helper as the
# other thresholds so garbage/zero-padded overrides degrade to the default.
RESPONDER_AGENT_ENABLED="${RESPONDER_AGENT_ENABLED:-1}"
RESPONDER_AGENT_STALE_SECS="$(_num "${RESPONDER_AGENT_STALE_SECS:-900}" 900 1)"
# Deadline for the `launchctl list` intentional-exit probe (Codex P2 round 4:
# the same hung-launchctl class the kickstart deadline guards against).
RESPONDER_LIST_TIMEOUT_SECS="$(_num "${RESPONDER_LIST_TIMEOUT_SECS:-5}" 5 1)"
# Deadline for the token-name-resolution `bun` subprocess (Codex P2 round 5:
# same hung-subprocess class — see _resolve_token_env_via_bun).
RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS="$(_num "${RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS:-5}" 5 1)"
# Whole-sweep reservation staleness (CTL-1510 item 5): a lock older than this
# belongs to a crashed sweep and is broken. Floored BELOW at the worst-case
# legitimate sweep duration (every bounded-subprocess timeout this sweep can
# spend waiting on — list, TOKEN RESOLUTION, kickstart, kickstart-wait — round
# 6 added the token-resolve term, previously missing) + slop (Codex P2: the
# wait/timeout knobs have no upper bounds, so a configured stale threshold
# under a legitimate sweep's runtime would let the next invocation break a
# LIVE lock and reintroduce the concurrent-kickstart race this lock exists to
# close).
RESPONDER_SWEEP_LOCK_STALE_SECS="$(_num "${RESPONDER_SWEEP_LOCK_STALE_SECS:-300}" 300 1)"
# CTL-1518 widened the floor to cover BOTH kickstart budgets: a single sweep can
# now kickstart the agent (its block reuses RESPONDER_KICKSTART_TIMEOUT/WAIT_SECS)
# AND the cloud-sync writer, so the worst-case legitimate sweep spends the
# kickstart timeout+wait TWICE — the second `+ RESPONDER_KICKSTART_TIMEOUT_SECS +
# RESPONDER_KICKSTART_WAIT_SECS` term. Without it the stale-lock breaker could
# break a still-live two-target sweep and reintroduce the concurrent-kickstart
# race the sweep lock exists to close. (The first three terms are unchanged, so
# the token-resolve-floor invariant test still matches.)
_SWEEP_MIN_STALE=$(( RESPONDER_LIST_TIMEOUT_SECS + RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS + RESPONDER_KICKSTART_TIMEOUT_SECS + RESPONDER_KICKSTART_WAIT_SECS + RESPONDER_KICKSTART_TIMEOUT_SECS + RESPONDER_KICKSTART_WAIT_SECS + 60 ))
(( RESPONDER_SWEEP_LOCK_STALE_SECS < _SWEEP_MIN_STALE )) && RESPONDER_SWEEP_LOCK_STALE_SECS="$_SWEEP_MIN_STALE"
RESPONDER_RUN_ID="${RESPONDER_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
# Resolve every state/target path through CATALYST_DIR exactly like the
# writer's config.mjs catalystDir() (Codex P1 round 3): a node using the
# supported CATALYST_DIR override moves the replica db, lock, breadcrumb, and
# responder state together — a $HOME/catalyst hardcode here would blind the
# responder to the real lock AND let a leftover default-path lock trigger
# false restarts.
CATALYST_DIR="${CATALYST_DIR:-${HOME}/catalyst}"
RESPONDER_STATE_DIR="${RESPONDER_STATE_DIR:-${CATALYST_DIR}/.health-responder}"
RESPONDER_SELFHEAL_FILE="${RESPONDER_SELFHEAL_FILE:-${CATALYST_DIR}/cloud-sync.selfheal.json}"

# Target: the supervised cloud-sync replica writer. Label + plist dir + replica
# db path all mirror doctor.mjs checkCloudSync / config.mjs getReplicaDbPath so
# the responder and the doctor can never disagree about WHERE to look.
CLOUD_SYNC_LABEL="ai.coalesce.catalyst-cloud-sync"
CLOUD_SYNC_PLIST="${CATALYST_LAUNCHAGENTS_DIR:-${HOME}/Library/LaunchAgents}/${CLOUD_SYNC_LABEL}.plist"
REPLICA_DB="${CATALYST_REPLICA_DB:-${CATALYST_DIR}/catalyst-replica.db}"
WRITER_LOCK="${REPLICA_DB}.writer.lock"
ESCALATED_MARKER="${RESPONDER_STATE_DIR}/ESCALATED.cloud-sync"

# Second supervised target (CTL-1518): the com.catalyst.agent host-metrics
# sampler. Its plist lives in the SAME LaunchAgents dir as cloud-sync's; its
# breadcrumb is written by catalyst-agent.mjs each --once tick, CATALYST_DIR-
# resolved exactly like config.mjs getHeartbeatPath() so the two never disagree
# about WHERE to look. AGENT_HEARTBEAT_FILE is overridable so tests can redirect
# it into scratch. Agent markers use their own agent-attempt.* / ESCALATED.
# catalyst-agent namespace — never sharing a budget with the cloud-sync markers.
AGENT_LABEL="com.catalyst.agent"
AGENT_PLIST="${CATALYST_LAUNCHAGENTS_DIR:-${HOME}/Library/LaunchAgents}/${AGENT_LABEL}.plist"
AGENT_HEARTBEAT_FILE="${AGENT_HEARTBEAT_FILE:-${CATALYST_DIR}/catalyst-agent.heartbeat}"
AGENT_ESCALATED_MARKER="${RESPONDER_STATE_DIR}/ESCALATED.catalyst-agent"
# The operator-provisioned token files the cloud-sync launcher sources
# (cloud-sync/launch.sh sources BOTH, in this order: cluster.env — the CTL-1307
# shared-token projection — then the dedicated cloud-sync.env; Codex P1).
# Presence of EITHER discriminates the two exit-0 flows for the
# intentional-exit gate (CTL-1510 item 0): tokenless idle no-op (both absent —
# genuinely idle by design) vs a failed bounce (a token source present —
# adopt's bootout SIGTERM'd the writer to exit 0 but the bootstrap relaunch
# never stuck, the live mini-2 incident). NOTE the deliberate trade-off: a
# manual SIGTERM stop on a token-bearing node now gets kickstarted — an
# operator who wants the writer to STAY down must use the RESPONDER_ENABLED=0
# kill-switch (or uninstall); the attempt cap bounds the disagreement either way.
RESPONDER_TOKEN_FILE="${RESPONDER_TOKEN_FILE:-${HOME}/.config/catalyst/cloud-sync.env}"
RESPONDER_CLUSTER_ENV_FILE="${RESPONDER_CLUSTER_ENV_FILE:-${HOME}/.config/catalyst/cluster.env}"

# _token_provisioned: true iff the RESOLVED cloud-sync token variable is
# actually non-empty after sourcing both launcher-sourced files — NOT merely
# whether a token file is readable (Codex P1 round 3: an adopted-but-not-yet-
# provisioned node's cloud-sync.env can exist and be readable while EMPTY —
# exactly the tokenless-idle case CTL-1509 was designed around. Treating file
# presence as token presence would kickstart a genuinely idle writer into a
# false-escalation storm). Mirrors catalyst-stack's install-time token probe
# byte-for-byte: source both files in a subshell matching launch.sh's view,
# resolve the env-var NAME via the same config.mjs helper (falls back to the
# secret-contract bash mirror's catalyst_secret_cloud_token_name if bun is
# unavailable — CTL-1616 PR5), then check presence of THAT resolved name —
# never a fixed/guessed variable name.
# _resolve_token_env_via_bun: prints the resolved env-var NAME from
# resolveNodeCloudTokenEnv() — which is itself now a thin delegate over
# lib/secret-contract.mjs's resolveCloudTokenName (CTL-1616 PR5) — or prints
# nothing on timeout/failure/absence.
# Bounded the same way _last_exit_status bounds `launchctl list` (Codex P2
# round 5): this runs INSIDE _token_provisioned, which runs AFTER the sweep
# lock is acquired — an unbounded bun call there would let a wedged bun or
# module import hold the lock indefinitely, defeating the "short-lived
# process, cannot zombie" guarantee this whole responder exists to provide.
# CFG_DIR is exported (not just set) so the backgrounded subshell — a
# separate process — inherits it; a plain assignment before `(` is NOT
# exported to that child.
_resolve_token_env_via_bun() {
  local out="" f pid rc=""
  f="$(mktemp "${TMPDIR:-/tmp}/responder-tokenname.XXXXXX")"
  # Background bun DIRECTLY (a leading VAR=val prefix scopes CFG_DIR to just
  # this command) rather than wrapping it in a `( ... ) &` subshell — a
  # subshell wrapper would make $! the WRAPPER's pid, and killing that on
  # timeout leaves the actual hung bun process orphaned rather than reaped
  # (found live while testing this fix). Mirrors _last_exit_status's own
  # backgrounding shape exactly for the same reason.
  CFG_DIR="${SCRIPT_DIR}/execution-core" bun -e '
    const m = await import(process.env.CFG_DIR + "/config.mjs");
    process.stdout.write(m.resolveNodeCloudTokenEnv().envVar);
  ' > "$f" 2>/dev/null &
  pid=$!
  for (( _tri = 0; _tri < RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS; _tri++ )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      rc=$?
      break
    fi
    sleep 1
  done
  if [[ -z "$rc" ]]; then
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  elif [[ "$rc" -eq 0 ]]; then
    out="$(cat "$f" 2>/dev/null)"
  fi
  rm -f "$f"
  printf '%s' "$out"
}

# _token_provisioned's env-isolation subshell below must stay COMMENT-FREE
# inside the `probe="$( ... )"` body (CTL-1510 hotfix, found live on mini-2):
# bash 3.2 — the ACTUAL interpreter macOS launchd/cron invoke via the
# plist's/cron line's hardcoded /bin/bash, never caught by this repo's own
# test suite because `bash script.sh` there resolves through `env` to a
# newer Homebrew bash — has a parser defect where multi-line comments
# containing an unbalanced paren or a stray quote/colon INSIDE a `$(...)`
# command substitution corrupt its paren-matching. The visible symptom is
# bizarre and misleading: a `set -u` "unbound variable" (or "bad
# substitution") error for a variable that IS assigned, at a REPORTED line
# number that is often a comment line nowhere near the real one. Reproduced
# 100% with the original heavily-commented version of this function and
# vanished completely once every comment moved outside the substitution,
# confirmed under the real system bash (`/bin/bash`, not `env bash`). This is
# the ONLY multi-statement `="$(...)"` capture in this file — keep the code
# inside it, keep everything else out.
#
# Behavior: unsets CATALYST_CLOUD_TOKEN_ENV so an override can only come from
# the sourced files (not an ambient value); does NOT unset
# CATALYST_LAYER2_CONFIG_FILE (unlike catalyst-stack's install-time probe,
# which strips both to simulate launchd's clean env from an interactive
# shell) since this responder has no different context to simulate and both
# the bun path and the bash fallback below need to see a real override.
# _resolve_token_env_via_bun returning empty means bun was unavailable or its
# import failed; the fallback then calls catalyst_secret_cloud_token_name
# (lib/catalyst-secret-contract.sh, sourced at script load above) — the SAME
# registry row's bash mirror, not a hand-duplicated ladder — which resolves
# the identical env-override / Layer-2 catalyst.cloud.tokenEnv / default
# precedence in pure bash (design §9 PR5: "both cloud-token readers agree
# byte-for-byte on the resolved env-var name"). Sourcing that lib is cheap
# (function/array definitions only — no subprocess/network at load time; see
# the `source` comment above), so this fallback still never blocks on
# anything heavier than the same jq call the OLD hand-rolled ladder already
# made.
_token_provisioned() {
  local probe
  probe="$(
    set +u
    unset CATALYST_CLOUD_TOKEN_ENV 2>/dev/null || true
    [[ -r "$RESPONDER_CLUSTER_ENV_FILE" ]] && . "$RESPONDER_CLUSTER_ENV_FILE"
    [[ -r "$RESPONDER_TOKEN_FILE" ]] && . "$RESPONDER_TOKEN_FILE"
    name="$(_resolve_token_env_via_bun)"
    if [[ -z "$name" ]]; then
      catalyst_secret_cloud_token_name cloud-token >/dev/null
      name="$CATALYST_SECRET_TOKEN_NAME"
      echo "[health-responder] token-env resolved via bash-fallback: ${name}" >&2
    else
      echo "[health-responder] token-env resolved via bun: ${name}" >&2
    fi
    [[ -n "${!name:-}" ]] && printf yes || printf no
  )"
  [[ "$probe" == "yes" ]]
}

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
# _last_exit_status: LastExitStatus from `launchctl list <label>` ("" when the
# job is unknown, the output unparseable, or the probe TIMES OUT). Used ONLY
# inside the already-anomalous installed-but-not-running branch — passive
# every-sweep detection stays launchctl-free by design (see _writer_alive).
# Bounded like the kickstart call (Codex P2 round 4): a hung launchctl here
# would otherwise wedge the sweep before its heartbeat, and launchd won't
# start the next StartInterval run while this one lives. "" on timeout means
# the caller treats the writer as dead (recovery is never lost to a hang).
_last_exit_status() {
  local f pid rc="" i out=""
  f="$(mktemp "${TMPDIR:-/tmp}/responder-lelist.XXXXXX")"
  launchctl list "$CLOUD_SYNC_LABEL" > "$f" 2>/dev/null &
  pid=$!
  for (( i = 0; i < RESPONDER_LIST_TIMEOUT_SECS; i++ )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      rc=$?
      break
    fi
    sleep 1
  done
  # One post-loop recheck (Codex round 5): a probe that finishes DURING the
  # final sleep would otherwise be discarded as a timeout — and a discarded
  # LastExitStatus=0 means kickstarting an intentionally idle writer.
  if [[ -z "$rc" ]] && ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null
    rc=$?
  fi
  if [[ -z "$rc" ]]; then
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    # stderr, NOT stdout: this function runs inside $(…) — a stdout log line
    # would be captured into the caller's _LE instead of reaching the console.
    # The plist routes stderr to the same health-responder.log.
    log "WARN: launchctl list timed out after ${RESPONDER_LIST_TIMEOUT_SECS}s — treating the writer as dead (recovery over politeness)" >&2
  else
    out="$(sed -n 's/.*"LastExitStatus" *= *\(-\{0,1\}[0-9][0-9]*\).*/\1/p' "$f" | head -1)"
  fi
  rm -f "$f"
  printf '%s' "$out"
}

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
  # A FUTURE timestamp (clock skew / corrupt-but-numeric ts) would make the
  # age negative — permanently "within grace", holding a dead writer in
  # settling with all recovery suppressed until wall time catches up
  # (Codex round 5). Treat it as invalid instead: dead-writer recovery applies.
  if (( SELFHEAL_AGE < 0 )); then
    log "WARN: self-heal breadcrumb timestamp is in the future (age ${SELFHEAL_AGE}s) — treating the breadcrumb as invalid"
    SELFHEAL_AGE=""
    return 0
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

# Sets PRUNE_DEGRADED=1 when an expired/unparseable marker SURVIVES its rm
# (state dir went read-only): those markers keep counting toward the cap, so
# escalation could fire outside the configured window on phantom attempts.
# The consumers degrade explicitly (CTL-1510 item 4) instead of acting on the
# unreliable count — same contract as the _record_attempt / _clear_markers
# failure paths.
_prune_attempts() {
  is_dry && return 0 # dry-run is read-only — stale markers are reported, never pruned
  local f ts now
  now="$(date +%s)"
  for f in "${RESPONDER_STATE_DIR}"/attempt.*; do
    [[ -e "$f" ]] || continue
    ts="${f##*/}"; ts="${ts#attempt.}"; ts="${ts%%.*}"
    # Unparseable marker name → remove it (it can only mis-count).
    if [[ ! "$ts" =~ ^[0-9]+$ ]]; then
      rm -f "$f" 2>/dev/null
      [[ -e "$f" ]] && PRUNE_DEGRADED=1
      continue
    fi
    if [[ $(( now - ts )) -gt "$RESPONDER_ATTEMPT_WINDOW_SECS" ]]; then
      rm -f "$f" 2>/dev/null
      [[ -e "$f" ]] && PRUNE_DEGRADED=1
    fi
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

# Returns non-zero when any marker SURVIVES the rm (state dir went read-only):
# the caller must NOT report "re-armed" while the durable ESCALATED marker
# still exists on disk, or the next incident silently enters the escalated
# hold with zero recovery attempts while the log claims a clean slate
# (Codex P2 round 3).
_clear_markers() {
  rm -f "${RESPONDER_STATE_DIR}"/attempt.* "$ESCALATED_MARKER" 2>/dev/null || true
  [[ -e "$ESCALATED_MARKER" ]] && return 1
  local f
  for f in "${RESPONDER_STATE_DIR}"/attempt.*; do
    [[ -e "$f" ]] && return 1
  done
  return 0
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

# ─── whole-sweep reservation (CTL-1510 item 5) ──────────────────────────────
#
# Two overlapping sweeps (manual + scheduled, or launchd + the cron backstop)
# could both read attempts=N-1 and both kickstart (cap+1). One atomic mkdir
# closes the window: the sweep that gets the lock dir runs; a contender
# heartbeats "skipped" and exits (the heartbeat-always contract holds — a
# skipped sweep is visible, not silent). A lock older than
# RESPONDER_SWEEP_LOCK_STALE_SECS belongs to a crashed sweep and is broken.
# Degrades gracefully (adversarial caveat): a read-only state dir means mkdir
# fails with NO dir present — proceed UNLOCKED (the TOCTOU window returns, but
# a responder that cannot write state refuses to act anyway via
# _record_attempt, so the regression is bounded to dry-run-like probing).
SWEEP_LOCK_DIR="${RESPONDER_STATE_DIR}/sweep.lock"
SWEEP_LOCK_HELD=0
# Ownership token (Codex P2): the EXIT trap must only release a lock THIS
# process acquired — after a stale-break + re-acquire by a newer sweep, the
# old process's trap would otherwise rmdir the REPLACEMENT's live lock.
SWEEP_LOCK_TOKEN="${RESPONDER_RUN_ID}.$$"
_acquire_sweep_lock() {
  mkdir "$SWEEP_LOCK_DIR" 2>/dev/null || return 1
  # Owner file write can fail on a weird dir — the lock still holds; the trap
  # then just leaves it for the stale-breaker (bounded, never wrong-owner rm).
  printf '%s' "$SWEEP_LOCK_TOKEN" > "${SWEEP_LOCK_DIR}/owner" 2>/dev/null || true
  SWEEP_LOCK_HELD=1
  return 0
}
# _claim_stale_lock: atomically take EXCLUSIVE ownership of whatever is
# CURRENTLY at SWEEP_LOCK_DIR and verify — on the claimed, uniquely-owned
# copy — that it was actually stale, rather than checking staleness on the
# live path and acting on it afterward (Codex P2 round 3: a check-then-act
# split has a window between the two steps in which a DIFFERENT contender can
# already have broken and recreated a fresh lock at the same path; the first
# contender's stale-age check, performed before that happened, would then
# still pass, and its `mv` of the NOW-fresh directory would succeed — same
# path, different underlying instance — destroying the second contender's
# live lock). Claim-then-verify closes this: `mv` is atomic (only one
# concurrent claim of a given directory INSTANCE can succeed; every other
# claim of that same instance fails with ENOENT), and `mv` preserves mtime
# exactly, so the claimed copy's age is the SAME instance's age — never a
# newer one swapped in mid-check. A claim that turns out NOT to be stale
# (mtime says it's live) is put back for its rightful owner; if the put-back
# itself loses a race (someone else already grabbed the now-empty path), the
# claimed copy is simply discarded — either way this process falls through to
# ordinary contention, never leaves TWO directories on disk.
# _age_secs_or_stale MTIME: age in seconds since MTIME, but a NEGATIVE age
# (future timestamp — clock stepped backward, or the state dir restored from
# a newer snapshot, Codex P2 round 5) is clamped to just above the stale
# threshold instead of blocking forever. Without this, a signed age check
# NEVER exceeds any positive threshold once pre_m is in the future, so every
# launchd/cron invocation exits status=skipped until wall time catches up —
# potentially disabling writer recovery for hours or days. Mirrors the
# breadcrumb's own future-timestamp handling (T48): favor recovery over
# indefinitely trusting an untrustworthy clock read.
_age_secs_or_stale() {
  local mtime="$1" age
  age=$(( $(date +%s) - mtime ))
  if (( age < 0 )); then
    echo $(( RESPONDER_SWEEP_LOCK_STALE_SECS + 1 ))
  else
    echo "$age"
  fi
}

_claim_stale_lock() {
  # Read-only pre-check FIRST (Codex P2 round 4 — a regression in THIS round's
  # earlier shape): unconditionally attempting the claim on ANY existing lock
  # (stale or not) creates a vacancy window on EVERY contention, not just
  # genuinely stale ones — a second contender could rename a THIRD's
  # brand-new fresh lock away just to inspect it, and while restoring it, a
  # fourth contender's ordinary mkdir grabs the momentarily-vacant canonical
  # path. Gating on a cheap, non-destructive mtime read first means this
  # process only ever ATTEMPTS to touch the lock when it already has reason
  # to believe it's abandoned — a fresh lock is never touched at all.
  local pre_m
  pre_m="$(_mtime "$SWEEP_LOCK_DIR")"
  [[ "$pre_m" =~ ^[0-9]+$ ]] || return 1
  (( $(_age_secs_or_stale "$pre_m") > RESPONDER_SWEEP_LOCK_STALE_SECS )) || return 1
  # Claim-then-reverify (Codex P2 round 3): `mv` is atomic, so of any number
  # of contenders whose pre-check above passed on the SAME instance, only one
  # can rename it away; every other's `mv` fails outright (ENOENT). The
  # reverify closes the residual window between this process's pre-check and
  # its mv, in which a DIFFERENT contender's own break-and-recreate cycle
  # could have already replaced the path with a fresh instance (`mv`
  # preserves mtime exactly, so a mismatch here can only mean a swap
  # happened) — that fresh copy is put back for its rightful owner rather
  # than destroyed; the residual window this doesn't close (some FOURTH
  # party grabbing the canonical path during THIS specific put-back) is the
  # same bounded, documented risk the sweep lock already accepts (item 5:
  # "worst case one extra bounded kickstart").
  local claim="${SWEEP_LOCK_DIR}.stale.$$" m
  mv "$SWEEP_LOCK_DIR" "$claim" 2>/dev/null || return 1
  m="$(_mtime "$claim")"
  if [[ ! "$m" =~ ^[0-9]+$ ]] || (( $(_age_secs_or_stale "$m") <= RESPONDER_SWEEP_LOCK_STALE_SECS )); then
    mv "$claim" "$SWEEP_LOCK_DIR" 2>/dev/null || rm -rf "$claim" 2>/dev/null
    return 1
  fi
  rm -rf "$claim" 2>/dev/null || true
  return 0
}
if ! is_dry; then
  if ! _acquire_sweep_lock; then
    if [[ -d "$SWEEP_LOCK_DIR" ]]; then
      if _claim_stale_lock; then
        log "broke stale sweep lock (> ${RESPONDER_SWEEP_LOCK_STALE_SECS}s old) — prior sweep crashed"
        _acquire_sweep_lock || true
      fi
      # A failed claim means the lock is live (either genuinely fresh, or an
      # instance swap was detected and put back) — fall through to the
      # SWEEP_LOCK_HELD check below like any contention.
      if [[ "$SWEEP_LOCK_HELD" -eq 0 ]]; then
        INSTALLED=0 ALIVE=0 C_DEAD=0 C_STALE=0 C_NORESPAWN=0 ATTEMPTS=0 ESCALATED=0
        log "another sweep holds ${SWEEP_LOCK_DIR} — skipping this run"
        heartbeat "skipped"
        exit 0
      fi
    else
      log "WARN: cannot create sweep lock under ${RESPONDER_STATE_DIR} (read-only?) — proceeding unlocked"
    fi
  fi
fi
# Release on ANY exit path — only when held AND still ours (see ownership note).
_release_sweep_lock() {
  [[ "${SWEEP_LOCK_HELD:-0}" -eq 1 ]] || return 0
  local owner=""
  owner="$(cat "${SWEEP_LOCK_DIR}/owner" 2>/dev/null || true)"
  # Missing owner file (write failed at acquire) or matching token → ours.
  if [[ -z "$owner" || "$owner" == "$SWEEP_LOCK_TOKEN" ]]; then
    rm -rf "$SWEEP_LOCK_DIR" 2>/dev/null || true
  fi
  return 0
}
trap _release_sweep_lock EXIT

# ─── agent supervision (CTL-1518) ───────────────────────────────────────────
#
# Second supervised target: the com.catalyst.agent host-metrics sampler. It died
# on mini-2 and launchd left it dead for 10 days — this block is the code
# backstop for that class of silent death. Same bounded-kickstart + one-shot-
# escalation + re-arm contract as the cloud-sync path, but with its OWN agent-
# scoped attempt markers (agent-attempt.*), escalation marker (ESCALATED.
# catalyst-agent), heartbeat line (target=catalyst-agent), and OTel escalate — so
# the two targets never share an attempt budget or clobber each other's state.
#
# PLACEMENT is load-bearing: this runs BEFORE the cloud-sync detect because the
# cloud-sync ACT path terminates the script with `exit 0` at several points — a
# block placed after it would be unreachable. Running first, this block MUST NOT
# exit; it falls through to the cloud-sync detect, whose heartbeat stays the LAST
# line of every sweep (the doctor-freshness contract). It runs only after the
# sweep lock is held (this trap fires after acquisition), so the two targets
# share the same single-sweep reservation.
#
# CRITICAL (CTL-1510 lineage): agent_heartbeat / emit_agent_escalated are
# SELF-CONTAINED — they read ONLY agent-scoped vars plus globals set at the top
# of the file. They deliberately do NOT call heartbeat() / emit_escalated(),
# which reference cloud-sync globals (INSTALLED, ALIVE, C_DEAD, CONDITIONS_CSV,
# ATTEMPTS, …) that are UNSET here under `set -u`; calling them would abort the
# sweep before the EXIT trap runs and leak the sweep lock. And every `$(...)`
# capture below is a single-line single command — NO comments inside a
# command-substitution capture (the bash 3.2 parser defect that cost CTL-1513 a
# production incident; the real interpreter is /bin/bash 3.2 via launchd/cron).

agent_heartbeat() {
  local status="$1"
  log "agent-supervision status=${status} target=catalyst-agent installed=${AGENT_INSTALLED} stale=${AGENT_STALE} attempts=${AGENT_ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} escalated=${AGENT_ESCALATED}"
}

# Fail-open agent-scoped escalate (mirrors emit_escalated; own attrs only).
emit_agent_escalated() {
  command -v emit-otel-event.sh >/dev/null 2>&1 || return 0
  emit-otel-event.sh \
    --event "catalyst.responder.escalated" \
    --outcome fail \
    --session-id "$RESPONDER_RUN_ID" \
    --attr "target=catalyst-agent" \
    --attr "conditions=agent-stale" \
    --attr "attempts=${AGENT_ATTEMPTS}" \
    --attr "windowSecs=${RESPONDER_ATTEMPT_WINDOW_SECS}" >/dev/null 2>&1 || true
}

# agent-attempt.* markers — a SEPARATE glob namespace from the cloud-sync
# attempt.* markers (the `attempt.*` glob never matches `agent-attempt.*`), so
# the two targets prune / count / clear independently.
_agent_prune_attempts() {
  is_dry && return 0
  local f ts now
  now="$(date +%s)"
  for f in "${RESPONDER_STATE_DIR}"/agent-attempt.*; do
    [[ -e "$f" ]] || continue
    ts="${f##*/}"; ts="${ts#agent-attempt.}"; ts="${ts%%.*}"
    if [[ ! "$ts" =~ ^[0-9]+$ ]]; then
      rm -f "$f" 2>/dev/null
      [[ -e "$f" ]] && AGENT_PRUNE_DEGRADED=1
      continue
    fi
    if [[ $(( now - ts )) -gt "$RESPONDER_ATTEMPT_WINDOW_SECS" ]]; then
      rm -f "$f" 2>/dev/null
      [[ -e "$f" ]] && AGENT_PRUNE_DEGRADED=1
    fi
  done
  return 0
}

_agent_attempt_count() {
  local n=0 f
  for f in "${RESPONDER_STATE_DIR}"/agent-attempt.*; do
    [[ -e "$f" ]] && n=$((n+1))
  done
  echo "$n"
}

# Fail-SAFE like _record_attempt: a marker that cannot be written means the cap
# cannot bound us, so the caller refuses to kickstart.
_agent_record_attempt() {
  : > "${RESPONDER_STATE_DIR}/agent-attempt.$(date +%s).$$" 2>/dev/null
}

# Returns non-zero when a durable marker SURVIVES the rm (read-only dir) so the
# caller never reports a false re-arm (mirrors _clear_markers).
_agent_clear_markers() {
  rm -f "${RESPONDER_STATE_DIR}"/agent-attempt.* "$AGENT_ESCALATED_MARKER" 2>/dev/null || true
  [[ -e "$AGENT_ESCALATED_MARKER" ]] && return 1
  local f
  for f in "${RESPONDER_STATE_DIR}"/agent-attempt.*; do
    [[ -e "$f" ]] && return 1
  done
  return 0
}

# _agent_stale_age: seconds since the agent's last liveness signal — the
# breadcrumb mtime when present, else the plist install mtime (a freshly-
# installed-but-never-ticked sampler is NOT yet stale). "" when neither is
# readable. A future mtime (clock skew) clamps to 0/fresh — the safe direction
# here is to NEVER kickstart a healthy sampler.
_agent_stale_age() {
  local now m age
  now="$(date +%s)"
  m="$(_mtime "$AGENT_HEARTBEAT_FILE")"
  [[ "$m" =~ ^[0-9]+$ ]] || m="$(_mtime "$AGENT_PLIST")"
  [[ "$m" =~ ^[0-9]+$ ]] || { printf ''; return 0; }
  age=$(( now - m ))
  (( age < 0 )) && age=0
  printf '%s' "$age"
}

# _agent_kickstart: a DUPLICATE of the CTL-1510-hardened cloud-sync deadline-
# wrapped kickstart (CTL-1518 correction a — NOT a shared refactor; cloud-sync
# stays literally untouched). Agent-prefixed locals so nothing clobbers the
# cloud-sync path. Reuses RESPONDER_KICKSTART_TIMEOUT_SECS / _WAIT_SECS. Sets
# AGENT_KICK_RESULT to recovered|still-down from a post-settle breadcrumb re-probe.
_agent_kickstart() {
  local out pid rc="" i uid new_age
  uid="$(id -u)"
  out="$(mktemp "${TMPDIR:-/tmp}/responder-agent-kick.XXXXXX")"
  launchctl kickstart -k "gui/${uid}/${AGENT_LABEL}" > "$out" 2>&1 &
  pid=$!
  for (( i = 0; i < RESPONDER_KICKSTART_TIMEOUT_SECS; i++ )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      rc=$?
      break
    fi
    sleep 1
  done
  if [[ -z "$rc" ]]; then
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    log "agent: kickstart TIMED OUT after ${RESPONDER_KICKSTART_TIMEOUT_SECS}s for gui/${uid}/${AGENT_LABEL} (attempt ${AGENT_ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} still counted)"
  elif [[ "$rc" -eq 0 ]]; then
    sed 's/^/  /' "$out"
    log "agent: kickstarted gui/${uid}/${AGENT_LABEL} (attempt ${AGENT_ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS})"
  else
    sed 's/^/  /' "$out"
    log "agent: kickstart FAILED for gui/${uid}/${AGENT_LABEL} — label not loaded? (attempt ${AGENT_ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} still counted)"
  fi
  rm -f "$out"
  [[ "$RESPONDER_KICKSTART_WAIT_SECS" -gt 0 ]] && sleep "$RESPONDER_KICKSTART_WAIT_SECS"
  new_age="$(_agent_stale_age)"
  if [[ -n "$new_age" && "$new_age" -le "$RESPONDER_AGENT_STALE_SECS" ]]; then
    AGENT_KICK_RESULT="recovered"
  else
    AGENT_KICK_RESULT="still-down"
  fi
}

# Inert on nodes without the agent plist (existing tests + non-sampler nodes stay
# silent — no agent heartbeat line at all).
if [[ -f "$AGENT_PLIST" ]]; then
  AGENT_INSTALLED=1
  AGENT_STALE=0
  AGENT_ATTEMPTS=0
  AGENT_ESCALATED=0
  AGENT_PRUNE_DEGRADED=0
  AGENT_KICK_RESULT=""

  if [[ "$RESPONDER_AGENT_ENABLED" != "1" ]]; then
    agent_heartbeat "disabled"
  else
    _AGENT_AGE="$(_agent_stale_age)"
    if [[ -n "$_AGENT_AGE" && "$_AGENT_AGE" -gt "$RESPONDER_AGENT_STALE_SECS" ]]; then
      AGENT_STALE=1
      log "agent: host-metrics breadcrumb ${_AGENT_AGE}s old (> ${RESPONDER_AGENT_STALE_SECS}s) — com.catalyst.agent sampler stale/dead"
    fi
    [[ -f "$AGENT_ESCALATED_MARKER" ]] && AGENT_ESCALATED=1
    _agent_prune_attempts
    AGENT_ATTEMPTS="$(_agent_attempt_count)"
    [[ "$AGENT_PRUNE_DEGRADED" -eq 1 ]] && log "agent: ERROR: expired attempt markers could not be pruned from ${RESPONDER_STATE_DIR} (read-only?) — agent attempt count over-counts; fix permissions"

    if [[ "$AGENT_STALE" -eq 0 ]]; then
      if [[ "$AGENT_ESCALATED" -eq 1 || "$AGENT_ATTEMPTS" -gt 0 ]]; then
        if is_dry; then
          log "agent: [dry-run] would re-arm: clear ${AGENT_ATTEMPTS} attempt marker(s) + escalated=${AGENT_ESCALATED}"
          agent_heartbeat "healthy"
        elif _agent_clear_markers; then
          [[ "$AGENT_ESCALATED" -eq 1 ]] && log "agent: condition cleared — re-armed (ESCALATED.catalyst-agent + attempt markers removed)"
          AGENT_ESCALATED=0
          AGENT_ATTEMPTS=0
          agent_heartbeat "healthy"
        else
          log "agent: ERROR: condition cleared but markers could not be removed from ${RESPONDER_STATE_DIR} (read-only?) — agent supervision remains ESCALATED on disk; fix permissions"
          agent_heartbeat "degraded"
        fi
      else
        agent_heartbeat "healthy"
      fi
    elif [[ "$AGENT_ESCALATED" -eq 1 ]]; then
      log "agent: condition active: agent-stale (escalated hold)"
      agent_heartbeat "escalated"
    elif [[ "$AGENT_ATTEMPTS" -ge "$RESPONDER_MAX_ATTEMPTS" ]]; then
      log "agent: condition active: agent-stale"
      if [[ "$AGENT_PRUNE_DEGRADED" -eq 1 ]]; then
        log "agent: ERROR: attempt cap reached but the count includes unprunable expired markers — refusing to escalate on unreliable state; fix ${RESPONDER_STATE_DIR} permissions"
        agent_heartbeat "degraded"
      elif is_dry; then
        log "agent: [dry-run] would escalate: ${AGENT_ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} kickstarts in ${RESPONDER_ATTEMPT_WINDOW_SECS}s did not clear agent-stale"
        agent_heartbeat "dry-run"
      else
        if : > "$AGENT_ESCALATED_MARKER" 2>/dev/null; then
          AGENT_ESCALATED=1
          emit_agent_escalated
        else
          AGENT_ESCALATED=1
          log "agent: ERROR: cannot write ESCALATED.catalyst-agent marker under ${RESPONDER_STATE_DIR} — skipping the one-shot OTel emit; fix permissions"
        fi
        log "agent: ERROR: escalated — agent-stale persists after ${AGENT_ATTEMPTS}/${RESPONDER_MAX_ATTEMPTS} kickstarts in ${RESPONDER_ATTEMPT_WINDOW_SECS}s; kickstarting stopped until the condition clears (check ~/catalyst/catalyst-agent.log)"
        agent_heartbeat "escalated"
      fi
    elif is_dry; then
      log "agent: [dry-run] would kickstart gui/$(id -u)/${AGENT_LABEL} (agent-stale)"
      agent_heartbeat "dry-run"
    else
      log "agent: condition active: agent-stale"
      if ! _agent_record_attempt; then
        log "agent: ERROR: cannot write attempt marker under ${RESPONDER_STATE_DIR} — refusing to kickstart (attempt cap unenforceable); fix permissions"
        agent_heartbeat "degraded"
      else
        AGENT_ATTEMPTS=$((AGENT_ATTEMPTS+1))
        _agent_kickstart
        if [[ "$AGENT_KICK_RESULT" == "recovered" ]]; then
          log "agent: recovered: com.catalyst.agent breadcrumb is fresh after kickstart"
          agent_heartbeat "recovered"
        else
          log "agent: still-down: com.catalyst.agent breadcrumb still stale after kickstart + ${RESPONDER_KICKSTART_WAIT_SECS}s"
          agent_heartbeat "still-down"
        fi
      fi
    fi
  fi
fi

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

# Intentional-exit gate (Codex P1 round 3), evaluated once for the anomalous
# installed-but-not-running state: the writer exits 0 ON PURPOSE in two
# supported flows — the tokenless fail-open no-op (adopt-cloud-sync installs
# the plist before the token exists; cloud-sync.mjs:113-116 "writer idle") and
# a manual SIGTERM stop (exit 0 by design so KeepAlive does NOT resurrect it).
# Kickstarting either fights the operator and ends in a false escalation.
# LastExitStatus==0 → idle by design, leave it down; nonzero or unparseable →
# treat as dead (recovery must not be lost to weird launchctl output).
_LE=""
if [[ "$INSTALLED" -eq 1 && "$ALIVE" -eq 0 ]]; then
  _LE="$(_last_exit_status)"
  if [[ "$_LE" == "0" ]]; then
    # Token-file discrimination (CTL-1510 item 0): exit 0 is only "idle by
    # design" on a TOKENLESS node. With a token provisioned (either launcher-
    # sourced file), a down writer with a clean exit is the failed-bounce
    # signature (bootout's SIGTERM → exit 0 → bootstrap never stuck) — both
    # KeepAlive={SuccessfulExit:false} and a naive exit-0 gate would suppress
    # recovery forever. Neutralize the gate so dead-writer/no-respawn
    # detection applies.
    if _token_provisioned; then
      log "writer down with last exit 0 but a token file is provisioned (${RESPONDER_TOKEN_FILE} or ${RESPONDER_CLUSTER_ENV_FILE}) — failed-bounce signature, treating as dead (CTL-1510 item 0)"
      _LE=""
    else
      log "writer idle by design (last exit 0, no token file); not a fault"
    fi
  fi
fi

# Condition 1: dead-writer. Installed-gated: a node without the cloud-sync
# agent (not on the replica tier) is simply not our patient — do nothing.
# SETTLING-gated: a fresh self-heal breadcrumb means the writer exited on
# purpose expecting a launchd relaunch — kicking now would race/kill it, so
# hold for the grace window (the relaunch either lands, clearing this, or the
# breadcrumb ages into the no-respawn condition).
C_DEAD=0
[[ "$INSTALLED" -eq 1 && "$ALIVE" -eq 0 && "$SETTLING" -eq 0 && "$_LE" != "0" ]] && C_DEAD=1

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
# Also gated on the intentional-exit check (_LE): a leftover ancient
# breadcrumb on a node that later became tokenless-idle (last exit 0) must not
# drive a kickstart loop either — the self-heal path always exits 1.
C_NORESPAWN=0
if [[ "$INSTALLED" -eq 1 && "$ALIVE" -eq 0 && "$_LE" != "0" && "$SELFHEAL_VALID" -eq 1 && "$SELFHEAL_AGE" -gt "$RESPONDER_SELFHEAL_GRACE_SECS" ]]; then
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

PRUNE_DEGRADED=0
_prune_attempts
ATTEMPTS="$(_attempt_count)"
[[ "$PRUNE_DEGRADED" -eq 1 ]] && log "ERROR: expired attempt markers could not be pruned from ${RESPONDER_STATE_DIR} (read-only?) — attempt count over-counts; fix permissions"

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
    elif _clear_markers; then
      [[ "$ESCALATED" -eq 1 ]] && log "condition cleared — re-armed (ESCALATED marker + attempt markers removed)"
      ESCALATED=0
      ATTEMPTS=0
    else
      # Codex P2 round 3: rm failed (state dir read-only?) and the durable
      # markers SURVIVED — reporting "re-armed" here would lie: the next
      # incident would enter the escalated hold with zero recovery attempts.
      # Degrade loudly instead; state stays escalated until perms are fixed.
      log "ERROR: condition cleared but markers could not be removed from ${RESPONDER_STATE_DIR} (read-only?) — responder remains ESCALATED on disk; fix permissions"
      heartbeat "degraded"
      exit 0
    fi
  fi
  if [[ "$SETTLING" -eq 1 ]]; then
    log "settling: self-heal breadcrumb is ${SELFHEAL_AGE}s old (grace ${RESPONDER_SELFHEAL_GRACE_SECS}s) — holding for the expected launchd relaunch"
    heartbeat "settling"
  elif [[ "$INSTALLED" -eq 0 ]]; then
    # CAT-53: every actionable condition is installed-gated. A writer that was
    # never adopted can therefore trigger none of them; call that absence what
    # it is instead of reporting a never-started replica tier as healthy.
    log "not-adopted: no ${CLOUD_SYNC_PLIST} — the replica writer has never been adopted on this host; run 'catalyst-stack adopt-cloud-sync'"
    heartbeat "not-adopted"
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
  # Cap reached on an UNRELIABLE count (unprunable expired markers, CTL-1510
  # item 4): the "cap" may be phantom attempts from a past incident — a false
  # escalation outside the window. Degrade explicitly instead of escalating on
  # state we know is broken; the ERROR above ships to Loki on every sweep.
  if [[ "$PRUNE_DEGRADED" -eq 1 ]]; then
    log "ERROR: attempt cap reached but the count includes unprunable expired markers — refusing to escalate on unreliable state; fix ${RESPONDER_STATE_DIR} permissions"
    heartbeat "degraded"
    exit 0
  fi
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
