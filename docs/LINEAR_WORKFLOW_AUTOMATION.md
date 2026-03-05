# Linear Workflow Automation Strategy

## Overview

The Linear command provides intelligent ticket management with **automatic status progression**
based on your workflow commands.

## How Automation Works

### Automatic Status Updates

When you run workflow commands, the Linear command automatically updates ticket status:

| Command                            | stateMap Key | Default State |
| ---------------------------------- | ------------ | ------------- |
| `/catalyst-dev:research_codebase` (with ticket) | `research` | **In Progress** |
| `/catalyst-dev:create_plan` (with ticket)       | `planning` | **In Progress** |
| `/catalyst-dev:implement_plan` (with ticket)    | `inProgress` | **In Progress** |
| `/catalyst-dev:create_pr` (with ticket)          | `inReview` | **In Review** |
| `/catalyst-dev:merge_pr`                        | `done` | **Done** |

State names are configurable via `linear.stateMap` in `.claude/config.json`. Defaults match
standard Linear workspace states.

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

### Default Workflow (Standard Linear States)

Catalyst works out of the box with standard Linear states. No custom states required:

```
1. Backlog → New ideas and requests
2. Todo → Acknowledged, unstarted
3. In Progress → Research, planning, or development ← /research_codebase, /create_plan, /implement_plan
4. In Review → Code review ← /create_pr, /describe_pr
5. Done → Complete ← /merge_pr
6. Canceled → Closed without completing
```

### Custom Workflow (Optional)

Teams that want finer-grained tracking can configure `stateMap` to use custom states:

```json
{
  "catalyst": {
    "linear": {
      "stateMap": {
        "research": "Research in Progress",
        "planning": "Plan in Progress",
        "inProgress": "In Dev",
        "inReview": "In Review",
        "done": "Done"
      }
    }
  }
}
```

Run `scripts/linear/setup-linear-workflow` to create the full 12-state custom workflow.

### Why This Workflow Works

**Key insight**: Review happens at the **planning stage**, not just the PR stage.

**Benefits**:

- Clear progression from idea to completion
- Each command moves ticket forward automatically
- Fewer statuses = less cognitive overhead
- Maintains review gates (plan review + code review)

---

## Setting Up Linear Statuses

### Default Setup (No Configuration Needed)

Standard Linear workspaces already have the states Catalyst needs:

- **Backlog** (Backlog category)
- **Todo** (Unstarted category)
- **In Progress** (Started category)
- **In Review** (Started category) — commonly added
- **Done** (Completed category)
- **Canceled** (Canceled category)

If your workspace has these states, Catalyst works immediately with no configuration.

### Advanced Setup (Optional)

For teams that want fine-grained status tracking, run the setup script:

```bash
scripts/linear/setup-linear-workflow
```

This creates a 12-state custom workflow. After running it, update your `stateMap` in
`.claude/config.json` to use the custom state names (the script outputs the config to copy).

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
# - Moves ticket to stateMap.research (default: "In Progress")
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
# - Moves ticket to stateMap.planning (default: "In Progress")
# - Creates plan document
# - Attaches plan to ticket
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
# - Moves ticket to stateMap.inProgress (default: "In Progress")
# - Implements each phase
# - Updates plan checkboxes
```

### 6. Code Review Phase

```bash
/catalyst-dev:describe_pr

# Automatically:
# - Moves ticket to stateMap.inReview (default: "In Review")
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
Backlog (stateMap.backlog)
  ↓ (create ticket)
Todo (stateMap.todo)
  ↓ (acknowledged)
In Progress (stateMap.research / stateMap.planning / stateMap.inProgress)
  ↓ (/research_codebase → /create_plan → /implement_plan)
In Review (stateMap.inReview)
  ↓ (/create_pr or /describe_pr)
Done (stateMap.done)
  ↓ (/merge_pr)
```

With standard Linear states, research/planning/implementation all map to "In Progress".
Teams with custom states can differentiate these phases via `stateMap`.

---

## Configuration Strategy

### Per-Project Configuration

Configuration is managed through `setup-catalyst.sh` and `.claude/config.json`:

1. **Run setup**: `./setup-catalyst.sh` configures your project
2. **Config file**: `.claude/config.json` stores team key and state mappings
3. **Secrets file**: `~/.config/catalyst/config-{projectKey}.json` stores API tokens
4. **Commit config**: `.claude/config.json` is safe to commit (no secrets)

### Example Setup

```bash
# Install the Catalyst plugin
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev

# Run setup
./setup-catalyst.sh

# Or manually edit .claude/config.json:
{
  "catalyst": {
    "projectKey": "acme",
    "project": {
      "ticketPrefix": "ACME"
    },
    "linear": {
      "teamKey": "ACME",
      "stateMap": {
        "backlog": "Backlog",
        "todo": "Todo",
        "research": "In Progress",
        "planning": "In Progress",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done",
        "canceled": "Canceled"
      }
    }
  }
}

# Now it works:
/catalyst-dev:linear create "Add OAuth support"
```

---

## Automation Details

### During `/catalyst-dev:create_plan`

```javascript
1. User runs: /catalyst-dev:create_plan
2. Command asks: "Is this for a Linear ticket?"
3. If yes:
   a. Get ticket ID (from user or auto-detect)
   b. Update ticket status → stateMap.planning (default: "In Progress")
   c. Add comment: "Creating implementation plan"
4. Create plan document
5. Save to thoughts/shared/plans/
6. When complete:
   a. Attach plan to Linear ticket via links
   b. Add comment with plan summary
   c. Ticket stays for team review
```

### During `/catalyst-dev:implement_plan`

```javascript
1. User runs: /catalyst-dev:implement_plan thoughts/shared/plans/plan.md
2. Read plan document
3. Check plan frontmatter for ticket ID
4. If ticket found:
   a. Update ticket status → stateMap.inProgress (default: "In Progress")
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
   a. Update ticket status → stateMap.inReview (default: "In Review")
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

**Fix**: Check exact status names in Linear using Linearis CLI:

```bash
linearis issues list --limit 1 | jq '.[0].state'
```

Update `stateMap` in `.claude/config.json` to use exact state names from your workspace.

---

## Summary

### ✅ What You Get

- **Automatic status updates** from workflow commands
- **One-time configuration** per project
- **Proven workflow** from HumanLayer
- **Portable** across projects
- **Team-shareable** once configured

### 🎯 Recommended Approach

1. **Start simple**: Use standard Linear states (works out of the box)
2. **Configure per-project**: Each project gets own settings
3. **Let automation work**: Trust the workflow commands to update tickets
4. **Review in 1 month**: Adjust statuses based on what you learn

### 💡 Key Insight

The magic isn't in the automation itself—it's in the **workflow design**:

> Align on the plan before coding → Less rework, faster shipping

The automation just makes it easier to follow that workflow consistently!
