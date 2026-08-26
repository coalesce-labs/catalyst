# Preflight — Branch, Base, and Existing-PR Checks (Steps 1–6)

## Step 1 — Check for uncommitted changes

```bash
git status --porcelain
```

If dirty, offer to commit ("Create commits now? [Y/n]"). Yes → internally call the `/commit`
workflow. No → proceed; the user may commit manually later.

## Step 2 — Verify not on main/master

```bash
branch=$(git branch --show-current)
```

On `main`/`master` → error "Cannot create PR from main branch. Create a feature branch first." and
exit.

## Step 3 — Detect base branch

```bash
if git show-ref --verify --quiet refs/heads/main; then
    base="main"
elif git show-ref --verify --quiet refs/heads/master; then
    base="master"
else
    base=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
fi
```

## Step 4 — Check if behind base; auto-rebase

```bash
git fetch origin $base
git log HEAD..origin/$base --oneline | grep -q . && echo "Branch is behind $base"
```

If behind: `git rebase origin/$base`. On conflicts: show conflicting files, error "Rebase
conflicts detected. Resolve conflicts and run /catalyst-dev:create-pr again.", exit.

## Step 5 — Check for an existing PR

```bash
gh pr view --json number,url,title,state 2>/dev/null
```

If one exists, show it and ask: "[D] Describe/update this PR  [S] Skip  [A] Abort". D → call
`/describe-pr` and exit. S → exit success. A → exit. **This is the only interactive prompt in the
happy path.**

## Step 6 — Extract ticket from branch name

```bash
CONFIG_FILE=".catalyst/config.json"
[[ ! -f "$CONFIG_FILE" ]] && CONFIG_FILE=".claude/config.json"
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "$CONFIG_FILE")

branch=$(git branch --show-current)
[[ "$branch" =~ ($TEAM_KEY-[0-9]+) ]] && ticket="${BASH_REMATCH[1]}"
```
