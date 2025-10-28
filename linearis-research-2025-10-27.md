# Linearis CLI Research: PR #4 Cycle Features

**Date:** 2025-10-27
**Purpose:** Understanding linearis capabilities for PM plugin implementation
**Focus:** Core features + PR #4 cycle additions

---

## What is Linearis?

Linearis is a command-line interface for Linear.app designed specifically for:

- **JSON-first output** - All commands return structured JSON for easy parsing
- **LLM agent optimization** - Token-efficient design (~1k tokens vs 13k for alternatives)
- **Developer workflows** - Smart ID resolution, optimized GraphQL queries
- **Scripting and automation** - Pipe to `jq` and other Unix tools

### Core Philosophy

The tool is described as "an opinionated Linear CLI client" that prioritizes:
- Working with tickets and comments via command line
- Maintaining low token usage for AI/LLM agents
- Providing structured data for integrations
- Smart ID resolution (supports `ABC-123` ticket format)

---

## Installation & Authentication

### Installation

```bash
# Install from GitHub
npm install -g --install-links czottmann/linearis

# Development setup
git clone <repository> && cd linearis
pnpm install
pnpm run build
```

### Authentication (Three Methods)

1. **Command-line flag:**
   ```bash
   linearis --api-token <token> issues list
   ```

2. **Environment variable:**
   ```bash
   export LINEAR_API_TOKEN=<token>
   linearis issues list
   ```

3. **File storage (recommended):**
   ```bash
   echo "<token>" > ~/.linear_api_token
   linearis issues list  # Auto-detects token
   ```

**Getting a token:**
- Log into Linear account
- Navigate to: Settings → Security & Access → Personal API keys
- Create a new API key

---

## Core Commands (Pre-PR #4)

### Issues

```bash
# List issues (with optional limit)
linearis issues list [-l <number>]

# Search issues
linearis issues search "<query>" \
  [--team <name>] \
  [--project <name>]

# Create issue
linearis issues create "<title>" \
  --team <name> \
  [--assignee <id>] \
  [--labels "<labels>"] \
  [--priority <number>] \
  [--description "<text>"]

# Read specific issue
linearis issues read <issue-id>

# Update issue
linearis issues update <issue-id> \
  [--state "<status>"] \
  [--priority <number>] \
  [--labels "<labels>"] \
  [--label-by <action>] \
  [--parent-ticket <id>] \
  [--clear-labels]
```

### Comments

```bash
# Add comment to issue
linearis comments create <issue-id> --body "<text>"
```

### Projects

```bash
# List all projects
linearis projects list
```

### Labels

```bash
# List labels (optionally filtered by team)
linearis labels list [--team <name>]
```

### Usage Documentation

```bash
# Display all commands and options (LLM-friendly)
linearis usage
```

---

## PR #4: Cycle Features (NEW)

**Pull Request:** https://github.com/czottmann/linearis/pull/4
**Closes Issues:** #2, #3
**Status:** Merged

### New Commands

#### 1. `cycles list` - Enumerate Cycles

**Command:**
```bash
linearis cycles list [options]
```

**Options:**
- `--team <team>` - Filter by team key, name, or ID
- `--limit <number>` - Result limit (default: 25)
- `--active` - Show only the active cycle
- `--around-active <n>` - Show active cycle ± n cycles (requires `--team`)

**Output:** JSON array of cycle objects containing:
- `id` - UUID
- `name` - Cycle name (e.g., "Sprint 2025-10")
- `number` - Cycle number
- `startsAt` - ISO timestamp
- `endsAt` - ISO timestamp
- `isActive` - Boolean
- `progress` - Completion percentage
- `issueCountHistory` - Historical issue counts
- `issues` - Nested array of issues in cycle

**Example Usage:**
```bash
# List all cycles for Backend team
linearis cycles list --team Backend

# Show only active cycle
linearis cycles list --team Backend --active

# Show active cycle plus 1 before and 1 after
linearis cycles list --team Backend --around-active 1

# Limit to 10 cycles
linearis cycles list --team Backend --limit 10
```

#### 2. `cycles read` - Retrieve Specific Cycle

**Command:**
```bash
linearis cycles read <cycleIdOrName> [options]
```

**Arguments:**
- `cycleIdOrName` - UUID or cycle name

**Options:**
- `--team <team>` - Scope name lookup to specific team
- `--issues-first <n>` - Fetch limit for issues in cycle (default: 50)

**Output:** Single cycle object (same structure as `cycles list`)

**Example Usage:**
```bash
# Read cycle by name (scoped to team)
linearis cycles read "Sprint 2025-10" --team Backend

# Read cycle by UUID
linearis cycles read "abc-123-def-456"

# Read cycle with custom issue limit
linearis cycles read "Q4 Planning" --team Backend --issues-first 100
```

### Enhanced `issues update` Command

**New Flags:**
- `--cycle <cycleName>` - Assign issue to a cycle by name
- `--clear-cycle` - Remove cycle assignment from issue

**Example Usage:**
```bash
# Assign issue to cycle
linearis issues update PROJ-123 --cycle "Sprint 2025-10"

# Remove cycle assignment
linearis issues update PROJ-123 --clear-cycle

# Combine with other updates
linearis issues update PROJ-123 \
  --cycle "Sprint 2025-10" \
  --state "In Progress" \
  --priority 1
```

---

## Smart Name Resolution (Cycle Lookup)

PR #4 introduces intelligent cycle identification logic:

### Resolution Strategy

1. **UUID Direct Lookup**
   - If input is a valid UUID → fetch directly (no name resolution)

2. **Team-Scoped Search (if `--team` provided)**
   - Search cycles within the specified team first
   - Prioritizes team-specific matches over global

3. **Global Name Search (fallback)**
   - Searches all cycles across all teams

### Disambiguation Logic

When multiple cycles match the name:

**Preference Ranking:**
1. **Active cycle** (`isActive: true`) - Highest priority
2. **Next cycle** (`isNext: true`) - Second priority
3. **Previous cycle** (`isPrevious: true`) - Third priority
4. **Single match** - Auto-selects if only one result

**Error Handling:**
- If ambiguous (multiple matches, no clear preference) → throws error
- Error message lists all candidate cycles with their statuses
- Helps user disambiguate by team or more specific name

### Example Scenarios

**Scenario 1: Unique name within team**
```bash
linearis cycles read "Sprint 2025-10" --team Backend
# ✓ Matches single cycle → returns it
```

**Scenario 2: Ambiguous name, active cycle exists**
```bash
linearis cycles read "Sprint 2025-10"
# Multiple teams have "Sprint 2025-10"
# ✓ Auto-selects the active one
```

**Scenario 3: Ambiguous with no preference**
```bash
linearis cycles read "Planning"
# Multiple "Planning" cycles, none active/next/previous
# ✗ Error: Lists all candidates with team names
```

---

## JSON Output Structure

All commands return structured JSON for easy parsing:

### Cycle Object Schema

```json
{
  "id": "abc-123-def-456",
  "name": "Sprint 2025-10",
  "number": 42,
  "startsAt": "2025-10-01T00:00:00.000Z",
  "endsAt": "2025-10-14T23:59:59.000Z",
  "isActive": true,
  "isNext": false,
  "isPrevious": false,
  "progress": 67.5,
  "issueCountHistory": [
    { "date": "2025-10-01", "count": 15 },
    { "date": "2025-10-08", "count": 10 }
  ],
  "issues": [
    {
      "id": "issue-uuid",
      "identifier": "PROJ-123",
      "title": "Feature implementation",
      "state": { "name": "In Progress" },
      "priority": 1,
      "assignee": { "name": "John Doe" }
    }
  ]
}
```

### Parsing with jq

```bash
# Get active cycle name
linearis cycles list --team Backend --active | jq -r '.[0].name'

# List issue identifiers in active cycle
linearis cycles list --team Backend --active | jq -r '.[0].issues[].identifier'

# Get cycle progress
linearis cycles read "Sprint 2025-10" --team Backend | jq -r '.progress'

# Count issues in cycle
linearis cycles read "Sprint 2025-10" --team Backend | jq '.issues | length'
```

---

## PM Workflow Integration Opportunities

### 1. Cycle/Sprint Planning

**Use Cases:**
- List upcoming cycles for planning
- Check active sprint status
- View sprint progress and issue distribution

**Commands:**
```bash
# View current and next 2 sprints
linearis cycles list --team Backend --around-active 2

# Check active sprint progress
linearis cycles list --team Backend --active | jq '.[0].progress'

# Get all issues in active sprint
linearis cycles list --team Backend --active | jq -r '.[0].issues[].identifier'
```

### 2. Issue Triage and Assignment

**Use Cases:**
- Bulk assign issues to current sprint
- Move issues between sprints
- Clear sprint assignments

**Commands:**
```bash
# Add issue to current sprint
linearis issues update PROJ-123 --cycle "Sprint 2025-10"

# Remove from sprint (for re-prioritization)
linearis issues update PROJ-123 --clear-cycle

# Combine with status update
linearis issues update PROJ-123 \
  --cycle "Sprint 2025-10" \
  --state "In Progress"
```

### 3. Sprint Retrospective Data

**Use Cases:**
- Analyze sprint completion rates
- Track issue count trends
- Compare sprint velocities

**Commands:**
```bash
# Get historical issue counts
linearis cycles read "Sprint 2025-10" --team Backend | \
  jq '.issueCountHistory'

# Compare start vs end issue count
linearis cycles read "Sprint 2025-10" --team Backend | \
  jq '{start: .issueCountHistory[0].count, end: .issueCountHistory[-1].count}'
```

### 4. Cross-Team Cycle Coordination

**Use Cases:**
- Check if multiple teams are on same sprint schedule
- Identify cycle misalignments
- Coordinate dependencies across teams

**Commands:**
```bash
# Compare active cycles across teams
for team in Backend Frontend Mobile; do
  echo "=== $team ==="
  linearis cycles list --team $team --active | jq -r '.[0].name'
done

# Check cycle overlap
linearis cycles read "Sprint 2025-10" --team Backend | \
  jq '{starts: .startsAt, ends: .endsAt}'
```

### 5. PM Dashboard Automation

**Use Cases:**
- Generate sprint status reports
- Track issue distribution across cycles
- Monitor sprint health metrics

**Example Script:**
```bash
#!/bin/bash
# Sprint status dashboard

TEAM="Backend"
CYCLE=$(linearis cycles list --team $TEAM --active | jq -r '.[0].name')

echo "=== Sprint Status: $CYCLE ==="
echo ""

# Progress
linearis cycles list --team $TEAM --active | \
  jq -r '"Progress: \(.[0].progress)%"'

# Issue counts by state
linearis cycles list --team $TEAM --active | \
  jq -r '.[0].issues | group_by(.state.name) |
         map({state: .[0].state.name, count: length}) |
         .[] | "\(.state): \(.count) issues"'

# High priority issues
echo ""
echo "High Priority Issues:"
linearis cycles list --team $TEAM --active | \
  jq -r '.[0].issues |
         map(select(.priority <= 1)) |
         .[] | "  - \(.identifier): \(.title)"'
```

---

## Technical Specifications

### Language & Framework
- Built with **TypeScript** (targeting ES2023)
- CLI framework: **Commander.js**
- Distribution: **npm** with git-based installation

### GraphQL Optimization
- Uses optimized GraphQL queries for Linear API
- Designed to minimize token usage for LLM agents
- Efficient data fetching with configurable limits

### Token Efficiency
- **~1,000 tokens** per operation (vs ~13k for alternatives)
- Critical for LLM agent integration
- Suitable for context-constrained workflows

### Output Format
- **JSON-only output** - No human-readable formatting
- Designed for piping to `jq` and other tools
- Consistent schema across all commands

---

## Limitations & Considerations

### Current Limitations (as of PR #4)

1. **No direct cycle creation** - Must be created via Linear UI/API
2. **No cycle metadata updates** - Can't change cycle dates/names via CLI
3. **Read-only cycle operations** - Only list/read, no delete/update
4. **Name resolution ambiguity** - Multiple cycles with same name requires team scoping

### Design Trade-offs

1. **JSON-only output** - Not human-friendly, requires parsing tools
2. **Opinionated** - Limited customization of output format
3. **Token optimization** - May omit some fields for efficiency
4. **Smart resolution complexity** - Name matching logic can be surprising

---

## Integration Recommendations for PM Plugin

### 1. Command Wrappers

Create thin wrappers around linearis commands:

```bash
# Example: Get active sprint issues
function get_active_sprint_issues() {
  local team=$1
  linearis cycles list --team "$team" --active | \
    jq -r '.[0].issues[] | "\(.identifier): \(.title)"'
}
```

### 2. State Management

Track current sprint context in workflow-context.json:

```json
{
  "pm": {
    "activeSprint": {
      "name": "Sprint 2025-10",
      "team": "Backend",
      "progress": 67.5,
      "issueCount": 15
    }
  }
}
```

### 3. Cycle-Aware Commands

Build PM commands that leverage cycle data:

- `/pm sprint-status` - Show active sprint dashboard
- `/pm sprint-planning` - Interactive sprint planning
- `/pm sprint-health` - Analyze sprint metrics
- `/pm move-to-sprint` - Bulk issue assignment

### 4. Cross-Command Integration

Integrate with existing workflow commands:

- `/create-plan` - Auto-assign to active sprint
- `/implement-plan` - Update issue cycle when starting work
- `/describe-pr` - Include sprint context in description

### 5. Error Handling

Handle common cycle resolution issues:

- Catch ambiguous cycle name errors
- Provide team scoping by default
- Fallback to UUID if name fails
- Cache cycle UUIDs for session

---

## Example Use Cases for PM Plugin

### Use Case 1: Sprint Health Check

**Goal:** Quick overview of current sprint status

**Implementation:**
```bash
# Get active sprint
CYCLE_JSON=$(linearis cycles list --team Backend --active)

# Extract key metrics
PROGRESS=$(echo "$CYCLE_JSON" | jq -r '.[0].progress')
TOTAL=$(echo "$CYCLE_JSON" | jq '.[0].issues | length')
IN_PROGRESS=$(echo "$CYCLE_JSON" | jq '[.[0].issues[] | select(.state.name == "In Progress")] | length')
BLOCKED=$(echo "$CYCLE_JSON" | jq '[.[0].issues[] | select(.state.name == "Blocked")] | length')

echo "Sprint Health:"
echo "  Progress: ${PROGRESS}%"
echo "  Total Issues: ${TOTAL}"
echo "  In Progress: ${IN_PROGRESS}"
echo "  Blocked: ${BLOCKED}"
```

### Use Case 2: Bulk Sprint Assignment

**Goal:** Add multiple issues to current sprint

**Implementation:**
```bash
# Get active sprint name
SPRINT=$(linearis cycles list --team Backend --active | jq -r '.[0].name')

# Assign issues
for issue in PROJ-123 PROJ-124 PROJ-125; do
  linearis issues update "$issue" --cycle "$SPRINT"
  echo "✓ Added $issue to $SPRINT"
done
```

### Use Case 3: Sprint Retrospective Report

**Goal:** Generate data for retrospective meeting

**Implementation:**
```bash
# Read completed sprint
CYCLE_JSON=$(linearis cycles read "Sprint 2025-09" --team Backend)

# Generate report
echo "Sprint Retrospective: Sprint 2025-09"
echo ""
echo "Velocity:"
echo "$CYCLE_JSON" | jq '{
  planned: .issueCountHistory[0].count,
  completed: (.issues | map(select(.state.name == "Done")) | length),
  progress: .progress
}'

echo ""
echo "Issues by Priority:"
echo "$CYCLE_JSON" | jq -r '.issues |
  group_by(.priority) |
  map({priority: .[0].priority, count: length})'
```

---

## Next Steps for PM Plugin Development

### 1. Core Integration
- [ ] Create linearis wrapper functions in PM plugin
- [ ] Add cycle-aware issue management commands
- [ ] Integrate with workflow-context.json

### 2. Sprint Management Commands
- [ ] `/pm sprint-status` - Dashboard view
- [ ] `/pm sprint-planning` - Interactive planning
- [ ] `/pm sprint-assign` - Bulk issue assignment
- [ ] `/pm sprint-retrospective` - Data extraction

### 3. Configuration
- [ ] Add `pm.defaultTeam` to `.claude/config.json`
- [ ] Add `pm.cycleFormat` for sprint naming conventions
- [ ] Support multiple team contexts

### 4. Workflow Integration
- [ ] Auto-assign issues to active sprint in `/create-plan`
- [ ] Update cycle context in `/implement-plan`
- [ ] Include sprint metrics in `/describe-pr`

### 5. Documentation
- [ ] Document linearis setup in PM plugin README
- [ ] Add sprint workflow examples
- [ ] Create troubleshooting guide

---

## References

- **Repository:** https://github.com/czottmann/linearis
- **PR #4 (Cycles):** https://github.com/czottmann/linearis/pull/4
- **Linear API Docs:** https://developers.linear.app/docs
- **Installation:** `npm install -g --install-links czottmann/linearis`
- **Authentication:** Store token in `~/.linear_api_token`

---

**End of Research Document**
