---
description: Set up recommended workflow statuses in Linear
category: project-task-management
---

# Linear Setup Workflow

You are tasked with automatically creating the recommended workflow statuses in a Linear team.

## Prerequisites

First, verify that Linear MCP tools are available by checking if any `mcp__linear__` tools exist. If not, respond:
```
I need access to Linear tools to set up workflow statuses. Please run the `/mcp` command to enable the Linear MCP server, then try again.
```

## Process

### 1. Get Team Information

Ask the user which team to set up:

```
I'll help you set up the recommended workflow statuses in Linear.

Let me get your teams...
```

Use `mcp__linear__list_teams` to get all teams.

Show teams to user:
```
Available teams:
1. [Team Name] (key: TEAM)
2. [Team Name] (key: PROJ)

Which team should I set up? (enter number or team key)
```

### 2. Confirm Setup

Once team is selected, show what will be created:

```
I'll create these workflow statuses for team: [TEAM NAME]

BACKLOG
  1. Backlog - New ideas and feature requests

UNSTARTED
  2. Triage - Initial review and prioritization
  3. Spec Needed - Needs problem statement and solution outline
  4. Research Needed - Requires investigation before planning

STARTED
  5. Research in Progress - Active research underway
  6. Ready for Plan - Research complete, ready for implementation plan
  7. Plan in Progress - Writing implementation plan (auto-set by /create_plan)
  8. Plan in Review - Plan under team discussion and review
  9. Ready for Dev - Plan approved, ready to implement
  10. In Dev - Active development (auto-set by /implement_plan)
  11. In Review - PR submitted for review (auto-set by /describe_pr)

COMPLETED
  12. Done - Completed and deployed

This will integrate with your workflow commands:
- /create_plan → Plan in Progress → Plan in Review
- /implement_plan → In Dev
- /describe_pr → In Review

Proceed with creation? (Y/n)
```

### 3. Create Workflow States

Use TodoWrite to track progress creating each status.

For each status, use `mcp__linear__create_workflow_state`:

```javascript
// Status definitions with colors:
const statuses = [
  // BACKLOG
  {
    name: "Backlog",
    type: "backlog",
    description: "New ideas and feature requests",
    color: "#bec2c8"
  },

  // UNSTARTED
  {
    name: "Triage",
    type: "unstarted",
    description: "Initial review and prioritization",
    color: "#e2e2e2"
  },
  {
    name: "Spec Needed",
    type: "unstarted",
    description: "Needs problem statement and solution outline",
    color: "#e2e2e2"
  },
  {
    name: "Research Needed",
    type: "unstarted",
    description: "Requires investigation before planning",
    color: "#e2e2e2"
  },

  // STARTED - Research & Planning
  {
    name: "Research in Progress",
    type: "started",
    description: "Active research underway",
    color: "#f2c94c"  // Yellow
  },
  {
    name: "Ready for Plan",
    type: "started",
    description: "Research complete, ready for implementation plan",
    color: "#f2c94c"
  },
  {
    name: "Plan in Progress",
    type: "started",
    description: "Writing implementation plan (auto-set by /create_plan)",
    color: "#f2c94c"
  },
  {
    name: "Plan in Review",
    type: "started",
    description: "Plan under team discussion and review",
    color: "#f2c94c"
  },

  // STARTED - Development
  {
    name: "Ready for Dev",
    type: "started",
    description: "Plan approved, ready to implement",
    color: "#5e6ad2"  // Blue
  },
  {
    name: "In Dev",
    type: "started",
    description: "Active development (auto-set by /implement_plan)",
    color: "#5e6ad2"
  },
  {
    name: "In Review",
    type: "started",
    description: "PR submitted for review (auto-set by /describe_pr)",
    color: "#5e6ad2"
  },

  // COMPLETED
  {
    name: "Done",
    type: "completed",
    description: "Completed and deployed",
    color: "#5e6ad2"
  }
];
```

Create each status using the MCP tool. If a status already exists (error), skip it and note it:

```
Creating statuses...
  ✓ Backlog
  ✓ Triage
  ⚠️  Spec Needed (already exists - skipped)
  ✓ Research Needed
  ...
```

### 4. Verify Creation

After creating all statuses, verify with `mcp__linear__list_workflow_states`:

```
Verifying workflow setup...
```

List all statuses and confirm they match the expected set.

### 5. Set Default State

If possible, set "Backlog" as the default state for new issues in the team.

### 6. Completion Summary

Show completion summary:

```
✅ Workflow setup complete!

Created 12 workflow statuses for team: [TEAM NAME]

Workflow progression:
  Backlog → Triage → Spec Needed → Research Needed →
  Research in Progress → Ready for Plan → Plan in Progress →
  Plan in Review → Ready for Dev → In Dev → In Review → Done

Automatic status updates:
  • /create_plan → Plan in Progress → Plan in Review
  • /implement_plan → In Dev
  • /describe_pr → In Review

Next steps:
  1. Configure the /linear command for this team
     Run: /linear
     (It will prompt for team ID and project ID)

  2. Try creating a ticket:
     /linear create thoughts/shared/research/example.md

  3. Test the workflow:
     - Create a plan: /create_plan
     - Implement it: /implement_plan path/to/plan.md
     - Create PR: /describe_pr

View the full workflow guide:
  docs/LINEAR_WORKFLOW_AUTOMATION.md
```

## Error Handling

### If status already exists:
Skip it and note in output: `⚠️  [Status] (already exists - skipped)`

### If MCP tools not available:
Show clear error with setup instructions

### If team not found:
Show available teams and ask user to select again

### If creation fails:
Show error and continue with remaining statuses

## Important Notes

- This command is **idempotent** - safe to run multiple times
- It will skip any statuses that already exist
- Colors are optimized for Linear's UI
- Descriptions include automation hints
- Order matters - statuses are created in workflow order

## After Setup

Once workflow statuses are created, the user should:

1. **Configure /linear command** - Run `/linear` for first-time setup
2. **Try the workflow** - Create a ticket and move it through stages
3. **Customize if needed** - Statuses can be edited in Linear UI
4. **Share with team** - Commit the configured linear.md command

This setup enables seamless integration between Linear and your workflow commands!
