---
date: 2025-10-25T19:30:00+0000
author: Claude
repository: catalyst
topic: "Catalyst Final Aligned Structure"
tags: [final, aligned, plugins, prerequisites]
status: ready-for-implementation
---

# Catalyst Final Aligned Structure

## Core Insight

**Research is part of the dev workflow, not separate.**

Research is the first step in solving a problem - whether implementing a feature, fixing a bug, or just understanding something. It's not a standalone activity; it's how dev work begins.

## Final Plugin Structure (3 Plugins)

### Plugin 1: catalyst-dev ⭐ **THE COMPLETE WORKFLOW**

**Tagline**: "Research-driven development from understanding to production"

**What it contains**:

**Agents (6)**:
- `codebase-locator` - Find WHERE code lives
- `codebase-analyzer` - Understand HOW code works
- `codebase-pattern-finder` - Find existing patterns
- `thoughts-locator` - Discover previous research/plans
- `thoughts-analyzer` - Extract insights from documents
- `external-research` - Research external repos

**Commands (13)**:
- `/research-codebase` - Start with understanding (spawns agents)
- `/create-plan` - Plan the solution
- `/implement-plan` - Build it
- `/validate-plan` - Verify it works
- `/commit` - Smart commits
- `/describe-pr` - PR descriptions
- `/debug` - Investigate issues
- `/linear` - Ticket management
- `/linear-setup-workflow` - Configure Linear
- `/create-pr` - Create PR + Linear integration
- `/merge-pr` - Merge PR + Linear completion
- `/create-worktree` - Parallel work
- `/workflow-help` - Interactive guidance

**Scripts**:
- `scripts/check-prerequisites.sh` - Verify HumanLayer CLI, jq, thoughts system
- `scripts/create-worktree.sh` - Worktree creation
- `scripts/frontmatter-utils.sh` - YAML utilities

**Prerequisites**:
- **Required**: HumanLayer CLI (`humanlayer` command)
- **Required**: jq (JSON processor)
- **Required**: Thoughts system initialized (`humanlayer thoughts init`)
- **Optional**: Linear MCP server (for Linear features)

**Who uses it**: All developers - the complete workflow

**Value proposition**: "Everything from understanding code to shipping features with Linear automation"

---

### Plugin 2: catalyst-handoff

**Tagline**: "Context persistence across sessions"

**What it contains**:
- **2 commands**: `/create-handoff`, `/resume-handoff`
- **1 script**: `scripts/check-prerequisites.sh`

**Prerequisites**:
- **Required**: HumanLayer CLI
- **Required**: Thoughts system initialized

**Who uses it**: Developers managing context limits

**Value proposition**: "Never lose context when pausing and resuming work"

---

### Plugin 3: catalyst-meta

**Tagline**: "Learn from the community and create workflows"

**What it contains**:
- **5 commands**:
  - `/discover-workflows` - Research external Claude Code repos
  - `/import-workflow` - Import and adapt workflows
  - `/create-workflow` - Create new agents/commands
  - `/validate-frontmatter` - Validate frontmatter consistency
  - `/workflow-help` - Interactive guidance (duplicate)
- **1 script**: `scripts/validate-frontmatter.sh`

**Prerequisites**: None

**Who uses it**: Anyone learning patterns, creating workflows

**Value proposition**: "Discover best practices and extend Catalyst"

---

## Prerequisite Checking Strategy

### Problem

Commands need to verify that required tools are installed before execution. Current approach uses `check-prerequisites.sh` script.

### Solution: Multi-Layer Checking

#### Layer 1: Plugin-Level Prerequisites Check

**When plugin is first installed**, show setup instructions if prerequisites missing.

**Implementation**: Add to plugin.json (if supported) or show in README:

```markdown
# catalyst-dev Plugin

## Prerequisites

Before using this plugin, ensure these tools are installed:

1. **HumanLayer CLI** (required)
   ```bash
   brew install humanlayer/tap/humanlayer
   # OR
   curl -fsSL https://humanlayer.dev/install.sh | sh
   ```

2. **jq** (required)
   ```bash
   brew install jq
   # OR
   apt-get install jq
   ```

3. **Initialize thoughts system** (required)
   ```bash
   humanlayer thoughts init
   ```

4. **Linear MCP** (optional - for Linear integration)
   Configure in Claude Code settings

## Verification

Run this to check your setup:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh"
```
```

#### Layer 2: Runtime Checking (Per Command)

**Each command that needs prerequisites** calls `check-prerequisites.sh` at start:

```bash
#!/bin/bash

# Check prerequisites before execution
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi

# Rest of command logic...
```

**Script behavior** (`check-prerequisites.sh`):

```bash
#!/bin/bash

ERRORS=0

# Check HumanLayer CLI
if ! command -v humanlayer &>/dev/null; then
  echo "❌ HumanLayer CLI not found"
  echo ""
  echo "Install with:"
  echo "  brew install humanlayer/tap/humanlayer"
  echo "  OR"
  echo "  curl -fsSL https://humanlayer.dev/install.sh | sh"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

# Check jq
if ! command -v jq &>/dev/null; then
  echo "❌ jq not found"
  echo ""
  echo "Install with:"
  echo "  brew install jq"
  echo "  OR"
  echo "  apt-get install jq"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

# Check thoughts system initialized
if ! humanlayer thoughts status &>/dev/null; then
  echo "❌ Thoughts system not initialized"
  echo ""
  echo "Initialize with:"
  echo "  humanlayer thoughts init"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "❌ $ERRORS prerequisite(s) missing. Please install and try again."
  exit 1
fi

echo "✅ All prerequisites met"
exit 0
```

#### Layer 3: Optional Dependency Checking

**For optional features** (like Linear), check gracefully and provide helpful message:

```bash
# Example in /linear command
if ! command -v linear &>/dev/null; then
  echo "ℹ️  Linear CLI not found. Linear MCP features will be limited."
  echo "   Install Linear MCP server in Claude Code settings for full functionality."
fi

# Continue with degraded functionality or fail gracefully
```

### Commands That Need Prerequisite Checks

**catalyst-dev**:
- `/research-codebase` ✅ Requires HumanLayer, jq, thoughts
- `/create-plan` ✅ Requires HumanLayer, jq, thoughts
- `/implement-plan` ✅ Requires HumanLayer, jq, thoughts
- `/validate-plan` ❌ No special requirements (just reads plan)
- `/commit` ❌ Only needs git
- `/describe-pr` ❌ Only needs git, gh
- `/debug` ❌ No special requirements
- `/linear` ⚠️ Optional: Linear MCP (graceful degradation)
- `/linear-setup-workflow` ⚠️ Optional: Linear MCP
- `/create-pr` ✅ Requires HumanLayer, jq, thoughts (calls /research-codebase)
- `/merge-pr` ⚠️ Optional: Linear MCP
- `/create-worktree` ⚠️ Optional: HumanLayer for thoughts integration
- `/workflow-help` ❌ No special requirements

**catalyst-handoff**:
- `/create-handoff` ✅ Requires HumanLayer, jq, thoughts
- `/resume-handoff` ✅ Requires HumanLayer, jq, thoughts

**catalyst-meta**:
- All commands ❌ No special requirements (use standard Claude tools)

### Implementation Strategy

**Option A: Per-Command Checking (Current Pattern)**
Each command calls `check-prerequisites.sh` independently.

**Pros**:
- Fine-grained control
- Clear which commands need what
- Existing pattern in codebase

**Cons**:
- Repeated checks if running multiple commands
- User sees check output every time

**Recommendation**: Use this approach

---

**Option B: Plugin-Level Check on Install**
Check once when plugin installed, cache result.

**Pros**:
- Check once, run many times
- Better user experience

**Cons**:
- Claude Code plugin system may not support install hooks
- Prerequisites could change after install

**Recommendation**: Document in README, but don't rely on it

---

**Option C: Lazy Checking (Check Only When Needed)**
Commands check only when actually calling HumanLayer/thoughts.

**Pros**:
- No overhead if feature not used

**Cons**:
- Late failure (user starts work, then fails)
- Confusing error messages mid-execution

**Recommendation**: Don't use this

---

## Recommended Approach: Hybrid

1. **Document prerequisites prominently** in plugin README
2. **Provide verification script** (`check-prerequisites.sh`) that users can run manually
3. **Check at command start** for commands that require prerequisites
4. **Cache results** (optional) - could add flag to skip if already checked in session
5. **Graceful degradation** for optional features (Linear MCP)

### Example: Enhanced check-prerequisites.sh

```bash
#!/bin/bash

# Allow skipping if checked recently (optional optimization)
CACHE_FILE="/tmp/.catalyst-prereqs-checked"
if [[ -f "$CACHE_FILE" ]]; then
  LAST_CHECK=$(cat "$CACHE_FILE")
  NOW=$(date +%s)
  if [[ $((NOW - LAST_CHECK)) -lt 3600 ]]; then
    # Checked within last hour, skip
    exit 0
  fi
fi

ERRORS=0

# Check HumanLayer CLI
if ! command -v humanlayer &>/dev/null; then
  echo "❌ HumanLayer CLI not found"
  echo ""
  echo "Install with:"
  echo "  brew install humanlayer/tap/humanlayer"
  echo "  OR"
  echo "  curl -fsSL https://humanlayer.dev/install.sh | sh"
  echo ""
  echo "Documentation: https://docs.humanlayer.dev"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ HumanLayer CLI found"
fi

# Check jq
if ! command -v jq &>/dev/null; then
  echo "❌ jq not found"
  echo ""
  echo "Install with:"
  echo "  brew install jq"
  echo "  OR"
  echo "  apt-get install jq"
  echo ""
  ERRORS=$((ERRORS + 1))
else
  echo "✅ jq found"
fi

# Check thoughts system initialized
if command -v humanlayer &>/dev/null; then
  if ! humanlayer thoughts status &>/dev/null; then
    echo "❌ Thoughts system not initialized"
    echo ""
    echo "Initialize with:"
    echo "  humanlayer thoughts init"
    echo ""
    echo "This will:"
    echo "  1. Create ~/thoughts/ directory"
    echo "  2. Initialize git repository"
    echo "  3. Configure HumanLayer CLI"
    echo ""
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ Thoughts system initialized"
  fi
fi

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ $ERRORS prerequisite(s) missing"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Please install missing tools and try again."
  echo ""
  echo "For help, see: https://github.com/coalesce-labs/catalyst#setup"
  exit 1
fi

# Cache successful check
date +%s > "$CACHE_FILE"

echo ""
echo "✅ All prerequisites met - ready to use Catalyst!"
exit 0
```

---

## Plugin Structure on Disk (Updated)

```
catalyst/
├── .claude-plugin/
│   └── marketplace.json
│
├── plugins/
│   ├── dev/                           # THE COMPLETE WORKFLOW
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── agents/                    # Research agents (part of workflow)
│   │   │   ├── codebase-locator.md
│   │   │   ├── codebase-analyzer.md
│   │   │   ├── codebase-pattern-finder.md
│   │   │   ├── thoughts-locator.md
│   │   │   ├── thoughts-analyzer.md
│   │   │   └── external-research.md
│   │   ├── commands/                  # All workflow commands
│   │   │   ├── research_codebase.md   # Uses agents above
│   │   │   ├── create_plan.md
│   │   │   ├── implement_plan.md
│   │   │   ├── validate_plan.md
│   │   │   ├── commit.md
│   │   │   ├── describe_pr.md
│   │   │   ├── debug.md
│   │   │   ├── linear.md
│   │   │   ├── linear_setup_workflow.md
│   │   │   ├── create_pr.md
│   │   │   ├── merge_pr.md
│   │   │   ├── create_worktree.md
│   │   │   └── workflow_help.md
│   │   └── scripts/
│   │       ├── check-prerequisites.sh  # MAIN PREREQUISITE CHECKER
│   │       ├── create-worktree.sh
│   │       ├── frontmatter-utils.sh
│   │       └── README.md              # Setup instructions
│   │
│   ├── handoff/
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   ├── create_handoff.md
│   │   │   └── resume_handoff.md
│   │   └── scripts/
│   │       ├── check-prerequisites.sh  # DUPLICATE (same as dev)
│   │       └── README.md
│   │
│   └── meta/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── commands/
│       │   ├── discover_workflows.md
│       │   ├── import_workflow.md
│       │   ├── create_workflow.md
│       │   ├── validate_frontmatter.md
│       │   └── workflow_help.md
│       └── scripts/
│           ├── validate-frontmatter.sh
│           └── README.md              # No prerequisites needed
│
├── hack/                              # Migration/setup tools
│   ├── install-user.sh
│   ├── install-project.sh
│   ├── setup-thoughts.sh              # INITIAL SETUP HELPER
│   ├── init-project.sh
│   ├── setup-multi-config.sh
│   └── ...
│
└── docs/
    ├── SETUP.md                       # Comprehensive setup guide
    └── ...
```

---

## User Experience: Setup Flow

### First-Time User

**Step 1: Install Plugin**
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev@catalyst
```

**Step 2: See Setup Instructions**
Plugin README automatically shown after install (if Claude Code supports it), or user reads it:

```
🎉 catalyst-dev installed!

⚠️  Before using, install prerequisites:

1. HumanLayer CLI:
   brew install humanlayer/tap/humanlayer

2. jq:
   brew install jq

3. Initialize thoughts:
   humanlayer thoughts init

Verify setup:
/path/to/plugin/scripts/check-prerequisites.sh

Documentation: https://github.com/coalesce-labs/catalyst#setup
```

**Step 3: Install Prerequisites**
User follows instructions, installs tools.

**Step 4: Verify Setup**
User can manually verify (optional):
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh"
```

**Step 5: Use Commands**
Commands automatically check prerequisites and fail with helpful message if missing:
```bash
/research-codebase

# If prerequisites missing:
❌ HumanLayer CLI not found
Install with: brew install humanlayer/tap/humanlayer
...
```

---

## Plugin Manifests

### catalyst-dev/plugin.json

```json
{
  "name": "catalyst-dev",
  "version": "1.0.0",
  "description": "Research-driven development workflow: understand → plan → implement → validate → ship with Linear automation",
  "author": {
    "name": "Coalesce Labs",
    "url": "https://github.com/coalesce-labs"
  },
  "homepage": "https://github.com/coalesce-labs/catalyst",
  "repository": "https://github.com/coalesce-labs/catalyst",
  "license": "MIT",
  "keywords": [
    "workflow",
    "research",
    "planning",
    "implementation",
    "validation",
    "agents",
    "linear",
    "git",
    "pr"
  ]
}
```

**Note**: No explicit prerequisite declaration in plugin.json (not supported by Claude Code plugin system yet). Prerequisites documented in README and checked at runtime.

### catalyst-handoff/plugin.json

```json
{
  "name": "catalyst-handoff",
  "version": "1.0.0",
  "description": "Context persistence: save and restore work across sessions",
  "author": {
    "name": "Coalesce Labs",
    "url": "https://github.com/coalesce-labs"
  },
  "homepage": "https://github.com/coalesce-labs/catalyst",
  "repository": "https://github.com/coalesce-labs/catalyst",
  "license": "MIT",
  "keywords": [
    "context",
    "handoff",
    "persistence"
  ]
}
```

### catalyst-meta/plugin.json

```json
{
  "name": "catalyst-meta",
  "version": "1.0.0",
  "description": "Discover, import, and create workflows: learn from community patterns",
  "author": {
    "name": "Coalesce Labs",
    "url": "https://github.com/coalesce-labs"
  },
  "homepage": "https://github.com/coalesce-labs/catalyst",
  "repository": "https://github.com/coalesce-labs/catalyst",
  "license": "MIT",
  "keywords": [
    "meta",
    "discovery",
    "creation",
    "validation",
    "best-practices"
  ]
}
```

---

## Installation Scenarios

### Scenario 1: "I want the full workflow"
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev@catalyst

# Setup (one-time):
brew install humanlayer/tap/humanlayer jq
humanlayer thoughts init
```

**Gets**: Complete workflow with research agents, planning, implementation, Linear automation

---

### Scenario 2: "I also hit context limits"
```bash
/plugin install catalyst-dev@catalyst
/plugin install catalyst-handoff@catalyst
```

**Gets**: Full workflow + context management

---

### Scenario 3: "I want to learn and create workflows"
```bash
/plugin install catalyst-meta@catalyst
```

**Gets**: Discovery, import, creation tools (no prerequisites)

---

## Documentation Strategy

### Main README.md

```markdown
# Catalyst

Production-ready AI-assisted development workflows.

## Quick Start

1. Install the plugin:
   ```bash
   /plugin marketplace add coalesce-labs/catalyst
   /plugin install catalyst-dev@catalyst
   ```

2. Install prerequisites:
   ```bash
   # macOS
   brew install humanlayer/tap/humanlayer jq

   # Ubuntu/Debian
   curl -fsSL https://humanlayer.dev/install.sh | sh
   sudo apt-get install jq
   ```

3. Initialize thoughts system:
   ```bash
   humanlayer thoughts init
   ```

4. Start using:
   ```bash
   /research-codebase
   ```

## Prerequisites

catalyst-dev requires:
- ✅ HumanLayer CLI
- ✅ jq
- ✅ Thoughts system initialized
- ⚠️ Linear MCP (optional)

See [SETUP.md](docs/SETUP.md) for detailed instructions.
```

### plugins/dev/scripts/README.md

```markdown
# catalyst-dev Scripts

## check-prerequisites.sh

Verifies that required tools are installed before command execution.

**Required**:
- HumanLayer CLI (`humanlayer`)
- jq (JSON processor)
- Thoughts system initialized

**Usage**:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh"
```

**Exit codes**:
- 0: All prerequisites met
- 1: Missing prerequisites (shows installation instructions)

**Called by**:
- /research-codebase
- /create-plan
- /implement-plan
- /create-pr
- /create-handoff
- /resume-handoff

## Installation Help

If you see prerequisite errors, follow the instructions in the output or see:
https://github.com/coalesce-labs/catalyst#setup
```

---

## Summary

**3 Plugins**:
1. `catalyst-dev` (6 agents, 13 commands, 3 scripts) ⭐ **THE COMPLETE WORKFLOW**
2. `catalyst-handoff` (2 commands, 1 script)
3. `catalyst-meta` (5 commands, 1 script)

**Key Decisions**:
- ✅ Research agents ARE part of dev (not separate plugin)
- ✅ Prerequisites checked at runtime per command
- ✅ HumanLayer + thoughts system required for catalyst-dev
- ✅ Linear MCP optional (graceful degradation)
- ✅ Clear setup documentation
- ✅ Helpful error messages with installation instructions

**Ready for**: `/create-plan` to implement this structure

**No more questions** - this is the final aligned structure! 🎉
