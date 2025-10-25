---
description: Manage Linear tickets with workflow automation
category: project-task-management
tools: Bash(linearis *), Read, Write, Edit, Grep
model: inherit
version: 1.0.0
---

# Linear - Ticket Management

You are tasked with managing Linear tickets, including creating tickets from thoughts documents,
updating existing tickets, and following a structured workflow using the Linearis CLI.

## Prerequisites Check

First, verify that Linearis CLI is installed and configured:

```bash
if ! command -v linearis &> /dev/null; then
    echo "❌ Linearis CLI not found"
    echo ""
    echo "Install with:"
    echo "  npm install -g --install-links ryanrozich/linearis#feat/cycles-cli"
    echo ""
    echo "Configure with:"
    echo "  export LINEAR_API_TOKEN=your_token"
    echo "  # or create ~/.linear_api_token file"
    exit 1
fi
```

## Configuration

Read team configuration from `.claude/config.json`:

```bash
CONFIG_FILE=".claude/config.json"

# Read team key (e.g., "ENG", "PROJ")
TEAM_KEY=$(jq -r '.linear.teamKey // "PROJ"' "$CONFIG_FILE")

# Read default team name (optional)
DEFAULT_TEAM=$(jq -r '.linear.defaultTeam // null' "$CONFIG_FILE")

# Read thoughts repo URL
THOUGHTS_URL=$(jq -r '.linear.thoughtsRepoUrl // "https://github.com/org/thoughts/blob/main"' "$CONFIG_FILE")
```

**Configuration in `.claude/config.json`**:
```json
{
  "linear": {
    "teamKey": "ENG",
    "defaultTeam": "Backend",
    "thoughtsRepoUrl": "https://github.com/coalesce-labs/thoughts/blob/main"
  }
}
```

## Initial Response

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

**Note**: These statuses must be configured in your Linear workspace settings. The Linearis CLI
will read and use whatever states exist in your workspace.

### Key Principle

**Review and alignment happen at the plan stage (not PR stage)** to move faster and avoid rework.

### Workflow Commands Integration

These commands automatically update ticket status:

- `/create_plan` → Moves ticket to "Plan in Progress"
- Plan completed → Moves to "Plan in Review"
- `/implement_plan` → Moves to "In Dev"
- `/create_pr` → Moves to "In Review"
- `/merge_pr` → Moves to "Done"

---

## Important Conventions

### URL Mapping for Thoughts Documents

When referencing thoughts documents, always provide GitHub links:

- `thoughts/shared/...` → `{thoughtsRepoUrl}/repos/{project}/shared/...`
- `thoughts/{user}/...` → `{thoughtsRepoUrl}/repos/{project}/{user}/...`
- `thoughts/global/...` → `{thoughtsRepoUrl}/global/...`

### Default Values

- **Status**: Create new tickets in "Backlog" status
- **Priority**: Default to Medium (3) for most tasks
  - Urgent (1): Critical blockers, security issues
  - High (2): Important features with deadlines, major bugs
  - Medium (3): Standard implementation tasks (default)
  - Low (4): Nice-to-haves, minor improvements

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

4. **Draft the ticket summary:** Present a draft to the user:

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

5. **Interactive refinement:** Ask the user:
   - Does this summary capture the ticket accurately?
   - What priority? (Default: Medium/3)
   - Any additional context to add?
   - Should we include more/less implementation detail?
   - Do you want to assign it to yourself?

   Note: Ticket will be created in "Backlog" status by default.

6. **Create the Linear ticket using Linearis CLI:**

   ```bash
   # Create issue with linearis
   linearis issues create \
     --team "$TEAM_KEY" \
     --title "[refined title]" \
     --description "[final description in markdown]" \
     --priority [1-4] \
     --status "Backlog"

   # Capture the created issue ID from output
   ISSUE_ID=$(linearis issues create ... | jq -r '.id')
   ```

   **Note**: Linearis creates issues in the team's default backlog state. To set specific status or
   assignee, create first then update:

   ```bash
   # Assign to self
   linearis issues update "$ISSUE_ID" --assignee "@me"
   ```

7. **Post-creation actions:**
   - Show the created ticket URL
   - Ask if user wants to:
     - Add a comment with additional implementation details
     - Update the original thoughts document with the ticket reference
   - If yes to updating thoughts doc:
     ```
     Add at the top of the document:
     ---
     linear_ticket: [TEAM-123]
     created: [date]
     ---
     ```

### 2. Adding Comments to Existing Tickets

When user wants to add a comment to a ticket:

1. **Determine which ticket:**
   - Use context from the current conversation to identify the relevant ticket
   - If uncertain, use `linearis issues read TEAM-123` to show ticket details and confirm

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

   Key insight: The 429 responses were clustered during batch operations, so exponential backoff
   alone wasn't sufficient - added request queuing.

   Files updated:

   - `src/webhooks/handler.ts` ([GitHub](link))
   - `thoughts/shared/rate_limit_analysis.md` ([GitHub](link))
   ```

5. **Add comment with Linearis:**

   ```bash
   linearis issues comment TEAM-123 "Your comment text here"
   ```

### 3. Moving Tickets Through Workflow

When moving tickets to a new status:

1. **Get current status:**
   ```bash
   linearis issues read TEAM-123 | jq -r '.state.name'
   ```

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

3. **Automatic status updates:** When certain commands are run, automatically update ticket status:
   - `/create_plan` with ticket → Move to "Plan in Progress"
   - Plan synced and linked → Move to "Plan in Review"
   - `/implement_plan` with ticket → Move to "In Dev"
   - `/create_pr` with ticket → Move to "In Review"
   - `/merge_pr` with ticket → Move to "Done"

4. **Manual status updates:**

   ```bash
   linearis issues update TEAM-123 --status "In Progress"
   ```

5. **Add comment explaining the transition:**
   ```bash
   linearis issues comment TEAM-123 "Moving to In Progress: Starting implementation"
   ```

### 4. Searching for Tickets

When user wants to find tickets:

1. **Gather search criteria:**
   - Query text
   - Status filters
   - Assignee filters

2. **Execute search:**

   ```bash
   # List all issues for team
   linearis issues list --team "$TEAM_KEY"

   # Filter by status
   linearis issues list --team "$TEAM_KEY" --status "In Progress"

   # Filter by assignee
   linearis issues list --team "$TEAM_KEY" --assignee "@me"

   # Search by text (filter JSON output with jq)
   linearis issues list --team "$TEAM_KEY" | \
     jq '.[] | select(.title | contains("search term"))'
   ```

3. **Present results:**
   - Show ticket ID, title, status, assignee
   - Include direct links to Linear
   - Parse JSON output for display

---

## Integration with Other Commands

### Automatic Ticket Updates

When these commands are run, check if there's a related Linear ticket and update it:

**During `/create_plan`:**

1. If ticket mentioned, move to "Plan in Progress"
2. When plan complete, add comment with plan link
3. Move to "Plan in Review"

**During `/implement_plan`:**

1. If ticket in plan metadata, move to "In Dev"
2. Add comment: "Started implementation from plan: [link]"

**During `/create_pr`:**

1. If ticket mentioned in PR or plan, move to "In Review"
2. Add comment with PR link

**During `/merge_pr`:**

1. Move ticket to "Done"
2. Add comment with merge details

---

## Example Workflows

### Workflow 1: Thought → Ticket → Plan → Implement

```bash
# 1. Research and document
/research_codebase "authentication patterns"
# Saves to thoughts/shared/research/auth-patterns.md

# 2. Create ticket from research
/linear create thoughts/shared/research/auth-patterns.md
# Creates ticket in Backlog

# 3. Create plan
/create_plan
# Reads research, creates plan
# Ticket moves to "Plan in Progress" → "Plan in Review"

# 4. Implement
/implement_plan thoughts/shared/plans/2025-01-08-auth-feature.md
# Ticket moves to "In Dev"

# 5. Create PR
/create_pr
# Ticket moves to "In Review"

# 6. Merge PR
/merge_pr
# Ticket moves to "Done"
```

### Workflow 2: Quick Ticket Updates

```bash
# Add progress comment
linearis issues comment PROJ-123 "Completed phase 1, moving to phase 2"

# Move ticket forward
linearis issues update PROJ-123 --status "In Dev"

# Search for related tickets
linearis issues list --team PROJ | jq '.[] | select(.title | contains("authentication"))'
```

---

## Linearis CLI Reference

### Common Commands

```bash
# List issues
linearis issues list --team TEAM [--status "Status"] [--assignee "@me"]

# Read specific issue
linearis issues read TICKET-123

# Create issue
linearis issues create --team TEAM --title "Title" --description "Description"

# Update issue
linearis issues update TICKET-123 --status "In Progress" [--assignee "@me"]

# Add comment
linearis issues comment TICKET-123 "Comment text"

# List cycles
linearis cycles list --team TEAM [--active]

# Read cycle
linearis cycles read "Sprint 2025-10" --team TEAM
```

### JSON Output Parsing

Linearis returns JSON, parse with jq:

```bash
# Get ticket status
linearis issues read TEAM-123 | jq -r '.state.name'

# Get ticket title
linearis issues read TEAM-123 | jq -r '.title'

# Get assignee
linearis issues read TEAM-123 | jq -r '.assignee.name'

# Filter list by keyword
linearis issues list --team TEAM | jq '.[] | select(.title | contains("bug"))'
```

---

## Notes

- **Configuration**: Use `.claude/config.json` for team settings
- **Status mapping**: Use status names that exist in your Linear workspace
- **Automation**: Workflow commands auto-update tickets when ticket IDs are referenced
- **CLI required**: Linearis CLI must be installed and configured with LINEAR_API_TOKEN

This command integrates seamlessly with the create_plan → implement_plan → validate_plan workflow
while keeping Linear tickets in sync!
