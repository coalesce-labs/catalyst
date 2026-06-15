#!/usr/bin/env bash
# phase-failure-comment.sh — Best-effort Linear comment on phase failure (CTL-1182 Phase 2).
#
# Called by phase-agent-emit-complete after --status failed or park. Posts the
# phase's .explanation.call_to_action (or --reason) to Linear exactly once,
# gated by CATALYST_FAILURE_COMMENT=1 (injected by phase-agent-dispatch so
# dispatched workers always post; default OFF keeps unit tests clean).
#
# Usage:
#   phase-failure-comment.sh \
#     --ticket <id> \
#     --phase  <name> \
#     [--reason <text>] \
#     [--orch-dir <path>] \
#     [--signal-file <path>]
#
# Always exits 0 — never blocks the caller's lifecycle.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

TICKET=""
PHASE=""
REASON=""
ORCH_DIR="${CATALYST_ORCHESTRATOR_DIR:-}"
SIGNAL_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket)      TICKET="${2:-}";      shift 2 || true ;;
    --phase)       PHASE="${2:-}";       shift 2 || true ;;
    --reason)      REASON="${2:-}";      shift 2 || true ;;
    --orch-dir)    ORCH_DIR="${2:-}";    shift 2 || true ;;
    --signal-file) SIGNAL_FILE="${2:-}"; shift 2 || true ;;
    *) shift ;;
  esac
done

# Gate: only post when explicitly enabled (default OFF = test-isolation boundary).
[[ "${CATALYST_FAILURE_COMMENT:-}" == "1" ]] || exit 0

[[ -n "$TICKET" ]] || exit 0
[[ -n "$PHASE"  ]] || exit 0

# Idempotency marker — mirrors the success .linear-mirror-${PHASE} convention.
MARKER=""
if [[ -n "$ORCH_DIR" ]]; then
  MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-failure-mirror-${PHASE}"
  [[ -e "$MARKER" ]] && exit 0
fi

# Resolve signal file.
if [[ -z "$SIGNAL_FILE" && -n "$ORCH_DIR" ]]; then
  SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
fi

# Build the comment body.
BODY=""
if [[ -f "${SIGNAL_FILE:-}" ]] && command -v jq >/dev/null 2>&1; then
  CALL_TO_ACTION="$(jq -r '.explanation.call_to_action // empty' "$SIGNAL_FILE" 2>/dev/null || true)"
  PROBLEM="$(jq -r '.explanation.problem // empty' "$SIGNAL_FILE" 2>/dev/null || true)"
  if [[ -n "$CALL_TO_ACTION" ]]; then
    BODY="**Phase ${PHASE} failed** (${TICKET})"
    [[ -n "$PROBLEM" ]] && BODY="${BODY}

${PROBLEM}"
    BODY="${BODY}

_${CALL_TO_ACTION}_"
  fi
fi

if [[ -z "$BODY" ]]; then
  BODY="**Phase ${PHASE} failed** (${TICKET}): ${REASON:-unknown failure}"
fi

# Append phase-mirror footer if available (consistency with success mirrors).
FOOTER_SCRIPT="${SCRIPT_DIR}/phase-mirror-footer.sh"
if [[ -x "$FOOTER_SCRIPT" && -n "$ORCH_DIR" ]]; then
  FOOTER="$("$FOOTER_SCRIPT" --orch-dir "$ORCH_DIR" --ticket "$TICKET" --phase "$PHASE" 2>/dev/null || true)"
  [[ -n "$FOOTER" ]] && BODY="${BODY}
${FOOTER}"
fi

# Truncate to stay within Linear's comment limits.
if [[ ${#BODY} -gt 30000 ]]; then
  BODY="${BODY:0:30000}

_... (truncated)_"
fi

# Resolve the comment-post helper (injectable via CATALYST_COMMENT_POST_HELPER for tests).
POSTER="${CATALYST_COMMENT_POST_HELPER:-${SCRIPT_DIR}/linear-comment-post.sh}"

# Post — timeout-bounded so a hung network call cannot delay teardown.
# Wrap in || true: best-effort, never fails the caller.
if [[ -x "$POSTER" ]]; then
  # Prefer `timeout` (GNU coreutils), then `gtimeout` (Homebrew coreutils on macOS),
  # then fall back to a direct (unbounded) exec.
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 "$POSTER" "$TICKET" "$BODY" >/dev/null 2>&1 || true
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 20 "$POSTER" "$TICKET" "$BODY" >/dev/null 2>&1 || true
  else
    "$POSTER" "$TICKET" "$BODY" >/dev/null 2>&1 || true
  fi
  # Write idempotency marker (whether the post succeeded or not — prevents
  # a storm of duplicate posts on restart).
  [[ -n "$MARKER" ]] && : >"$MARKER" || true
fi

exit 0
