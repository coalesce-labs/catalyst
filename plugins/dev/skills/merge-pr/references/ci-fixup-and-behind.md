# CI fix-up and BEHIND-rebase — deeper know-how

Relocated from the retired `phase-monitor-merge` daemon phase-agent (CTL-2223), with the `catalyst-events wait-for` / signal-file / broker plumbing stripped. [`blocker-loop.md`](blocker-loop.md) already covers the reactive wait and the top-level blocker table (BEHIND/DIRTY/UNSTABLE/…); this file adds the specific techniques that table doesn't spell out.

## BEHIND: rebase with hooks disabled on the push

`blocker-loop.md`'s BEHIND row uses the REST `update-branch` endpoint (safe default — GitHub does the merge commit). When you need an actual rebase instead (e.g. to keep a linear history, or `update-branch` itself is blocked), disable local hooks on the push so a pre-push hook can't reject a force-push it wasn't written to expect:

```bash
git fetch origin "$BASE_BRANCH"
git rebase "origin/${BASE_BRANCH}"
git -c core.hooksPath=/dev/null push --force-with-lease
```

On rebase conflict: `git rebase --abort` and report the conflicting files rather than guessing at a resolution — same rule as `merge-blocker-diagnosis.md`'s `conflicts` entry.

## CI fix-up: bound the attempt count, then go back to the reactive wait

An inline CI fix-up (read the failing check's log, patch, push) is worth attempting autonomously, but only within a hard cap — an unbounded fix-retry loop on a CI failure that isn't fixable this way just burns the 24h/session budget without ever surfacing to the operator. Cap at **3 attempts**; on the 4th consecutive failure of the same check, stop and report the failure instead of retrying again. (`merge-blocker-diagnosis.md`'s `MAX_RESOLVE_ATTEMPTS=3` loop is the same discipline generalized across all blocker types, not just CI.)

After each push, don't re-poll on your own — re-enter `blocker-loop.md`'s `catalyst-events wait-for` loop and let the next `github.check_suite.completed` wake-up (paired with the mandatory authoritative REST re-check) tell you whether the fix landed. A standalone re-poll here duplicates that reactive wait, burns the same shared GitHub API quota it exists to conserve, and can miss a reaction-only review signal that arrives in the same window.

## Bot threads vs. human threads are never the same branch

When an automated reviewer (Codex, claude-code-review) leaves unresolved threads, dispatch `/catalyst-dev:review-comments` to address them — that's the existing `blocker-loop.md` path. A **human** reviewer's unresolved thread is different and must not be routed the same way:

- An unresolved human review **thread** left on a `COMMENTED` or `APPROVED` review does not always flip `mergeable_state` to `blocked` and never surfaces as `CHANGES_REQUESTED` — so a check that only branches on `mergeable_state` or looks for `CHANGES_REQUESTED` can miss it and merge past an open human conversation.
- Never attempt to resolve a human thread programmatically. Stop and report: "human reviewer `<login>` left an unresolved thread — operator action required." Check this **before** the bot-thread auto-remediation path, so a PR carrying both kinds doesn't get half auto-remediated and merged with the human half still open.

## `merge_commit_sha` can be empty right after a squash merge

GitHub can return `merge_commit_sha: null` for a few seconds after `gh pr merge --squash` confirms `.merged == true`, while it's still computing the commit. Retry with a bounded, portable loop — **do not use `seq`**: stock macOS (the primary fleet host) ships no `seq` binary unless GNU coreutils is installed, so `$(seq 1 N)` silently expands to nothing and a `for i in $(seq 1 N)` loop runs zero times, leaving the SHA permanently unread on every successful merge.

```bash
RETRIES="${RETRIES:-5}"
MERGE_COMMIT_SHA=""
_i=1
while [[ "$_i" -le "$RETRIES" ]]; do
  MERGE_COMMIT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merge_commit_sha // empty' 2>/dev/null || true)
  [[ -n "$MERGE_COMMIT_SHA" ]] && break
  sleep 2
  _i=$((_i + 1))
done
[[ -z "$MERGE_COMMIT_SHA" ]] && echo "merge-pr: merge_commit_sha still empty after ${RETRIES} attempts for pr#${PR_NUMBER}" >&2
```

Use this whenever a step (a Linear comment, a follow-on relay-ticket phase) needs the actual squash SHA rather than `git rev-parse HEAD` from a checkout that may not have fetched the merge yet.

## Why REST, never GraphQL, for mergeable state

`gh pr view --json mergeable` reads GraphQL's `mergeable`/`mergeable_state` fields, which are eventually consistent and frequently lag or lie right after a push. Every check in this file and in `blocker-loop.md` reads `gh api repos/${REPO}/pulls/${PR_NUMBER}` (REST) instead — REST is the authoritative source for merge state.
