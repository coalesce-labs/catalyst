# GitHub signal traps — two shapes that look like an answer and aren't

Both traps below have burned real waits in this repo. Check both before trusting a bounded-poll
result.

## Trap 1: rollup `conclusion` is `""`, not `null`, while running

The check-run / status-check rollup exposes `conclusion` as the empty string `""` while a check is
still in progress — it is not `null`, and it is falsy in `jq`/bash the same way a real failure
string would test true for "not success." A naive test like:

```bash
# WRONG — "" is falsy-ish but this treats "still running" as "failed"
[ -z "$CONCLUSION" ] && echo "FAILED"
```

misreads every in-progress check as a failure the instant you poll it.

**Fix: gate on `status`, not `conclusion`.** `status` is one of `queued` / `in_progress` /
`completed`. Only look at `conclusion` once `status == "completed"`:

```bash
CHECK_JSON=$(gh api "repos/${REPO}/commits/${SHA}/check-runs" --jq '.check_runs')
STILL_RUNNING=$(echo "$CHECK_JSON" | jq '[.[] | select(.status != "completed")] | length')
if [ "$STILL_RUNNING" -gt 0 ]; then
  echo "PENDING"   # do not inspect conclusion yet
else
  FAILED=$(echo "$CHECK_JSON" | jq '[.[] | select(.conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped")] | length')
  [ "$FAILED" -gt 0 ] && echo "FAILED" || echo "SUCCESS"
fi
```

The same trap applies to the PR-level rollup (`gh api repos/{o}/{r}/commits/{sha}/status` or the
`statusCheckRollup` GraphQL field, which is GraphQL-only — see `wait-for-github`'s forbidden-pattern
note against using it at all): always check the aggregate `state`/`status` field first, and only
read a per-check `conclusion` once that check is individually `completed`.

## Trap 2: a clean automated review is a reaction, not a review object

The automated PR reviewer (Codex, claude-code-review) signals "no issues found" by leaving a 👍
**reaction** on the PR, or posting a terse issue comment such as "No major issues" — **instead of**
opening a review with `state: APPROVED` or `COMMENTED`. A wait that only watches
`GET /pulls/{n}/reviews` never sees this and will sit polling for a review object that is never
coming.

**Fix: check reactions and issue comments too, not only the reviews endpoint.**

```bash
REVIEWS=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --jq 'length')
REACTIONS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/reactions" \
  -H "Accept: application/vnd.github.squirrel-girl-preview+json" \
  --jq '[.[] | select(.content == "+1")] | length')
COMMENTS_CLEAN=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
  --jq '[.[] | select(.body | test("no (major )?issues"; "i"))] | length')

if [ "$REVIEWS" -gt 0 ] || [ "$REACTIONS" -gt 0 ] || [ "$COMMENTS_CLEAN" -gt 0 ]; then
  echo "REVIEWED"
else
  echo "PENDING"
fi
```

Treat any of the three as "the reviewer ran and passed" — do not require all three, and do not
require a review object specifically. See `merge-pr`'s review-thread sweep for the fuller version
of this check against `reviewThreads`/`isResolved` once a review-shaped signal has actually landed.

## Combining both traps in one "is this PR ready" check

Run the Trap-1 CI gate and the Trap-2 review gate independently inside the same bounded-poll tick —
they answer different questions (CI health vs. review completion) and either one alone can be
`PENDING` while the other is done. Only report the PR itself as ready when both resolve, plus the
authoritative `merged`/`state` check from `bounded-poll.md`'s core loop.
