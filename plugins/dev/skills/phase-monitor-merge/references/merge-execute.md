# Merge Execution: Thread Checks, Window, and gh pr merge

Continuing from [merge-threads.md](merge-threads.md) — thread counts and REVIEWER_VERDICT_PRESENT are set.

```bash
if [[ "$UNRESOLVED_THREAD_QUERY_FAILED" == true ]]; then
  echo "wake: pr#${PR_NUMBER} unresolved-thread lookup failed; NOT merging until it succeeds (fail-closed)"
  continue  # re-enter the loop; never risk merging past an unconfirmed finding
fi
if [[ "$UNRESOLVED_HUMAN_THREADS" -gt 0 ]]; then
  # `continue`: nothing this loop can do will resolve it, so re-waiting would spin until
  # the 24h cap. Checked BEFORE the bot branch so a PR carrying both goes to the operator
  # instead of silently auto-remediating half of it and merging.
  HUMAN_THREAD_REASON="pr#${PR_NUMBER} has ${UNRESOLVED_HUMAN_THREADS} unresolved human review thread(s) (${UNRESOLVED_HUMAN_AUTHORS}) — operator action required"
  echo "wake: ${HUMAN_THREAD_REASON}"
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$HUMAN_THREAD_REASON"
  [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
    "phase-monitor-merge failed: ${HUMAN_THREAD_REASON}" \
    --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
  exit 1
fi
if [[ "$UNRESOLVED_BOT_THREADS" -gt 0 ]]; then
  # CTL-1680 (Codex #3079 re-review P1): dispatch the existing review-remediation path
  # instead of merely re-waiting — a bare `continue` here left the PR permanently wedged
  # whenever conversation resolution isn't branch-protected (mergeable_state stays "clean"
  # and no later wake ever differs from this one, so every future iteration repeats the
  # same continue forever). Mirrors oneshot's Phase 5 `blocked` handling: same skill
  # invocation, same one-dispatch-per-wake shape.
  echo "wake: pr#${PR_NUMBER} has ${UNRESOLVED_BOT_THREADS} unresolved automated-review thread(s); dispatching /catalyst-dev:review-comments"
  /catalyst-dev:review-comments "$PR_NUMBER"
  continue  # re-enter the loop; re-evaluate mergeable_state + threads fresh next iteration
fi
if [[ "$REVIEWER_VERDICT_PRESENT" != true && -n "${HEAD_AGE_SEC:-}" ]]; then
  if [[ "$HEAD_AGE_SEC" -lt "$PHASE_REVIEWER_ARRIVAL_WAIT_SEC" ]]; then
    # CTL-1680 (Codex #3079 P2): BOUND the re-wait by the time left in the window, so
    # we re-evaluate when the window elapses even if NO further PR-lifecycle event
    # wakes us (the general listen-loop wait can otherwise block 600s on the broker
    # path or 180+7200s on the raw path — far past a 300s window). Export the remaining
    # seconds; the reused wait-for MUST cap its --timeout at MERGE_WAKE_TIMEOUT_SEC.
    MERGE_WAKE_TIMEOUT_SEC=$(( PHASE_REVIEWER_ARRIVAL_WAIT_SEC - HEAD_AGE_SEC ))
    export MERGE_WAKE_TIMEOUT_SEC
    echo "wake: reviewer-arrival window — pr#${PR_NUMBER} CLEAN but no automated-reviewer verdict on ${REVIEWED_HEAD:0:8} (age ${HEAD_AGE_SEC}s < ${PHASE_REVIEWER_ARRIVAL_WAIT_SEC}s); waiting up to ${MERGE_WAKE_TIMEOUT_SEC}s"
    continue  # re-enter the event-wait loop (timeout-bounded by MERGE_WAKE_TIMEOUT_SEC); a pr_review wake or the deadline re-evaluates
  fi
  echo "phase-monitor-merge: reviewer-arrival window elapsed; proceeding to merge pr#${PR_NUMBER}" >&2
fi
# CTL-56: capture head ref BEFORE merge so we can delete it checkout-free after confirm.
HEAD_REF=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.ref' 2>/dev/null || true)
# Merge via REST only (CTL-56: dropping the local branch-cleanup flag avoids the
# `git checkout <base>` that fails inside a linked worktree when main is checked
# out in the primary clone). The exit code is now meaningful; REST confirm below
# is the authoritative success gate.
gh pr merge "$PR_NUMBER" --squash
# REST is authoritative — confirm via REST, never GraphQL
MERGED_OK=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")
[[ "$MERGED_OK" = "true" ]] || { echo "phase-monitor-merge: merge not confirmed via REST" >&2; exit 1; }

# CTL-1680: retry empty merge_commit_sha — GitHub can return it empty for a few
# seconds after a squash merge while it computes the SHA. Bounded + sleeps (no
# GNU `timeout` dependency; portable to stock macOS).
PHASE_MERGE_SHA_RETRIES="${PHASE_MERGE_SHA_RETRIES:-5}"
MERGE_COMMIT_SHA=""
# CTL-1680 (Codex #3079 P1 portability): a portable counting `while` loop, NOT `seq` —
# stock macOS (the fleet's primary launchd environment) ships no `seq` binary unless GNU
# coreutils is installed, so `$(seq 1 N)` there expands to nothing and this loop silently
# runs zero times, leaving MERGE_COMMIT_SHA empty on every successful merge. A bash
# arithmetic while-loop needs no external command.
_sha_retry=1
while [[ "$_sha_retry" -le "$PHASE_MERGE_SHA_RETRIES" ]]; do
  MERGE_COMMIT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merge_commit_sha // empty' 2>/dev/null || true)
  [[ -n "$MERGE_COMMIT_SHA" ]] && break
  sleep 2
  _sha_retry=$((_sha_retry + 1))
done
[[ -z "$MERGE_COMMIT_SHA" ]] && \
  echo "phase-monitor-merge: merge_commit_sha still empty after ${PHASE_MERGE_SHA_RETRIES} attempts for pr#${PR_NUMBER}" >&2
MERGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Record merge in signal file.
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$MERGED_AT" --arg sha "${MERGE_COMMIT_SHA:-}" \
   '.pr.mergedAt = $ts | .pr.ciStatus = "merged"
    | (if $sha != "" then .pr.mergeCommitSha = $sha else . end)
    | .updatedAt = $ts' \
   "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"

# CTL-56: delete the remote head ref checkout-free, AFTER merge is REST-confirmed and SHA
# recorded. Idempotent + best-effort: a 404/422 means the ref is already gone or protected;
# never fail the phase on branch cleanup — the merge already landed.
if [[ -n "${HEAD_REF:-}" ]]; then
  # CTL-56: URL-encode the head ref (preserve '/') so a metacharacter like '#' in a branch name
  # (e.g. feature#123) can't truncate the endpoint into deleting the wrong ref.
  enc_ref=$(printf '%s' "$HEAD_REF" | jq -sRr @uri | sed 's|%2F|/|g')
  gh api --method DELETE "repos/${REPO}/git/refs/heads/${enc_ref}" >/dev/null 2>&1 \
    || echo "CTL-56: remote branch ${HEAD_REF} delete skipped (already gone or protected)" >&2
fi

# CTL-703: Linear Done is written by phase-teardown (10th phase), not here.
echo "phase-monitor-merge: pr#${PR_NUMBER} merged at ${MERGED_AT}"

# CTL-703: worktree + branch removal moved to phase-teardown.
```

Deployment verification (`skipDeployVerification=false`) is **not** in this phase's scope — that is
`phase-monitor-deploy`. This skill exits cleanly the moment the merge lands and the End-block mirror
is posted (CTL-703: Linear Done and worktree teardown happen in phase-teardown).
