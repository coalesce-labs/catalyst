#!/usr/bin/env bash
# parity-scenario.sh — hermetic single-scenario driver for orphan-sweep.sh's
# CTL-1531 WIDENED branch. It is the .sh half of the BEHAVIOURAL drift guard in
# execution-core/proc-reaper.test.mjs.
#
# WHY THIS EXISTS (CTL-1531 round 3)
# ----------------------------------
# The original drift guard asserted that proc-reaper.mjs and orphan-sweep.sh
# carried the same `PARITY: <slug>` COMMENT MARKERS. That is a TAGGING
# invariant, not a safety one — measured: deleting a `# PARITY: argv-redaction`
# comment failed 3 tests, while deleting the shell's actual root-absent bail
# (marker left in place) failed 0. A guard that cannot fail converts "untested"
# into "verified", which is worse than no guard.
#
# This script is the other half. It runs the REAL orphan-sweep.sh against a
# fixture built for ONE named shared safety property and prints a
# machine-readable OUTCOME, so proc-reaper.test.mjs can drive the SAME scenario
# through the JS seams and assert the two implementations BEHAVE the same. Delete
# either side's gate and the named test goes RED.
#
# Usage:  bash parity-scenario.sh <scenario>
#         bash parity-scenario.sh --list
# Output: ONE line of JSON on stdout —
#   {"scenario":"…","exit":0,"signalled":[2001],"signals":2,"reclaimed":[2001],"logB64":"…"}
#     signalled — pids that received ANY signal (deduped, ascending)
#     signals   — total signals DELIVERED (SIGTERM and SIGKILL both count)
#     reclaimed — pids for which an `orphan_proc` reclamation was emitted
#     logB64    — base64 of the sweep's combined stdout+stderr (argv-redaction
#                 asserts over it; base64 keeps the JSON line-safe)
#
# SAFETY: fully hermetic. ps / lsof / pgrep / kill / claude / linearis / git /
# emit-otel-event.sh are mocked into a scratch $PATH, $HOME is redirected into a
# temp dir, and the sweep's destructive `env kill` resolves to a mock that only
# appends to a log file. NO REAL PROCESS is ever enumerated or signalled.

set -uo pipefail

SCENARIOS="baseline allowlist denylist age-floor root-absent-bail per-run-cap \
signal-bound-odd tri-state-cwd-probe pre-signal-revalidation confirmed-exit \
probe-deadline argv-redaction shadow-default"

SCENARIO="${1:-}"
if [[ "$SCENARIO" == "--list" ]]; then
  printf '%s\n' $SCENARIOS
  exit 0
fi
if [[ -z "$SCENARIO" ]]; then
  echo "usage: parity-scenario.sh <scenario>|--list" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="${SCRIPT_DIR}/../orphan-sweep.sh"
if [[ ! -f "$SWEEP" ]]; then
  echo "parity-scenario.sh: orphan-sweep.sh not found at ${SWEEP}" >&2
  exit 2
fi

# The secret used by the argv-redaction scenario. Exported so the caller can
# assert on the exact literal rather than re-declaring it (a re-declared copy is
# how a redaction test silently starts asserting on a string nothing emits).
PARITY_SECRET="PARITY-SECRET-sk-live-DEADBEEF"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

export HOME="${SCRATCH}/home"; mkdir -p "$HOME"
MOCKBIN="${SCRATCH}/bin"; mkdir -p "$MOCKBIN"
export PATH="${MOCKBIN}:${PATH}"
export MOCK_STATE="${SCRATCH}/state"; mkdir -p "$MOCK_STATE"
export KILL_LOG="${SCRATCH}/kill.log"; : > "$KILL_LOG"
export OTEL_LOG="${SCRATCH}/otel.log"; : > "$OTEL_LOG"

# ─── mocks ──────────────────────────────────────────────────────────────────

# ps: `-axo pid=,ppid=`   → $PS_ROWS (the widened candidate enumeration)
#     `-o ppid= -p N`     → $PPID_N,  $PPID2_N  from the 2nd read on (TOCTOU)
#     `-o command= -p N`  → $CMD_N,   $CMD2_N   from the 2nd read on (TOCTOU)
#     `-o etime= -p N`    → $ETIME_N  (default 16:40:00 = 60000s, over the floor)
#     `-o pid= -p N`      → the tri-state LIVENESS probe. Default = CONFIRMED
#                           GONE, which real `ps` reports as rc 1 + EMPTY stdout
#                           + EMPTY STDERR. $ALIVE_N=1 models a process that
#                           ignores BOTH SIGTERM and SIGKILL.
# A pid not named in $FIX_PIDS gets its REAL ppid, so _sweep_self_pids' ancestor
# walk terminates naturally instead of being handed a synthetic ppid=1.
cat > "$MOCKBIN/ps" <<'PSEOF'
#!/usr/bin/env bash
axo=0; fmt=""; pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -axo) axo=1; shift 2 ;;
    -o) fmt="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$axo" == "1" ]]; then
  printf '%s\n' "${PS_ROWS:-}"
  exit 0
fi
_n_file="${MOCK_STATE}/${fmt%=}-${pid}"
_n=$(( $(cat "$_n_file" 2>/dev/null || echo 0) + 1 )); printf '%s' "$_n" > "$_n_file"
case "$fmt" in
  ppid=)
    eval "v2=\"\${PPID2_${pid}:-}\""
    if [[ -n "$v2" && "$_n" -ge 2 ]]; then printf '%s\n' "$v2"; exit 0; fi
    eval "v=\"\${PPID_${pid}:-}\""
    if [[ -n "$v" ]]; then printf '%s\n' "$v"; exit 0; fi
    case " ${FIX_PIDS:-} " in
      *" ${pid} "*) printf '1\n' ;;
      *) /bin/ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' ;;
    esac
    ;;
  command=)
    eval "v2=\"\${CMD2_${pid}-__UNSET__}\""
    if [[ "$v2" != "__UNSET__" && "$_n" -ge 2 ]]; then
      [[ -n "$v2" ]] && printf '%s\n' "$v2"; exit 0
    fi
    eval "v=\"\${CMD_${pid}-__DEFAULT__}\""
    [[ "$v" == "__DEFAULT__" ]] && v="sh -c while :; do :; done"
    [[ -n "$v" ]] && printf '%s\n' "$v"
    ;;
  etime=)
    eval "v=\"\${ETIME_${pid}-__DEFAULT__}\""
    [[ "$v" == "__DEFAULT__" ]] && v="16:40:00"
    [[ -n "$v" ]] && printf '%s\n' "$v"
    ;;
  pid=)
    eval "v=\"\${ALIVE_${pid}:-}\""
    if [[ -n "$v" ]]; then printf '%s\n' "$pid"; exit 0; fi
    exit 1
    ;;
esac
exit 0
PSEOF
chmod +x "$MOCKBIN/ps"

# lsof: cwd per pid via $CWD_<pid> ($CWD2_<pid> from the 2nd call on, which is
# what the pre-signal cwd RE-PROBE sees). $HANG_<pid>=<secs> models lsof blocking
# in the kernel on a hung/stale mount — the case the probe deadline exists for.
# The sleep is SELF-LIMITING: if the sweep's watchdog fails to fire, this still
# exits on its own instead of leaking a spinner.
cat > "$MOCKBIN/lsof" <<'LSOFEOF'
#!/usr/bin/env bash
pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in -p) pid="$2"; shift 2 ;; *) shift ;; esac
done
_n_file="${MOCK_STATE}/lsof-${pid}"
_n=$(( $(cat "$_n_file" 2>/dev/null || echo 0) + 1 )); printf '%s' "$_n" > "$_n_file"
eval "hang=\"\${HANG_${pid}:-}\""
if [[ -n "$hang" ]]; then sleep "$hang"; fi
eval "v2=\"\${CWD2_${pid}-__UNSET__}\""
if [[ "$v2" != "__UNSET__" && "$_n" -ge 2 ]]; then
  [[ -n "$v2" ]] && printf 'n%s\n' "$v2"
  exit 0
fi
eval "v=\"\${CWD_${pid}-__UNSET__}\""
[[ "$v" != "__UNSET__" && -n "$v" ]] && printf 'n%s\n' "$v"
exit 0
LSOFEOF
chmod +x "$MOCKBIN/lsof"

# kill: the DESTRUCTIVE seam. `env kill` resolves here; the bash builtin (used by
# _proc_cwd's own watchdog) does not, so probe traffic never pollutes this log.
cat > "$MOCKBIN/kill" <<'KILLEOF'
#!/usr/bin/env bash
echo "$@" >> "${KILL_LOG}"
exit 0
KILLEOF
chmod +x "$MOCKBIN/kill"

# pgrep: the LEGACY (bun run|turbo|node) branch — kept EMPTY so every signal in
# the log is attributable to the widened branch under test.
printf '#!/usr/bin/env bash\nexit 0\n' > "$MOCKBIN/pgrep"; chmod +x "$MOCKBIN/pgrep"
printf '#!/usr/bin/env bash\nif [[ "${1:-}" == "agents" ]]; then echo "[]"; fi\n' \
  > "$MOCKBIN/claude"; chmod +x "$MOCKBIN/claude"
printf '#!/usr/bin/env bash\necho "[]"\n' > "$MOCKBIN/linearis"; chmod +x "$MOCKBIN/linearis"
printf '#!/usr/bin/env bash\nexit 0\n' > "$MOCKBIN/git"; chmod +x "$MOCKBIN/git"
printf '#!/usr/bin/env bash\nexit 1\n' > "$MOCKBIN/pmset"; chmod +x "$MOCKBIN/pmset"
cat > "$MOCKBIN/emit-otel-event.sh" <<'OTELEOF'
#!/usr/bin/env bash
echo "$@" >> "${OTEL_LOG}"
exit 0
OTELEOF
chmod +x "$MOCKBIN/emit-otel-event.sh"

# ─── roots: every other sweep vector pointed at empty/inert state ────────────

WT="${SCRATCH}/wt"; mkdir -p "$WT"
GONE="${WT}/deleted-tree"            # deliberately NOT created
WT_ABSENT="${SCRATCH}/wt_absent"     # deliberately NOT created
export SWEEP_WT_ROOT="$WT"
export SWEEP_WORKERS_GLOB_ROOT="${SCRATCH}/catalyst"; mkdir -p "$SWEEP_WORKERS_GLOB_ROOT"
export SWEEP_TRUNK_CACHE_DIR="${SCRATCH}/trunk"; mkdir -p "$SWEEP_TRUNK_CACHE_DIR"
export SWEEP_INCLUDE_GLOBAL_CLAUDE_WT=0
export SWEEP_PROJECT_CLAUDE_WT=""
export SWEEP_FORCE_POWER=battery     # vector 2 (worktree removal) stays inert
export SWEEP_AB_ENABLED=0            # vector 5 (agent-browser) stays inert
export SWEEP_RUN_ID=parity
export SWEEP_PROC_WIDEN_GRACE_SECS=0 # confirm-exit probes once, no wall clock
export SWEEP_PROC_WIDEN=enforce      # scenarios override where the mode IS the subject

# ─── the scenarios ───────────────────────────────────────────────────────────
#
# Every scenario starts from the SAME maximally-kill-eligible shape (ppid 1, bare
# `sh`, cwd = a deleted tree under the worktree root, 16h old) and varies exactly
# ONE thing — the property under test. So "nothing was signalled" can only be
# explained by the gate the scenario is named for.

case "$SCENARIO" in
  baseline)
    # The CONTROL. Without it every "spared" assertion below could pass because
    # the harness cannot kill anything at all.
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    ;;
  allowlist)
    export PS_ROWS="2001 1
2002 1"
    export FIX_PIDS="2001 2002"
    export CWD_2001="$GONE"; export CWD_2002="$GONE"
    export CMD_2001="/bin/bash /Users/x/plugin-source/plugins/dev/scripts/orphan-sweep.sh"
    export CMD_2002="/bin/bash /Users/x/plugin-source/plugins/dev/scripts/catalyst-stack start"
    ;;
  denylist)
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    export CMD_2001="tmux: server (/private/tmp/tmux-501/default)"
    ;;
  age-floor)
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    export ETIME_2001="00:30"
    ;;
  root-absent-bail)
    # The cwds point UNDER the vanished root, so gate (j) admits them and the
    # early bail is the ONLY thing standing between the fixture and 5 SIGTERMs.
    export SWEEP_WT_ROOT="$WT_ABSENT"
    export PS_ROWS="2001 1
2002 1
2003 1
2004 1
2005 1"
    export FIX_PIDS="2001 2002 2003 2004 2005"
    for p in 2001 2002 2003 2004 2005; do
      eval "export CWD_${p}=\"\${WT_ABSENT}/deleted-tree\""
    done
    ;;
  per-run-cap)
    export SWEEP_PROC_WIDEN_MAX_KILLS=2
    export PS_ROWS="2001 1
2002 1
2003 1
2004 1
2005 1"
    export FIX_PIDS="2001 2002 2003 2004 2005"
    for p in 2001 2002 2003 2004 2005; do eval "export CWD_${p}=\"\$GONE\""; done
    ;;
  signal-bound-odd)
    # ODD PARITY, the CTL-1531 round-3 finding. cap=2 ⇒ ceiling 4 DELIVERED
    # signals. 2001 exits under SIGTERM (ONE signal); 2002+ ignore both signals
    # (TWO each). Admitting on `signalled >= cap*2` lets 2003 in at signalled==3
    # and it then spends two more ⇒ 5 delivered, i.e. cap*2 + 1.
    export SWEEP_PROC_WIDEN_MAX_KILLS=2
    export PS_ROWS="2001 1
2002 1
2003 1
2004 1"
    export FIX_PIDS="2001 2002 2003 2004"
    for p in 2001 2002 2003 2004; do eval "export CWD_${p}=\"\$GONE\""; done
    export ALIVE_2002=1; export ALIVE_2003=1; export ALIVE_2004=1
    ;;
  tri-state-cwd-probe)
    # The cwd probe cannot ANSWER (EIO), which `[[ -d ]]` alone reports
    # identically to "deleted". Only a definite ENOENT is kill evidence.
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"
    export CWD_2001="${WT}/unreadable-tree"
    export PARITY_EIO_PATH="${WT}/unreadable-tree"
    cat > "$MOCKBIN/stat" <<'STATEOF'
#!/usr/bin/env bash
for a in "$@"; do
  if [[ -n "${PARITY_EIO_PATH:-}" && "$a" == "${PARITY_EIO_PATH}" ]]; then
    echo "stat: ${a}: Input/output error" >&2
    exit 1
  fi
done
exec /usr/bin/stat "$@"
STATEOF
    chmod +x "$MOCKBIN/stat"
    ;;
  pre-signal-revalidation)
    # The argv CHANGES between the gate read and the pre-signal re-read: the pid
    # was recycled. No signal may be delivered at all.
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    export CMD2_2001="sh -c a-completely-different-process"
    ;;
  confirmed-exit)
    # Signals are DELIVERED but the process never dies. Two signals, ZERO
    # reclamations — `kill` returning success is not an exit.
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    export ALIVE_2001=1
    ;;
  probe-deadline)
    # lsof blocks in the kernel for 3s; the deadline is 1s. A timed-out probe
    # yields an UNKNOWN cwd, which spares — never a truncated path.
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    export HANG_2001=3
    export SWEEP_PROC_CWD_TIMEOUT_SECS=1
    ;;
  argv-redaction)
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    export CMD_2001="sh -c curl -H Authorization: Bearer ${PARITY_SECRET} https://x/y"
    ;;
  shadow-default)
    # SWEEP_PROC_WIDEN deliberately UNSET: the widened class must ship dark.
    unset SWEEP_PROC_WIDEN
    export PS_ROWS="2001 1"; export FIX_PIDS="2001"; export CWD_2001="$GONE"
    ;;
  *)
    echo "parity-scenario.sh: unknown scenario '${SCENARIO}' (see --list)" >&2
    exit 2
    ;;
esac

# ─── run + report ────────────────────────────────────────────────────────────

OUT="${SCRATCH}/sweep.out"
bash "$SWEEP" > "$OUT" 2>&1
RC=$?

_json_array() {   # stdin: one integer per line → [a,b,c]
  local first=1 v out="["
  while IFS= read -r v; do
    [[ -n "$v" ]] || continue
    if [[ "$first" == 1 ]]; then out="${out}${v}"; first=0; else out="${out},${v}"; fi
  done
  printf '%s]' "$out"
}

# The kill mock records the full argv it was handed: "2001" or "-9 2001". The pid
# is always the LAST field.
SIGNALLED="$(awk 'NF { print $NF }' "$KILL_LOG" | grep -E '^[0-9]+$' | sort -n -u | _json_array)"
SIGNALS="$(awk 'NF { n++ } END { print n+0 }' "$KILL_LOG")"
RECLAIMED="$(grep -F 'vector=orphan_proc' "$OTEL_LOG" 2>/dev/null \
  | sed -n 's/.*resource=\([0-9]*\).*/\1/p' | sort -n -u | _json_array)"
LOG_B64="$(base64 < "$OUT" | tr -d '\n')"

printf '{"scenario":"%s","exit":%d,"signalled":%s,"signals":%d,"reclaimed":%s,"logB64":"%s"}\n' \
  "$SCENARIO" "$RC" "$SIGNALLED" "$SIGNALS" "$RECLAIMED" "$LOG_B64"
