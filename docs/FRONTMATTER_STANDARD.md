# Frontmatter Standard

This document defines the frontmatter standard for all agents and commands in this workspace.

**Last Updated**: 2025-01-08 **Version**: 1.0.0

## Agent Frontmatter

### Required Fields

```yaml
---
name: { agent-name } # Agent identifier (kebab-case, must match filename)
description: | # Multi-line description
  {What this agent does}

  Use this agent when:
  - {Use case 1}
  - {Use case 2}
tools: { tool-list } # Array of Claude Code tools
model: inherit # Always "inherit"
category: { category } # One of: research, analysis, search, execution, validation, general
version: 1.0.0 # Semantic version
---
```

### Optional Fields

```yaml
source: { repo-url } # If imported/adapted from external source
adapted: { YYYY-MM-DD } # Date of adaptation
original-author: { name } # Original creator credit
```

### Valid Categories

- **research**: Finding and gathering information from codebases or external sources
- **analysis**: Deep code/data analysis and understanding
- **search**: Locating files/patterns/content within codebases
- **execution**: Running commands or performing operations
- **validation**: Checking, verifying, and validating code or data
- **general**: Multi-purpose or uncategorized agents

### Example

```yaml
---
name: codebase-analyzer
description: |
  Analyzes codebases to understand implementation details, patterns, and conventions.

  Use this agent when:
  - You need to understand how a feature is currently implemented
  - You want to trace data flow through the system
  - You need to find patterns and conventions to follow
  - You're investigating how components interact
tools: Read, Grep, Glob
model: inherit
category: analysis
version: 1.0.0
---
```

## Command Frontmatter

### Required Fields

```yaml
---
description: { one-line-summary } # Brief description (NOTE: commands don't have 'name' field!)
category: { category } # Command category
tools: { tool-list } # Array of Claude Code tools
model: inherit # Always "inherit"
version: 1.0.0 # Semantic version
---
```

### Optional Fields

```yaml
argument-hint: { hint } # Hint for command arguments (e.g., "[ticket-file]")
source: { repo-url } # If imported/adapted from external source
adapted: { YYYY-MM-DD } # Date of adaptation
original-author: { name } # Original creator credit
```

### Valid Categories

- **workflow**: Development workflows and processes
- **planning**: Planning and design activities
- **implementation**: Code changes and feature implementation
- **validation**: Testing and verification
- **linear**: Linear ticket integration and management
- **git**: Version control operations
- **workflow-discovery**: Meta-workflows for discovering and managing workflows
- **general**: Miscellaneous or uncategorized commands

### Example

```yaml
---
description: Create detailed implementation plans through interactive process
category: planning
argument-hint: [ticket-file | ticket-reference]
tools: Read, Write, Edit, Grep, Glob, Task, TodoWrite
model: inherit
version: 1.0.0
---
```

## Valid Tools

Claude Code provides these tools (non-exhaustive list - check official docs for complete reference):

### File Operations

- `Read` - Read file contents
- `Write` - Write new files (or overwrite existing)
- `Edit` - Edit existing files with string replacement

### Search & Discovery

- `Grep` - Search file contents using regex patterns
- `Glob` - Find files by glob patterns

### Execution & Task Management

- `Bash` - Run shell commands
- `Task` - Spawn specialized sub-agents
- `TodoWrite` - Manage todo lists

### Web & External

- `WebFetch` - Fetch web content
- `WebSearch` - Search the web
- `mcp__deepwiki__ask_question` - Query external GitHub repos
- `mcp__deepwiki__read_wiki_structure` - Get repository structure
- `mcp__deepwiki__read_wiki_contents` - Read repository documentation

### Specialized (if available in your environment)

- Linear integration tools (if Linear MCP is configured)
- Other MCP server tools (prefix: `mcp__`)

**Important**: Only reference tools that are actually available in your Claude Code environment.

## Validation Rules

### All Workflows

1. ✅ **Required fields must be present**
2. ✅ **Version must follow semver**: `X.Y.Z` (e.g., `1.0.0`, NOT `v1.0` or `1.0`)
3. ✅ **Model must be "inherit"** unless there's a specific reason to override
4. ✅ **Tools must be valid Claude Code tools** (check official documentation)
5. ✅ **Category must be from valid list** (see categories above)
6. ✅ **YAML must be well-formed** (proper indentation, no syntax errors)

### Agents Specifically

1. ✅ **Must have `name` field** that matches filename (without `.md` extension)
2. ✅ **Name must be kebab-case** (e.g., `codebase-analyzer`, not `CodebaseAnalyzer`)
3. ✅ **Description should be multi-line** with clear use cases

### Commands Specifically

1. ✅ **Must NOT have `name` field** (commands use filename as identifier)
2. ✅ **Description should be one-line summary** (concise, clear purpose)
3. ✅ **Use `argument-hint` if command accepts arguments**

## Common Mistakes

### ❌ Wrong: Command with name field

```yaml
---
name: create-plan # ← Commands don't have name field!
description: Create plans
category: planning
---
```

### ✅ Correct: Command without name

```yaml
---
description: Create detailed implementation plans
category: planning
tools: Read, Write, Task
model: inherit
version: 1.0.0
---
```

---

### ❌ Wrong: Agent name doesn't match filename

**File**: `agents/code_analyzer.md`

```yaml
---
name: codebase-analyzer # ← Doesn't match filename!
---
```

### ✅ Correct: Agent name matches filename

**File**: `agents/codebase-analyzer.md`

```yaml
---
name: codebase-analyzer # ← Matches filename ✓
description: |
  Analyzes codebases...
---
```

---

### ❌ Wrong: Invalid tool references

```yaml
tools: SearchFiles, FindFile, GrepFiles # ← These aren't real tools!
```

### ✅ Correct: Valid tools

```yaml
tools: Grep, Glob, Read # ← Correct tool names ✓
```

---

### ❌ Wrong: Version format

```yaml
version: v1.0 # ← Should be semver (X.Y.Z)
```

### ✅ Correct: Semver version

```yaml
version: 1.0.0 # ← Proper semver ✓
```

---

### ❌ Wrong: Invalid category

```yaml
category: misc # ← Not a valid category
```

### ✅ Correct: Valid category

```yaml
category: general # ← Valid category ✓
```

## Templates

### Minimal Agent Template

```yaml
---
name: {agent-name}
description: |
  {What this agent does}

  Use this agent when:
  - {scenario 1}
  - {scenario 2}
tools: Read, Grep
model: inherit
category: general
version: 1.0.0
---

# {Agent Name}

You are a specialized agent for {purpose}.

## Process

{Your implementation steps}

## Output

Return: {what you return to the caller}
```

### Minimal Command Template

```yaml
---
description: {One-line summary of what this command does}
category: general
tools: Read, Write
model: inherit
version: 1.0.0
---

# {Command Name}

You are tasked with {purpose}.

## Process

{Your implementation steps}
```

### Full-Featured Agent Template

```yaml
---
name: {agent-name}
description: |
  {Detailed description of what this agent does and its purpose}

  Use this agent when:
  - {Use case 1}
  - {Use case 2}
  - {Use case 3}

  This agent will:
  - {Action 1}
  - {Action 2}
  - {Action 3}
tools: Read, Grep, Glob, {other-tools}
model: inherit
category: {appropriate-category}
version: 1.0.0
---

# {Agent Name}

You are a specialized agent for {purpose}.

## Your Role

{Detailed explanation of the agent's responsibilities}

## Process

### Step 1: {First Step}

{Instructions for first step}

### Step 2: {Second Step}

{Instructions for second step}

{Continue with all steps...}

## Output Format

Return your findings in this format:

\`\`\`
{Expected output structure}
\`\`\`

## Important Notes

- {Guideline 1}
- {Guideline 2}
- {Guideline 3}

## Examples

### Example 1: {Scenario}

**Input**: {example input}
**Output**: {example output}

{More examples as needed...}
```

### Full-Featured Command Template

```yaml
---
description: {One-line summary}
category: {appropriate-category}
argument-hint: {argument-format}
tools: {comprehensive-tool-list}
model: inherit
version: 1.0.0
---

# {Command Name}

You are tasked with {command purpose}.

## Purpose

{Detailed explanation of what this command does and why it exists}

## Initial Response

When invoked:

\`\`\`
{Default message to show user when command starts}
\`\`\`

## Process

### Step 1: {First Step Name}

{Instructions for first step}

### Step 2: {Second Step Name}

{Instructions for second step}

{Continue with all steps...}

## Configuration

This command uses configuration from \`.claude/config.json\`:

\`\`\`json
{
  "project": {
    "ticketPrefix": "PROJ"
  }
}
\`\`\`

## Advanced Usage

### {Advanced Feature 1}

\`\`\`
{Example usage}
\`\`\`

### {Advanced Feature 2}

\`\`\`
{Example usage}
\`\`\`

## Important Notes

- {Guideline 1}
- {Guideline 2}

## Integration with Other Commands

- **{Related command 1}**: {How they work together}
- **{Related command 2}**: {How they work together}

## Error Handling

### {Common Error 1}
- {How to handle it}

### {Common Error 2}
- {How to handle it}
```

## Updating the Standard

When adding new categories, tools, or patterns:

1. **Update this document** with the new standard
2. **Run validation**: `/validate-frontmatter` to check all existing workflows
3. **Fix inconsistencies**: Update workflows to match new standard
4. **Document changes**: Include clear commit message explaining the update
5. **Notify team**: If working in a team, communicate the change

## Best Practices

### Descriptions

- **Agents**: Multi-line, include use cases and what the agent will do
- **Commands**: One-line summary, clear and concise
- Both should make the purpose immediately obvious

### Tools

- Only list tools actually used by the workflow
- Use correct tool names (check Claude Code docs)
- Order doesn't matter, but alphabetical is nice for readability

### Categories

- Choose the most specific category that applies
- Use `general` only when no other category fits
- If you find yourself using `general` frequently, consider proposing new categories

### Versioning

- Start all new workflows at `1.0.0`
- Increment minor version (e.g., `1.1.0`) for backwards-compatible changes
- Increment major version (e.g., `2.0.0`) for breaking changes
- Patch versions (e.g., `1.0.1`) for bug fixes

## Validation

Use the `/validate-frontmatter` command to check compliance:

```bash
# Validate all workflows
/validate-frontmatter

# Validate and auto-fix
/validate-frontmatter --fix

# Validate specific file
/validate-frontmatter agents/codebase-analyzer.md
```

## See Also

- `/validate-frontmatter` - Validate workflows against this standard
- `/create-workflow` - Create new workflows with correct frontmatter
- `/import-workflow` - Import external workflows and adapt frontmatter
- `/discover-workflows` - Discover workflows from external repositories
