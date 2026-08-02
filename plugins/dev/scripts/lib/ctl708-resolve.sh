#!/usr/bin/env bash
# lib/ctl708-resolve.sh — CTL-708: bounded-LLM arbitrary source-conflict
# resolver. Installs a real implementation over worktree-rebase.sh's
# ctl708_escalate() stub (which itself stays untouched — a pure git/bash
# file by design; see its header). Mirrors the recovery-pass skill's own
# Rubric Two guidance for a human/agent operator resolving an rc=2 stall
# by hand ("read both sides... pick the resolution consistent with the
# ticket's goal... bounded-LLM engineering, not an automatic escalation"),
# now automated for the highest-volume call site — phase-agent-dispatch's
# pre-flight rebase — which runs BEFORE any phase agent exists to do this.
#
# Opt-in, OFF by default. Sourcing this file alone is inert; the caller
# must also call ctl708_wire_resolver, which only installs the override
# when CATALYST_CTL708_ENABLE is set. Two explicit steps (source + wire)
# is deliberate belt-and-braces against an accidental behavior change on
# a live fleet — this closes a real incident where an operator kept
# clicking "retry" on an rc=2 stall, which can never succeed against an
# unimplemented resolver: the stall is deterministic, not transient.
#
# Downstream safety net: this only ever STAGES a resolution (git add); it
# never continues the rebase or pushes. The existing verify->remediate
# pipeline phase still reviews the actual diff (tests, code review,
# reward-hacking scan) before anything ships — a wrong resolution here is
# caught there, exactly as a human-authored diff would be. This is not a
# bypass of that gate, and it changes nothing about it.

set -uo pipefail

if [[ -n "${__CATALYST_CTL708_RESOLVE_SOURCED:-}" ]]; then return 0; fi
__CATALYST_CTL708_RESOLVE_SOURCED=1

_CTL708_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rebase-telemetry.sh
[[ -f "${_CTL708_DIR}/rebase-telemetry.sh" ]] && source "${_CTL708_DIR}/rebase-telemetry.sh" 2>/dev/null || true
# shellcheck source=./executor.sh
[[ -f "${_CTL708_DIR}/executor.sh" ]] && source "${_CTL708_DIR}/executor.sh" 2>/dev/null || true

# Bounds are read fresh from the environment on every call (not cached at
# source time) — both so a caller can tune them per-invocation without
# re-sourcing, and so tests can flip them between calls in the same process.
# Each conflict contributes at least 3 marker lines (<<<<<<<, =======,
# >>>>>>>); CTL708_MAX_MARKER_LINES is therefore a marker-LINE bound, not a
# conflict-count bound, so it also catches one huge conflict as well as many
# small ones.

# ctl708_wire_resolver — call AFTER sourcing worktree-rebase.sh to install the
# real resolver in place of its stub. No-op unless CATALYST_CTL708_ENABLE is
# a non-empty string.
ctl708_wire_resolver() {
  [[ -n "${CATALYST_CTL708_ENABLE:-}" ]] || return 0
  # shellcheck disable=SC2317  # invoked indirectly via the overridden name
  ctl708_escalate() { _ctl708_llm_resolve "$@"; }
}

# _ctl708_build_prompt FILES… — stdout the resolver prompt. Split out for
# unit testing (assert on wording/structure without spawning a process).
_ctl708_build_prompt() {
  local files=("$@")
  cat <<'PROMPT_HEAD'
You are resolving git merge conflicts left by an automated rebase, inside a
real git worktree on disk. Each file listed below currently contains git
conflict markers (<<<<<<< HEAD / ======= / >>>>>>>). For each one:

1. Read BOTH sides in full (open the file, use `git log --merge` / `git diff`
   as needed) and understand what each side is trying to accomplish.
2. If both sides are purely additive (different, non-overlapping changes),
   keep both.
3. If they genuinely conflict, pick the resolution most consistent with
   correctness and the apparent intent of each side. Prefer preserving
   functionality from both over silently dropping one side's work.
4. Edit the file in place so NO conflict markers remain anywhere in it.
5. If you cannot resolve a file with reasonable confidence, leave that
   file's markers exactly as they are — a human will review it. Do not
   guess. Partial progress (some files resolved, one left with markers)
   is fine and expected in that case.

Do not run `git add`, `git rebase --continue`, or any git command that
changes repository state beyond editing the listed files' contents — the
caller handles staging and continuation.

Files with conflicts:
PROMPT_HEAD
  local f
  for f in "${files[@]}"; do printf -- '- %s\n' "$f"; done
}

# _ctl708_llm_resolve FILES… — the real implementation. Returns 0 iff every
# listed file's conflict markers are gone AND the files are staged; returns 1
# (unresolved) on any bound violation, missing binary, LLM failure, timeout,
# or a resolution that still contains markers in ANY listed file — the
# caller's existing terminal-stall path is the safe fallback in every
# failure case, unchanged from today.
_ctl708_llm_resolve() {
  local files=("$@")
  local orch="${ORCH_ID:-}" ticket="${TICKET:-}" phase="${PHASE:-}"
  local max_files="${CATALYST_CTL708_MAX_FILES:-6}"
  local max_marker_lines="${CATALYST_CTL708_MAX_MARKER_LINES:-120}"
  local turn_cap="${CATALYST_CTL708_TURN_CAP:-15}"
  local timeout_s="${CATALYST_CTL708_TIMEOUT_S:-240}"
  local files_json
  files_json="$(printf '%s\n' "${files[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]")"

  if [[ ${#files[@]} -eq 0 ]]; then
    return 1
  fi

  if [[ ${#files[@]} -gt $max_files ]]; then
    emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
      --outcome declined --files "$files_json" \
      --reason "file_count ${#files[@]} exceeds max_files=$max_files" 2>/dev/null || true
    return 1
  fi

  local marker_lines=0 f
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      return 1
    fi
    marker_lines=$(( marker_lines + $(grep -cE '^(<<<<<<<|=======|>>>>>>>)' "$f" 2>/dev/null || echo 0) ))
  done
  if [[ $marker_lines -gt $max_marker_lines ]]; then
    emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
      --outcome declined --files "$files_json" \
      --reason "marker_lines $marker_lines exceeds max_marker_lines=$max_marker_lines" 2>/dev/null || true
    return 1
  fi

  local claude_bin
  claude_bin="$(type executor_claude_bin >/dev/null 2>&1 && executor_claude_bin || echo "${CATALYST_DISPATCH_CLAUDE_BIN:-claude}")"
  if ! command -v "$claude_bin" >/dev/null 2>&1; then
    emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
      --outcome failed --files "$files_json" --reason "claude_bin_not_found" 2>/dev/null || true
    return 1
  fi

  local prompt out rc
  prompt="$(_ctl708_build_prompt "${files[@]}")"
  if command -v timeout >/dev/null 2>&1; then
    out=$(printf '%s' "$prompt" | timeout "${timeout_s}s" \
      "$claude_bin" -p --dangerously-skip-permissions --max-turns "$turn_cap" 2>&1)
    rc=$?
  else
    out=$(printf '%s' "$prompt" | \
      "$claude_bin" -p --dangerously-skip-permissions --max-turns "$turn_cap" 2>&1)
    rc=$?
  fi

  if [[ $rc -ne 0 ]]; then
    emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
      --outcome failed --files "$files_json" --reason "resolver_exit_${rc}" 2>/dev/null || true
    return 1
  fi

  for f in "${files[@]}"; do
    if grep -qE '^(<<<<<<<|=======|>>>>>>>)' "$f" 2>/dev/null; then
      emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
        --outcome markers-remained --files "$files_json" --reason "$f" 2>/dev/null || true
      return 1
    fi
  done

  git add -- "${files[@]}" 2>/dev/null
  emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
    --outcome resolved --files "$files_json" --reason "" 2>/dev/null || true
  return 0
}
