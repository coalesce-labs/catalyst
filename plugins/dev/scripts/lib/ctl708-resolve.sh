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
4. EXCEPTION — do not auto-resolve a public-API conflict. If the conflicting
   hunk is another ticket's already-merged, load-bearing public contract (an
   exported function signature, a public type, a CLI flag, a config schema —
   not a local implementation detail), that is a decision for a human, not
   you. Leave that file's markers exactly as they are, the same as rule 6
   below, so the caller falls through to its terminal-stall path instead of
   continuing the rebase automatically.
5. Edit the file in place so NO conflict markers remain anywhere in it,
   except under rule 4 above.
6. If you cannot resolve a file with reasonable confidence, leave that
   file's markers exactly as they are — a human will review it. Do not
   guess. Partial progress (some files resolved, one left with markers)
   is fine and expected in that case.

Do not run `git add`, `git rebase --continue`, or any git command that
changes repository state beyond editing the listed files' contents — the
caller handles staging and continuation. Do not create, delete, rename, or
edit any file that is not in the "Files with conflicts" list below.

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

  local marker_lines=0 region_lines=0 f count
  for f in "${files[@]}"; do
    if [[ ! -f "$f" ]]; then
      return 1
    fi
    # CTL-708 P1: `grep -cE ... || echo 0` double-prints "0" on a no-match
    # exit (grep -c already prints "0" and exits 1), poisoning the arithmetic
    # below with a two-line operand. Capture the count on its own and let the
    # (harmless, no-match) nonzero grep exit fall through unchecked.
    count="$(grep -cE '^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)' "$f" 2>/dev/null)"
    marker_lines=$(( marker_lines + ${count:-0} ))
    # CTL-708 P2: marker-line count alone is ~3 lines per conflict regardless
    # of payload size, so it can't bound one huge conflict. Also measure the
    # actual conflicted region — every line from <<<<<<< through >>>>>>>,
    # inclusive, across all hunks in the file — and bound on the larger of
    # the two totals below so a single oversized hunk still trips the limit.
    count="$(awk '/^<<<<<<</{c=1} c{n++} /^>>>>>>>/{c=0} END{print n+0}' "$f" 2>/dev/null)"
    region_lines=$(( region_lines + ${count:-0} ))
  done
  if [[ $region_lines -gt $marker_lines ]]; then
    marker_lines=$region_lines
  fi
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

  # CTL-708 P1: snapshot working-tree state before invoking the resolver so
  # its scope can be verified afterward — the resolver runs with
  # --dangerously-skip-permissions, so the prompt's "only touch the listed
  # files" instruction is prose, not enforcement.
  local pre_status
  pre_status="$(git status --porcelain 2>/dev/null)"

  local prompt out rc
  prompt="$(_ctl708_build_prompt "${files[@]}")"
  if command -v timeout >/dev/null 2>&1; then
    out=$(printf '%s' "$prompt" | timeout "${timeout_s}s" \
      "$claude_bin" -p --dangerously-skip-permissions --max-turns "$turn_cap" 2>&1)
    rc=$?
  else
    # No GNU `timeout` on this host — notably stock macOS, the fleet's
    # primary launchd environment, ships neither `timeout` nor `gtimeout`.
    # Enforce CATALYST_CTL708_TIMEOUT_S ourselves: run the resolver in the
    # background, capture its output to a scratch file, and a watchdog kills
    # it if it outlives the deadline (AGENTS.md "Working the Loop" pattern —
    # the watchdog sleeps, it never spins).
    local out_file
    out_file="$(mktemp -t ctl708-resolve-out-XXXXXX)"
    printf '%s' "$prompt" | \
      "$claude_bin" -p --dangerously-skip-permissions --max-turns "$turn_cap" \
      >"$out_file" 2>&1 &
    local resolver_pid=$!
    ( sleep "$timeout_s"; kill "$resolver_pid" 2>/dev/null ) &
    local watchdog_pid=$!
    wait "$resolver_pid"
    rc=$?
    kill "$watchdog_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null
    out="$(cat "$out_file" 2>/dev/null)"
    rm -f "$out_file"
  fi

  if [[ $rc -ne 0 ]]; then
    emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
      --outcome failed --files "$files_json" --reason "resolver_exit_${rc}" 2>/dev/null || true
    return 1
  fi

  for f in "${files[@]}"; do
    if grep -qE '^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)' "$f" 2>/dev/null; then
      emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
        --outcome markers-remained --files "$files_json" --reason "$f" 2>/dev/null || true
      return 1
    fi
  done

  # CTL-708 P1: refuse to stage anything the resolver touched outside the
  # files we handed it — an errant tool call, or instructions embedded in
  # repository content the resolver read, could otherwise stage an unrelated
  # change that `git rebase --continue` folds into the rebased commit.
  local post_status changed_path known wf
  post_status="$(git status --porcelain 2>/dev/null)"
  while IFS= read -r changed_path; do
    [[ -z "$changed_path" ]] && continue
    changed_path="${changed_path:3}"
    changed_path="${changed_path#* -> }"
    known=0
    for wf in "${files[@]}"; do
      [[ "$changed_path" == "$wf" ]] && { known=1; break; }
    done
    if [[ $known -eq 0 ]]; then
      emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
        --outcome declined --files "$files_json" \
        --reason "unexpected_change:${changed_path}" 2>/dev/null || true
      return 1
    fi
  done < <(comm -13 <(printf '%s\n' "$pre_status" | sort) <(printf '%s\n' "$post_status" | sort))

  if ! git add -- "${files[@]}" 2>/dev/null; then
    emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
      --outcome failed --files "$files_json" --reason "git_add_failed" 2>/dev/null || true
    return 1
  fi
  emit_ctl708_resolution --orch "$orch" --ticket "$ticket" --phase "$phase" \
    --outcome resolved --files "$files_json" --reason "" 2>/dev/null || true
  return 0
}
