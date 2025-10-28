---
description: Create new agents or commands using discovered patterns and templates
category: workflow-discovery
tools: Read, Write, Edit, Grep, Glob
model: inherit
version: 1.0.0
workspace_only: true
---

# Create Workflow

You are tasked with helping users create new agents or commands by leveraging discovered patterns,
templates, and examples from the workflow catalog.

## Purpose

This command guides users through creating well-structured, standardized workflows by showing
relevant examples and enforcing frontmatter consistency.

## Initial Response

When invoked:

```
I'll help you create a new agent or command.

What would you like to create?
1. Agent (for Task tool sub-agents)
2. Command (for slash commands)

Or provide details:
- Name: (e.g., code-reviewer, test-generator)
- Purpose: (brief description)
- Similar to: (optional - name of existing workflow to model after)
```

## Process

### Step 1: Gather Requirements

Ask the user:

1. **Type**: Agent or Command?
2. **Name**: What should it be called? (suggest kebab-case)
3. **Purpose**: What does it do?
4. **Tools needed**: Which Claude Code tools will it use?
5. **Category**: Which category does it belong to?
6. **Similar workflows**: Any existing workflows to model after?

### Step 2: Parallel Example Research

**IMPORTANT**: Spawn 3 parallel tasks to gather comprehensive examples.

Use TodoWrite to track parallel research.

**Task 1 - Local Examples**:

```
Use codebase-pattern-finder agent:
"Find all {agents/commands} in our workspace that are similar to {user-description}. Focus on {category} workflows. Return file paths and brief descriptions."

Tools: Glob, Grep, Read
Path: /Users/ryan/code-repos/ryan-claude-workspace
Return: List of similar local workflows with their frontmatter and key patterns
```

**Task 2 - Catalog Examples**:

```
Use thoughts-analyzer agent:
"Search the workflow catalog at thoughts/shared/workflows/ for workflows similar to {user-description}. Find examples from external repositories that match the {category} category."

Tools: Grep, Read
Path: thoughts/shared/workflows/
Return: External workflow examples with their implementations
```

**Task 3 - Frontmatter Standards**:

```
Use codebase-analyzer agent:
"Analyze all existing {agents/commands} in the workspace to extract the frontmatter standard. What fields are required? What patterns are used? What categories exist?"

Tools: Glob, Grep, Read
Path: /Users/ryan/code-repos/ryan-claude-workspace/{agents,commands}/
Return: Frontmatter standard with field definitions and examples
```

**WAIT for all 3 tasks to complete.**

### Step 3: Aggregate Examples

Combine results from parallel tasks:

- Local examples (Task 1)
- Catalog examples (Task 2)
- Frontmatter standards (Task 3)

Mark all tasks complete in TodoWrite.

Analyze:

1. **Common patterns**: What do similar workflows do?
2. **Tool usage**: Which tools are typically used?
3. **Structure**: How are they organized?
4. **Frontmatter**: What's the standard format?

### Step 4: Present Options to User

Show analysis and options:

````markdown
# Create {workflow-type}: {name}

## Similar Workflows Found

### From Our Workspace

1. **{local-workflow-1}**
   - Purpose: {description}
   - Tools: {tools}
   - File: {path}

2. **{local-workflow-2}** [....]

### From Catalog

1. **{external-workflow-1}** (from {repo})
   - Purpose: {description}
   - Tools: {tools}

## Frontmatter Standard

Based on existing workflows, here's the standard format:

```yaml
---
{ required-fields }
---
```
````

## Recommended Approach

Based on similar workflows, I recommend:

- **Model after**: {most-similar-workflow}
- **Tools to use**: {suggested-tools}
- **Key patterns**: {patterns-to-follow}

Would you like me to:

1. Generate a workflow based on {specific-example}
2. Create a custom workflow from scratch
3. Show me more examples first

````

### Step 5: Generate Workflow Template

Based on user selection, generate the appropriate template:

#### 5a. For Agents

```markdown
---
name: {workflow-name}
description: |
  {Clear description from user input}

  Use this agent when:
  - {use case 1}
  - {use case 2}

  This agent will:
  - {action 1}
  - {action 2}
tools: {validated-tool-list}
model: inherit
category: {selected-category}
version: 1.0.0
---

# {Agent Name}

You are a specialized agent for {purpose}.

## Your Role

{Detailed role description}

## Process

### Step 1: {First Step}

{Instructions for first step}

### Step 2: {Second Step}

{Instructions for second step}

[Continue with all steps...]

## Output Format

Return your findings in this format:

````

{Expected output structure}

```

## Important Notes

- {Guideline 1}
- {Guideline 2}
- {Guideline 3}

## Examples

### Example 1: {Scenario}

**Input**: {example input}
**Expected output**: {example output}

[More examples...]
```

#### 5b. For Commands

````markdown
---
description: { One-line summary }
category: { category }
argument-hint: { if applicable }
tools: { tool-list }
model: inherit
version: 1.0.0
---

# {Command Name}

You are tasked with {command purpose}.

## Purpose

{Detailed explanation of what this command does and why it exists}

## Initial Response

When invoked:

\`\`\` {Default message to show user} \`\`\`

## Process

### Step 1: {First Step Name}

{Instructions for first step}

### Step 2: {Second Step Name}

{Instructions for second step}

[Continue with all steps...]

## Configuration

This command uses configuration from `.claude/config.json`:

```json
{
  "catalyst": {
    "project": {
      "ticketPrefix": "PROJ"
    }
  }
}
```
````

## Advanced Usage

### {Advanced Feature 1}

```
{Example usage}
```

### {Advanced Feature 2}

```
{Example usage}
```

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

````

### Step 6: Validate Template

Before showing to user, validate:

1. **Frontmatter**:
   - All required fields present?
   - Tools list valid?
   - Category matches existing categories?
   - Name in kebab-case?
   - Version starts at 1.0.0?

2. **Structure**:
   - Clear purpose statement?
   - Step-by-step process?
   - Output format specified (for agents)?
   - Error handling included?

3. **Consistency**:
   - Matches patterns from similar workflows?
   - Uses workspace conventions?
   - References config.json for project-specific values?

If validation fails, fix issues before proceeding.

### Step 7: Present Draft

Show the user the generated template:

```markdown
# Generated Workflow: {name}

I've created a draft based on {source-pattern}.

**Type**: {Agent/Command}
**File**: {target-path}

## Frontmatter
```yaml
{frontmatter}
````

## Key Features

- {Feature 1}
- {Feature 2}
- {Feature 3}

## Modeled After

- Local: {local-example if any}
- External: {catalog-example if any}

Would you like me to:

1. Save this workflow as-is
2. Make adjustments (specify what to change)
3. Show me alternative approaches

````

### Step 8: Iterate on Feedback

Be ready to adjust:
- Add/remove steps
- Change tools
- Adjust frontmatter
- Modify structure
- Add examples
- Update descriptions

Continue iterating until user is satisfied.

### Step 9: Save Workflow

Determine save location:

**If Agent**:
- Save to: `agents/{workflow-name}.md`

**If Command**:
- Save to: `commands/{workflow-name}.md`

### Step 10: Create Creation Record

Save creation details to `thoughts/shared/workflows/created.md`:

```markdown
## {workflow-name}

- **Created**: {date}
- **Type**: {agent/command}
- **Location**: {file-path}
- **Modeled After**:
  - {local-example if any}
  - {catalog-example if any}
- **Purpose**: {brief-description}
- **Tools**: {tool-list}
- **Category**: {category}

**Creation Notes**: {any special notes about decisions made}
````

### Step 11: Confirmation

Present success summary:

```markdown
✅ Workflow created successfully!

**Saved to**: {file-path}

**What's included**:

- Standardized frontmatter
- Clear step-by-step process
- {Type-specific features}
- Error handling guidelines

**Next steps**:

1. Review: `{file-path}`
2. Test: Try using the workflow
3. Customize: Adjust for your specific needs
4. Commit: `git add {file-path} && git commit -m "Add {workflow-name} {type}"`

Creation recorded in: thoughts/shared/workflows/created.md
```

## Advanced Usage

### Create from Catalog Entry

```
/create-workflow from catalog wshobson/commands/code-review
```

Creates a new workflow based on a specific catalog entry.

### Create with Custom Template

```
/create-workflow agent data-analyzer --template minimal
```

Uses predefined templates:

- `minimal`: Basic structure only
- `standard`: Full featured (default)
- `advanced`: Includes sub-agent patterns

### Quick Create

```
/create-workflow command quick-commit "Create conventional commits"
```

Skips interactive steps, uses defaults.

## Templates

### Minimal Agent Template

```yaml
---
name: {name}
description: {description}
tools: Read, Grep
model: inherit
category: general
version: 1.0.0
---

# {Name}

You are a specialized agent for {purpose}.

## Process

[Your implementation]

## Output

Return: {what you return}
```

### Minimal Command Template

```yaml
---
description: {description}
category: general
tools: Read, Write
model: inherit
version: 1.0.0
---

# {Name}

You are tasked with {purpose}.

## Process

[Your implementation]
```

## Categories

Standard categories found in workspace:

**For Agents**:

- `research` - Finding and analyzing information
- `analysis` - Deep code/data analysis
- `search` - Locating files/patterns
- `execution` - Running commands/operations
- `validation` - Checking and verifying
- `general` - Multi-purpose agents

**For Commands**:

- `workflow` - Development workflows
- `planning` - Planning and design
- `implementation` - Code changes
- `validation` - Testing and verification
- `linear` - Linear integration
- `git` - Version control
- `workflow-discovery` - Meta-workflows
- `general` - Miscellaneous

## Frontmatter Field Reference

### Required for All

- `description`: One-line summary (commands) or longer explanation (agents)
- `tools`: Array of Claude Code tools used
- `model`: Usually "inherit"
- `version`: Start with "1.0.0"

### Agent-Specific

- `name`: Agent identifier in kebab-case
- `category`: Agent category from list above

### Command-Specific

- `category`: Command category from list above
- `argument-hint`: (optional) Hint for command arguments

### Optional for Both

- `source`: URL of origin if imported/adapted
- `adapted`: Date if modified from external source
- `original-author`: Credit for original creator

## Important Notes

- **Follow standards**: Always use workspace frontmatter format
- **Validate tools**: Only reference tools that exist in Claude Code
- **Check categories**: Use existing categories when possible
- **Kebab-case names**: All workflow names should be kebab-case
- **Clear descriptions**: Make purpose immediately obvious
- **Include examples**: Show expected inputs/outputs for agents
- **Error handling**: Always include error scenarios
- **Configuration**: Use .claude/config.json for project values

## Integration with Other Commands

- **Discover**: `/discover-workflows` → find examples to model after
- **Import**: `/import-workflow` → import external workflow as starting point
- **Create**: `/create-workflow` (this command) → create new workflow
- **Validate**: `/validate-frontmatter` → ensure consistency

## Error Handling

### No Similar Workflows Found

- Show general templates
- Ask for more details about desired functionality
- Suggest browsing catalog manually

### Invalid Tool References

- List available tools
- Suggest alternatives
- Ask if should proceed without unavailable tools

### Category Mismatch

- Show list of existing categories
- Suggest closest match
- Allow creating new category if justified

### Name Collision

- Detect existing workflow with same name
- Suggest alternative names
- Ask: Rename / Replace / Cancel?

This command helps you create high-quality workflows following workspace standards!
