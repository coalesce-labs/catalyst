# Usage Guide

A comprehensive guide to using the Ryan Claude Workspace for AI-assisted development.

## Table of Contents

- [Initial Setup](#initial-setup)
- [Project Initialization](#project-initialization)
- [Working with Thoughts](#working-with-thoughts)
- [Using Research Agents](#using-research-agents)
- [Workflow Commands](#workflow-commands)
- [Worktree Workflow](#worktree-workflow)
- [Concrete Examples](#concrete-examples)

---

## Initial Setup

### Step 1: Install Catalyst Plugin

Install Catalyst via the Claude Code plugin marketplace:

```bash
# Add the marketplace repository
/plugin marketplace add coalesce-labs/catalyst

# Install catalyst-dev (main workflow)
/plugin install catalyst-dev

# Optionally install catalyst-meta (workflow discovery)
/plugin install catalyst-meta
```

This makes all agents and commands available in Claude Code across all projects.

### Step 2: Install the Thoughts System

The thoughts repository is a centralized, version-controlled context management system that persists
across all your worktrees.

```bash
# Install HumanLayer CLI
pip install humanlayer
# or
pipx install humanlayer

# Download and run the thoughts setup script
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/scripts/setup-thoughts.sh
chmod +x setup-thoughts.sh
./setup-thoughts.sh
```

This creates:

```
~/thoughts/
├── repos/              # Per-repository context
│   └── (empty initially - created per project)
└── global/             # Cross-repository thoughts
    ├── patterns/       # General coding patterns
    ├── decisions/      # Architecture decisions
    └── learnings/      # Lessons learned
```

The thoughts repository is a git repository itself, allowing you to:

- Version control all your context
- Sync across machines
- Share with teammates
- Restore historical context

---

## Project Initialization

### Initialize Thoughts for a New Project

When you start working on a new repository:

```bash
cd /path/to/your-project

# Run the init command (installed by setup-thoughts.sh)
ryan-init-project my-project-name
```

This creates a symlinked thoughts directory in your project:

```
your-project/
├── thoughts/           # Symlinked to ~/thoughts/repos/my-project-name/
│   ├── {your_name}/   # Personal notes (git-ignored by default)
│   │   ├── tickets/   # Your ticket research
│   │   ├── notes/     # Personal notes
│   │   └── scratch/   # Temporary thoughts
│   ├── shared/        # Team-shared (committed to thoughts repo)
│   │   ├── plans/     # Implementation plans
│   │   ├── research/  # Research documents
│   │   ├── tickets/   # Detailed ticket analysis
│   │   └── prs/       # PR descriptions
│   ├── global/        # Cross-repo (symlinked to ~/thoughts/global/)
│   └── searchable/    # Hard links for fast searching (read-only)
└── .gitignore         # Updated to ignore thoughts/
```

**Key Benefits:**

- **Persistent**: Survives across worktrees
- **Searchable**: Fast grep via searchable/ directory
- **Organized**: Clear separation of personal vs shared
- **Portable**: Symlinked from central location

### Understanding the Thoughts Structure

**Personal Directory (`thoughts/{your_name}/`)**

- Your private notes and research
- Not shared with team
- Use for exploration, TODOs, rough ideas

**Shared Directory (`thoughts/shared/`)**

- Team knowledge base
- Implementation plans
- Ticket analysis
- PR descriptions
- Research findings

**Global Directory (`thoughts/global/`)**

- Cross-repository knowledge
- General patterns
- Architecture decisions
- Shared learnings

**Searchable Directory (`thoughts/searchable/`)**

- Read-only hard links to all above
- Enables fast searching without traversing multiple directories
- Automatically maintained by thoughts sync

---

## Working with Thoughts

### Creating Documents

Documents in thoughts/ should follow naming conventions:

**Plans**: `YYYY-MM-DD-ENG-XXXX-description.md`

```bash
# Example
thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

**Research**: `YYYY-MM-DD_topic.md` or `topic.md`

```bash
thoughts/shared/research/2025-01-08_authentication_approaches.md
thoughts/shared/research/database_patterns.md
```

**Tickets**: `eng_XXXX.md` or `ticket_description.md`

```bash
thoughts/shared/tickets/eng_1234.md
thoughts/ryan/tickets/eng_1235_my_notes.md
```

**PR Descriptions**: `pr_XXXX_description.md`

```bash
thoughts/shared/prs/pr_456_add_rate_limiting.md
```

### Syncing Thoughts

The thoughts directory is a git repository. Sync changes regularly:

```bash
# Sync from any project directory
humanlayer thoughts sync

# Or manually
cd ~/thoughts
git add .
git commit -m "Update research and plans"
git push
```

**Best Practice**: Sync after:

- Creating or updating plans
- Completing research
- Finishing implementation
- Creating PR descriptions

### Backing Up Thoughts

Since thoughts are git-backed, you can:

```bash
# Push to remote
cd ~/thoughts
git remote add origin <your-thoughts-repo-url>
git push -u origin main

# Clone on another machine
git clone <your-thoughts-repo-url> ~/thoughts

# Then re-run ryan-init-project in each repository
```

---

## Using Research Agents

Agents are specialized AI experts that Claude Code can delegate to. They follow the principle of
**focused, read-only research**.

### Available Agents

#### codebase-locator

Finds files and directories relevant to a feature or task.

**When to use:**

- Finding all files related to a feature
- Locating test files
- Discovering configuration files
- Mapping directory structure

**Example:**

```
@agent-codebase-locator find all files related to authentication
```

**What it does:**

- Uses Grep, Glob, and Bash(ls) to search
- Returns categorized file paths
- Groups by purpose (implementation, tests, config, etc.)
- Does NOT read file contents

**Output:**

```
## File Locations for Authentication

### Implementation Files
- src/auth/authenticator.js - Main authentication logic
- src/auth/session-manager.js - Session handling
- src/middleware/auth.js - Auth middleware

### Test Files
- src/auth/__tests__/authenticator.test.js
- e2e/auth.spec.js

### Configuration
- config/auth.json
```

#### codebase-analyzer

Analyzes HOW code works with detailed implementation analysis.

**When to use:**

- Understanding complex logic
- Tracing data flow
- Identifying integration points
- Learning how a feature works

**Example:**

```
@agent-codebase-analyzer explain how the authentication flow works from login to session creation
```

**What it does:**

- Reads files to understand logic
- Traces function calls and data flow
- Returns detailed analysis with file:line references
- Documents patterns and conventions

**Output includes:**

- Entry points with line numbers
- Step-by-step data flow
- Key functions and their purposes
- Configuration and dependencies

#### thoughts-locator

Discovers relevant documents in the thoughts/ directory.

**When to use:**

- Finding previous research
- Locating related tickets
- Discovering existing plans
- Searching historical context

**Example:**

```
@agent-thoughts-locator find any documents about rate limiting
```

**What it does:**

- Searches all thoughts directories
- Categorizes by document type
- Corrects searchable/ paths to actual paths
- Returns organized results

**Output:**

```
## Thought Documents about Rate Limiting

### Tickets
- thoughts/shared/tickets/eng_1234.md - Implement API rate limiting

### Research Documents
- thoughts/shared/research/2025-01-05_rate_limiting.md

### Implementation Plans
- thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

#### codebase-pattern-finder

Finds similar implementations and code patterns to model after.

**When to use:**

- Finding examples of similar features
- Discovering coding conventions
- Locating test patterns
- Understanding best practices in the codebase

**Example:**

```
@agent-codebase-pattern-finder show me examples of pagination implementations
```

**What it does:**

- Searches for similar code
- Extracts actual code snippets
- Shows multiple variations
- Includes test examples

**Output includes:**

- Concrete code examples
- Multiple pattern variations
- Test patterns
- Usage locations

#### thoughts-analyzer

Deeply analyzes thoughts documents to extract actionable insights.

**When to use:**

- Extracting key decisions from research
- Understanding past architectural choices
- Finding specific technical details
- Validating current relevance

**Example:**

```
@agent-thoughts-analyzer analyze thoughts/shared/research/2025-01-05_rate_limiting.md and extract key decisions
```

**What it does:**

- Reads documents completely
- Extracts decisions and trade-offs
- Filters noise and outdated info
- Returns actionable insights

**Output includes:**

- Key decisions made
- Technical specifications
- Constraints and trade-offs
- Relevance assessment

### Agent Best Practices

**Spawn Multiple Agents in Parallel**

Research agents work independently, so spawn multiple for comprehensive research:

```
I need to understand the payment system.

@agent-codebase-locator find all payment-related files
@agent-thoughts-locator search for any payment research or tickets
@agent-codebase-pattern-finder show me similar payment implementations
```

**Be Specific in Your Requests**

Good:

```
@agent-codebase-analyzer trace how a webhook is validated and processed in the webhook handler
```

Bad:

```
@agent-codebase-analyzer look at webhooks
```

**Use the Right Agent for the Job**

- **Finding files?** → codebase-locator
- **Understanding logic?** → codebase-analyzer
- **Finding examples?** → codebase-pattern-finder
- **Searching thoughts?** → thoughts-locator
- **Deep analysis of thoughts?** → thoughts-analyzer

---

## Workflow Commands

Commands are slash commands that execute multi-step workflows.

### /catalyst-dev:create_plan

Creates comprehensive implementation plans through interactive research and collaboration.

**Basic Usage:**

```
/catalyst-dev:create_plan
```

Claude will ask for task details and guide you through the planning process.

**With Ticket File:**

```
/catalyst-dev:create_plan thoughts/shared/tickets/eng_1234.md
```

**With Deep Analysis:**

```
/catalyst-dev:create_plan think deeply about thoughts/shared/tickets/eng_1234.md
```

**The Process:**

1. **Context Gathering**
   - Reads all provided files FULLY
   - Spawns parallel research agents:
     - codebase-locator for finding files
     - codebase-analyzer for understanding current implementation
     - thoughts-locator for historical context
   - Reads all discovered files into main context

2. **Initial Analysis**
   - Presents understanding with file:line references
   - Asks targeted questions that research couldn't answer
   - Verifies assumptions

3. **Research & Discovery**
   - Creates research todo list
   - Spawns specialized agents for deep investigation
   - Waits for all research to complete
   - Presents findings and design options

4. **Plan Structure**
   - Proposes phase breakdown
   - Gets feedback on structure
   - Iterates until aligned

5. **Detailed Writing**
   - Writes plan to `thoughts/shared/plans/YYYY-MM-DD-ENG-XXXX-description.md`
   - Includes both automated and manual success criteria
   - Documents what's NOT being done (scope control)
   - References all relevant files with line numbers

6. **Review & Iteration**
   - Syncs thoughts directory
   - Presents plan for review
   - Iterates based on feedback

**Plan Structure:**

```markdown
# Feature Implementation Plan

## Overview

[Brief description]

## Current State Analysis

[What exists, what's missing, key constraints]

## Desired End State

[Specification and verification criteria]

## What We're NOT Doing

[Explicit out-of-scope items]

## Phase 1: [Name]

### Overview

### Changes Required

### Success Criteria

#### Automated Verification

- [ ] Tests pass: `make test`

#### Manual Verification

- [ ] Feature works in UI

## Testing Strategy

## References
```

### /catalyst-dev:implement_plan

Executes an approved implementation plan phase by phase.

**Usage:**

```
/catalyst-dev:implement_plan thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

**The Process:**

1. **Initialization**
   - Reads plan completely
   - Checks for existing checkmarks (resume capability)
   - Reads original ticket and referenced files FULLY
   - Creates todo list for tracking

2. **Implementation**
   - Implements each phase fully before moving to next
   - Updates checkboxes in plan as work completes
   - Runs automated verification at natural stopping points
   - Adapts to reality while following plan's intent

3. **Verification**
   - Runs success criteria checks
   - Fixes issues before proceeding
   - Updates progress in plan file

**Resuming Work:**

If plan has checkmarks, implementation picks up from first unchecked item:

```markdown
## Phase 1: Database Schema

- [x] Add migration file
- [x] Run migration
- [ ] Add indexes ← Resumes here
```

**Handling Mismatches:**

If reality doesn't match the plan:

```
Issue in Phase 2:
Expected: Configuration in config/auth.json
Found: Configuration moved to environment variables
Why this matters: Plan assumes JSON editing

How should I proceed?
```

### /catalyst-dev:validate_plan

Verifies implementation correctness and identifies deviations.

**Usage:**

```
/catalyst-dev:validate_plan
```

**The Process:**

1. **Context Discovery**
   - Locates the plan (from commits or user input)
   - Reviews git commits for changes
   - Reads plan completely

2. **Parallel Research**
   - Spawns agents to verify each aspect:
     - Database changes
     - Code changes
     - Test coverage
   - Compares actual vs planned

3. **Automated Verification**
   - Runs all success criteria commands
   - Documents pass/fail status
   - Investigates failures

4. **Validation Report**

```markdown
## Validation Report: Rate Limiting

### Implementation Status

✓ Phase 1: Database Schema - Fully implemented ✓ Phase 2: API Endpoints - Fully implemented ⚠️ Phase
3: UI Components - Partially implemented

### Automated Verification Results

✓ Tests pass: `make test` ✗ Linting issues: `make lint` (3 warnings)

### Code Review Findings

#### Matches Plan:

- Migration adds rate_limits table
- API returns 429 on exceeded limits

#### Deviations:

- Used Redis instead of in-memory (improvement)

#### Potential Issues:

- Missing index on user_id column

### Manual Testing Required:

- [ ] Verify UI shows rate limit errors
- [ ] Test with 1000+ requests
```

**When to Use:**

- After implementing a plan
- Before creating a PR
- During code review
- To verify completeness

---

## Workflow State Management

Catalyst automatically tracks your workflow state in `.claude/.workflow-context.json` to enable
intelligent command chaining.

### What is workflow-context.json?

A local file that tracks recent workflow documents (research, plans, handoffs, PRs) so commands can
auto-discover them without manual file paths.

**Location**: `.claude/.workflow-context.json` (per-worktree, not committed to git)

**Structure**:

```json
{
  "lastUpdated": "2025-10-26T10:30:00Z",
  "currentTicket": "PROJ-123",
  "mostRecentDocument": {
    "type": "plans",
    "path": "thoughts/shared/plans/2025-10-26-PROJ-123-feature.md",
    "created": "2025-10-26T10:30:00Z",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [
      {
        "path": "thoughts/shared/research/2025-10-26-auth-flow.md",
        "created": "2025-10-26T09:15:00Z",
        "ticket": "PROJ-123"
      }
    ],
    "plans": [
      {
        "path": "thoughts/shared/plans/2025-10-26-PROJ-123-feature.md",
        "created": "2025-10-26T10:30:00Z",
        "ticket": "PROJ-123"
      }
    ],
    "handoffs": [],
    "prs": []
  }
}
```

### How Commands Use It

**Automatic path discovery**:

1. `/research-codebase` → Saves research document to context
2. `/create-plan` → Automatically finds and references recent research
3. `/implement-plan` → Automatically finds most recent plan (no path needed!)
4. `/create-handoff` → Saves handoff document to context
5. `/resume-handoff` → Automatically finds most recent handoff

**Example workflow**:

```bash
# Step 1: Research (saves to context)
/research-codebase
> How does authentication work?

# Step 2: Create plan (auto-finds research)
/create-plan
# Plan automatically includes research from step 1

# Step 3: Implement (auto-finds plan)
/implement-plan
# No need to specify plan path - uses most recent!

# Step 4: Create handoff (saves to context)
/create-handoff

# Later: Resume work (auto-finds handoff)
/resume-handoff
# Automatically loads most recent handoff
```

### Manual Management

**View context**:

```bash
cat .claude/.workflow-context.json | jq
```

**Initialize context** (normally automatic):

```bash
plugins/dev/scripts/workflow-context.sh init
```

**Add document manually** (normally automatic):

```bash
plugins/dev/scripts/workflow-context.sh add plans thoughts/shared/plans/my-plan.md PROJ-123
```

**Get most recent plan**:

```bash
plugins/dev/scripts/workflow-context.sh recent plans
```

**Get all documents for ticket**:

```bash
plugins/dev/scripts/workflow-context.sh ticket PROJ-123
```

### Benefits

✅ **No manual paths**: Commands remember your work ✅ **Seamless chaining**: Research → Plan →
Implement flows naturally ✅ **Per-worktree**: Each worktree has independent workflow state ✅
**Automatic**: Updated by commands, no user intervention needed

### Worktree Behavior

Each worktree maintains its own `.workflow-context.json`:

- **Main repo**: `.claude/.workflow-context.json` tracks main branch work
- **Worktree 1**: `~/wt/myapp/feature-a/.claude/.workflow-context.json` tracks feature-a
- **Worktree 2**: `~/wt/myapp/feature-b/.claude/.workflow-context.json` tracks feature-b

This allows parallel work on different features with independent workflow states.

---

## Worktree Workflow

Worktrees allow parallel work on different features while sharing the thoughts directory.

### Creating a Worktree

```bash
cd /path/to/main-repository

# Create worktree with ticket number and feature name
/create-worktree ENG-1234 rate-limiting
```

This creates:

```
~/wt/main-repository/rate-limiting/
├── .git                # Separate working directory
├── .claude/            # Copied from main repo
├── thoughts/           # SHARED with main repo (symlinked)
└── [project files]     # Separate working copy
```

**What happens:**

1. Git worktree created at `~/wt/{repo-name}/{feature-name}/`
2. New branch `ENG-1234-rate-limiting` created
3. `.claude/` directory copied over
4. `thoughts/` automatically shared (same symlink target)
5. Dependencies installed (if applicable)

### Working in a Worktree

Your worktree is a complete, independent working directory:

```bash
cd ~/wt/main-repository/rate-limiting

# Work normally
git status
make test
npm run dev
```

**Thoughts are Shared:**

Any changes to thoughts/ in the worktree are immediately visible in the main repository:

```bash
# In worktree
echo "Research" > thoughts/shared/research/topic.md

# In main repo
cat thoughts/shared/research/topic.md  # Same file!
```

### Parallel Work Example

**Main Repository:**

```bash
cd ~/projects/my-app
git branch
# * main

# Working on bugfix
vim src/bugfix.js
```

**Worktree 1:**

```bash
cd ~/wt/my-app/rate-limiting
git branch
# * ENG-1234-rate-limiting

# Working on rate limiting feature
vim src/rate-limiter.js

# Create plan
/catalyst-dev:create_plan
# Plan saved to thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

**Worktree 2:**

```bash
cd ~/wt/my-app/authentication
git branch
# * ENG-1235-authentication

# Can see plan from worktree 1!
cat thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

### Cleaning Up Worktrees

After merging your feature:

```bash
# From main repository
git worktree remove ~/wt/my-app/rate-limiting

# Or if already deleted
git worktree prune
```

---

## Concrete Examples

### Example 1: Implementing a New Feature from Scratch

**Scenario**: Add rate limiting to an API

**Step 1: Create Research Ticket**

```bash
cd ~/projects/my-api

# Create ticket file
cat > thoughts/shared/tickets/eng_1234.md << 'EOF'
# ENG-1234: Add Rate Limiting to API

## Objective
Implement rate limiting to prevent API abuse.

## Requirements
- 100 requests/minute for anonymous users
- 1000 requests/minute for authenticated users
- Return 429 status when exceeded
- Include retry-after header

## Constraints
- Must work across multiple instances
- No blocking operations in request path
EOF
```

**Step 2: Create Implementation Plan**

```
# In Claude Code
/catalyst-dev:create_plan thoughts/shared/tickets/eng_1234.md
```

Claude will:

1. Read the ticket
2. Research current authentication system
3. Find similar rate limiting examples
4. Ask clarifying questions
5. Create detailed plan with phases

**Step 3: Review and Refine Plan**

```
thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md

# Review the plan, give feedback
# Claude iterates until plan is solid
```

**Step 4: Implement the Plan**

```
/catalyst-dev:implement_plan thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

Claude implements phase by phase, checking boxes as it progresses.

**Step 5: Validate Implementation**

```
/catalyst-dev:validate_plan
```

Claude runs all success criteria and generates validation report.

**Step 6: Commit and Push**

```bash
git add .
git commit -m "Implement rate limiting (ENG-1234)"
git push
```

### Example 2: Working with Parallel Features in Worktrees

**Scenario**: Two features being developed simultaneously

**Main Repo - Bugfixes**

```bash
cd ~/projects/my-app

# Working on small bugfixes on main
git checkout main
vim src/components/Button.js
git commit -m "Fix button styling"
```

**Worktree 1 - Major Feature A**

```bash
# Create worktree for feature A
/create-worktree ENG-1234 new-dashboard

cd ~/wt/my-app/new-dashboard

# Create and implement plan
/catalyst-dev:create_plan thoughts/shared/tickets/eng_1234.md
/catalyst-dev:implement_plan thoughts/shared/plans/2025-01-08-ENG-1234-new-dashboard.md
```

**Worktree 2 - Major Feature B**

```bash
# Create worktree for feature B (while A is in progress)
cd ~/projects/my-app
/create-worktree ENG-1235 user-settings

cd ~/wt/my-app/user-settings

# Can reference research from feature A!
@agent-thoughts-locator find dashboard research

# Create separate plan
/catalyst-dev:create_plan thoughts/shared/tickets/eng_1235.md
```

**Both worktrees share thoughts:**

- Plans visible across all worktrees
- Research accessible everywhere
- No context duplication

**Cleanup:**

```bash
# After feature A is merged
cd ~/projects/my-app
git worktree remove ~/wt/my-app/new-dashboard
git branch -d ENG-1234-new-dashboard

# Feature B continues independently
```

### Example 3: Using Research Agents for Investigation

**Scenario**: Debugging a complex issue

```
# In Claude Code

I need to understand why webhooks are failing intermittently.

# Spawn parallel research
@agent-codebase-locator find all webhook-related files
@agent-thoughts-locator search for any webhook issues or research
@agent-codebase-analyzer trace the webhook processing flow from receipt to completion
```

Claude spawns three agents simultaneously:

**Agent 1 Result (codebase-locator):**

```
## Webhook Files
### Implementation
- src/webhooks/handler.js
- src/webhooks/validator.js
- src/webhooks/processor.js

### Tests
- tests/webhooks/handler.test.js
```

**Agent 2 Result (thoughts-locator):**

```
## Webhook Documents
### Tickets
- thoughts/shared/tickets/eng_0987.md - Webhook timeout issues

### Research
- thoughts/shared/research/webhook_reliability.md
```

**Agent 3 Result (codebase-analyzer):**

```
## Webhook Flow Analysis
1. Request arrives: handler.js:23
2. Signature validation: validator.js:15-34
3. Async processing: processor.js:45
4. Database update: processor.js:67

Key finding: No timeout handling in processor.js:45
```

**Then investigate further:**

```
@agent-thoughts-analyzer analyze thoughts/shared/tickets/eng_0987.md

# Returns past solution that was implemented
# Confirms timeout handling was added but in different location
```

### Example 4: Team Collaboration with Shared Thoughts

**Developer A:**

```bash
cd ~/projects/shared-app

# Research authentication approaches
cat > thoughts/shared/research/2025-01-08_auth_comparison.md << 'EOF'
# Authentication Approaches

## Evaluated Options
1. JWT tokens - Stateless, scalable
2. Session tokens - Simpler, requires state

## Decision: JWT
Rationale: API will be called by mobile apps

## Implementation Notes
- Use RS256 algorithm
- 1 hour expiry
- Refresh token pattern
EOF

# Sync to shared repository
humanlayer thoughts sync
```

**Developer B (different machine):**

```bash
cd ~/projects/shared-app

# Pull latest thoughts
humanlayer thoughts sync

# Can now reference Developer A's research
/catalyst-dev:create_plan

# Claude reads shared research automatically
@agent-thoughts-locator find authentication research

# Plan builds on shared context
```

**Result**: No duplicated research, shared understanding, consistent implementation.

---

## Tips and Tricks

### Quick Search Across All Thoughts

```bash
# Search thoughts via searchable directory
grep -r "rate limiting" thoughts/searchable/

# Search only shared thoughts
grep -r "authentication" thoughts/shared/
```

### Viewing Recent Plans

```bash
ls -lt thoughts/shared/plans/ | head -10
```

### Finding Related Work

```
@agent-thoughts-locator find anything about [feature area]
@agent-codebase-pattern-finder show similar implementations
```

### Resuming Interrupted Work

Plans track progress with checkboxes. If interrupted:

```
/catalyst-dev:implement_plan thoughts/shared/plans/2025-01-08-ENG-1234-feature.md
```

Claude automatically resumes from first unchecked item.

### Syncing Thoughts Automatically

Add to your git hooks or CI:

```bash
# .git/hooks/pre-commit
#!/bin/bash
cd ~/thoughts && git add . && git commit -m "Auto-sync" || true
```

### Sharing Agents Across Team

Commit your custom agents to the project:

```bash
cd ~/projects/my-app
mkdir -p .claude/plugins/custom/agents
cp ~/.claude/plugins/custom/agents/custom-agent.md .claude/plugins/custom/agents/
git add .claude/plugins/custom/agents/custom-agent.md
git commit -m "Add custom agent"
```

Team members get the agent on next pull!

---

## Troubleshooting

### Thoughts Directory Not Syncing

```bash
# Check symlink
ls -la thoughts/
# Should show: thoughts -> /Users/you/thoughts/repos/project-name

# Recreate if broken
./scripts/humanlayer/init-project.sh . project-name
```

### Agent Not Found

```bash
# Check plugin installation
ls ~/.claude/plugins/
ls .claude/plugins/

# Reinstall if needed
/plugin update catalyst-dev
```

### Worktree Thoughts Not Shared

```bash
# Both should point to same location
cd ~/projects/my-app && ls -la thoughts/
cd ~/wt/my-app/feature && ls -la thoughts/

# Should show identical symlink targets
```

### Plan Checkboxes Not Updating

Claude updates plans using the Edit tool. If checkboxes aren't updating:

- Verify plan file exists and is readable
- Check file permissions
- Ensure plan follows correct markdown checkbox format: `- [ ]` or `- [x]`

---

## Next Steps

- See [BEST_PRACTICES.md](BEST_PRACTICES.md) for patterns that work
- See [PATTERNS.md](PATTERNS.md) for creating custom agents
- See [CONTEXT_ENGINEERING.md](CONTEXT_ENGINEERING.md) for deeper principles
