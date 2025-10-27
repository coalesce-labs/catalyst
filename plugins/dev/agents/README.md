# agents/ Directory: Specialized Research Agents

This directory contains markdown files that define specialized research agents for Claude Code.
Agents are invoked by commands using the `Task` tool to perform focused research tasks in parallel.

## How Agents Work

**Agents vs Commands:**

- **Commands** (`/command-name`) - User-facing workflows you invoke directly
- **Agents** (`@agent-name`) - Specialized research tools spawned by commands

**Invocation:** Commands spawn agents using the Task tool:

```markdown
Task(subagent_type="codebase-locator", prompt="Find authentication files")
```

**Philosophy:** All agents follow a **documentarian, not critic** approach:

- Document what EXISTS, not what should exist
- NO suggestions for improvements unless explicitly asked
- NO root cause analysis unless explicitly asked
- Focus on answering "WHERE is X?" and "HOW does X work?"

## Available Agents

### Codebase Research Agents

#### codebase-locator

**Purpose**: Find WHERE code lives in a codebase

**Use when**: You need to locate files, directories, or components

- Finding all files related to a feature
- Discovering directory structure
- Locating test files, configs, or documentation

**Tools**: Grep, Glob, Bash(ls \*)

**Example invocation:**

```markdown
Task( subagent_type="codebase-locator", prompt="Find all authentication-related files" )
```

**Returns**: Organized list of file locations categorized by purpose

---

#### codebase-analyzer

**Purpose**: Understand HOW specific code works

**Use when**: You need to analyze implementation details

- Understanding how a component functions
- Documenting data flow
- Identifying integration points
- Tracing function calls

**Tools**: Read, Grep, Glob, Bash(ls \*)

**Example invocation:**

```markdown
Task( subagent_type="codebase-analyzer", prompt="Analyze the authentication middleware
implementation and document how it works" )
```

**Returns**: Detailed analysis of how code works, with file:line references

---

#### codebase-pattern-finder

**Purpose**: Find existing patterns and usage examples

**Use when**: You need concrete examples

- Finding similar implementations
- Discovering usage patterns
- Locating test examples
- Understanding conventions

**Tools**: Grep, Glob, Read, Bash(ls \*)

**Example invocation:**

```markdown
Task( subagent_type="codebase-pattern-finder", prompt="Find examples of how other components handle
error logging" )
```

**Returns**: Concrete code examples showing patterns in use

### Thoughts System Agents

#### thoughts-locator

**Purpose**: Discover existing thought documents about a topic

**Use when**: You need to find related research or plans

- Finding previous research on a topic
- Discovering related plans
- Locating historical decisions
- Searching for related discussions

**Tools**: Grep, Glob, LS

**Example invocation:**

```markdown
Task( subagent_type="thoughts-locator", prompt="Find all thoughts documents about authentication" )
```

**Returns**: List of relevant thought documents with paths

---

#### thoughts-analyzer

**Purpose**: Extract key insights from thought documents

**Use when**: You need to understand documented decisions

- Analyzing research documents
- Understanding plan rationale
- Extracting historical context
- Identifying previous decisions

**Tools**: Read, Grep, Glob, LS

**Example invocation:**

```markdown
Task( subagent_type="thoughts-analyzer", prompt="Analyze the authentication research document and
extract key findings" )
```

**Returns**: Summary of insights and decisions from documents

### External Research Agents

#### external-research

**Purpose**: Research external frameworks and repositories

**Use when**: You need information from outside sources

- Understanding how popular repos implement features
- Learning framework patterns
- Researching best practices from open-source
- Discovering external documentation

**Tools**: mcp**deepwiki**ask_question, mcp**deepwiki**read_wiki_structure

**Example invocation:**

```markdown
Task( subagent_type="external-research", prompt="Research how Next.js implements middleware
authentication patterns" )
```

**Returns**: Information from external repositories and documentation

## Agent File Structure

Every agent file has this structure:

```markdown
---
name: agent-name
description: What this agent does
tools: Tool1, Tool2, Tool3
model: inherit
---

# Agent Implementation

Instructions for the agent...

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY

- DO NOT suggest improvements...
- DO NOT perform root cause analysis...
- ONLY describe what exists...
```

### Required Frontmatter Fields

- `name` - Agent identifier (matches filename without .md)
- `description` - One-line description for invoking commands
- `tools` - Tools available to the agent
- `model` - AI model to use (usually "inherit")

### Naming Convention

- Filename: `agent-name.md` (hyphen-separated)
- Frontmatter name: `agent-name` (matches filename)
- Unlike commands, agents MUST have a `name` field

## How Commands Use Agents

### Parallel Research Pattern

Commands spawn multiple agents concurrently for efficiency:

```markdown
# Spawn three agents in parallel

Task(subagent_type="codebase-locator", ...) Task(subagent_type="thoughts-locator", ...)
Task(subagent_type="codebase-analyzer", ...)

# Wait for all to complete

# Synthesize findings
```

### Example from research_codebase.md

```markdown
Task 1 - Find WHERE components live: subagent: codebase-locator prompt: "Find all files related to
authentication"

Task 2 - Understand HOW it works: subagent: codebase-analyzer prompt: "Analyze auth middleware and
document how it works"

Task 3 - Find existing patterns: subagent: codebase-pattern-finder prompt: "Find similar
authentication implementations"
```

## Documentarian Philosophy

**What agents do:**

- ✅ Locate files and components
- ✅ Document how code works
- ✅ Provide concrete examples
- ✅ Explain data flow
- ✅ Show integration points

**What agents do NOT do:**

- ❌ Suggest improvements
- ❌ Critique implementation
- ❌ Identify bugs (unless asked)
- ❌ Recommend refactoring
- ❌ Comment on code quality

**Why this matters:**

- Research should be objective
- Understanding comes before judgment
- Prevents bias in documentation
- Maintains focus on current state

## Plugin Distribution

Agents are distributed as part of the Catalyst plugin system:

### Installation

**Install Catalyst plugin**:
```bash
/plugin install catalyst-dev
```

This installs all agents automatically.

### Updates

**Update plugin**:
```bash
/plugin update catalyst-dev
```

Agents are pure research logic with no project-specific configuration, so updates are always safe.

### Per-Project Availability

Agents are available in any project where the catalyst-dev plugin is installed. No per-project setup needed.

## Creating New Agents

### Step 1: Create Markdown File

```bash
# Create file with hyphen-separated name
touch agents/my-new-agent.md
```

### Step 2: Add Frontmatter

```yaml
---
name: my-new-agent
description: Clear, focused description of what this agent finds or analyzes
tools: Read, Grep, Glob
model: inherit
---
```

### Step 3: Write Agent Logic

```markdown
You are a specialist at [specific research task].

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY

[Standard documentarian guidelines]

## Core Responsibilities

1. **[Primary Task]**
   - [Specific action]
   - [What to look for]

2. **[Secondary Task]**
   - [Specific action]
   - [What to document]

## Output Format

[Specify how results should be structured]
```

### Step 4: Test

```bash
# In this workspace, agents are immediately available via symlinks
# Just restart Claude Code to reload

# Create a command that uses the agent
# Invoke the command to test the agent
```

### Step 5: Validate Frontmatter

```bash
# In Claude Code (workspace only)
/validate-frontmatter
```

## Common Patterns

### Pattern 1: Locator → Analyzer

```markdown
# First, find files

Task(subagent_type="codebase-locator", ...)

# Then analyze the most relevant ones

Task(subagent_type="codebase-analyzer", ...)
```

### Pattern 2: Parallel Search

```markdown
# Search codebase and thoughts simultaneously

Task(subagent_type="codebase-locator", ...) Task(subagent_type="thoughts-locator", ...)
```

### Pattern 3: Pattern Discovery

```markdown
# Find patterns after understanding the code

Task(subagent_type="codebase-analyzer", ...) Task(subagent_type="codebase-pattern-finder", ...)
```

## Tool Access

Agents specify required tools in frontmatter:

**File Operations:**

- `Read` - Read file contents
- `Write` - Create files (rare for agents)

**Search:**

- `Grep` - Content search
- `Glob` - File pattern matching

**Execution:**

- `Bash(ls *)` - List directory contents

**External:**

- `mcp__deepwiki__ask_question` - Query external repos
- `mcp__deepwiki__read_wiki_structure` - Read external docs

## Troubleshooting

### Agent not found when spawned

**Check:**

1. Plugin installed? Run `/plugin list` to verify
2. Frontmatter `name` field matches filename?
3. Restarted Claude Code after adding/modifying agent?

**Solution:**

```bash
# Update plugin
/plugin update catalyst-dev

# Restart Claude Code
```

### Agent auto-updated by plugin

**This is by design** - agents are pure logic with no project-specific config.

**If you need customization:**

- Don't modify plugin agents - they'll be overwritten on update
- Create a custom agent in `.claude/plugins/custom/agents/`
- Use a different name to avoid conflicts

## See Also

- `../commands/README.md` - Documentation for commands in this plugin
- `../../docs/AGENTIC_WORKFLOW_GUIDE.md` - Agent patterns and best practices
- `../../docs/FRONTMATTER_STANDARD.md` - Frontmatter validation rules
- `../../README.md` - Workspace overview
- `../../scripts/README.md` - Setup scripts documentation
