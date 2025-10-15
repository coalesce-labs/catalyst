---
description: Create pull request with automatic Linear integration
category: version-control-git
tools: Bash, Read, Task
model: inherit
version: 1.0.0
---

# Create Pull Request

Orchestrates the complete PR creation flow: commit → rebase → push → create → describe → link Linear
ticket.

## Process:

### 1. Check for uncommitted changes

```bash
git status --porcelain
```

If there are uncommitted changes:

- Offer to commit: "You have uncommitted changes. Create commits now? [Y/n]"
- If yes: internally call `/commit` workflow
- If no: proceed (user may want to commit manually later)

### 2. Verify not on main/master branch

```bash
branch=$(git branch --show-current)
```

If on `main` or `master`:

- Error: "Cannot create PR from main branch. Create a feature branch first."
- Exit

### 3. Detect base branch

```bash
# Check which exists
if git show-ref --verify --quiet refs/heads/main; then
    base="main"
elif git show-ref --verify --quiet refs/heads/master; then
    base="master"
else
    base=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
fi
```

### 4. Check if branch is up-to-date with base

```bash
# Fetch latest
git fetch origin $base

# Check if behind
if git log HEAD..origin/$base --oneline | grep -q .; then
    echo "Branch is behind $base"
fi
```

If behind:

- Auto-rebase: `git rebase origin/$base`
- If conflicts:
  - Show conflicting files
  - Error: "Rebase conflicts detected. Resolve conflicts and run /create_pr again."
  - Exit

### 5. Check for existing PR

```bash
gh pr view --json number,url,title,state 2>/dev/null
```

If PR exists:

- Show: "PR #{number} already exists: {title}\n{url}"
- Ask: "What would you like to do?\n [D] Describe/update this PR\n [S] Skip (do nothing)\n [A]
  Abort"
- If D: call `/describe_pr` and exit
- If S: exit with success message
- If A: exit
- **This is the ONLY interactive prompt in the happy path**

### 6. Extract ticket from branch name

```bash
branch=$(git branch --show-current)

# Extract pattern: PREFIX-NUMBER
if [[ "$branch" =~ ([A-Z]+)-([0-9]+) ]]; then
    ticket="${BASH_REMATCH[0]}"  # e.g., RCW-13
    prefix="${BASH_REMATCH[1]}"   # e.g., RCW
    number="${BASH_REMATCH[2]}"   # e.g., 13
fi
```

### 7. Generate PR title from branch and ticket

```bash
# Branch format examples:
# - RCW-13-implement-pr-lifecycle → "RCW-13: implement pr lifecycle"
# - feature-add-validation → "add validation"

# Extract description from branch name
if [[ "$ticket" ]]; then
    # Remove ticket prefix from branch
    desc=$(echo "$branch" | sed "s/^$ticket-//")
    # Convert kebab-case to spaces
    desc=$(echo "$desc" | tr '-' ' ')
    # Capitalize first word
    desc="$(tr '[:lower:]' '[:upper:]' <<< ${desc:0:1})${desc:1}"

    title="$ticket: $desc"
else
    # No ticket in branch
    desc=$(echo "$branch" | tr '-' ' ')
    desc="$(tr '[:lower:]' '[:upper:]' <<< ${desc:0:1})${desc:1}"
    title="$desc"
fi
```

### 8. Push branch

```bash
# Check if branch has upstream
if ! git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null; then
    # No upstream, push with -u
    git push -u origin HEAD
else
    # Has upstream, check if up-to-date
    git push
fi
```

### 9. Create PR

```bash
# Minimal initial body
body="Automated PR creation. Comprehensive description generating..."

# If ticket exists, add reference
if [[ "$ticket" ]]; then
    body="$body\n\nRefs: $ticket"
fi

# Create PR
gh pr create --title "$title" --body "$body" --base "$base"
```

Capture PR number and URL from output.

### 10. Auto-call /describe_pr

Immediately call `/describe_pr` with the PR number to:

- Generate comprehensive description
- Run verification checks
- Update PR title (refined from code analysis)
- Save to thoughts/
- Update Linear ticket

### 11. Update Linear ticket (if ticket found)

If ticket was extracted from branch:

```javascript
// Get current user
const viewer = await mcp__linear__get_user({ query: "me" });

// Assign to self and move to "In Review"
mcp__linear__update_issue({
  id: ticket,
  state: "In Review",
  assignee: "me", // Auto-assign to current user
});

// Add PR link
mcp__linear__update_issue({
  id: ticket,
  links: [
    {
      url: prUrl,
      title: `PR #${prNumber}: ${prTitle}`,
    },
  ],
});

// Add comment
mcp__linear__create_comment({
  issueId: ticket,
  body: `PR created and ready for review!\n\n**PR**: ${prUrl}\n\nDescription has been auto-generated with verification checks.`,
});
```

### 12. Report success

```
✅ Pull request created successfully!

**PR**: #{number} - {title}
**URL**: {url}
**Base**: {base_branch}
**Ticket**: {ticket} (moved to "In Review")

Description has been generated and verification checks have been run.
Review the PR on GitHub!
```

## Error Handling

**On main/master branch:**

```
❌ Cannot create PR from main branch.

Create a feature branch first:
  git checkout -b TICKET-123-feature-name
```

**Rebase conflicts:**

```
❌ Rebase conflicts detected

Conflicting files:
  - src/file1.ts
  - src/file2.ts

Resolve conflicts and run:
  git add <resolved-files>
  git rebase --continue
  /create_pr
```

**GitHub CLI not configured:**

```
❌ GitHub CLI not configured

Run: gh auth login
Then: gh repo set-default
```

**Linear ticket not found:**

```
⚠️  Could not find Linear ticket for {ticket}

PR created successfully, but ticket not updated.
Update manually or check ticket ID.
```

## Configuration

Uses `.claude/config.json`:

```json
{
  "project": {
    "ticketPrefix": "RCW"
  },
  "linear": {
    "teamId": "team-id",
    "inReviewStatusName": "In Review"
  }
}
```

## Examples

**Branch: `RCW-13-implement-pr-lifecycle`**

```
Extracting ticket: RCW-13
Generated title: "RCW-13: Implement pr lifecycle"
Creating PR...
✅ PR #2 created
Calling /describe_pr to generate description...
Updating Linear ticket RCW-13 → In Review
✅ Complete!
```

**Branch: `feature-add-validation` (no ticket)**

```
No ticket found in branch name
Generated title: "Feature add validation"
Creating PR...
✅ PR #3 created
Calling /describe_pr...
⚠️  No Linear ticket to update
✅ Complete!
```

## Integration with Other Commands

- **Calls `/commit`** - if uncommitted changes (optional)
- **Calls `/describe_pr`** - always, to generate comprehensive description
- **Sets up for `/merge_pr`** - PR is now ready for review and eventual merge

## Remember:

- **Minimize prompts** - only ask when PR already exists
- **Auto-rebase** - keep branch up-to-date with base
- **Auto-link Linear** - extract ticket from branch, update status
- **Auto-describe** - comprehensive description generated immediately
- **Fail fast** - stop on conflicts or errors with clear messages
