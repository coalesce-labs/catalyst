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

Two more ways a naive check over-counts: (1) counting *any* review object, from *any* reviewer, in *any* state — including `CHANGES_REQUESTED` from a human — as "reviewed"; and (2) counting *any* prior 👍 reaction on the PR at all, even one left on an earlier commit before the current push, as if it certified the code sitting there right now. Reactions are PR-level, not commit-scoped, so an old clean pass does not disappear when new commits land — you have to check its timestamp against the latest push yourself.

**Fix: scope to the specific automated reviewer, exclude an explicit rejection, and require the signal be current.**

```bash
BOT_LOGIN="chatgpt-codex-connector"   # the automated reviewer configured for this repo
HEAD_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.head.sha')
HEAD_PUSHED_AT=$(gh api "repos/${REPO}/commits/${HEAD_SHA}" --jq '.commit.committer.date')

# A review from the bot ON THE CURRENT HEAD COMMIT that isn't a rejection.
BOT_REVIEW=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --jq \
  --arg sha "$HEAD_SHA" --arg bot "$BOT_LOGIN" \
  '[.[] | select(.user.login == $bot and .commit_id == $sha and .state != "CHANGES_REQUESTED")] | length')

# The bot's own reaction, posted no earlier than the current head commit.
BOT_REACTION=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" \
  -H "Accept: application/vnd.github.squirrel-girl-preview+json" --jq \
  --arg bot "$BOT_LOGIN" --arg since "$HEAD_PUSHED_AT" \
  '[.[] | select(.content == "+1" and .user.login == $bot and .created_at >= $since)] | length')

if [ "$BOT_REVIEW" -gt 0 ] || [ "$BOT_REACTION" -gt 0 ]; then
  echo "REVIEWED"
else
  echo "PENDING"
fi
```

See `merge-pr`'s review-thread sweep for the fuller version of this check against `reviewThreads`/`isResolved` once a review-shaped signal has actually landed.

## Combining both traps in one "is this PR ready" check

Run the Trap-1 CI gate and the Trap-2 review gate independently inside the same bounded-poll tick — they answer different questions (CI health vs. review completion) and either one alone can be `PENDING` while the other is done. Only report the PR itself as ready when both resolve, plus the authoritative `merged`/`state` check from [bounded-poll.md](bounded-poll.md)'s core loop.
