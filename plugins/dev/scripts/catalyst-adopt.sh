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
#
# The terminal set is NOT a fixed literal list: it is the project's configured
# terminal state names (single source of truth: .catalyst/config.json stateMap.done
# / stateMap.canceled) unioned with the repository-recognized terminal aliases,
# so a board that renames Done/Canceled — or returns the canceled-category state
# `Duplicate` — is still refused. CTL-1642 Codex P1 (#3175).
# CATALYST_ADOPT_TERMINAL_STATES still overrides the whole set verbatim.
_adopt_terminal_states() {
  if [[ -n "${CATALYST_ADOPT_TERMINAL_STATES:-}" ]]; then
    printf '%s' "${CATALYST_ADOPT_TERMINAL_STATES}"
    return 0
  fi
  # Built-in terminal aliases (repository-recognized completed/canceled names).
  local states="Done,Cancelled,Canceled,Duplicate,Merged"
  # Union with the PROJECT's configured terminal state names.
  local cfg="${CATALYST_CONFIG_JSON:-}"
  if [[ -z "$cfg" ]]; then
    local top
    top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [[ -n "$top" && -f "$top/.catalyst/config.json" ]] && cfg="$top/.catalyst/config.json"
  fi
  if [[ -n "$cfg" && -f "$cfg" ]] && command -v jq >/dev/null 2>&1; then
    local mapped
    mapped="$(jq -r '[.catalyst.linear.stateMap.done, .catalyst.linear.stateMap.canceled]
                     | map(select(. != null and . != "")) | join(",")' "$cfg" 2>/dev/null || true)"
    [[ -n "$mapped" ]] && states="${states},${mapped}"
  fi
  printf '%s' "$states"
}
TERMINAL_STATES="$(_adopt_terminal_states)"

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
  # No replica helper available. Per AGENTS.md's replica-read contract a bare
  # `linearis issues read` here would 429 the shared-quota fleet AND bypass the
  # freshness gate — forbidden even as a fallback. Refuse loudly instead; the
  # caller reads the empty state as state_read_failed and refuses to mutate
  # (fail-safe). CTL-1642 Codex P2 (#3175).
  printf 'catalyst-adopt: linear-read-replica.sh unavailable; refusing bare linearis read (AGENTS.md replica-read contract)\n' >&2
  return 1
}

# ─── Worktree resolution ──────────────────────────────────────────────────────

# Resolve the worktree for <ticket> from `git worktree list --porcelain`.
# Returns 0 + path on a unique match, 2 on ambiguity (>1 distinct worktree), 1 on
# none. Matching is bounded to the COMPLETE ticket id so a short id (CTL-9,
# CTL-1642) can never match a longer sibling branch (CTL-900, ryan/CTL-16420-x);
# and it collects DISTINCT matches and refuses on ambiguity rather than silently
# keeping the last one seen. CTL-1642 Codex P1 (#3175).
_adopt_resolve_worktree() {
  local ticket="$1"
  local porcelain current_path=""
  porcelain="$(git worktree list --porcelain 2>/dev/null)" || return 1
  local line
  local -a matches=()
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        current_path="${line#worktree }"
        ;;
      "branch refs/heads/"*)
        local branch="${line#branch refs/heads/}"
        # A branch belongs to <ticket> iff its ticket segment is EXACTLY <ticket>:
        # the bare id, the id + "-slug", or the same under a "user/" prefix. A
        # longer id that merely starts with <ticket> (CTL-16420 vs CTL-1642) is
        # NOT a match because it is neither "${ticket}" nor "${ticket}-*".
        if [[ "$branch" == "$ticket" \
           || "$branch" == "${ticket}-"* \
           || "$branch" == *"/${ticket}" \
           || "$branch" == *"/${ticket}-"* ]]; then
          local seen=0 m
          for m in ${matches[@]+"${matches[@]}"}; do
            [[ "$m" == "$current_path" ]] && seen=1
          done
          [[ "$seen" -eq 0 ]] && matches+=("$current_path")
        fi
        ;;
    esac
  done <<< "$porcelain"
  if [[ "${#matches[@]}" -gt 1 ]]; then
    printf 'catalyst-adopt: ambiguous worktree for %s — %d candidates: %s (pass --worktree)\n' \
      "$ticket" "${#matches[@]}" "${matches[*]}" >&2
    return 2
  fi
  if [[ "${#matches[@]}" -eq 1 ]]; then
    printf '%s' "${matches[0]}"
    return 0
  fi
  return 1
}

# ─── Source libs (side-effect-free: functions only) ──────────────────────────

SALVAGE_LIB="${PLUGIN_ROOT}/scripts/lib/worktree-salvage.sh"
DRAFT_PR_LIB="${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
REMOVE_GUARD_LIB="${PLUGIN_ROOT}/scripts/lib/worktree-remove-guard.sh"

[[ -f "$SALVAGE_LIB" ]] && source "$SALVAGE_LIB" || true
[[ -f "$DRAFT_PR_LIB" ]] && source "$DRAFT_PR_LIB" || true
[[ -f "$REMOVE_GUARD_LIB" ]] && source "$REMOVE_GUARD_LIB" || true

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
  _wt_rc=0
  WORKTREE="$(_adopt_resolve_worktree "$TICKET")" || _wt_rc=$?
  if [[ "$_wt_rc" -eq 2 ]]; then
    # Ambiguity diagnostic already printed by the resolver; refuse to guess.
    printf 'catalyst-adopt: refusing to guess among multiple worktrees for %s (pass --worktree)\n' "$TICKET" >&2
    exit 1
  fi
  if [[ "$_wt_rc" -ne 0 || -z "$WORKTREE" ]]; then
    printf 'catalyst-adopt: no worktree found for %s (use --worktree to specify)\n' "$TICKET" >&2
    exit 1
  fi
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
  printf '  2. re-assert live-handle guard (refuse if still held)\n' >&2
  printf '  3. infer resume phase (BEFORE the WIP commit)\n' >&2
  printf '  4. WIP commit (if dirty)\n' >&2
  printf '  5. push branch\n' >&2
  printf '  6. ensure draft PR\n' >&2
  printf '  7. dispatch inferred phase via phase-agent-dispatch\n' >&2
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

# Step 2b: re-assert the live-handle guard AFTER salvage and BEFORE any mutation.
# If the "orphaned" worktree is in fact still held (never truly orphaned, or a
# worker re-entered it while salvage ran) we must NOT `git add -A`/commit that
# worker's in-progress bytes, then launch a second worker on top of it. This is
# the guard the header + dry-run plan promise but that the first cut omitted
# (CTL-1642 Codex P1, #3175). Run it while cwd is still OUTSIDE the worktree —
# assert_worktree_removal_safe refuses when cwd is at/under the target, so the
# probe must precede the `cd` below. Fail-closed: an unavailable guard refuses.
if declare -f assert_worktree_removal_safe >/dev/null 2>&1; then
  if ! assert_worktree_removal_safe "$WORKTREE"; then
    printf 'catalyst-adopt: worktree %s still has a live handle; refusing to adopt (retry once truly orphaned)\n' "$WORKTREE" >&2
    _ADOPT_RESULT_REFUSED_REASON="live_handle_present"
    [[ "$JSON_MODE" -eq 1 ]] && _emit_json
    exit 1
  fi
  printf 'catalyst-adopt: live-handle guard clear\n' >&2
else
  printf 'catalyst-adopt: worktree-remove-guard unavailable; refusing to mutate (fail-closed)\n' >&2
  _ADOPT_RESULT_REFUSED_REASON="removal_guard_unavailable"
  [[ "$JSON_MODE" -eq 1 ]] && _emit_json
  exit 1
fi

# Step 3: infer resume phase — BEFORE the WIP commit. Deferring inference until
# after the commit is a trap: the WIP commit makes the tree clean AND ahead of
# origin/main, so implementProbe reads it as completed implementation and infers
# `verify`, skipping any unfinished research/plan/implement work (CTL-1642 Codex
# P1, #3175). Inference is read-only and keys on --cwd + the durable worker
# signals under --orch-dir, so it reflects the TRUE pre-adoption state here.
INFER_SHIM="${PLUGIN_ROOT}/scripts/execution-core/adopt-infer-phase.mjs"
RESUME_PHASE="research"
if [[ -f "$INFER_SHIM" ]]; then
  infer_args=(--ticket "$TICKET" --cwd "$WORKTREE")
  [[ -n "$ORCH_DIR" ]] && infer_args+=(--orch-dir "$ORCH_DIR")
  INFERRED="$(node "$INFER_SHIM" "${infer_args[@]}" 2>/dev/null || \
              bun "$INFER_SHIM" "${infer_args[@]}" 2>/dev/null || \
              echo "research")"
  [[ -n "$INFERRED" ]] && RESUME_PHASE="$INFERRED"
fi
printf 'catalyst-adopt: inferred resume phase: %s\n' "$RESUME_PHASE" >&2
_ADOPT_RESULT_PHASE="$RESUME_PHASE"

# Step 4: WIP commit (if tree is dirty)
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

# Step 5: push branch
printf 'catalyst-adopt: pushing branch\n' >&2
if declare -f draft_pr_push >/dev/null 2>&1; then
  draft_pr_push || printf 'catalyst-adopt: warn: push failed (continuing)\n' >&2
else
  # Fallback: direct push
  git -c core.hooksPath=/dev/null push -u origin HEAD 2>/dev/null || \
    git -c core.hooksPath=/dev/null push origin HEAD 2>/dev/null || \
    printf 'catalyst-adopt: warn: push failed (continuing)\n' >&2
fi

# Step 6: ensure draft PR
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

# Step 7: dispatch the inferred phase (computed in Step 3, before the WIP commit).
# adopt does NOT pre-write a signal file — the dispatcher owns the worker dir +
# signal. Prefer PATH-resolved dispatch so test stubs can shadow the real one.
DISPATCHER="$(command -v phase-agent-dispatch 2>/dev/null || true)"
[[ -z "$DISPATCHER" ]] && DISPATCHER="${PLUGIN_ROOT}/scripts/phase-agent-dispatch"
if [[ -n "$DISPATCHER" && -x "$DISPATCHER" ]]; then
  dispatch_args=(--phase "$RESUME_PHASE" --ticket "$TICKET")
  [[ -n "$ORCH_DIR" ]] && dispatch_args+=(--orch-dir "$ORCH_DIR")
  [[ -n "$ORCH_ID" ]] && dispatch_args+=(--orch-id "$ORCH_ID")
  # Propagate a genuine dispatch failure to the caller instead of reporting a
  # successful adoption. The dispatcher's contract: exit 0 = launched (or an
  # idempotent already-dispatched no-op), exit 1 = arg/config error, exit 2 =
  # missing prior-phase artifact. Only 0 means a worker is (or already was)
  # running; any non-zero means nothing launched, so adopt must surface it.
  # CTL-1642 Codex P1 (#3175).
  _dispatch_rc=0
  "$DISPATCHER" "${dispatch_args[@]}" >&2 || _dispatch_rc=$?
  if [[ "$_dispatch_rc" -ne 0 ]]; then
    printf 'catalyst-adopt: dispatch FAILED (rc=%d) — no worker launched for %s at phase %s\n' \
      "$_dispatch_rc" "$TICKET" "$RESUME_PHASE" >&2
    _ADOPT_RESULT_ADOPTED=false
    _ADOPT_RESULT_REFUSED_REASON="dispatch_failed:rc=${_dispatch_rc}"
    [[ "$JSON_MODE" -eq 1 ]] && _emit_json
    exit "$_dispatch_rc"
  fi
  printf 'catalyst-adopt: dispatch complete\n' >&2
else
  # No dispatcher on PATH or at the expected location: the salvage/commit/push
  # side effects landed but no worker was launched. That is NOT a completed
  # adoption — report it honestly rather than exiting 0 with adopted:true.
  printf 'catalyst-adopt: phase-agent-dispatch not found; salvage+push done but NO worker launched for %s\n' "$TICKET" >&2
  _ADOPT_RESULT_ADOPTED=false
  _ADOPT_RESULT_REFUSED_REASON="dispatcher_not_found"
  [[ "$JSON_MODE" -eq 1 ]] && _emit_json
  exit 1
fi

_ADOPT_RESULT_ADOPTED=true
printf 'catalyst-adopt: done — %s adopted at phase %s\n' "$TICKET" "$RESUME_PHASE" >&2

[[ "$JSON_MODE" -eq 1 ]] && _emit_json
exit 0
