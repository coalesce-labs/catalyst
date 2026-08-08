#!/usr/bin/env bash
# phase-signal-freshness.sh — detect a post-PR phase signal left over from a
# previous pipeline run (CTL-1667). A post-PR signal is STALE-for-this-run when
# it names a different PR number than the current run's phase-pr.json, or predates
# that phase-pr.json's timestamp. Only the three phases that run after the PR is
# opened are in scope; all others are always "fresh" (out of scope for this guard).

POST_PR_PHASES=(monitor-merge monitor-deploy teardown)

# _iso_epoch — convert an ISO-8601 UTC string to epoch seconds.
# Supports BSD date (macOS -j -f) and GNU date (-d). Returns empty on failure.
_iso_epoch() {
  local ts="$1"
  [[ -z "$ts" ]] && { printf ''; return; }
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null \
    || date -u -d "$ts" +%s 2>/dev/null \
    || printf ''
}

# is_poststale_signal WORKER_DIR PHASE
#   → exit 0  if the signal is STALE for the current run (safe to re-launch)
#   → exit 1  if the signal is FRESH / the answer is unknown (do not re-launch)
#
# Conservative: any ambiguity (missing file, unresolvable timestamp, no phase-pr)
# returns FRESH (exit 1) — we never re-launch spuriously due to a data gap.
is_poststale_signal() {
  local dir="$1" phase="$2"

  # Out of scope — only post-PR phases are checked.
  local p is_post=1
  for p in "${POST_PR_PHASES[@]}"; do
    [[ "$p" == "$phase" ]] && is_post=0
  done
  [[ $is_post -eq 0 ]] || return 1   # not a post-PR phase → fresh

  local sig="${dir}/phase-${phase}.json"
  local pr="${dir}/phase-pr.json"

  # If either file is absent we cannot prove staleness — conservative fresh.
  [[ -f "$sig" && -f "$pr" ]] || return 1

  local sig_pr cur_pr
  sig_pr="$(jq -r '.pr.number // empty' "$sig" 2>/dev/null)"
  cur_pr="$(jq -r '.pr.number // empty' "$pr"  2>/dev/null)"

  # PR-number mismatch is definitive staleness — takes precedence over timestamps
  # (a newer signal with an old PR# is absolutely from the prior run).
  if [[ -n "$sig_pr" && -n "$cur_pr" && "$sig_pr" != "$cur_pr" ]]; then
    return 0  # STALE
  fi

  # Timestamp ordering: signal must be older than the current run's PR opener.
  local sig_ts pr_ts
  sig_ts="$(jq -r '.updatedAt // .startedAt // empty' "$sig" 2>/dev/null)"
  pr_ts="$(jq -r '.updatedAt // .startedAt // empty' "$pr"  2>/dev/null)"

  local se pe
  se="$(_iso_epoch "$sig_ts")"
  pe="$(_iso_epoch "$pr_ts")"

  # Unresolvable timestamps — fail-safe: cannot prove stale → fresh.
  [[ -n "$se" && -n "$pe" ]] || return 1

  [[ "$se" -lt "$pe" ]] && return 0  # signal predates current run's PR → STALE

  return 1  # fresh
}
