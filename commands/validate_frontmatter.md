---
description: Validate and fix frontmatter consistency across all workflows
category: workflow-discovery
tools: Read, Edit, Glob, Grep
model: inherit
version: 1.0.0
workspace_only: true
---

# Validate Frontmatter

You are tasked with validating frontmatter consistency across all agents and commands in the workspace, and fixing any issues found.

## Purpose

This command ensures all workflows follow the workspace frontmatter standard, making them easier to maintain, discover, and integrate.

## Initial Response

When invoked:

```
I'll validate frontmatter across all workflows.

Checking:
- agents/ directory
- commands/ directory

What would you like to do?
1. Validate all workflows (report issues only)
2. Validate and auto-fix issues
3. Validate specific workflow
4. Generate frontmatter standard document
```

## Process

### Step 1: Determine Scope

Get user selection:

- **All workflows**: Check everything
- **Auto-fix**: Fix issues automatically
- **Specific workflow**: Validate one file
- **Generate standard**: Create reference document

### Step 2: Parallel Validation

**IMPORTANT**: Spawn parallel validation tasks for efficiency.

Use TodoWrite to track parallel validation tasks.

**For "Validate All" mode**:

**Task 1 - Validate Agents**:

```
Use codebase-analyzer agent:
"Validate frontmatter in all files matching agents/*.md. For each file, check:
1. Required fields present (name, description, tools, model, version)
2. Name field matches filename (kebab-case)
3. Tools list contains valid Claude Code tools
4. Category is one of: research, analysis, search, execution, validation, general
5. Version follows semver (e.g., 1.0.0)
6. Description is clear and informative
Return: List of all validation issues found with file:line references"

Tools: Glob, Grep, Read
Path: /Users/ryan/code-repos/ryan-claude-workspace/agents/
Return: Validation report for all agents
```

**Task 2 - Validate Commands**:

```
Use codebase-analyzer agent:
"Validate frontmatter in all files matching commands/*.md. For each file, check:
1. Required fields present (description, category, tools, model, version)
2. No 'name' field (commands use filename)
3. Tools list contains valid Claude Code tools
4. Category is one of: workflow, planning, implementation, validation, linear, git, workflow-discovery, general
5. Version follows semver (e.g., 1.0.0)
6. Description is clear and concise
7. argument-hint present if command takes arguments
Return: List of all validation issues found with file:line references"

Tools: Glob, Grep, Read
Path: /Users/ryan/code-repos/ryan-claude-workspace/commands/
Return: Validation report for all commands
```

**Task 3 - Extract Tool References**:

```
Use codebase-pattern-finder agent:
"Extract all unique tool names referenced in frontmatter across agents/*.md and commands/*.md. Return a sorted list of all tools used."

Tools: Glob, Grep
Path: /Users/ryan/code-repos/ryan-claude-workspace/
Return: Complete list of tools referenced
```

**WAIT for all 3 tasks to complete.**

### Step 3: Aggregate Validation Results

Combine results from parallel tasks:

- Agent issues (Task 1)
- Command issues (Task 2)
- Tool inventory (Task 3)

Mark all tasks complete in TodoWrite.

Analyze:

1. **Critical issues**: Missing required fields, invalid formats
2. **Warnings**: Unusual patterns, potential improvements
3. **Tool usage**: Are all tools valid?
4. **Category distribution**: Are categories being used correctly?

### Step 4: Present Validation Report

Show comprehensive report:

```markdown
# Frontmatter Validation Report

**Validated**: {date}
**Scope**: {agents-count} agents, {commands-count} commands
**Status**: {PASS/FAIL}

## Summary

- ✅ **Passed**: {pass-count} workflows
- ⚠️ **Warnings**: {warning-count} workflows
- ❌ **Failed**: {fail-count} workflows

## Critical Issues

### {workflow-name}.md

- ❌ Missing required field: `version`
- ❌ Invalid category: "misc" (should be one of: general, research, analysis...)

### {workflow-name}.md

- ❌ Name field "{name}" doesn't match filename "{filename}"
- ❌ Invalid tool reference: "SearchFiles" (not a valid Claude Code tool)

## Warnings

### {workflow-name}.md

- ⚠️ Description is very short (< 20 chars)
- ⚠️ No category specified (defaulting to "general")

### {workflow-name}.md

- ⚠️ Using old version format: "v1.0" (should be "1.0.0")

## Tool Inventory

**Total unique tools**: {tool-count}
**Valid tools**: {valid-count}
**Invalid references**: {invalid-count}

### Used Tools:

- Read ({usage-count} workflows)
- Write ({usage-count} workflows)
- Edit ({usage-count} workflows)
- Grep ({usage-count} workflows)
- Glob ({usage-count} workflows)
  [... more tools ...]

### Invalid References:

- SearchFiles (used in {workflow-name}.md) → Should be: Grep or Glob
- FindFile (used in {workflow-name}.md) → Should be: Glob

## Category Distribution

### Agents:

- research: {count}
- analysis: {count}
- search: {count}
- execution: {count}
- validation: {count}
- general: {count}

### Commands:

- workflow: {count}
- planning: {count}
- implementation: {count}
- validation: {count}
- linear: {count}
- git: {count}
- workflow-discovery: {count}
- general: {count}

## Recommendations

1. **Fix critical issues first**: {count} workflows need immediate attention
2. **Standardize versions**: {count} workflows use non-semver format
3. **Update tool references**: {count} invalid tool names found
4. **Add descriptions**: {count} workflows have minimal descriptions

---

Next steps:

- Run with `--fix` to auto-correct issues
- Review and approve fixes before applying
- Re-validate after fixes
```

### Step 5: Auto-Fix Mode (if requested)

If user chose auto-fix:

1. **Create fix plan**:
   - List all fixable issues
   - Show what will be changed
   - Ask for confirmation

2. **Present fix plan**:

   ```markdown
   # Auto-Fix Plan

   I can automatically fix {fixable-count} issues:

   ## {workflow-name}.md

   - Add missing `version: 1.0.0`
   - Fix category: "misc" → "general"
   - Standardize tool name: "SearchFiles" → "Grep"

   ## {workflow-name}.md

   - Fix version format: "v1.0" → "1.0.0"
   - Add missing `model: inherit`

   **Cannot auto-fix** ({manual-count} issues):

   - {workflow-name}.md: Description too short (needs human review)
   - {workflow-name}.md: Unclear category (analysis vs research?)

   Proceed with auto-fix? (Y/n)
   ```

3. **Apply fixes** (after confirmation):
   - Use Edit tool to fix each issue
   - Track all changes made
   - Preserve original formatting and comments

4. **Report results**:

   ```markdown
   ✅ Auto-fix complete!

   **Fixed**: {fixed-count} issues across {file-count} files

   ### Changes Made:

   #### agents/codebase-locator.md

   - Added `version: 1.0.0`
   - Standardized category: "search"

   #### commands/create_plan.md

   - Fixed version: "v1.0" → "1.0.0"
   - Updated tool reference: "SearchFiles" → "Grep"

   [... more changes ...]

   **Still needs manual review**:

   - {workflow-name}.md: {issue description}

   Re-run validation to verify: `/validate-frontmatter`
   ```

### Step 6: Generate Standard Document (if requested)

If user chose to generate standard:

Create `docs/FRONTMATTER_STANDARD.md`:

````markdown
# Frontmatter Standard

This document defines the frontmatter standard for all agents and commands in this workspace.

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
````

### Optional Fields

```yaml
source: { repo-url } # If imported/adapted
adapted: { date } # Date of adaptation
original-author: { name } # Original creator
```

### Valid Categories

- **research**: Finding and gathering information
- **analysis**: Deep code/data analysis
- **search**: Locating files/patterns/content
- **execution**: Running commands/operations
- **validation**: Checking and verifying
- **general**: Multi-purpose or uncategorized

### Example

```yaml
---
name: codebase-analyzer
description: |
  Analyzes codebases to understand implementation details and patterns.

  Use this agent when:
  - You need to understand how a feature is implemented
  - You want to trace data flow through the system
  - You need to find patterns and conventions
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
description: { one-line-summary } # Brief description (no name field!)
category: { category } # Command category
tools: { tool-list } # Array of Claude Code tools
model: inherit # Always "inherit"
version: 1.0.0 # Semantic version
---
```

### Optional Fields

```yaml
argument-hint: { hint } # Hint for command arguments
source: { repo-url } # If imported/adapted
adapted: { date } # Date of adaptation
original-author: { name } # Original creator
```

### Valid Categories

- **workflow**: Development workflows
- **planning**: Planning and design
- **implementation**: Code changes
- **validation**: Testing and verification
- **linear**: Linear integration
- **git**: Version control
- **workflow-discovery**: Meta-workflows
- **general**: Miscellaneous

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

Claude Code provides these tools:

### File Operations

- `Read` - Read file contents
- `Write` - Write files
- `Edit` - Edit existing files

### Search

- `Grep` - Search file contents (regex)
- `Glob` - Find files by pattern

### Execution

- `Bash` - Run shell commands
- `Task` - Spawn sub-agents

### Management

- `TodoWrite` - Manage todo lists

### External

- `WebFetch` - Fetch web content
- `WebSearch` - Search the web
- `mcp__deepwiki__ask_question` - Query external repos
- `mcp__deepwiki__read_wiki_structure` - Get repo structure
- `mcp__deepwiki__read_wiki_contents` - Read repo docs

### Linear Integration

- `linear_get_ticket` - Get Linear ticket details
- `linear_create_ticket` - Create Linear tickets
- `linear_update_ticket` - Update Linear tickets

(Check official Claude Code docs for complete list)

## Validation Rules

### All Workflows

1. **Required fields must be present**
2. **Version must follow semver**: `X.Y.Z` (not `vX.Y`)
3. **Model must be "inherit"** (unless specific reason)
4. **Tools must be valid Claude Code tools**
5. **Category must be from valid list**

### Agents Specifically

1. **Must have `name` field** matching filename
2. **Name must be kebab-case**
3. **Description should be multi-line with use cases**

### Commands Specifically

1. **Must NOT have `name` field** (use filename)
2. **Description should be one-line summary**
3. **Use `argument-hint` if command takes arguments**

## Common Mistakes

### ❌ Wrong: Command with name field

```yaml
---
name: create-plan # Commands don't have name field
description: Create plans
---
```

### ✅ Correct: Command without name

```yaml
---
description: Create detailed implementation plans
category: planning
---
```

### ❌ Wrong: Invalid tool reference

```yaml
tools: SearchFiles, FindFile # These aren't real tools
```

### ✅ Correct: Valid tools

```yaml
tools: Grep, Glob # Correct tool names
```

### ❌ Wrong: Version format

```yaml
version: v1.0 # Should be semver
```

### ✅ Correct: Semver version

```yaml
version: 1.0.0 # Proper semver
```

## Updating the Standard

When adding new categories or patterns:

1. Update this document
2. Validate all existing workflows
3. Fix any inconsistencies
4. Document the change in git commit

## See Also

- `/validate-frontmatter` - Validate workflows against this standard
- `/create-workflow` - Create new workflows with correct frontmatter
- `/import-workflow` - Import external workflows and adapt frontmatter

```

Save and report:
```

✅ Frontmatter standard documented!

**Saved to**: docs/FRONTMATTER_STANDARD.md

This document now serves as the canonical reference for all frontmatter in this workspace.

Next steps:

1. Review the standard
2. Share with team
3. Use `/validate-frontmatter` to check compliance
4. Reference when creating new workflows

```

## Advanced Usage

### Validate Specific Workflow

```

/validate-frontmatter agents/codebase-analyzer.md

```

Validates just one file.

### Auto-Fix Everything

```

/validate-frontmatter --fix

```

Automatically fixes all issues without prompting.

### Generate Report Only

```

/validate-frontmatter --report-only > frontmatter-report.md

```

Saves report to file for review.

### Validate by Category

```

/validate-frontmatter --category research

```

Only validates workflows in "research" category.

## Validation Categories

### Critical Issues (Must Fix)

- Missing required fields
- Invalid field values
- Name/filename mismatch (agents)
- Invalid tool references
- Malformed YAML

### Warnings (Should Fix)

- Short descriptions (< 20 chars)
- Missing optional but recommended fields
- Unusual category choices
- Non-standard patterns

### Info (Nice to Have)

- Could add more detail
- Could specify argument-hint
- Could add source attribution
- Could improve formatting

## Auto-Fix Capabilities

### What Can Be Auto-Fixed

✅ Missing version field → Add `version: 1.0.0`
✅ Wrong version format → Convert to semver
✅ Missing model field → Add `model: inherit`
✅ Common tool typos → Fix to correct names
✅ Category typos → Fix to valid category
✅ YAML formatting → Standardize indentation

### What Requires Manual Review

❌ Ambiguous categories → Needs human judgment
❌ Short descriptions → Needs content creation
❌ Complex tool issues → May need workflow redesign
❌ Missing description → Needs understanding of purpose

## Important Notes

- **Non-destructive**: Auto-fix preserves content, only fixes frontmatter
- **Safe**: Always shows plan before applying fixes
- **Trackable**: Reports all changes made
- **Reversible**: Changes are standard edits, can be reverted via git
- **Standard-based**: Uses workspace-specific conventions

## Integration with Other Commands

- **Discover**: `/discover-workflows` → uses this for validation
- **Import**: `/import-workflow` → validates imported workflows
- **Create**: `/create-workflow` → ensures new workflows are valid
- **Validate**: `/validate-frontmatter` (this command) → checks everything

## Error Handling

### Malformed YAML
- Report syntax errors
- Show line number
- Suggest fixes
- Cannot auto-fix (manual correction needed)

### Unknown Fields
- Report unexpected fields
- Ask: Keep / Remove?
- Could be custom extensions

### Missing Files
- Skip files that don't exist
- Report which files were skipped
- Continue validation

### Permission Errors
- Report read/write issues
- Skip files that can't be accessed
- Provide error details

This command ensures workspace consistency and quality!
```
