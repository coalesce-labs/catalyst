# Linear Workflow Automation Strategy

## Overview

The Linear command provides intelligent ticket management with **automatic status progression** based on your workflow commands.

## How Automation Works

### Automatic Status Updates

When you run workflow commands, the Linear command automatically updates ticket status:

| Command | Ticket Status Update |
|---------|---------------------|
| `/create_plan` (with ticket) | → **Plan in Progress** |
| Plan saved & linked | → **Plan in Review** |
| `/implement_plan` (with ticket) | → **In Dev** |
| `/describe_pr` (with ticket) | → **In Review** |
| PR merged | → **Done** (manual or via webhook) |

### How It Detects Tickets

The commands look for tickets in:
1. **Ticket mentioned in plan frontmatter**:
   ```yaml
   ---
   ticket: PROJ-123
   ---
   ```

2. **Ticket in filename**:
   ```
   thoughts/shared/plans/2025-01-08-PROJ-123-feature.md
   ```

3. **Ticket in handoff document**

4. **User explicitly provides ticket ID**

---

## The Workflow

### Recommended Workflow Statuses

Based on HumanLayer's proven workflow:

```
1. Backlog → New ideas and requests
2. Triage → Initial review
3. Spec Needed → Needs problem statement
4. Research Needed → Needs investigation
5. Research in Progress → Active research
6. Ready for Plan → Research complete
7. Plan in Progress → Writing plan ← /create_plan
8. Plan in Review → Plan discussion
9. Ready for Dev → Plan approved
10. In Dev → Active coding ← /implement_plan
11. In Review → PR submitted ← /describe_pr
12. Done → Complete
```

### Why This Workflow Works

**Key insight**: Review happens at the **plan stage**, not the PR stage.

**Benefits**:
- Catch issues during planning, not after coding
- Faster iteration on approach
- Less wasted implementation effort
- Team alignment before work starts

**HumanLayer's experience**:
> "We move faster and avoid rework by aligning on the plan before writing code."

---

## Setting Up Linear Statuses

### Option 1: Quick Setup (Recommended)

Use HumanLayer's proven statuses:

```bash
# In Linear:
# 1. Go to Team Settings → Workflow States
# 2. Create these statuses in order:

Backlog (Backlog category)
Triage (Unstarted category)
Spec Needed (Unstarted category)
Research Needed (Unstarted category)
Research in Progress (Started category)
Ready for Plan (Started category)
Plan in Progress (Started category)
Plan in Review (Started category)
Ready for Dev (Started category)
In Dev (Started category)
In Review (Started category)
Done (Completed category)
```

### Option 2: Simplified Workflow

Start simple, add statuses as needed:

```
Backlog → To Do → In Progress → In Review → Done
```

Then evolve to:
```
Backlog → To Do → Planning → In Progress → In Review → Done
```

Eventually:
```
Backlog → Triage → Research → Planning → In Progress → Review → Done
```

### Option 3: Custom Workflow

Adapt to your team's process! The command is flexible.

---

## Configuration Strategy

### Per-Project Configuration

The `/linear` command uses a **clever initialization pattern**:

1. **First use**: Detects `[NEEDS_SETUP]` markers
2. **Prompts for config**: Team ID, Project ID, GitHub URL
3. **Updates itself**: Replaces markers with actual values
4. **Removes setup code**: Self-modifying command
5. **Commit it**: Now configured for your team

### Why This Works

**Portable**: Copy command to new repo → It prompts for config → It's customized

**Shareable**: Once configured, whole team uses same settings

**No secrets**: Just IDs and URLs, safe to commit

### Example First-Time Flow

```bash
# Copy command to new project
cp ~/ryan-claude-workspace/commands/linear.md .claude/commands/

# First use
/linear

# Output:
# This Linear command needs one-time configuration...
#
# 1. What's your Linear team ID?
#    (Find it with: mcp__linear__list_teams)
#    Team ID: [you enter: abc123]
#
# 2. What's your default project ID?
#    Project ID: [you enter: proj456]
#
# 3. What's your thoughts repository URL?
#    Your pattern: https://github.com/coalesce-labs/thoughts/blob/main

# Command updates itself:
# ✅ Configuration complete! I've updated the linear.md file.
#
# Please commit this change:
#   git add .claude/commands/linear.md
#   git commit -m "Configure Linear command"

# Now it works:
/linear create thoughts/shared/research/feature.md
```

---

## Automation Details

### During `/create_plan`

```javascript
1. User runs: /create_plan
2. Command asks: "Is this for a Linear ticket?"
3. If yes:
   a. Get ticket ID (from user or auto-detect)
   b. Update ticket status → "Plan in Progress"
   c. Add comment: "Starting implementation plan"
4. Create plan document
5. Save to thoughts/shared/plans/
6. When complete:
   a. Attach plan to Linear ticket via links
   b. Add comment with plan summary
   c. Update ticket status → "Plan in Review"
```

### During `/implement_plan`

```javascript
1. User runs: /implement_plan thoughts/shared/plans/plan.md
2. Read plan document
3. Check plan frontmatter for ticket ID
4. If ticket found:
   a. Update ticket status → "In Dev"
   b. Add comment: "Started implementation from plan: [link]"
5. Implement the plan
6. Update checkboxes in plan as phases complete
```

### During `/describe_pr`

```javascript
1. User runs: /describe_pr
2. Get PR diff and metadata
3. Check for ticket references in:
   - PR title
   - Commit messages
   - Plan document linked in description
4. If ticket found:
   a. Update ticket status → "In Review"
   b. Add comment with PR link
   c. Attach PR to ticket via links
```

---

## Advanced: Cross-Project Sharing

### Scenario: Multiple Projects, Same Workflow

You have:
- `coalesce-labs/project-a` (uses Linear)
- `coalesce-labs/project-b` (uses Linear)
- `client/project-c` (uses Linear, different team)

### Strategy 1: Base Command + Project Override

**In your workspace** (`ryan-claude-workspace/commands/linear.md`):
- Keep the template with `[NEEDS_SETUP]` markers
- Don't commit configured values

**In each project** (`.claude/commands/linear.md`):
- Copy from workspace
- Run first-time setup
- Commit configured version
- Project-specific settings

**Benefits**:
- Easy to start new projects
- Each project has its own settings
- Updates to base workflow logic can be pulled

### Strategy 2: Environment-Based

**Alternative approach** (more complex):

```javascript
// In linear.md, check for project-specific config file
const config = loadConfig('.claude/linear-config.json');
```

**Not recommended**: Too complex for this use case.

---

## Integration with Worktrees

### Worktree + Linear Workflow

When you create a worktree for a ticket:

```bash
# In main repo
/create_worktree PROJ-123

# This:
# 1. Creates worktree with ticket in name
# 2. Auto-detects ticket from worktree name
# 3. Sets up thoughts
# 4. Ready to work

# In worktree
cd ~/wt/project/PROJ-123

/implement_plan  # Auto-detects PROJ-123 from directory name
# → Updates Linear ticket to "In Dev"
```

**Enhancement idea**: Worktree creation could auto-update Linear ticket to "In Dev"

---

## Best Practices

### 1. Reference Tickets in Plan Frontmatter

```yaml
---
date: 2025-01-08
ticket: PROJ-123
linear_url: https://linear.app/team/issue/PROJ-123
---
```

This enables automatic status updates.

### 2. Use Consistent Ticket Format

**Good**:
- `PROJ-123`
- `ENG-456`
- Consistent prefix + number

**Why**: Easy to parse and auto-detect

### 3. Attach Artifacts to Tickets

Always link:
- Research docs → Tickets
- Plans → Tickets
- PRs → Tickets

Creates a **complete audit trail**.

### 4. Add Context in Comments

When auto-updating ticket status, add a comment explaining:
```markdown
Moving to In Dev

Starting implementation from plan: thoughts/shared/plans/2025-01-08-auth.md

Phases:
- [ ] Phase 1: Database schema
- [ ] Phase 2: API endpoints
- [ ] Phase 3: Frontend integration
```

### 5. Review Workflow Regularly

After a month, evaluate:
- Are statuses useful?
- Too many/few statuses?
- Is automation helpful?

Adjust as needed!

---

## Troubleshooting

### "Ticket not auto-detected"

**Check**:
1. Ticket mentioned in plan frontmatter?
2. Ticket in filename?
3. Correct format (PROJ-123)?

**Fix**: Manually specify ticket:
```bash
/linear move PROJ-123 "In Dev"
```

### "Wrong status updated"

**Cause**: Multiple tickets referenced

**Fix**: Be explicit about which ticket
```bash
/implement_plan thoughts/shared/plans/plan.md --ticket PROJ-123
```

### "Status not found in Linear"

**Cause**: Status name mismatch

**Fix**: Check exact status names in Linear:
```bash
mcp__linear__list_workflow_states
```

Update command to use exact names.

---

## Summary

### ✅ What You Get

- **Automatic status updates** from workflow commands
- **One-time configuration** per project
- **Proven workflow** from HumanLayer
- **Portable** across projects
- **Team-shareable** once configured

### 🎯 Recommended Approach

1. **Start simple**: Use HumanLayer's proven statuses
2. **Configure per-project**: Each project gets own settings
3. **Let automation work**: Trust the workflow commands to update tickets
4. **Review in 1 month**: Adjust statuses based on what you learn

### 💡 Key Insight

The magic isn't in the automation itself—it's in the **workflow design**:

> Align on the plan before coding → Less rework, faster shipping

The automation just makes it easier to follow that workflow consistently!
