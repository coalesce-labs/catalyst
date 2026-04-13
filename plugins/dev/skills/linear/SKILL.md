---
name: linear
description:
  "Manage Linear tickets with workflow automation. **ALWAYS use when** the user says 'create a
  ticket', 'update the ticket', 'move ticket to', 'search Linear', or wants to create tickets from
  thoughts documents, update ticket status, or manage the Linear workflow. Uses Linearis CLI."
disable-model-invocation: true
allowed-tools: Bash(linearis *), Read, Write, Edit, Grep
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
    echo "  npm install -g linearis"
    echo ""
    echo "Configure with:"
    echo "  export LINEAR_API_TOKEN=your_token"
    echo "  # or create ~/.linear_api_token file"
    exit 1
fi
```

## Configuration

Read team configuration from `.catalyst/config.json`:

```bash
CONFIG_FILE=".catalyst/config.json"
[[ ! -f "$CONFIG_FILE" ]] && CONFIG_FILE=".claude/config.json"

# Read team key (e.g., "ENG", "PROJ")
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "$CONFIG_FILE")

# Read team UUID — required for issues create and issues search (keys don't work)
# Use `linearis teams usage` to discover UUIDs — see /catalyst-dev:linearis
TEAM_UUID=$(jq -r '.catalyst.linear.teamUuid // empty' "$CONFIG_FILE")
if [ -z "$TEAM_UUID" ]; then
  echo "WARNING: Could not resolve team UUID for $TEAM_KEY. issues create/search may target wrong team."
  echo "Add teamUuid to .catalyst/config.json — see /catalyst-dev:linearis for lookup commands"
fi

# Read thoughts repo URL
THOUGHTS_URL=$(jq -r '.catalyst.linear.thoughtsRepoUrl // "https://github.com/org/thoughts/blob/main"' "$CONFIG_FILE")
```

**Configuration in `.catalyst/config.json`**:

```json
{
  "catalyst": {
    "linear": {
      "teamKey": "ENG",
      "teamUuid": "<team-uuid>"
    }
  }
}
```

To find your team UUID, see `/catalyst-dev:linearis` for team discovery commands.

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

Catalyst maps workflow phases to your Linear workspace states via `stateMap` in
`.catalyst/config.json`. Default mapping (matches standard Linear states):

| Workflow Phase   | Default State | Config Key            |
| ---------------- | ------------- | --------------------- |
| New tickets      | Backlog       | `stateMap.backlog`    |
| Acknowledged     | Todo          | `stateMap.todo`       |
| Research started | In Progress   | `stateMap.research`   |
| Planning started | In Progress   | `stateMap.planning`   |
| Implementation   | In Progress   | `stateMap.inProgress` |
| PR created       | In Review     | `stateMap.inReview`   |
| Completed        | Done          | `stateMap.done`       |
| Canceled         | Canceled      | `stateMap.canceled`   |

**Customization**: Override any key to match your workspace. Set to `null` to skip that transition.

**Note**: These states must exist in your Linear workspace. The defaults match what Linear provides
out of the box (plus "In Review" which is commonly added to the Started category).

### Key Principle

**Review and alignment happen at the plan stage (not PR stage)** to move faster and avoid rework.

### Workflow Commands Integration

These commands automatically update ticket status using `stateMap` config:

- `/research-codebase` → Moves ticket to `stateMap.research` (default: "In Progress")
- `/create-plan` → Moves ticket to `stateMap.planning` (default: "In Progress")
- `/implement-plan` → Moves to `stateMap.inProgress` (default: "In Progress")
- `/create-pr` → Moves to `stateMap.inReview` (default: "In Review")
- `/merge-pr` → Moves to `stateMap.done` (default: "Done")

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

   Use `linearis issues usage` for create syntax, or see `/catalyst-dev:linearis`.

   **Important**: `--team` only accepts UUIDs, not team keys/names (upstream bug:
   czottmann/linearis#56). Team keys silently fall back to the workspace default. Use the
   `$TEAM_UUID` from config above.

   Linearis creates issues in the team's default backlog state. To set specific status or assignee,
   create first then update. Capture the created issue ID from the JSON output with jq.

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
   - If uncertain, read the ticket to show details and confirm (see `linearis issues usage`)

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

5. **Add comment with Linearis** (see `linearis comments usage` for syntax)

### 3. Moving Tickets Through Workflow

When moving tickets to a new status:

1. **Get current status** by reading the ticket (see `linearis issues usage`)

2. **Suggest next status based on workflow:**

   State names come from `stateMap` in `.catalyst/config.json`:

   ```
   Backlog → Todo (acknowledged)
   Todo → In Progress (research/planning/implementation started)
   In Progress → In Review (PR created)
   In Review → Done (PR merged)
   ```

   Teams with custom states can configure finer-grained transitions via `stateMap`.

3. **Automatic status updates:** When certain commands are run, automatically update ticket status
   (state names read from `stateMap` config):
   - `/research-codebase` with ticket → Move to `stateMap.research`
   - `/create-plan` with ticket → Move to `stateMap.planning`
   - `/implement-plan` with ticket → Move to `stateMap.inProgress`
   - `/create-pr` with ticket → Move to `stateMap.inReview`
   - `/merge-pr` with ticket → Move to `stateMap.done`

4. **Manual status updates** — use `linearis issues usage` for update syntax

5. **Add comment explaining the transition** — use `linearis comments usage` for syntax

### 4. Searching for Tickets

When user wants to find tickets:

1. **Gather search criteria:**
   - Query text
   - Status filters
   - Assignee filters

2. **Execute search** using `linearis issues usage` for search/list syntax:
   - Use `issues search` for server-side query matching
   - Use `issues list` + jq for filtering by fields that search doesn't support
   - **Note**: `--team` requires a UUID on search (upstream bug: czottmann/linearis#56)

3. **Present results:**
   - Show ticket ID, title, status, assignee
   - Include direct links to Linear
   - Parse JSON output for display

---

## Integration with Other Commands

### Automatic Ticket Updates

When these commands are run, check if there's a related Linear ticket and update it:

**During `/create-plan`:**

1. If ticket mentioned, move to `stateMap.planning` (default: "In Progress")
2. When plan complete, add comment with plan link

**During `/implement-plan`:**

1. If ticket in plan metadata, move to `stateMap.inProgress` (default: "In Progress")
2. Add comment: "Started implementation from plan: [link]"

**During `/create-pr`:**

1. If ticket mentioned in PR or plan, move to `stateMap.inReview` (default: "In Review")
2. Add comment with PR link

**During `/merge-pr`:**

1. Move ticket to `stateMap.done` (default: "Done")
2. Add comment with merge details

---

## Example Workflows

### Workflow 1: Thought → Ticket → Plan → Implement

```bash
# 1. Research and document
/catalyst-dev:research-codebase "authentication patterns"
# Saves to thoughts/shared/research/auth-patterns.md

# 2. Create ticket from research
/catalyst-dev:linear create thoughts/shared/research/auth-patterns.md
# Creates ticket in Backlog

# 3. Create plan
/catalyst-dev:create-plan
# Reads research, creates plan
# Ticket moves to stateMap.planning (default: "In Progress")

# 4. Implement
/catalyst-dev:implement-plan thoughts/shared/plans/2025-01-08-auth-feature.md
# Ticket moves to stateMap.inProgress (default: "In Progress")

# 5. Create PR
/catalyst-dev:create-pr
# Ticket moves to stateMap.inReview (default: "In Review")

# 6. Merge PR
/catalyst-dev:merge-pr
# Ticket moves to stateMap.done (default: "Done")
```

### Workflow 2: Quick Ticket Updates

Add a progress comment, move the ticket forward using the state name from `stateMap` config, and
search for related tickets. Use `linearis issues usage` and `linearis comments usage` for exact
syntax.

---

For Linearis CLI syntax, see the `linearis` skill reference.

---

## Notes

- **Configuration**: Use `.catalyst/config.json` for team settings and `stateMap` for state names
- **Status mapping**: Configure `linear.stateMap` to match your Linear workspace states
- **Automation**: Workflow commands auto-update tickets using state names from `stateMap`
- **CLI required**: Linearis CLI must be installed and configured with LINEAR_API_TOKEN

This command integrates seamlessly with the create-plan → implement-plan → validate-plan workflow
while keeping Linear tickets in sync!
