# Linear Workflow Automation Strategy

## Overview

The Linear command provides intelligent ticket management with **automatic status progression**
based on your workflow commands.

## How Automation Works

### Automatic Status Updates

When you run workflow commands, the Linear command automatically updates ticket status:

| Command                            | Ticket Status Update               |
| ---------------------------------- | ---------------------------------- |
| `/catalyst-dev:research_codebase` (with ticket) | → **Research**                     |
| `/catalyst-dev:create_plan` (with ticket)       | → **Planning**                     |
| `/catalyst-dev:implement_plan` (with ticket)    | → **In Progress**                  |
| `/catalyst-dev:describe_pr` (with ticket)       | → **In Review**                    |
| PR merged                          | → **Done** (manual or via webhook) |

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

Simplified 6-status workflow (Option C):

```
1. Backlog → New ideas and requests
2. Research → Investigation, triage, spec definition ← /catalyst-dev:research_codebase
3. Planning → Implementation plans ← /catalyst-dev:create_plan
4. In Progress → Active development ← /catalyst-dev:implement_plan
5. In Review → Code review ← /catalyst-dev:describe_pr
6. Done → Complete
```

### Why This Workflow Works

**Key insight**: Review happens at the **planning stage**, not just the PR stage.

**Benefits**:

- Clear progression from idea to completion
- Each command moves ticket forward automatically
- Fewer statuses = less cognitive overhead
- Maintains review gates (plan review + code review)

---

## Setting Up Linear Statuses

### Quick Setup (Recommended)

Use the `/linear_setup_workflow` command:

```bash
/catalyst-dev:linear_setup_workflow
```

This creates 6 statuses optimized for the workflow commands:

1. **Backlog** (Backlog category) - Gray
2. **Research** (Unstarted category) - Yellow
3. **Planning** (Started category) - Yellow
4. **In Progress** (Started category) - Blue
5. **In Review** (Started category) - Blue
6. **Done** (Completed category) - Blue

### Manual Setup

If you prefer to create statuses manually in Linear:

1. Go to Team Settings → Workflow States
2. Create these 6 statuses in order
3. Assign to the correct category (Backlog/Unstarted/Started/Completed)
4. Use the color scheme above for visual clarity

## Complete Workflow Example

Here's how tickets flow through the simplified workflow:

### 1. Create Ticket

```bash
/catalyst-dev:linear create "Add OAuth support"
# Creates in Backlog
```

### 2. Research Phase

```bash
/catalyst-dev:research_codebase PROJ-123
> "How does authentication currently work?"

# Automatically:
# - Moves ticket to "Research"
# - Adds comment: "Starting research: How does authentication currently work?"
# - Saves research document
# - Attaches research to ticket
# - Adds comment: "Research complete! See findings: [link]"
```

### 3. Planning Phase

```bash
/catalyst-dev:create_plan
# Reference research document
# User provides task details

# Automatically:
# - Moves ticket to "Planning"
# - Creates plan document
# - Attaches plan to ticket
# - Stays in "Planning" for team review
```

### 4. Team Review

```
# Team reviews plan in Linear
# Discusses in comments
# When approved, manually move to "In Progress"
# Or /catalyst-dev:implement_plan does it automatically
```

### 5. Implementation Phase

```bash
/catalyst-dev:implement_plan thoughts/shared/plans/2025-10-04-PROJ-123-oauth.md

# Automatically:
# - Moves ticket to "In Progress"
# - Implements each phase
# - Updates plan checkboxes
```

### 6. Code Review Phase

```bash
/catalyst-dev:describe_pr

# Automatically:
# - Moves ticket to "In Review"
# - Attaches PR to ticket
# - Adds comment with PR link
```

### 7. Completion

```
# After PR is merged
# Manually move to "Done"
# Or set up Linear webhook automation
```

## Workflow Progression Summary

```
Backlog
  ↓ (create ticket)
Research
  ↓ (/research_codebase)
Planning
  ↓ (/create_plan)
Planning (stays for team review)
  ↓ (team approves or /catalyst-dev:implement_plan)
In Progress
  ↓ (/implement_plan)
In Review
  ↓ (/describe_pr)
Done
  ↓ (PR merged)
```

---

## Configuration Strategy

### Per-Project Configuration

The `/catalyst-dev:linear` command uses a **clever initialization pattern**:

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
mkdir -p .claude/commands/linear
cp ~/ryan-claude-workspace/commands/linear/linear.md .claude/commands/linear/

# First use
/catalyst-dev:linear

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
#   git add .claude/commands/linear/linear.md
#   git commit -m "Configure Linear command"

# Now it works:
/catalyst-dev:linear create thoughts/shared/research/feature.md
```

---

## Automation Details

### During `/catalyst-dev:create_plan`

```javascript
1. User runs: /catalyst-dev:create_plan
2. Command asks: "Is this for a Linear ticket?"
3. If yes:
   a. Get ticket ID (from user or auto-detect)
   b. Update ticket status → "Planning"
   c. Add comment: "Creating implementation plan"
4. Create plan document
5. Save to thoughts/shared/plans/
6. When complete:
   a. Attach plan to Linear ticket via links
   b. Add comment with plan summary
   c. Ticket stays in "Planning" for team review
```

### During `/catalyst-dev:implement_plan`

```javascript
1. User runs: /catalyst-dev:implement_plan thoughts/shared/plans/plan.md
2. Read plan document
3. Check plan frontmatter for ticket ID
4. If ticket found:
   a. Update ticket status → "In Progress"
   b. Add comment: "Started implementation from plan: [link]"
5. Implement the plan
6. Update checkboxes in plan as phases complete
```

### During `/catalyst-dev:describe_pr`

```javascript
1. User runs: /catalyst-dev:describe_pr
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

**In your workspace** (`ryan-claude-workspace/commands/linear/linear.md`):

- Keep the template with `[NEEDS_SETUP]` markers
- Don't commit configured values

**In each project** (`.claude/commands/linear/linear.md`):

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
const config = loadConfig(".claude/linear-config.json");
```

**Not recommended**: Too complex for this use case.

---

## Integration with Worktrees

### Worktree + Linear Workflow

When you create a worktree for a ticket:

```bash
# In main repo
/catalyst-dev:create_worktree PROJ-123

# This:
# 1. Creates worktree with ticket in name
# 2. Auto-detects ticket from worktree name
# 3. Sets up thoughts
# 4. Ready to work

# In worktree
cd ~/wt/project/PROJ-123

/catalyst-dev:implement_plan  # Auto-detects PROJ-123 from directory name
# → Updates Linear ticket to "In Progress"
```

**Enhancement idea**: Worktree creation could auto-update Linear ticket to "In Progress"

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
Moving to In Progress

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
/catalyst-dev:linear move PROJ-123 "In Progress"
```

### "Wrong status updated"

**Cause**: Multiple tickets referenced

**Fix**: Be explicit about which ticket

```bash
/catalyst-dev:implement_plan thoughts/shared/plans/plan.md --ticket PROJ-123
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
