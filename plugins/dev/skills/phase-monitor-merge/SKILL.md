---
name: phase-monitor-merge
description: |
  Phase-agent that watches the open PR through to merge (CTL-449 Initiative 1
  Phase 3). Lifts the active listen loop from the legacy `oneshot` Phase 5
  body: event-driven wait on `catalyst-events wait-for`, inline resolution of
  CI fix-ups, bot review threads, and BEHIND rebases, then `gh pr merge
  --squash` (worktree-safe, CTL-56) when the PR reaches CLEAN. Linear Done transition
  and worktree teardown are owned by phase-teardown (CTL-703). Dispatched as
  a `claude --bg` job by `phase-agent-dispatch`, which invokes it via slash
  command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Task
---

# phase-monitor-merge

Phase-agent that drives an open PR to a squash merge via a reactive listen loop
(catalyst-events wait-for; github.pr.merged / github.check_suite / github.pr_review
filter), then posts the Linear mirror and emits the terminal event.

## /goal condition

Plan §"Per-phase /goal conditions":

```
/goal "`gh pr view --json merged` returns `true` for the PR linked to
       ${TICKET} (PR #${PR_NUMBER}) AND I have posted the merge mirror
       comment to Linear and emitted phase-monitor-merge.complete (I have
       printed both confirmations to my transcript);
       OR 24 wall-clock hours have elapsed without merge completion
       and I have recorded status:timeout."
```

Wall-clock cap is 24h (per plan §Failure handling).

## Load on demand

| Situation | Reference |
|---|---|
| Prerequisites, prelude (signal, comms, session, status, EMIT variable) | [prelude.md](references/prelude.md) |
| Reactive listen loop: catalyst-events wait-for, state machine (clean/blocked/behind/dirty), human/bot reviewer detection, yield guidance | [listen-loop.md](references/listen-loop.md) |
| Merge entry: CTL-1051 stale-ref guard (draft_pr_push_verify, head.sha), CTL-1680 reviewer-arrival window (PHASE_REVIEWER_ARRIVAL_WAIT_SEC, REVIEWED_HEAD, HEAD_EXPOSED_AT, pushedDate, fromdateiso8601) | [merge-reviewer.md](references/merge-reviewer.md) |
| Merge reviewer check: CLEAN_PASS_RE, commit_id-scoped verdict (commit_id == $h), UNRESOLVED_BOT_THREADS + HUMAN thread count, Reviewed commit detection | [merge-threads.md](references/merge-threads.md) |
| Merge execution: MERGE_WAKE_TIMEOUT_SEC, gh pr merge --squash, PHASE_MERGE_SHA_RETRIES (sleep 2, merge_commit_sha still empty after), git/refs/heads/ --method DELETE | [merge-execute.md](references/merge-execute.md) |
| Compound-log closing entry and cross-ticket retro | [compound-log.md](references/compound-log.md) |
| End block mirror: phase-monitor-merge-mirror fence, .linear-mirror- marker, linear-comment-post.sh, statusCheckRollup, phase-mirror-footer.sh — phase-monitor-merge: linear-comment-post failed (continuing) | [mirror.md](references/mirror.md) |
| End block: thoughts-doc, terminal emit, failure handling, comms discipline, why thin wrapper | [end-block.md](references/end-block.md) |
