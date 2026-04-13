---
name: describe-pr
description:
  "Generate or update PR description with incremental changes. **ALWAYS use when** the user says
  'describe the PR', 'update PR description', 'generate PR description', or after pushing new
  commits to an existing PR. Supports incremental updates that preserve manual edits."
disable-model-invocation: true
allowed-tools: Bash, Read, Write
version: 2.0.0
---

# Generate/Update PR Description

Generates or updates PR description with incremental information, auto-updates title, and links
Linear tickets.

## Prerequisites

```bash
# Check project setup (thoughts, CLAUDE.md snippet, config)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

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

Get Linear ticket details using the Linearis CLI (run `linearis issues usage` for read syntax).
Extract title and description with jq. Use ticket title and description for context.

### 9. Generate updated title

**Title generation rules:**

```bash
# If ticket exists and linearis available, read ticket title (see `linearis issues usage`)
if [[ "$ticket" ]] && command -v linearis &>/dev/null; then
    ticket_title=$(linearis issues read "$ticket" | jq -r '.title')
    title="$ticket: ${ticket_title:0:60}"
elif [[ "$ticket" ]]; then
    # Fallback: generate title from branch name + commits
    title="$ticket: $(echo "$branch" | sed "s/^.*$ticket-//" | tr '-' ' ')"
else
    # No ticket: generate from primary change
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

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/prs/` for PR descriptions
- NEVER write to `thoughts/searchable/` — this is a read-only search index

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

**CRITICAL: NO CLAUDE ATTRIBUTION**

Before updating the PR, ensure the description contains NO Claude attribution:

❌ **Remove these if present**:

- "Generated with Claude Code" or similar messages
- "Co-Authored-By: Claude" lines
- Any reference to AI assistance or Anthropic
- Links to Claude Code documentation

✅ **Keep descriptions professional and human-authored**:

- Focus on code changes and their purpose
- Attribute work to the git author (the human developer)
- Write in first-person if needed ("I added...", "We implemented...")

**Update title:**

```bash
gh pr edit $pr_number --title "$new_title"
```

**Update body:**

```bash
# Ensure no Claude attribution in the description file
gh pr edit $pr_number --body-file "thoughts/shared/prs/${pr_number}_description.md"
```

### 13. Update Linear ticket

If ticket found:

```bash
# If Linearis CLI is available:
# 1. Update ticket status to stateMap.inReview from config
# 2. Add a comment with the PR link and verification summary
# Use `linearis issues usage` and `linearis comments usage` for exact syntax.
# Skip silently if CLI not available.
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

## Incremental Update Behavior

Each subsequent call detects new commits since the last description update, appends changes to the
appropriate sections, reruns verification checks, preserves manual edits (reviewer notes,
screenshots, checked boxes), and adds entries to the update history log.

## Error Handling

- **No PR found** → List open PRs and ask user which to describe
- **Template missing** → Warn and generate without template
- **Verification fails** → Mark failed checks with error details, continue with description

## Configuration

Uses `.catalyst/config.json`:

```json
{
  "catalyst": {
    "project": {
      "ticketPrefix": "PROJ"
    },
    "linear": {
      "teamKey": "PROJ",
      "stateMap": {
        "inReview": "In Review"
      }
    },
    "pr": {
      "testCommand": "make test",
      "lintCommand": "make lint",
      "buildCommand": "make build"
    }
  }
}
```

State names are read from `stateMap` with sensible defaults. See `.catalyst/config.json` for all
keys.

## Remember:

- **No interactive prompts** — fully automated
- **Incremental updates** — preserve manual edits, append new
- **Auto-update title** — based on analysis
- **Run verification** — attempt all automated checks
- **Link Linear** — extract ticket, update status
- **Metadata tracking** — commit history, timestamps
- For Linearis CLI syntax, see the `linearis` skill reference
