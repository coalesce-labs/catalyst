---
description: Set up recommended workflow statuses in Linear
category: project-task-management
install_once: true
---

# Linear Setup Workflow

You are tasked with automatically creating the recommended workflow statuses in a Linear team.

## Prerequisites

First, verify that Linear MCP tools are available by checking if any `mcp__linear__` tools exist. If not, respond:

```text
I need access to Linear tools to set up workflow statuses. Please run the `/mcp` command to enable the Linear MCP server, then try again.
```

## Process

### 1. Get Team Information

Ask the user which team to set up:

```text
I'll help you set up the recommended workflow statuses in Linear.

Let me get your teams...
```

Use `mcp__linear__list_teams` to get all teams.

Show teams to user:

```text
Available teams:
1. [Team Name] (key: TEAM)
2. [Team Name] (key: PROJ)

Which team should I set up? (enter number or team key)
```

### 2. Confirm Setup

Once team is selected, show what will be created:

```text
I'll create these workflow statuses for team: [TEAM NAME]

BACKLOG
  1. Backlog - New ideas and feature requests

UNSTARTED
  2. Research - Investigation, triage, and spec definition

STARTED
  3. Planning - Writing and reviewing implementation plans
  4. In Progress - Active development and implementation
  5. In Review - PR submitted for code review

COMPLETED
  6. Done - Completed and deployed

This will integrate with your workflow commands:
- /research_codebase → Research
- /create_plan → Planning
- /implement_plan → In Progress
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
    color: "#bec2c8", // Gray
  },

  // UNSTARTED
  {
    name: "Research",
    type: "unstarted",
    description:
      "Investigation, triage, and spec definition (auto-set by /research_codebase)",
    color: "#f2c94c", // Yellow
  },

  // STARTED - Planning & Development
  {
    name: "Planning",
    type: "started",
    description:
      "Writing and reviewing implementation plans (auto-set by /create_plan)",
    color: "#f2c94c", // Yellow
  },
  {
    name: "In Progress",
    type: "started",
    description:
      "Active development and implementation (auto-set by /implement_plan)",
    color: "#5e6ad2", // Blue
  },
  {
    name: "In Review",
    type: "started",
    description: "PR submitted for code review (auto-set by /describe_pr)",
    color: "#5e6ad2", // Blue
  },

  // COMPLETED
  {
    name: "Done",
    type: "completed",
    description: "Completed and deployed",
    color: "#5e6ad2", // Blue
  },
];
```

Create each status using the MCP tool. If a status already exists (error), skip it and note it:

```text
Creating statuses...
  ✓ Backlog
  ✓ Research
  ✓ Planning
  ✓ In Progress
  ✓ In Review
  ✓ Done
```

### 4. Verify Creation

After creating all statuses, verify with `mcp__linear__list_workflow_states`:

```text
Verifying workflow setup...
```

List all statuses and confirm they match the expected set.

### 5. Set Default State

If possible, set "Backlog" as the default state for new issues in the team.

### 6. Completion Summary

Show completion summary:

```text
✅ Workflow setup complete!

Created 6 workflow statuses for team: [TEAM NAME]

Workflow progression:
  Backlog → Research → Planning → In Progress → In Review → Done

Automatic status updates:
  • /research_codebase → Research
  • /create_plan → Planning
  • /implement_plan → In Progress
  • /describe_pr → In Review

Next steps:
  1. Configure the /linear command for this team
     Run: /linear
     (It will prompt for team ID and project ID)

  2. Try creating a ticket:
     /linear create thoughts/shared/research/example.md

  3. Test the workflow:
     - Research: /research_codebase "How does X work?"
     - Plan: /create_plan
     - Implement: /implement_plan path/to/plan.md
     - Review: /describe_pr

View the full workflow guide:
  docs/LINEAR_WORKFLOW_AUTOMATION.md
```

## Error Handling

### If status already exists

Skip it and note in output: `⚠️  [Status] (already exists - skipped)`

### If MCP tools not available

Show clear error with setup instructions

### If team not found

Show available teams and ask user to select again

### If creation fails

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
