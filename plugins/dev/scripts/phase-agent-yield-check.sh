#!/usr/bin/env bash
# Codified bg_job_id yield helper (CTL-615).
#
# Returns 0 (yield fired) when the running process is a redispatch duplicate
# of another live phase-agent worker — caller MUST exit 0 without touching
# the signal file and without emitting any phase event. Returns 1 (proceed)
# otherwise: canonical worker, missing env, or canonical job dir reaped.
#
# Encodes operator memories #43/#44/#49/#50 into code:
# - Read signal.bg_job_id.
# - If it matches $(basename $CLAUDE_JOB_DIR) → we are canonical, proceed.
# - If it names a DIFFERENT job AND that job's $JOBS_ROOT dir still exists →
#   we are a duplicate of a live worker, yield (write sidecar, exit 0).
# - Otherwise (canonical reaped, missing env, malformed signal) → proceed;
#   the caller's normal prelude handles the edge case.
#
# Failure mode is fail-open: any internal error (missing jq, unreadable
# signal, etc.) returns 1 so the caller falls through to normal prelude
# rather than hanging silently. This is deliberate — a false-positive
# yield is far worse than a missed yield, because it would silently drop
# work on the floor.

set -uo pipefail

SIGNAL=""
JOBS_ROOT="${HOME}/.claude/jobs"
PHASE=""
WORKER_DIR=""

usage() {
  cat >&2 <<EOF
usage: phase-agent-yield-check.sh \\
  --signal <signal.json> \\
  --phase <phase-name> \\
  --worker-dir <orch/workers/TICKET> \\
  [--jobs-root <dir>]

Exit codes:
  0   yield fired (sidecar written; caller MUST exit 0)
  1   proceed with normal prelude
  2   bad invocation (missing required args)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --signal)     SIGNAL="$2"; shift 2 ;;
    --jobs-root)  JOBS_ROOT="$2"; shift 2 ;;
    --phase)      PHASE="$2"; shift 2 ;;
    --worker-dir) WORKER_DIR="$2"; shift 2 ;;
    -h|--help)    usage; exit 2 ;;
    *)            echo "phase-agent-yield-check: unknown arg $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$SIGNAL" || -z "$PHASE" || -z "$WORKER_DIR" ]]; then
  echo "phase-agent-yield-check: --signal, --phase, --worker-dir are required" >&2
  exit 2
fi

# Fail-open paths: any of these → proceed (exit 1), do nothing destructive.
[[ -f "$SIGNAL" ]] || exit 1
[[ -n "${CLAUDE_JOB_DIR:-}" ]] || exit 1
command -v jq >/dev/null 2>&1 || exit 1

OUR_JOB="$(basename "${CLAUDE_JOB_DIR}")"
OTHER_JOB="$(jq -r '.bg_job_id // empty' "$SIGNAL" 2>/dev/null || true)"

# Canonical worker — no yield.
if [[ -z "$OTHER_JOB" || "$OTHER_JOB" == "$OUR_JOB" ]]; then
  exit 1
fi

# Duplicate-but-canonical-reaped — no yield.
if [[ ! -d "${JOBS_ROOT}/${OTHER_JOB}" ]]; then
  exit 1
fi

# Real yield case — write sidecar, emit reap-intent so the daemon reaper can
# `claude stop` our supervisor (CTL-649). Pre-CTL-649 the yielding worker
# simply exited and left its supervisor entry running as idle — that's the
# inverse-yield ORPHAN class (#2/#3 in CTL-649). The emit is best-effort:
# even if the event log is unwritable, the yield itself proceeds.
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$WORKER_DIR"
cat > "${WORKER_DIR}/.phase-${PHASE}-yield" <<EOF
{"yieldedAt":"${TS}","ourJob":"${OUR_JOB}","canonicalJob":"${OTHER_JOB}","reason":"bg_job_id_mismatch_other_alive","phase":"${PHASE}"}
EOF

# Source emit-reap-intent.sh from sibling lib/.
_yield_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${_yield_script_dir}/lib/emit-reap-intent.sh" ]]; then
  # shellcheck source=./lib/emit-reap-intent.sh
  . "${_yield_script_dir}/lib/emit-reap-intent.sh"
  TICKET_FROM_SIGNAL="$(jq -r '.ticket // empty' "$SIGNAL" 2>/dev/null || echo "")"
  WT_FROM_SIGNAL="$(jq -r '.worktreePath // empty' "$SIGNAL" 2>/dev/null || echo "")"
  emit_reap_intent phase.yield.reap-requested \
    --ticket "${TICKET_FROM_SIGNAL:-unknown}" \
    --phase "$PHASE" \
    --bg-job-id "$OUR_JOB" \
    ${WT_FROM_SIGNAL:+--worktree-path "$WT_FROM_SIGNAL"} \
    --canonical-bg-job-id "$OTHER_JOB" \
    --reason "duplicate-of-canonical" 2>/dev/null || true
fi

exit 0
