# Steps 7–11a — Execute Squash Merge and Cleanup (CTL-56)

_Covers ticket extraction, merge summary, squash merge, checkout-free remote-ref delete,
Linear update, and worktree-safe local cleanup. All CTL-56 guard strings live here._

## Step 7 — Extract ticket reference

```bash
branch=$(gh pr view $pr_number --json headRefName -q .headRefName)
title=$(gh pr view $pr_number --json title -q .title)
# From branch using configured team key
if [[ "$branch" =~ ($TEAM_KEY-[0-9]+) ]]; then ticket="${BASH_REMATCH[1]}"; fi
# From title if not in branch
if [[ -z "$ticket" ]] && [[ "$title" =~ ($TEAM_KEY-[0-9]+) ]]; then ticket="${BASH_REMATCH[1]}"; fi
```

## Step 8 — Show merge summary

Print a summary (PR number, title, from/to branch, commit count, file count, merge state,
review status, CI status, test result, ticket) and ask "Proceed? [Y/n]:".

## Step 9 — Execute squash merge

```bash
# CTL-56: capture head ref + head repo BEFORE merge so we can delete checkout-free after
# a REST-confirmed merge.
head_ref=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.head.ref' 2>/dev/null || true)
head_repo=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.head.repo.full_name' 2>/dev/null || true)
# Merge via REST only — no local branch-cleanup flag (CTL-56).
gh pr merge $pr_number --squash
# Codex P1 (CTL-2232, PR #4043): `gh pr merge` merges on GitHub's side and never touches this
# local checkout, so `git rev-parse HEAD` here is whatever the worktree already had checked
# out (typically the PR branch's own pre-merge tip in a linked worktree) — NOT the new squash
# commit that landed on the base branch. Read the authoritative merge commit back via REST
# instead; a merge can take a moment to report `merge_commit_sha`, so retry briefly.
merge_sha=""
for _ in 1 2 3 4 5; do
  merge_sha=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.merge_commit_sha // empty' 2>/dev/null || true)
  [[ -n "$merge_sha" ]] && break
  sleep 2
done
```

## Step 9b — Delete remote head ref (checkout-free)

After verifying the merge via REST, delete the remote head branch via API — no `git checkout`
required, safe from any worktree (CTL-56):

```bash
# Confirm the merge landed via REST BEFORE deleting anything. `gh pr merge` returning success
# is NOT proof it merged: with a merge queue it only ENQUEUES the PR, so the head ref may
# still belong to a still-open PR. Preserve the old atomic delete-on-merge conditional with
# an executable `.merged` check here (a prose "after verifying" step is not a gate). (CTL-56)
merged_ok=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.merged' 2>/dev/null || echo "false")
# Delete the remote head ref checkout-free ONLY when BOTH hold:
#  - the merge is REST-confirmed (.merged == true), and
#  - the head branch actually lives in ${REPO}. A fork PR's .head.ref names a branch in the
#    FORK, so deleting repos/${REPO}/git/refs/heads/${head_ref} could hit a same-named branch
#    in the base repo. Gate on .head.repo.full_name == ${REPO} (CTL-56).
# Idempotent + best-effort: 404/422 means ref already gone or protected.
if [[ "$merged_ok" == "true" && -n "${head_ref:-}" && "${head_repo:-}" == "${REPO}" ]]; then
  # CTL-56: URL-encode the head ref (preserve '/') so a metacharacter like '#' can't truncate
  # the endpoint into deleting the wrong ref.
  enc_ref=$(printf '%s' "$head_ref" | jq -sRr @uri | sed 's|%2F|/|g')
  gh api --method DELETE "repos/${REPO}/git/refs/heads/${enc_ref}" >/dev/null 2>&1 \
    || echo "CTL-56: remote branch ${head_ref} delete skipped (already gone or protected)" >&2
elif [[ "$merged_ok" != "true" ]]; then
  echo "merge-pr: merge of #${pr_number} not REST-confirmed; skipping branch cleanup (CTL-56)" >&2
fi
```

## Step 10 — Update Linear ticket

```bash
# Use the shared transition helper (CTL-69). Reads stateMap from .catalyst/config.json,
# is idempotent, and silently skips when the linearis CLI is not installed.
"${CLAUDE_PLUGIN_ROOT}/scripts/linear-transition.sh" \
  --ticket "$ticket_id" --transition done --config .catalyst/config.json

# Then add a comment with PR number, merge commit, and base branch.
# Use `linearis comments usage` for exact syntax. Skip silently if CLI missing.
```

## Step 11 — Delete local branch and update base

```bash
# CTL-56: detect linked-worktree — when absolute-git-dir ≠ git-common-dir we are in a
# linked worktree. Skip local `git checkout <base>` (fails when base is already checked
# out in the primary clone); defer local feature-branch delete to teardown/reaper.
# NOTE: both sides MUST be absolute. --git-common-dir returns a RELATIVE .git in the
# primary clone, which would falsely differ from --absolute-git-dir and misfire the guard
# in the primary. Force absolute with --path-format=absolute.
_abs_git="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
_com_git="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$_abs_git" && -n "$_com_git" && "$_abs_git" != "$_com_git" ]]; then
  echo "merge-pr: linked worktree — skipping local base checkout (CTL-56)" >&2
else
  git checkout $base_branch
  git pull origin $base_branch
  git branch -d $head_branch
  echo "✅ Deleted local branch: $head_branch"
fi
```

## Step 11a — Update primary worktree

If running in a git worktree, update the primary checkout of main:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/pull-primary-worktree.sh" --branch "$base_branch"
```
