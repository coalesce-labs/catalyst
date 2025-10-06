---
description: Generate or update PR description with incremental changes
category: version-control-git
tools: Bash, Read, Write
model: inherit
version: 2.0.0
---

# Generate/Update PR Description

Generates or updates PR description with incremental information, auto-updates title, and links Linear tickets.

## Process:

### 1. Read PR description template

```bash
# Check if template exists
if [ ! -f "thoughts/shared/pr_description.md" ]; then
    echo "❌ PR description template not found"
fi
```

If missing:
```
❌ PR description template missing

Your humanlayer thoughts setup is incomplete. Create a template at:
  thoughts/shared/pr_description.md

See the PR description template you created earlier for reference.
```

Read template fully to understand all sections.

### 2. Identify target PR

**If argument provided:**
- Use that PR number: `/describe_pr 123`

**If no argument:**
```bash
# Try current branch
gh pr view --json number,url,title,state,body,headRefName,baseRefName 2>/dev/null
```

If no PR on current branch OR on main/master:
```bash
# List recent PRs
gh pr list --limit 10 --json number,title,headRefName,state
```

Ask user: "Which PR would you like to describe? (enter number)"

### 3. Extract ticket reference

**From multiple sources:**

```bash
# 1. From branch name
branch=$(gh pr view $pr_number --json headRefName -q .headRefName)
if [[ "$branch" =~ ([A-Z]+)-([0-9]+) ]]; then
    ticket="${BASH_REMATCH[0]}"
fi

# 2. From PR title
title=$(gh pr view $pr_number --json title -q .title)
if [[ "$title" =~ ([A-Z]+)-([0-9]+) ]]; then
    ticket="${BASH_REMATCH[0]}"
fi

# 3. From existing PR body
body=$(gh pr view $pr_number --json body -q .body)
if [[ "$body" =~ Refs:\ ([A-Z]+-[0-9]+) ]]; then
    ticket="${BASH_REMATCH[1]}"
fi
```

### 4. Read existing descriptions

**Read current PR body from GitHub:**
```bash
current_body=$(gh pr view $pr_number --json body -q .body)
```

**Read saved description (if exists):**
```bash
saved_desc="thoughts/shared/prs/${pr_number}_description.md"
if [ -f "$saved_desc" ]; then
    # Read fully
    # Note what sections exist vs what's new
fi
```

**Check for metadata header:**
```markdown
<!-- Auto-generated: 2025-10-06T10:30:00Z -->
<!-- Last updated: 2025-10-06T14:45:00Z -->
<!-- PR: #123 -->
<!-- Previous commits: abc123,def456 -->
```

### 5. Gather comprehensive PR information

```bash
# Full diff
gh pr diff $pr_number

# Commit history with messages
gh pr view $pr_number --json commits

# Changed files
gh pr view $pr_number --json files

# PR metadata
gh pr view $pr_number --json url,title,number,state,baseRefName,headRefName,author

# CI/CD status
gh pr checks $pr_number
```

### 6. Analyze changes incrementally

**If this is an UPDATE (saved description exists):**

```bash
# Extract previous commit list from metadata
prev_commits=$(grep "Previous commits:" $saved_desc | sed 's/.*: //')

# Get current commits
current_commits=$(gh pr view $pr_number --json commits -q '.commits[].oid' | tr '\n' ',' | sed 's/,$//')

# Compare
new_commits=$(comm -13 <(echo "$prev_commits" | tr ',' '\n' | sort) <(echo "$current_commits" | tr ',' '\n' | sort))
```

**Analysis:**
- Identify what's NEW since last description
- Deep analysis of:
  - Code changes and architectural impact
  - Breaking changes
  - User-facing vs internal changes
  - Migration requirements
  - Security implications

### 7. Merge descriptions intelligently

**Auto-generated sections (always update):**
- **Summary** - regenerate based on ALL changes
- **Changes Made** - append new changes, preserve old
- **How to Verify It** - update checklist, rerun checks
- **Changelog Entry** - update to reflect all changes

**Preserve manual edits in:**
- **Reviewer Notes** - keep existing unless explicitly empty
- **Screenshots/Videos** - never overwrite
- **Manually checked boxes** - preserve [x] marks for manual steps
- **Post-Merge Tasks** - append new, keep existing

**Merging strategy:**
```markdown
## Changes Made

### Backend Changes
[Existing changes from previous description]

**New changes** (since last update):
- [New change 1]
- [New change 2]

### Frontend Changes
[Existing + new merged together]
```

**Add change summary at top:**
```markdown
<!-- Auto-generated: 2025-10-06T15:00:00Z -->
<!-- Last updated: 2025-10-06T15:00:00Z -->
<!-- PR: #123 -->
<!-- Previous commits: abc123,def456,ghi789 -->

---
**Update History:**
- 2025-10-06 15:00: Added validation logic, updated tests (3 new commits)
- 2025-10-06 10:30: Initial implementation (5 commits)
---
```

### 8. Add Linear reference

If ticket found:

```markdown
## Related Issues/PRs

- Fixes https://linear.app/{workspace}/issue/{ticket}
- Related to [any other linked issues]
```

Get Linear ticket details:
```javascript
mcp__linear__get_issue({
  id: ticket
});
```

Use ticket title and description for context.

### 9. Generate updated title

**Title generation rules:**

```bash
# If ticket exists
if [[ "$ticket" ]]; then
    # Get ticket title from Linear
    ticket_title=$(linear API or fallback to branch)

    # Format: TICKET: Descriptive title (max 72 chars)
    title="$ticket: ${ticket_title:0:60}"
else
    # Generate from primary change
    # Analyze commits and code changes
    title="Brief summary of main change"
fi
```

**Auto-update without prompt** - title is auto-generated section.

### 10. Run verification checks

**For each checklist item in "How to Verify It":**

```bash
# Example: "- [ ] Build passes: `make build`"
# Extract command: make build

# Try to run
if command -v make >/dev/null 2>&1; then
    if make build 2>&1; then
        # Mark as checked
        checkbox="- [x] Build passes: \`make build\` ✅"
    else
        # Mark unchecked with error
        checkbox="- [ ] Build passes: \`make build\` ❌ (failed: $error)"
    fi
else
    # Can't run
    checkbox="- [ ] Build passes: \`make build\` (manual verification required)"
fi
```

**Common checks to attempt:**
- `make test` / `npm test` / `pytest`
- `make lint` / `npm run lint`
- `npm run typecheck` / `tsc --noEmit`
- `make build` / `npm run build`

**Document results:**
- ✅ if passed
- ❌ if failed (with error)
- Manual required if can't automate

### 11. Save and sync

**Save description:**
```bash
# Add metadata header
cat > "thoughts/shared/prs/${pr_number}_description.md" <<EOF
<!-- Auto-generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->
<!-- Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->
<!-- PR: #$pr_number -->
<!-- Previous commits: $commit_list -->

[Full description content]
EOF
```

**Sync thoughts:**
```bash
humanlayer thoughts sync
```

### 12. Update PR on GitHub

**Update title:**
```bash
gh pr edit $pr_number --title "$new_title"
```

**Update body:**
```bash
gh pr edit $pr_number --body-file "thoughts/shared/prs/${pr_number}_description.md"
```

### 13. Update Linear ticket

If ticket found:

```javascript
// If not already in "In Review", move it and assign to self
mcp__linear__update_issue({
  id: ticket,
  state: "In Review",
  assignee: "me"  // Auto-assign to current user
});

// If PR link not already attached, add it
mcp__linear__update_issue({
  id: ticket,
  links: [{
    url: prUrl,
    title: `PR #${prNumber}: ${newTitle}`
  }]
});

// Add comment about update
mcp__linear__create_comment({
  issueId: ticket,
  body: `PR description updated!\n\n**Changes**: ${updateSummary}\n**Verification**: ${checksPassedCount}/${totalChecks} automated checks passed\n\nView PR: ${prUrl}`
});
```

### 14. Report results

**If first-time generation:**
```
✅ PR description generated!

**PR**: #123 - {title}
**URL**: {url}
**Verification**: {X}/{Y} automated checks passed
**Linear**: {ticket} updated

Manual verification steps remaining:
- [ ] Test feature in staging
- [ ] Verify UI on mobile

Review PR on GitHub!
```

**If incremental update:**
```
✅ PR description updated!

**Changes since last update**:
- 3 new commits
- Added validation logic
- Updated tests

**Verification**: {X}/{Y} automated checks passed
**Sections updated**: Summary, Changes Made, How to Verify It
**Sections preserved**: Reviewer Notes, Screenshots

**What changed**:
  Updated: Summary, Backend Changes, Automated Checks
  Preserved: Manual verification steps, Reviewer notes
  Added: New validation section

Review updated PR: {url}
```

## Metadata Management

**First generation:**
```markdown
<!-- Auto-generated: 2025-10-06T10:00:00Z -->
<!-- Last updated: 2025-10-06T10:00:00Z -->
<!-- PR: #123 -->
<!-- Previous commits: abc123,def456 -->
```

**Subsequent updates:**
```markdown
<!-- Auto-generated: 2025-10-06T10:00:00Z -->
<!-- Last updated: 2025-10-06T15:30:00Z -->
<!-- PR: #123 -->
<!-- Previous commits: abc123,def456,ghi789,jkl012 -->

---
**Update History:**
- 2025-10-06 15:30: Added error handling, fixed tests (2 commits)
- 2025-10-06 10:00: Initial implementation (2 commits)
---
```

## Incremental Update Examples

**Example 1: Code review changes**
```
User pushes 2 commits after code review feedback

/describe_pr detects:
- 2 new commits
- Changes in validation logic
- New tests added

Updates:
- Appends to "Backend Changes"
- Updates "How to Verify It" (reruns test check)
- Updates Summary to mention review changes
- Preserves reviewer notes and screenshots
- Adds to update history
```

**Example 2: Multiple updates**
```
Update 1 (initial): 5 commits
Update 2 (review): 3 commits
Update 3 (fixes): 2 commits

Description shows:
- Complete history in update log
- All changes accumulated
- Latest verification status
- All manual notes preserved
```

## Error Handling

**No PR found:**
```
❌ No PR found for current branch

Open PRs:
  #120 - Feature A (feature-a branch)
  #121 - Fix B (fix-b branch)

Which PR? (enter number)
```

**Template missing:**
```
❌ PR description template required

Create: thoughts/shared/pr_description.md
See earlier in conversation for template structure.
```

**Verification command fails:**
```
⚠️  Some automated checks failed

Failed:
- make test (exit code 1)
  Error: 2 tests failed in validation.test.ts

Passed:
- make lint ✅
- make build ✅

Fix failing tests before merge or document as known issues.
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
  },
  "pr": {
    "testCommand": "make test",
    "lintCommand": "make lint",
    "buildCommand": "make build"
  }
}
```

## Remember:

- **No interactive prompts** - fully automated
- **Incremental updates** - preserve manual edits, append new
- **Auto-update title** - based on analysis
- **Run verification** - attempt all automated checks
- **Link Linear** - extract ticket, update status
- **Show what changed** - clear summary of updates
- **Full context** - read entire existing description
- **Metadata tracking** - commit history, timestamps
