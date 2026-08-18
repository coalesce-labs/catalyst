#!/usr/bin/env bash
# verify-loaded.sh — CTL-1916. Prove a host is RUNNING the code you think it is.
#
# ⛔ WHY THIS IS A COMMITTED FILE. A tool built to prove a cutover is safe was written
# three times into a session temp dir and evaporated three times (CTL-1916). Each
# re-derivation is a fresh chance to check something subtly different from what was
# checked last time — and the whole point of the tool is that the check is the SAME one
# every time. So it ships with the plugin; there is no host-local copy to go stale.
#
#   verify-loaded.sh --root <serving-root> --host <name> --mode <mode> [--role worker|monitor]
#
# ⭐ "LOADED" MEANS THE PID, NOT THE CHECKOUT. A git sha on disk says the bytes arrived;
# it says nothing about what the running process is executing. Every link below is
# anchored on the live pid, and link 4 is the one that makes the difference explicit: a
# daemon that started BEFORE the file changed is serving the previous bytes no matter how
# current the checkout looks. That distinction is not academic — it is the entire content
# of CTL-1919 (a writer serving a checkout three schema versions stale while every git
# check on the host read clean) and of CTL-1659 before it.
#
# ⛔ EVERY LINK FAILS CLOSED. "I could not measure it" exits non-zero and says which link
# and why. A verification tool that degrades to silence on an unreadable input is the
# false-clean mechanism this repo has shipped more than once; it must not be re-created
# in the layer whose job is catching it.
#
# Exit: 0 = every link verified. 1 = at least one link FAILED or could not be measured.
set -uo pipefail

VL_ROOT=""; VL_HOST=""; VL_MODE=""; VL_ROLE="worker"
VL_MODULE="plugins/dev/scripts/execution-core/cloud-feed-timer.mjs"
VL_ARMED_RE="cloud-feed: armed"
VL_LOG="\$HOME/catalyst/execution-core/daemon.log"
VL_PROC_PAT="execution-core/daemon.mjs"

usage() {
  cat >&2 <<'USAGE'
usage: verify-loaded.sh --root <serving-root> --host <name> --mode <mode>
                        [--role worker|monitor] [--module <repo-relative path>]
                        [--armed-pattern <regex>] [--log <remote path>]
                        [--process-pattern <pgrep -f pattern>]

  --root    the checkout the daemon is REQUIRED to be serving (e.g. ~/catalyst/plugin-source)
  --host    host to verify; the local hostname runs locally, anything else over ssh
  --mode    the mode the running process must have announced (e.g. enforce)
  --role    worker (default) asserts the daemon is present; monitor asserts its ABSENCE
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) VL_ROOT="${2:-}"; shift 2 ;;
    --host) VL_HOST="${2:-}"; shift 2 ;;
    --mode) VL_MODE="${2:-}"; shift 2 ;;
    --role) VL_ROLE="${2:-}"; shift 2 ;;
    --module) VL_MODULE="${2:-}"; shift 2 ;;
    --armed-pattern) VL_ARMED_RE="${2:-}"; shift 2 ;;
    --log) VL_LOG="${2:-}"; shift 2 ;;
    --process-pattern) VL_PROC_PAT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "verify-loaded: unknown argument '$1'" >&2; usage; exit 1 ;;
  esac
done

[[ -n "$VL_ROOT" ]] || { echo "verify-loaded: --root is required" >&2; exit 1; }
[[ -n "$VL_HOST" ]] || { echo "verify-loaded: --host is required" >&2; exit 1; }
case "$VL_ROLE" in
  worker) [[ -n "$VL_MODE" ]] || { echo "verify-loaded: --mode is required for role worker" >&2; exit 1; } ;;
  monitor) : ;;
  *) echo "verify-loaded: --role must be 'worker' or 'monitor' (got '$VL_ROLE')" >&2; exit 1 ;;
esac

# _vl_run — the ONE transport seam. Everything this script learns about the host goes
# through here, so a test can seal the transport with a single injected runner instead of
# shadowing a helper on PATH — stubbing a helper only proves the helper was not called,
# which is not the same as proving nothing else reached the network.
_vl_run() {
  if [[ -n "${CATALYST_VERIFY_LOADED_RUNNER:-}" ]]; then
    "${CATALYST_VERIFY_LOADED_RUNNER}" "$VL_HOST" "$1"
  elif [[ "$VL_HOST" == "$(hostname -s 2>/dev/null)" || "$VL_HOST" == "localhost" ]]; then
    bash -c "$1"
  else
    ssh -o ConnectTimeout=10 -o BatchMode=yes "$VL_HOST" "$1"
  fi
}

VL_FAILURES=0
_pass() { printf '  \033[32mPASS\033[0m  %-16s %s\n' "$1" "$2"; }
_fail() { printf '  \033[31mFAIL\033[0m  %-16s %s\n' "$1" "$2"; VL_FAILURES=$((VL_FAILURES+1)); }

echo "verify-loaded: host=${VL_HOST} root=${VL_ROOT} role=${VL_ROLE}${VL_MODE:+ mode=${VL_MODE}}"

# ── link 1: the daemon process, and which root its argv names ───────────────────────
# Read from the live process table, never from a pid FILE: a pid file is a claim written
# at some past moment, and a recycled pid makes it a confident lie.
PID="$(_vl_run "pgrep -f '${VL_PROC_PAT}' 2>/dev/null | head -1" 2>/dev/null | tr -d '[:space:]')"

if [[ "$VL_ROLE" == "monitor" ]]; then
  # ⭐ The monitor role ASSERTS AN ABSENCE rather than skipping. A skipped link reports the
  # same "no complaint" as a verified one, so a monitor node running a daemon it must not
  # run would look identical to a correctly configured one.
  if [[ -z "$PID" ]]; then
    _pass "no-exec-core" "no execution-core daemon on this monitor node (asserted, not skipped)"
  else
    _fail "no-exec-core" "monitor node is running an execution-core daemon (pid ${PID}) — it must not"
  fi
  echo
  [[ $VL_FAILURES -eq 0 ]] && { echo "verify-loaded: OK"; exit 0; }
  echo "verify-loaded: ${VL_FAILURES} link(s) FAILED"; exit 1
fi

if [[ -z "$PID" ]]; then
  _fail "daemon-live" "no process matching '${VL_PROC_PAT}' — nothing is loaded"
  echo; echo "verify-loaded: ${VL_FAILURES} link(s) FAILED"; exit 1
fi

CMD="$(_vl_run "ps -p ${PID} -o command= 2>/dev/null" 2>/dev/null)"
if [[ -z "$CMD" ]]; then
  _fail "serving-root" "pid ${PID} vanished before its argv could be read — cannot prove which root it serves"
elif [[ "$CMD" == *"${VL_ROOT}/"* ]]; then
  _pass "serving-root" "pid ${PID} is serving ${VL_ROOT}"
else
  _fail "serving-root" "pid ${PID} is NOT serving ${VL_ROOT} — argv says: ${CMD}"
fi

# ── link 2: the gate module, on disk AND resolvable from the serving root ───────────
# Two questions, not one. Presence on disk proves the pull landed; import-resolvability
# proves the module the daemon would actually load is loadable from THAT root. A file can
# be present and unimportable (a broken transitive dep — CTL-1831), which reads as
# "installed" to every git-level check.
MOD_PATH="${VL_ROOT}/${VL_MODULE}"
if [[ "$(_vl_run "test -f '${MOD_PATH}' && echo yes || echo no" 2>/dev/null | tr -d '[:space:]')" == "yes" ]]; then
  RESOLVE="$(_vl_run "cd '${VL_ROOT}' && bun -e 'await import(\"${MOD_PATH}\"); console.log(\"IMPORT_OK\")' 2>&1 | tail -1" 2>/dev/null)"
  if [[ "$RESOLVE" == *IMPORT_OK* ]]; then
    _pass "gate-module" "${VL_MODULE} present and importable from ${VL_ROOT}"
  else
    _fail "gate-module" "${VL_MODULE} is on disk but does NOT import from ${VL_ROOT}: ${RESOLVE}"
  fi
else
  _fail "gate-module" "${VL_MODULE} is absent under ${VL_ROOT}"
fi

# ── link 3: the mode line THE RUNNING PROCESS wrote ─────────────────────────────────
# ⛔ Matched against this pid, not merely "somewhere in the log". A log is append-only
# across restarts, so an unanchored grep happily matches the line a PREVIOUS process wrote
# before the very rollback you are checking for.
ARMED="$(_vl_run "grep -h '\"pid\":${PID}' ${VL_LOG} 2>/dev/null | grep -E '${VL_ARMED_RE}' | tail -1" 2>/dev/null)"
if [[ -z "$ARMED" ]]; then
  _fail "armed-line" "pid ${PID} never wrote a line matching '${VL_ARMED_RE}' — the mode is UNPROVEN (a log line from an earlier pid does not count)"
elif [[ "$ARMED" == *"${VL_MODE}"* ]]; then
  # ⚠️ The declared MODE and the runtime ARMED flag are different facts, and this tool
  # reports both rather than letting the first stand for the second. Measured on the fleet
  # 2026-08-17: mini-2 writes `"mode":"enforce" … "armed":false` — enforce is configured and
  # the feed is not currently armed (the CTL-1909 readiness behaviour). A tool that printed
  # only "announced mode enforce" would read as a clean bill of health for a feed that is
  # not running, which is the failure class this whole script exists to prevent.
  #
  # It is surfaced, NOT failed: "is this code loaded, with this mode" is the question
  # verify-loaded answers, and arming is a separate runtime condition with its own ticket.
  # Failing here would make a correctly-loaded host report FAIL, which is the opposite
  # error and would train operators to ignore the tool.
  ARMED_FLAG=""
  case "$ARMED" in
    *'"armed":true'*)  ARMED_FLAG=" (armed=true)" ;;
    *'"armed":false'*) ARMED_FLAG=" (⚠️ armed=false — mode is configured but the feed is not currently armed; that is a RUNTIME condition, not a load failure)" ;;
  esac
  _pass "armed-line" "pid ${PID} announced mode ${VL_MODE}${ARMED_FLAG}"
else
  _fail "armed-line" "pid ${PID} announced a DIFFERENT mode than ${VL_MODE}: ${ARMED}"
fi

# ── link 4: the pid started AFTER the bytes changed ─────────────────────────────────
# ⭐ THE LINK THAT SEPARATES "THE CHECKOUT IS CURRENT" FROM "THE PROCESS IS RUNNING IT".
# Links 1–3 all pass for a daemon that booted before the pull landed. Compare the process
# start time to the module's mtime; an unreadable either side FAILS, because "I could not
# compare" is exactly the answer a stale daemon produces for free.
EPOCHS="$(_vl_run "s=\$(ps -p ${PID} -o lstart= 2>/dev/null); m=\$(stat -f %m '${MOD_PATH}' 2>/dev/null); ps_e=\$(date -j -f '%a %b %d %T %Y' \"\$s\" +%s 2>/dev/null); echo \"\${ps_e:-NA} \${m:-NA}\"" 2>/dev/null)"
PS_EPOCH="${EPOCHS%% *}"; MOD_EPOCH="${EPOCHS##* }"
if [[ "$PS_EPOCH" == "NA" || "$MOD_EPOCH" == "NA" || -z "$PS_EPOCH" || -z "$MOD_EPOCH" ]]; then
  _fail "started-after" "could not read process start time and/or module mtime (got '${EPOCHS}') — freshness is UNPROVEN"
elif [[ "$PS_EPOCH" -ge "$MOD_EPOCH" ]]; then
  _pass "started-after" "pid ${PID} started $(( PS_EPOCH - MOD_EPOCH ))s after ${VL_MODULE} last changed"
else
  _fail "started-after" "pid ${PID} started $(( MOD_EPOCH - PS_EPOCH ))s BEFORE ${VL_MODULE} last changed — it is serving the previous bytes"
fi

echo
if [[ $VL_FAILURES -eq 0 ]]; then echo "verify-loaded: OK — 4/4 links verified on ${VL_HOST}"; exit 0; fi
echo "verify-loaded: ${VL_FAILURES} link(s) FAILED on ${VL_HOST}"; exit 1
