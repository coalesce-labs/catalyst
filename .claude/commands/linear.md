---
description: Manage Linear tickets with workflow automation
category: project-task-management
---

# Linear - Ticket Management

You are tasked with managing Linear tickets, including creating tickets from thoughts documents, updating existing tickets, and following a structured workflow.

## ⚠️ FIRST-TIME SETUP REQUIRED

**Before using this command for the first time**, you need to configure it for your Linear workspace.

Run this configuration check:
1. Check if this file contains `[NEEDS_SETUP]` markers
2. If yes, prompt the user for configuration and update this file
3. If no, proceed with normal operation

### Configuration Prompts

If `[NEEDS_SETUP]` markers are found, ask the user:

```
This Linear command needs one-time configuration. I'll help you set it up.

1. What's your Linear team ID?
   (Find it with: mcp__linear__list_teams)
   Team ID:

2. What's your default project ID (or leave blank for none)?
   (Find it with: mcp__linear__list_projects after selecting team)
   Project ID:

3. What's your thoughts repository URL pattern?
   For coalesce-labs: https://github.com/coalesce-labs/thoughts/blob/main
   Your pattern:

Once you provide these, I'll update this command file and remove this setup prompt.
You'll need to commit the changes so others on your team can use it too.
```

After getting responses, update this file:
- Replace `[NEEDS_SETUP:TEAM_ID]` with the actual team ID
- Replace `[NEEDS_SETUP:PROJECT_ID]` with the project ID (or remove if not used)
- Replace `[NEEDS_SETUP:THOUGHTS_URL]` with the URL pattern
- Remove this setup section entirely

Then inform the user:
```
✅ Configuration complete! I've updated the linear.md file.

Please commit this change:
  git add .claude/commands/linear.md
  git commit -m "Configure Linear command for this project"

Now you can use /linear normally!
```

---

## Configuration (Edit these values)

```javascript
// [NEEDS_SETUP] - Remove this line after configuration
const LINEAR_CONFIG = {
  teamId: "[NEEDS_SETUP:TEAM_ID]",  // Your Linear team ID
  defaultProjectId: "[NEEDS_SETUP:PROJECT_ID]",  // Default project ID (optional)
  thoughtsRepoUrl: "[NEEDS_SETUP:THOUGHTS_URL]",  // e.g., "https://github.com/org/thoughts/blob/main"
  reposPath: "repos",  // Path in thoughts repo to project-specific thoughts
  user: "your-name"  // Your username in thoughts (will be detected from thoughts config)
};
```

---

## Initial Setup

First, verify that Linear MCP tools are available by checking if any `mcp__linear__` tools exist. If not, respond:
```
I need access to Linear tools to help with ticket management. Please run the `/mcp` command to enable the Linear MCP server, then try again.
```

If tools are available, respond based on the user's request:

### For general requests:
```
I can help you with Linear tickets. What would you like to do?
1. Create a new ticket from a thoughts document
2. Add a comment to a ticket (I'll use our conversation context)
3. Search for tickets
4. Update ticket status or details
5. Move ticket through workflow
```

Then wait for the user's input.

---

## Workflow & Status Progression

This workflow ensures alignment through planning before implementation:

### Workflow Statuses

1. **Backlog** → New ideas and feature requests
2. **Triage** → Initial review and prioritization
3. **Spec Needed** → Needs problem statement and solution outline
4. **Research Needed** → Requires investigation
5. **Research in Progress** → Active research underway
6. **Ready for Plan** → Research complete, needs implementation plan
7. **Plan in Progress** → Writing implementation plan
8. **Plan in Review** → Plan under discussion
9. **Ready for Dev** → Plan approved, ready to implement
10. **In Dev** → Active development
11. **In Review** → PR submitted
12. **Done** → Completed

### Key Principle

**Review and alignment happen at the plan stage (not PR stage)** to move faster and avoid rework.

### Workflow Commands Integration

These commands automatically update ticket status:

- `/create_plan` → Moves ticket to "Plan in Progress"
- Plan completed → Moves to "Plan in Review"
- `/implement_plan` → Moves to "In Dev"
- `/describe_pr` → Moves to "In Review"

---

## Important Conventions

### URL Mapping for Thoughts Documents

When referencing thoughts documents, always provide GitHub links using the `links` parameter:
- `thoughts/shared/...` → `{thoughtsRepoUrl}/repos/{project}/shared/...`
- `thoughts/{user}/...` → `{thoughtsRepoUrl}/repos/{project}/{user}/...`
- `thoughts/global/...` → `{thoughtsRepoUrl}/global/...`

### Default Values

- **Status**: Create new tickets in "Backlog" status
- **Project**: Use configured `defaultProjectId` or ask user
- **Priority**: Default to Medium (3) for most tasks
  - Urgent (1): Critical blockers, security issues
  - High (2): Important features with deadlines, major bugs
  - Medium (3): Standard implementation tasks (default)
  - Low (4): Nice-to-haves, minor improvements
- **Links**: Use the `links` parameter to attach URLs (not just markdown links)

---

## Action-Specific Instructions

### 1. Creating Tickets from Thoughts

#### Steps to follow:

1. **Locate and read the thoughts document:**
   - If given a path, read the document directly
   - If given a topic/keyword, search thoughts/ directory using Grep
   - If multiple matches found, show list and ask user to select
   - Create a TodoWrite list to track: Read document → Analyze → Draft → Create

2. **Analyze the document content:**
   - Identify the core problem or feature being discussed
   - Extract key implementation details or technical decisions
   - Note any specific code files or areas mentioned
   - Look for action items or next steps
   - Identify what stage the idea is at (early ideation vs ready to implement)

3. **Check for related context (if mentioned in doc):**
   - If the document references specific code files, read relevant sections
   - If it mentions other thoughts documents, quickly check them
   - Look for any existing Linear tickets mentioned

4. **Get Linear workspace context:**
   - Use configured `teamId` from config
   - Use configured `defaultProjectId` or list projects: `mcp__linear__list_projects`

5. **Draft the ticket summary:**
   Present a draft to the user:
   ```
   ## Draft Linear Ticket

   **Title**: [Clear, action-oriented title]

   **Description**:
   [2-3 sentence summary of the problem/goal]

   ## Key Details
   - [Bullet points of important details from thoughts]
   - [Technical decisions or constraints]
   - [Any specific requirements]

   ## Implementation Notes (if applicable)
   [Any specific technical approach or steps outlined]

   ## References
   - Source: `thoughts/[path]` ([View on GitHub](converted URL))
   - Related code: [any file:line references]

   ---
   Based on the document, this seems to be at the stage of: [ideation/planning/ready to implement]
   ```

6. **Interactive refinement:**
   Ask the user:
   - Does this summary capture the ticket accurately?
   - Which project should this go in? [show list or use default]
   - What priority? (Default: Medium/3)
   - Any additional context to add?
   - Should we include more/less implementation detail?
   - Do you want to assign it to yourself?

   Note: Ticket will be created in "Backlog" status by default.

7. **Create the Linear ticket:**
   ```
   mcp__linear__create_issue with:
   - title: [refined title]
   - description: [final description in markdown]
   - teamId: [from config]
   - projectId: [selected or from config]
   - priority: [selected priority number, default 3]
   - stateId: [Backlog status ID]
   - assigneeId: [if requested]
   - links: [{url: "GitHub URL", title: "Document Title"}]
   ```

8. **Post-creation actions:**
   - Show the created ticket URL
   - Ask if user wants to:
     - Add a comment with additional implementation details
     - Create sub-tasks for specific action items
     - Update the original thoughts document with the ticket reference
   - If yes to updating thoughts doc:
     ```
     Add at the top of the document:
     ---
     linear_ticket: [URL]
     created: [date]
     ---
     ```

### 2. Adding Comments and Links to Existing Tickets

When user wants to add a comment to a ticket:

1. **Determine which ticket:**
   - Use context from the current conversation to identify the relevant ticket
   - If uncertain, use `mcp__linear__get_issue` to show ticket details and confirm

2. **Format comments for clarity:**
   - Keep concise (~10 lines) unless more detail needed
   - Focus on key insights or most useful information
   - Include relevant file references with backticks and GitHub links

3. **File reference formatting:**
   - Wrap paths in backticks: `thoughts/user/example.md`
   - Add GitHub link after: `([View](url))`
   - Do this for both thoughts/ and code files

4. **Comment structure example:**
   ```markdown
   Implemented retry logic in webhook handler to address rate limit issues.

   Key insight: The 429 responses were clustered during batch operations,
   so exponential backoff alone wasn't sufficient - added request queuing.

   Files updated:
   - `src/webhooks/handler.ts` ([GitHub](link))
   - `thoughts/shared/rate_limit_analysis.md` ([GitHub](link))
   ```

5. **Handle links properly:**
   - If adding a link with a comment: Update the issue with the link AND mention it in the comment
   - If only adding a link: Still create a comment noting what link was added
   - Always add links to the issue itself using the `links` parameter

### 3. Moving Tickets Through Workflow

When moving tickets to a new status:

1. **Get current status:**
   - Fetch ticket details with `mcp__linear__get_issue`
   - Show current status in workflow

2. **Suggest next status based on workflow:**
   ```
   Backlog → Triage (for initial review)
   Triage → Spec Needed (needs more detail) OR Research Needed (needs investigation)
   Spec Needed → Research Needed (once problem outlined)
   Research Needed → Research in Progress (starting research)
   Research in Progress → Ready for Plan (research complete)
   Ready for Plan → Plan in Progress (starting plan with /create_plan)
   Plan in Progress → Plan in Review (plan complete)
   Plan in Review → Ready for Dev (plan approved)
   Ready for Dev → In Dev (starting work with /implement_plan)
   In Dev → In Review (PR created)
   In Review → Done (PR merged)
   ```

3. **Automatic status updates:**
   When certain commands are run, automatically update ticket status:

   - `/create_plan` with ticket → Move to "Plan in Progress"
   - Plan synced and linked → Move to "Plan in Review"
   - `/implement_plan` with ticket → Move to "In Dev"
   - `/describe_pr` with ticket → Move to "In Review"

4. **Manual status updates:**
   ```
   mcp__linear__update_issue with:
   - id: [ticket ID]
   - stateId: [new status ID]
   ```

5. **Add comment explaining the transition:**
   ```
   mcp__linear__create_comment with:
   - issueId: [ticket ID]
   - body: "Moving to [new status]: [brief reason]"
   ```

### 4. Searching for Tickets

When user wants to find tickets:

1. **Gather search criteria:**
   - Query text
   - Project filters
   - Status filters
   - Date ranges

2. **Execute search:**
   ```
   mcp__linear__list_issues with:
   - query: [search text]
   - teamId: [from config]
   - projectId: [if specified]
   - stateId: [if filtering by status]
   - limit: 20
   ```

3. **Present results:**
   - Show ticket ID, title, status, assignee
   - Group by project if multiple projects
   - Include direct links to Linear

---

## Integration with Other Commands

### Automatic Ticket Updates

When these commands are run, check if there's a related Linear ticket and update it:

**During `/create_plan`:**
1. If ticket mentioned, move to "Plan in Progress"
2. When plan complete, attach to ticket via links
3. Add comment with plan summary
4. Move to "Plan in Review"

**During `/implement_plan`:**
1. If ticket in plan metadata, move to "In Dev"
2. Add comment: "Started implementation from plan: [link]"

**During `/describe_pr`:**
1. If ticket mentioned in PR or plan, move to "In Review"
2. Add comment with PR link

**During `/commit`:**
1. If ticket mentioned in commits, consider adding progress comment

---

## Example Workflows

### Workflow 1: Thought → Ticket → Plan → Implement

```bash
# 1. Research and document
/research_codebase "authentication patterns"
# Saves to thoughts/shared/research/auth-patterns.md

# 2. Create ticket from research
/linear create thoughts/shared/research/auth-patterns.md
# Creates ticket in Backlog → Move to "Research in Progress"

# 3. Create plan
/create_plan
# Reads research, creates plan
# Ticket moves to "Plan in Progress" → "Plan in Review"

# 4. Implement
/implement_plan thoughts/shared/plans/2025-01-08-auth-feature.md
# Ticket moves to "In Dev"

# 5. Create PR
/describe_pr
# Ticket moves to "In Review"
```

### Workflow 2: Quick Ticket Updates

```bash
# Add progress comment
/linear comment PROJ-123 "Completed phase 1, moving to phase 2"

# Move ticket forward
/linear move PROJ-123 "In Dev"

# Search for related tickets
/linear search "authentication"
```

---

## Notes

- **First-time setup**: Remember to configure this file before first use
- **Commit config**: Share your configured version with your team
- **Status mapping**: Customize workflow statuses for your team's process
- **Automation**: Workflow commands auto-update tickets when ticket IDs are referenced

This command integrates seamlessly with the create_plan → implement_plan → validate_plan workflow while keeping Linear tickets in sync!
