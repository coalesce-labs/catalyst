# PR Identification and Pre-Merge Verification (Steps 1–5)

_Steps to identify the target PR, verify it is open and mergeable, rebase if behind, and run
local tests before entering the blocker-diagnosis loop._

## Step 1 — Identify PR to merge

If a PR number was passed as argument, use it. Otherwise:

```bash
gh pr view --json number,url,title,state,mergeable 2>/dev/null
```

If no PR on current branch:
```bash
gh pr list --limit 10 --json number,title,headRefName,state
```
Ask: "Which PR would you like to merge? (enter number)"

## Step 2 — Get PR details

```bash
gh pr view $pr_number --json \
  number,url,title,state,mergeable,mergeStateStatus,\
  baseRefName,headRefName,reviewDecision
```

Extract: PR number, URL, title, mergeable status, base branch, head branch, review decision.

## Step 3 — Verify PR is open and mergeable

```bash
state=$(gh pr view $pr_number --json state -q .state)
mergeable=$(gh pr view $pr_number --json mergeable -q .mergeable)
```

If PR is not OPEN → report current state and exit.

If `mergeable == "CONFLICTING"`:
```
❌ PR has merge conflicts — resolve first:
  gh pr checkout $pr_number
  git fetch origin $base_branch
  git merge origin/$base_branch
  # ... resolve conflicts ...
  git push
```
Exit with error.

## Step 4 — Check if head branch is up-to-date with base

```bash
gh pr checkout $pr_number
base_branch=$(gh pr view $pr_number --json baseRefName -q .baseRefName)
git fetch origin $base_branch
if git log HEAD..origin/$base_branch --oneline | grep -q .; then
  echo "Branch is behind $base_branch"
fi
```

If behind, auto-rebase:
```bash
git rebase origin/$base_branch
if [ $? -ne 0 ]; then
  echo "❌ Rebase conflicts"
  git rebase --abort
  exit 1
fi
git push --force-with-lease
```

On conflict:
```
❌ Rebase conflicts detected — conflicting files:
  $(git diff --name-only --diff-filter=U)
Resolve: fix files, git add, git rebase --continue, git push --force-with-lease,
then re-run /catalyst-dev:merge-pr.
```

## Step 5 — Run local tests

```bash
test_cmd=$(jq -r '.catalyst.pr.testCommand // "make test"' .catalyst/config.json)
echo "Running tests: $test_cmd"
if ! $test_cmd; then
  echo "❌ Tests failed"
  exit 1
fi
```

Skip with `--skip-tests` flag.
