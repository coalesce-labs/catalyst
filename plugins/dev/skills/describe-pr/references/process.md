# Identify the PR and Gather Its Change Set (Steps 1–5)

## Step 1 — Read the PR description template

```bash
[ -f "thoughts/shared/pr_description.md" ] || echo "❌ PR description template not found"
```

If missing, tell the user their humanlayer thoughts setup is incomplete and point them at `thoughts/shared/pr_description.md`. Read the template fully before continuing — it defines every section this skill fills in.

## Step 2 — Identify the target PR

If an argument was given, use that PR number (`/describe_pr 123`). Otherwise:

```bash
gh pr view --json number,url,title,state,body,headRefName,baseRefName 2>/dev/null
```

If there's no PR on the current branch (or it's `main`/`master`), list recent PRs and ask:

```bash
gh pr list --limit 10 --json number,title,headRefName,state
```

## Step 3 — Extract the ticket reference

Check, in order: branch name, PR title, existing PR body's `Refs: TEAM-NNN` line — each matched against `[A-Z]+-[0-9]+`. First match wins.

## Step 4 — Read existing descriptions

Read the current PR body from GitHub (`gh pr view $pr_number --json body -q .body`) and the saved description at `thoughts/shared/prs/${pr_number}_description.md` if it exists. Check for the metadata header (`<!-- Auto-generated -->`, `<!-- Previous commits: -->`) to determine whether this is a first-time generation or an incremental update.

## Step 5 — Gather comprehensive PR information

```bash
gh pr diff $pr_number
gh pr view $pr_number --json commits
gh pr view $pr_number --json files
gh pr view $pr_number --json url,title,number,state,baseRefName,headRefName,author
gh pr checks $pr_number
```

## Incremental-update detection

If a saved description exists, diff the previous commit list (from its metadata header) against the current one:

```bash
prev_commits=$(grep "Previous commits:" $saved_desc | sed 's/.*: //')
current_commits=$(gh pr view $pr_number --json commits -q '.commits[].oid' | tr '\n' ',' | sed 's/,$//')
new_commits=$(comm -13 <(echo "$prev_commits" | tr ',' '\n' | sort) <(echo "$current_commits" | tr ',' '\n' | sort))
```

Analyze what's NEW since the last description: architectural impact, breaking changes, user-facing vs. internal changes, migration requirements, security implications.
