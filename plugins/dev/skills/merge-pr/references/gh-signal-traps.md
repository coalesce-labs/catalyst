# GitHub signal traps — two shapes that look like an answer and aren't

Both traps below have burned real waits in this repo. Check both before trusting a bounded-poll result.

## Trap 1: rollup `conclusion` is `""`, not `null`, while running — and empty means "no evidence yet," not "success"

The check-run / status-check rollup exposes `conclusion` as the empty string `""` while a check is still in progress — it is not `null`, and it is falsy in `jq`/bash the same way a real failure string would test true for "not success." A naive test like `[ -z "$CONCLUSION" ] && echo "FAILED"` misreads every in-progress check as a failure the instant you poll it.

A second, easier-to-miss version of the same mistake: if you poll before GitHub has created any check runs at all (the workflow hasn't started, or the repo only uses commit-status contexts instead of check-runs), the check-runs array is empty. An "all completed AND all succeeded" test over an empty array is vacuously true in most languages — `[]`'s "every element passes" is `true` — so it reports `SUCCESS` on zero evidence. Treat an empty result set as `PENDING`, the same as an in-progress check, never as a pass.

**Fix: gate on `status`, and on there being anything to gate on, before ever reading `conclusion`.** `status` is one of `queued` / `in_progress` / `completed`.

```bash
CHECK_JSON=$(gh api "repos/${REPO}/commits/${SHA}/check-runs" --jq '.check_runs')
TOTAL=$(echo "$CHECK_JSON" | jq 'length')
STILL_RUNNING=$(echo "$CHECK_JSON" | jq '[.[] | select(.status != "completed")] | length')

if [ "$TOTAL" -eq 0 ] || [ "$STILL_RUNNING" -gt 0 ]; then
  echo "PENDING"   # no checks yet, or some still running — do not inspect conclusion
else
  FAILED=$(echo "$CHECK_JSON" | jq '[.[] | select(.conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped")] | length')
  [ "$FAILED" -gt 0 ] && echo "FAILED" || echo "SUCCESS"
fi
```

The same trap applies to the PR-level rollup (`gh api repos/{o}/{r}/commits/{sha}/status`, or the `statusCheckRollup` GraphQL field — GraphQL-only, and forbidden by bounded-poll's anti-pattern list on cost grounds alone): always check the aggregate `state`/`status` field first, confirm there is at least one check to aggregate, and only read a per-check `conclusion` once that check is individually `completed`.

## Trap 2: a clean automated review is a reaction, not a review object — and a stale one from a prior push isn't a current pass

The automated PR reviewer (Codex, claude-code-review) signals "no issues found" by leaving a 👍 **reaction** on the PR, or posting a terse issue comment such as "No major issues" — **instead of** opening a review with `state: APPROVED` or `COMMENTED`. A wait that only watches `GET /pulls/{n}/reviews` never sees this and will sit polling for a review object that is never coming.

Two more ways a naive check over-counts: (1) counting *any* review object, from *any* reviewer, in *any* state — including `CHANGES_REQUESTED` from a human — as "reviewed"; and (2) counting *any* prior 👍 reaction on the PR at all, even one left on an earlier commit before the current push, as if it certified the code sitting there right now. Reactions are PR-level, not commit-scoped, so an old clean pass does not disappear when new commits land.

A THIRD trap sits inside that second one: you can't fix it by comparing the reaction's `created_at` against the pushed commit's `.commit.committer.date` — the committer date is client-set at commit-creation time, not server-set at push time, so stacked or rebased commits routinely carry a committer date that PREDATES a reaction that already reviewed an earlier head. A stale reaction then reads as newer than the push it never saw, and the check reports `REVIEWED` on unreviewed code.

**Fix: scope to the specific automated reviewer, exclude an explicit rejection, and use a BASELINE of prior reaction ids — never a timestamp — to prove a reaction is new.** Three mechanical requirements this snippet has to get right: `gh api --jq` takes exactly one query string and has no `--arg`/`--argjson` of its own (those are `jq`'s flags, not `gh api`'s — pipe to a separate `jq` invocation instead); the baseline snapshot must be taken AFTER the push lands, not before, since a review of the still-in-flight OLD head can complete in the gap between an earlier snapshot and the push actually landing; and — because a bounded-poll wait can itself span a LATER push (a remediation or update-branch commit landing mid-wait) — the baseline must be re-captured (and review re-requested) every time `HEAD_SHA` changes, never taken once and reused for the rest of the wait.

```bash
BOT_LOGIN="chatgpt-codex-connector[bot]"   # the automated reviewer configured for this repo — the GitHub App suffix is part of the login, verify with: gh api repos/{owner}/{repo}/pulls/{n}/reviews --jq '[.[].user.login] | unique'

snapshot_baseline() {
  # Call this immediately after any push this loop observes — including one that lands mid-wait, not just the push that started the wait. Sets BASELINE_HEAD_SHA and BASELINE_IDS together so they can never drift apart.
  BASELINE_HEAD_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha')
  BASELINE_IDS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" \
    -H "Accept: application/vnd.github.squirrel-girl-preview+json" \
    | jq --arg bot "$BOT_LOGIN" '[.[] | select(.content == "+1" and .user.login == $bot) | .id]')
  gh pr comment "$PR_NUMBER" --body "@codex review" >/dev/null
}

snapshot_baseline   # first push already landed before entering the wait

# Bounded-poll tick (see bounded-poll.md for the ceiling/interval this sits inside):
HEAD_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha')
if [ "$HEAD_SHA" != "$BASELINE_HEAD_SHA" ]; then
  # A remediation/update-branch push landed mid-wait — the old baseline no longer proves anything about this head. Re-baseline and re-request before evaluating.
  snapshot_baseline
fi

BOT_REVIEW=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
  | jq --arg sha "$HEAD_SHA" --arg bot "$BOT_LOGIN" \
  '[.[] | select(.user.login == $bot and .commit_id == $sha and .state != "CHANGES_REQUESTED")] | length')
NEW_REACTION=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" \
  -H "Accept: application/vnd.github.squirrel-girl-preview+json" \
  | jq --argjson baseline "$BASELINE_IDS" --arg bot "$BOT_LOGIN" \
  '[.[] | select(.content == "+1" and .user.login == $bot and ([.id] | inside($baseline) | not))] | length')

if [ "$BOT_REVIEW" -gt 0 ] || [ "$NEW_REACTION" -gt 0 ]; then
  # Re-confirm the head hasn't moved while the evidence queries above were running —
  # a new push landing mid-tick can leave $HEAD_SHA stale even though the review/reaction
  # calls above genuinely found evidence FOR that now-superseded commit.
  CURRENT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha')
  if [ "$CURRENT_SHA" = "$HEAD_SHA" ]; then
    echo "REVIEWED"
  else
    echo "PENDING"   # head moved under us — this tick's evidence no longer applies; next tick rebaselines
  fi
else
  echo "PENDING"
fi
```

`BOT_REVIEW` stays SHA-scoped (`.commit_id == $sha`), which is exact — a review object really does carry the commit it reviewed. **`NEW_REACTION` cannot reach that same guarantee, and this is a known, honest limitation rather than a solved problem**: a reaction carries no commit or request id at all, so if a review of the OLD head is still in flight when the new push lands and rebaselines, that reaction can arrive AFTER the rebaseline and be misread as evidence for the new head — id-membership only proves "posted after the rebaseline," not "reviewed this exact commit." Treat `BOT_REVIEW` as the authoritative signal and `NEW_REACTION` as a corroborating, best-effort one: the id-baseline still closes the much larger window this trap opened with (an old reaction from before the push at all), it just can't close the narrow one where a stale review request is still actively running across the rebaseline. If a caller needs a stronger guarantee than that, don't treat a reaction as sufficient on its own — wait for a SHA-scoped `BOT_REVIEW`, or confirm no review is left outstanding for a prior head before trusting a reaction.

See `merge-pr`'s review-thread sweep for the fuller version of this check against `reviewThreads`/`isResolved` once a review-shaped signal has actually landed.

## Combining both traps in one "is this PR ready" check

Run the Trap-1 CI gate and the Trap-2 review gate independently inside the same bounded-poll tick — they answer different questions (CI health vs. review completion) and either one alone can be `PENDING` while the other is done. Only report the PR itself as ready when both resolve, plus the authoritative `merged`/`state` check from [bounded-poll.md](bounded-poll.md)'s core loop.
