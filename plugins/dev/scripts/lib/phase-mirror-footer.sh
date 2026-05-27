#!/usr/bin/env bash
# lib/phase-mirror-footer.sh — render the shared metadata footer appended to
# every phase-agent Linear "mirror" comment (CTL-632 follow-on).
#
# Prints a 2-line markdown block to stdout:
#
#   ---
#   _model `<model>` · <N> sub-agent(s) launched · active <Xm Ys>_
#   _catalyst session `<sess_…>` · job `<short>` · session uuid `<uuid>` · cwd `<dir>`_
#
# Every field is best-effort and resolved independently — a missing source
# degrades that one field to a placeholder rather than dropping the footer.
# The script ALWAYS exits 0 and always prints at least the `---` + a minimal
# line, because the caller appends our stdout directly into the comment body
# (a non-zero exit or empty output must never corrupt the mirror).
#
# Data sources (all fail-soft):
#   * model / sub-agent count / active duration  ← the worker's conversation
#       JSONL, resolved via the signal file's bg_job_id →
#       ${CATALYST_BG_JOBS_DIR:-~/.claude/jobs}/<bg>/state.json → .linkScanPath
#       (same chain orchestrate-roll-usage.sh uses). Active duration is the sum
#       of `system`/`turn_duration` events — actual compute time, NOT wall-clock,
#       so a phase that mostly waits (e.g. monitor-merge) reports only its work.
#   * catalyst session id  ← $CATALYST_SESSION_ID, else signal .catalystSessionId
#   * long session uuid    ← $CLAUDE_CODE_SESSION_ID, else bg state .sessionId
#   * short job id         ← signal .bg_job_id, else first 8 hex of the uuid
#   * working directory    ← bg state .cwd, else $PWD
#
# Cost/token totals are intentionally NOT emitted: the only reliable number
# excludes sub-agent sessions (see CTL-666 to add a true sub-agent-inclusive
# rollup, likely via OTEL).
#
# Usage: phase-mirror-footer.sh --orch-dir <dir> --ticket <id> --phase <name>

set -uo pipefail

ORCH_DIR="" TICKET="" PHASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --orch-dir) ORCH_DIR="${2:-}"; shift 2 ;;
    --ticket)   TICKET="${2:-}";   shift 2 ;;
    --phase)    PHASE="${2:-}";    shift 2 ;;
    *) shift ;;
  esac
done

emit_minimal_and_exit() {
  printf '%s\n' "---"
  printf '_phase-%s metadata unavailable_\n' "${PHASE:-?}"
  exit 0
}

# Without the signal coordinates we cannot resolve anything useful — still emit
# a footer so the caller's body stays well-formed.
[ -n "$ORCH_DIR" ] && [ -n "$TICKET" ] && [ -n "$PHASE" ] || emit_minimal_and_exit
command -v jq >/dev/null 2>&1 || emit_minimal_and_exit

SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"

CAT_SID="${CATALYST_SESSION_ID:-}"
BG_JOB="" SIG_MODEL=""
if [ -f "$SIGNAL" ]; then
  [ -n "$CAT_SID" ] || CAT_SID="$(jq -r '.catalystSessionId // empty' "$SIGNAL" 2>/dev/null || true)"
  BG_JOB="$(jq -r '.bg_job_id // empty' "$SIGNAL" 2>/dev/null || true)"
  SIG_MODEL="$(jq -r '.model // empty' "$SIGNAL" 2>/dev/null || true)"
fi

# Resolve the bg job state.json → long uuid, cwd, JSONL path.
LONG_UUID="${CLAUDE_CODE_SESSION_ID:-}"
CWD="" JSONL=""
BG_JOBS_DIR="${CATALYST_BG_JOBS_DIR:-${HOME}/.claude/jobs}"
if [ -n "$BG_JOB" ] && [ -f "${BG_JOBS_DIR}/${BG_JOB}/state.json" ]; then
  BG_STATE="${BG_JOBS_DIR}/${BG_JOB}/state.json"
  [ -n "$LONG_UUID" ] || LONG_UUID="$(jq -r '.sessionId // empty' "$BG_STATE" 2>/dev/null || true)"
  CWD="$(jq -r '.cwd // empty' "$BG_STATE" 2>/dev/null || true)"
  JSONL="$(jq -r '.linkScanPath // empty' "$BG_STATE" 2>/dev/null || true)"
fi
[ -n "$CWD" ] || CWD="$(pwd 2>/dev/null || echo '?')"

# short job id: prefer the signal's bg_job_id, else first 8 hex of the uuid.
SHORT="$BG_JOB"
if [ -z "$SHORT" ] && [[ "$LONG_UUID" =~ ^([0-9a-f]{8}) ]]; then
  SHORT="${BASH_REMATCH[1]}"
fi

# model / sub-agent count / active duration from the conversation JSONL.
MODEL="" SUBS="?" ACTIVE_MS=0
if [ -n "$JSONL" ] && [ -f "$JSONL" ]; then
  MODEL="$(jq -rs '[.[]|select(.type=="assistant")][-1].message.model // empty' "$JSONL" 2>/dev/null || true)"
  SUBS="$(jq -rs '[.[]|select(.type=="assistant")|.message.content[]?|select(.type=="tool_use" and ((.name=="Task") or (.name=="Agent")))]|length' "$JSONL" 2>/dev/null || echo '?')"
  ACTIVE_MS="$(jq -rs '[.[]|select(.type=="system" and .subtype=="turn_duration")|.durationMs // 0]|add // 0' "$JSONL" 2>/dev/null || echo 0)"
fi
[ -n "$MODEL" ] || MODEL="${SIG_MODEL:-unknown}"
[ -n "$SUBS" ] || SUBS="?"
[[ "$ACTIVE_MS" =~ ^[0-9]+$ ]] || ACTIVE_MS=0

# Format active duration (ms → "Xm Ys" / "Ys").
fmt_duration() {
  local ms="$1" s m
  s=$(( ms / 1000 ))
  if [ "$s" -ge 60 ]; then
    m=$(( s / 60 )); s=$(( s % 60 ))
    printf '%dm %ds' "$m" "$s"
  else
    printf '%ds' "$s"
  fi
}

# ── Line 1: run metadata ──────────────────────────────────────────────────────
LINE1="model \`${MODEL}\` · ${SUBS} sub-agent(s) launched"
if [ "$ACTIVE_MS" -gt 0 ]; then
  LINE1="${LINE1} · active $(fmt_duration "$ACTIVE_MS")"
fi

# ── Line 2: identifiers + cwd (omit unknown id pieces) ────────────────────────
LINE2="catalyst session \`${CAT_SID:-—}\`"
[ -n "$SHORT" ]     && LINE2="${LINE2} · job \`${SHORT}\`"
[ -n "$LONG_UUID" ] && LINE2="${LINE2} · session uuid \`${LONG_UUID}\`"
LINE2="${LINE2} · cwd \`${CWD}\`"

printf '%s\n' "---"
printf '_%s_\n' "$LINE1"
printf '_%s_\n' "$LINE2"
exit 0
