# lib/resume.sh — shared `claude --bg --resume` stderr classifier (CTL-658).
#
# Single source of truth for the launched/alive/failed decision used by both
# the legacy bash revive path (orchestrate-revive) and the daemon revive path
# (phase-agent-dispatch --resume-session). Extracted from orchestrate-revive's
# inline classify_resume_stderr (CTL-604) so the two paths cannot drift.
#
# The resume-id RESOLVER stays per-runtime — bash `resolve_phase_session_id`
# (orchestrate-revive) and JS `resolvePhaseSessionId` (recovery.mjs) read the
# same ~/.claude/jobs/<bg>/state.json contract but run in different runtimes.
# Only this classifier is shared.
#
# Source me; do not execute. Kept POSIX-ish (no bashisms) so any sh-family
# caller can source it safely.

# classify_resume_stderr — map a `claude --bg --resume` attempt's stderr to one
# of three outcomes so the caller never records a false successful revive:
#   "launched"  empty stderr — a clean resume (the normal path).
#   "alive"     the agent is still running as a bg job; the resume was rejected
#               ("currently running as a background agent (bg)" / "already
#               running as a background agent"). The worker is NOT dead — the
#               caller must NOT spawn a duplicate or record a successful revive.
#   "failed"    any other non-empty stderr — a hard resume error; the caller
#               falls back to a fresh start (phase-agent-dispatch) or records a
#               spawn failure (orchestrate-revive).
classify_resume_stderr() {
  local stderr_text="$1"
  if [ -z "$stderr_text" ]; then
    echo "launched"
    return 0
  fi
  if printf '%s' "$stderr_text" \
       | grep -qiE "currently running as a background agent \(bg\)|already running as a background agent"; then
    echo "alive"
    return 0
  fi
  echo "failed"
}
