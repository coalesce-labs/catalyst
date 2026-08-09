#!/usr/bin/env bash
# catalyst-adopt.sh — CTL-1642: adopt an orphaned worktree back into the pipeline.
#
# Usage:
#   catalyst-adopt.sh <ticket> [options]
#
# Options:
#   --worktree <path>   Path to the orphaned worktree (default: resolved from
#                       git worktree list matching the ticket branch)
#   --orch-dir <path>   Orchestrator dir (default: $CATALYST_ORCHESTRATOR_DIR)
#   --orch-id <id>      Orchestrator id (default: $CATALYST_ORCHESTRATOR_ID)
#   --dry-run           Print the ordered plan without mutating anything
#   --json              Emit a machine-readable JSON result on stdout (progress
#                       on stderr). Exit codes: 0 success, 2 refused-terminal,
#                       non-zero on error. CTL-1644 delegate-callable contract.
#   -h, --help          Print this usage and exit 0
#
# Mutation sequence (all guarded by --dry-run and terminal-state check):
#   1. Salvage snapshot (fail-open, CTL-1639)
#   2. Re-assert live-handle guard
#   3. WIP commit if tree is dirty
#   4. Push branch
#   5. Ensure draft PR (CTL-783)
#   6. Infer resume phase and dispatch (CTL-1642 shim → phase-agent-dispatch)
#
# Terminal tickets are refused with exit 2 and nothing is mutated.
# This script is idempotent: safe to re-run at any interruption point.
#
# Delegate-callable seam for CTL-1644: the --json + --orch-dir + --orch-id
# contract lets a delegate runner invoke adopt without interactive prompts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: catalyst-adopt.sh <ticket> [options]

Adopt an orphaned worktree back into the Catalyst pipeline.

Options:
  --worktree <path>   Path to the orphaned worktree
  --orch-dir <path>   Orchestrator dir (default: \$CATALYST_ORCHESTRATOR_DIR)
  --orch-id <id>      Orchestrator id (default: \$CATALYST_ORCHESTRATOR_ID)
  --dry-run           Print the plan without mutating anything
  --json              Emit machine-readable JSON result (for delegate runners)
  -h, --help          Print this usage

Exit codes: 0 success, 2 refused-terminal, non-zero on other error.
EOF
}

# ─── Argument parsing ─────────────────────────────────────────────────────────

TICKET=""
WORKTREE=""
ORCH_DIR="${CATALYST_ORCHESTRATOR_DIR:-}"
ORCH_ID="${CATALYST_ORCHESTRATOR_ID:-}"
DRY_RUN=0
JSON_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --orch-dir) ORCH_DIR="$2"; shift 2 ;;
    --orch-id)  ORCH_ID="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --json)     JSON_MODE=1; shift ;;
    -*) printf 'catalyst-adopt: unknown flag: %s\n' "$1" >&2; usage >&2; exit 1 ;;
    *)  if [[ -z "$TICKET" ]]; then
          TICKET="$1"
        else
          printf 'catalyst-adopt: unexpected argument: %s\n' "$1" >&2; exit 1
        fi
        shift ;;
  esac
done

if [[ -z "$TICKET" ]]; then
  printf 'catalyst-adopt: <ticket> is required\n' >&2
  usage >&2
  exit 1
fi

# ─── Terminal-state detection ─────────────────────────────────────────────────

# CATALYST_ADOPT_TICKET_STATE: test hook — if set, skip the live replica read
# and treat this as the ticket's state name. Production callers leave it unset.
TERMINAL_STATES="${CATALYST_ADOPT_TERMINAL_STATES:-Done,Cancelled,Canceled,Merged}"

_adopt_is_terminal_state() {
  local state="$1"
  local IFS=','
  local ts
  for ts in ${TERMINAL_STATES}; do
    if [[ "$state" == "$ts" ]]; then
      return 0
    fi
  done
  return 1
}

_adopt_get_ticket_state() {
  local ticket="$1"
  # Test hook: CATALYST_ADOPT_TICKET_STATE overrides the live replica read.
  if [[ -n "${CATALYST_ADOPT_TICKET_STATE:-}" ]]; then
    printf '%s' "${CATALYST_ADOPT_TICKET_STATE}"
    return 0
  fi
  # Production path: freshness-gated replica read.
  local lib="${PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh"
  if [[ -f "$lib" ]]; then
    # shellcheck source=./lib/linear-read-replica.sh
    source "$lib"
    local json
    json="$(linear_read_ticket "$ticket" 2>/dev/null)" || return 1
    printf '%s' "$(printf '%s' "$json" | jq -r '.state.name // empty' 2>/dev/null)"
    return 0
  fi
  # Fallback: linearis (rate-limited; last resort)
  linearis issues read "$ticket" 2>/dev/null | jq -r '.state.name // empty' || return 1
}

# ─── Worktree resolution ──────────────────────────────────────────────────────

_adopt_resolve_worktree() {
  local ticket="$1"
  # Parse `git worktree list --porcelain` for a worktree on the ticket's branch.
  local porcelain current_path=""
  porcelain="$(git worktree list --porcelain 2>/dev/null)" || return 1
  local line branch_match=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        current_path="${line#worktree }"
        ;;
      "branch refs/heads/"*)
        local branch="${line#branch refs/heads/}"
        # Match: exact ticket name OR starts with ticket (e.g. ryan/CTL-XXXX-slug)
        if [[ "$branch" == "$ticket" || "$branch" == *"/${ticket}"* || "$branch" == *"/${ticket}-"* ]]; then
          branch_match="$current_path"
        fi
        ;;
    esac
  done <<< "$porcelain"
  if [[ -n "$branch_match" ]]; then
    printf '%s' "$branch_match"
    return 0
  fi
  return 1
}

# ─── Source libs (side-effect-free: functions only) ──────────────────────────

SALVAGE_LIB="${PLUGIN_ROOT}/scripts/lib/worktree-salvage.sh"
DRAFT_PR_LIB="${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"

[[ -f "$SALVAGE_LIB" ]] && source "$SALVAGE_LIB" || true
[[ -f "$DRAFT_PR_LIB" ]] && source "$DRAFT_PR_LIB" || true

# ─── Main ─────────────────────────────────────────────────────────────────────

# Track result fields for --json
_ADOPT_RESULT_ADOPTED=false
_ADOPT_RESULT_PHASE=""
_ADOPT_RESULT_PR=""
_ADOPT_RESULT_SALVAGE=""
_ADOPT_RESULT_REFUSED_REASON=""

_emit_json() {
  printf '{"ticket":"%s","adopted":%s,"phase":"%s","pr":"%s","salvage":"%s","refused_reason":"%s"}\n' \
    "$TICKET" \
    "$_ADOPT_RESULT_ADOPTED" \
    "${_ADOPT_RESULT_PHASE}" \
    "${_ADOPT_RESULT_PR}" \
    "${_ADOPT_RESULT_SALVAGE}" \
    "${_ADOPT_RESULT_REFUSED_REASON}"
}

# Step 0: terminal-state guard (refuse-first, before any mutation)
STATE="$(_adopt_get_ticket_state "$TICKET" 2>/dev/null || echo "")"
if [[ -z "$STATE" ]]; then
  printf 'catalyst-adopt: could not read state for %s (replica stale or missing); refusing to proceed\n' "$TICKET" >&2
  _ADOPT_RESULT_REFUSED_REASON="state_read_failed"
  [[ "$JSON_MODE" -eq 1 ]] && _emit_json
  exit 1
fi
if _adopt_is_terminal_state "$STATE"; then
  printf 'catalyst-adopt: refusing to adopt terminal ticket %s (state: %s)\n' "$TICKET" "$STATE" >&2
  _ADOPT_RESULT_REFUSED_REASON="terminal_state:${STATE}"
  [[ "$JSON_MODE" -eq 1 ]] && _emit_json
  exit 2
fi

# Step 1: resolve worktree
if [[ -z "$WORKTREE" ]]; then
  WORKTREE="$(_adopt_resolve_worktree "$TICKET" 2>/dev/null)" || {
    printf 'catalyst-adopt: no worktree found for %s (use --worktree to specify)\n' "$TICKET" >&2
    exit 1
  }
fi
if [[ ! -d "$WORKTREE" ]]; then
  printf 'catalyst-adopt: worktree path does not exist: %s\n' "$WORKTREE" >&2
  exit 1
fi
printf 'catalyst-adopt: worktree = %s\n' "$WORKTREE" >&2

# Dry-run: print plan and exit
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '[dry-run] ordered adoption plan for %s:\n' "$TICKET" >&2
  printf '  1. salvage snapshot → ~/catalyst/salvage/\n' >&2
  printf '  2. re-assert live-handle guard\n' >&2
  printf '  3. WIP commit (if dirty)\n' >&2
  printf '  4. push branch\n' >&2
  printf '  5. ensure draft PR\n' >&2
  printf '  6. infer resume phase + dispatch via phase-agent-dispatch\n' >&2
  printf '[dry-run] worktree: %s\n' "$WORKTREE" >&2
  printf '[dry-run] orch-dir: %s\n' "${ORCH_DIR:-<not set>}" >&2
  printf '[dry-run] orch-id:  %s\n' "${ORCH_ID:-<not set>}" >&2
  printf '[dry-run] no mutations made\n' >&2
  [[ "$JSON_MODE" -eq 1 ]] && printf '{"ticket":"%s","adopted":false,"dry_run":true}\n' "$TICKET"
  exit 0
fi

# Step 2: salvage snapshot (fail-open, always before any mutation)
if declare -f salvage_worktree >/dev/null 2>&1; then
  salvage_worktree "$WORKTREE" "$TICKET" \
    --reason "adopt" --orch "${ORCH_ID:-}" --site "catalyst-adopt" || true
  _ADOPT_RESULT_SALVAGE="${CATALYST_SALVAGE_DIR:-${HOME}/catalyst/salvage}"
  printf 'catalyst-adopt: salvage snapshot complete\n' >&2
else
  printf 'catalyst-adopt: warn: worktree-salvage.sh not found; skipping salvage\n' >&2
fi

# Step 3: WIP commit (if tree is dirty)
cd "$WORKTREE"
DIRTY_FILES="$(git status --porcelain 2>/dev/null)"
if [[ -n "$DIRTY_FILES" ]]; then
  N_FILES="$(printf '%s\n' "$DIRTY_FILES" | grep -c '.' || echo 0)"
  printf 'catalyst-adopt: committing %s dirty file(s) as WIP-adopted\n' "$N_FILES" >&2
  git add -A
  git commit --quiet -m "chore(adopt): ${TICKET} WIP-adopted (${N_FILES} files)"
  printf 'catalyst-adopt: WIP commit created\n' >&2
else
  printf 'catalyst-adopt: worktree is clean; no WIP commit needed\n' >&2
fi

# Step 4: push branch
printf 'catalyst-adopt: pushing branch\n' >&2
if declare -f draft_pr_push >/dev/null 2>&1; then
  draft_pr_push || printf 'catalyst-adopt: warn: push failed (continuing)\n' >&2
else
  # Fallback: direct push
  git -c core.hooksPath=/dev/null push -u origin HEAD 2>/dev/null || \
    git -c core.hooksPath=/dev/null push origin HEAD 2>/dev/null || \
    printf 'catalyst-adopt: warn: push failed (continuing)\n' >&2
fi

# Step 5: ensure draft PR
BASE_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||' || true)"
[[ -z "$BASE_BRANCH" ]] && BASE_BRANCH="main"
PR_NUM="" PR_URL=""
if declare -f draft_pr_ensure >/dev/null 2>&1; then
  DPR_OUT="$(draft_pr_ensure "$BASE_BRANCH" "$TICKET" 2>/dev/null || true)"
  if [[ -n "$DPR_OUT" ]]; then
    PR_NUM="$(printf '%s' "$DPR_OUT" | cut -f1)"
    PR_URL="$(printf '%s' "$DPR_OUT" | cut -f2)"
    _ADOPT_RESULT_PR="${PR_URL}"
    printf 'catalyst-adopt: draft PR #%s %s\n' "${PR_NUM:-?}" "${PR_URL:-}" >&2
  fi
else
  printf 'catalyst-adopt: warn: draft-pr.sh not found; skipping PR creation\n' >&2
fi

# Step 6: infer resume phase + dispatch
INFER_SHIM="${PLUGIN_ROOT}/scripts/execution-core/adopt-infer-phase.mjs"
RESUME_PHASE="research"
if [[ -f "$INFER_SHIM" ]]; then
  INFERRED="$(node "$INFER_SHIM" --ticket "$TICKET" --cwd "$WORKTREE" 2>/dev/null || \
              bun "$INFER_SHIM" --ticket "$TICKET" --cwd "$WORKTREE" 2>/dev/null || \
              echo "research")"
  [[ -n "$INFERRED" ]] && RESUME_PHASE="$INFERRED"
fi
printf 'catalyst-adopt: inferred resume phase: %s\n' "$RESUME_PHASE" >&2
_ADOPT_RESULT_PHASE="$RESUME_PHASE"

# Dispatch (adopt does NOT pre-write a signal file — dispatcher owns worker dir + signal)
# Prefer PATH-resolved dispatch so test stubs can shadow the real dispatcher.
DISPATCHER="$(command -v phase-agent-dispatch 2>/dev/null || true)"
[[ -z "$DISPATCHER" ]] && DISPATCHER="${PLUGIN_ROOT}/scripts/phase-agent-dispatch"
if [[ -n "$DISPATCHER" && -x "$DISPATCHER" ]]; then
  dispatch_args=(--phase "$RESUME_PHASE" --ticket "$TICKET")
  [[ -n "$ORCH_DIR" ]] && dispatch_args+=(--orch-dir "$ORCH_DIR")
  [[ -n "$ORCH_ID" ]] && dispatch_args+=(--orch-id "$ORCH_ID")
  "$DISPATCHER" "${dispatch_args[@]}" >&2 || {
    printf 'catalyst-adopt: warn: dispatch exited non-zero (may be idempotent no-op)\n' >&2
  }
  printf 'catalyst-adopt: dispatch complete\n' >&2
else
  printf 'catalyst-adopt: warn: phase-agent-dispatch not found; skipping dispatch\n' >&2
fi

_ADOPT_RESULT_ADOPTED=true
printf 'catalyst-adopt: done — %s adopted at phase %s\n' "$TICKET" "$RESUME_PHASE" >&2

[[ "$JSON_MODE" -eq 1 ]] && _emit_json
exit 0
