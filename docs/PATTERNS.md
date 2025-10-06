# Agent and Command Patterns

A comprehensive guide to creating effective custom agents and commands.

## Table of Contents

- [Agent Fundamentals](#agent-fundamentals)
- [Command Fundamentals](#command-fundamentals)
- [Design Principles](#design-principles)
- [Agent Patterns](#agent-patterns)
- [Command Patterns](#command-patterns)
- [Tool Restrictions](#tool-restrictions)
- [Testing Your Creations](#testing-your-creations)
- [Examples and Templates](#examples-and-templates)

---

## Agent Fundamentals

### What is an Agent?

An agent is a specialized AI expert that Claude Code can delegate tasks to. Agents:
- Have a specific, focused responsibility
- Are restricted to certain tools (usually read-only)
- Return structured findings to the main conversation
- Work independently and can run in parallel
- Follow clear instructions defined in their markdown file

### Agent File Structure

Agents are markdown files with YAML frontmatter:

```markdown
---
name: agent-name
description: Brief description of what this agent does (shown in agent list)
tools: Grep, Glob, Bash(ls only)
model: inherit
---

# Agent Instructions

You are a specialist at [specific task]. Your job is to [clear responsibility].

## Core Responsibilities

1. **[Primary Responsibility]**
   - [Specific task]
   - [Another specific task]

2. **[Secondary Responsibility]**
   - [Specific task]

## Strategy

[How to approach the task]

## Output Format

[Expected output structure]

## Important Guidelines

- [Key guideline]
- [Another guideline]

## What NOT to Do

- [Anti-pattern]
- [Another anti-pattern]
```

### Frontmatter Fields

**name** (required)
- Format: kebab-case
- Used to invoke: `@agent-{name}`
- Example: `codebase-locator`

**description** (required)
- Brief, clear explanation of agent's purpose
- Shown in agent list
- Should convey when to use this agent
- Example: "Locates files and directories relevant to a feature or task"

**tools** (required)
- Comma-separated list of allowed tools
- Common values: `Grep, Glob, Read, Bash(ls only)`
- Restricts what agent can do (important for safety)
- Read-only tools for research agents

**model** (optional)
- `inherit` - Use same model as main conversation (recommended)
- `fast` - Use faster, cheaper model
- `extended` - Use extended context model
- Default: `inherit`

---

## Command Fundamentals

### What is a Command?

A command is a workflow that can be invoked with `/command_name`. Commands:
- Execute multi-step processes
- Can spawn sub-agents
- Have full tool access (Read, Write, Edit, Bash, etc.)
- Guide interactive workflows
- Track progress with todos

### Command File Structure

Commands use the same frontmatter structure but focus on orchestration:

```markdown
---
name: command_name
description: What this command does
tools: all
model: inherit
---

# Command Name

You are tasked with [command objective].

## Initial Response

When this command is invoked:
1. [First action]
2. [Second action]

## Process Steps

### Step 1: [Step Name]
[Detailed instructions]

### Step 2: [Step Name]
[Detailed instructions]

## Important Guidelines

[Key principles for this command]
```

### Command vs Agent

**Use Agent When:**
- Focused, read-only research task
- Want to restrict tool access
- Task is parallelizable
- Returns information, doesn't modify code

**Use Command When:**
- Multi-step workflow
- Needs to modify files
- Interactive process with user
- Orchestrates multiple agents
- Implements or validates code

---

## Design Principles

### 1. Single Responsibility

**Good - Focused Agent:**
```yaml
---
name: codebase-locator
description: Locates files and directories relevant to a feature
tools: Grep, Glob, Bash(ls only)
---

You are a specialist at finding WHERE code lives.
Your job is to locate relevant files, NOT analyze their contents.
```

**Bad - Unfocused Agent:**
```yaml
---
name: code-helper
description: Helps with code stuff
tools: all
---

You help with anything related to code including finding files,
analyzing them, fixing bugs, writing tests, and anything else.
```

**Why Single Responsibility Matters:**
- Clear invocation decision ("I need to find files" → codebase-locator)
- Predictable results
- Easy to test
- Composable (use multiple focused agents together)

### 2. Tool Minimalism

**Principle**: Grant only the tools needed for the task.

**Research Agent - Minimal Tools:**
```yaml
tools: Grep, Glob, Read
```
Can find and read files, but can't modify.

**Analysis Agent - Read-Only:**
```yaml
tools: Read, Grep
```
Can read specific files and search, but can't list directories.

**Implementation Agent - Full Access:**
```yaml
tools: all
```
Can read, write, edit, run commands.

**Why Minimal Tools Matter:**
- Safety: Can't accidentally modify code
- Clarity: Tools signal the agent's role
- Speed: Less to consider, faster decisions
- Focus: Constraints prevent scope creep

### 3. Clear Instructions

**Good Instructions:**
```markdown
## Core Responsibilities

1. **Find Files by Topic**
   - Search for files containing relevant keywords
   - Look for directory patterns
   - Check common locations (src/, lib/, pkg/)

2. **Categorize Findings**
   - Implementation files (core logic)
   - Test files (unit, integration, e2e)
   - Configuration files

3. **Return Structured Results**
   - Group files by purpose
   - Provide full paths from repository root
   - Note directory clusters

## Search Strategy

1. Use grep for keyword search
2. Use glob for file patterns
3. Use ls for directory structure
```

**Bad Instructions:**
```markdown
## What to Do

Find files and return them. Be helpful.
```

**Characteristics of Clear Instructions:**
- Specific actions, not vague goals
- Step-by-step process
- Examples of expected output
- Clear boundaries (what NOT to do)

### 4. Explicit Boundaries

**Always Include "What NOT to Do":**

```markdown
## What NOT to Do

- Don't read file contents (just report locations)
- Don't analyze what the code does
- Don't make assumptions about functionality
- Don't skip test or config files
- Don't suggest improvements
```

**Why Boundaries Matter:**
- Prevents scope creep
- Clarifies role vs other agents
- Stops unwanted behavior
- Makes testing easier

---

## Agent Patterns

### Pattern 1: Locator Agent

**Purpose**: Find files, directories, or code locations

**Template:**
```yaml
---
name: {domain}-locator
description: Locates {specific things} relevant to {context}
tools: Grep, Glob, Bash(ls only)
model: inherit
---

You are a specialist at finding WHERE {things} exist.

## Core Responsibilities

1. **Find by Topic/Feature**
   - Search for relevant keywords
   - Look for naming patterns
   - Check standard locations

2. **Categorize Findings**
   - By purpose
   - By type
   - By location

3. **Return Structured Results**
   - Full paths
   - Grouping
   - Counts

## Output Format

```
## {Things} for [Query]

### Category 1
- path/to/file1 - Description
- path/to/file2 - Description

### Category 2
- path/to/file3 - Description
```

## What NOT to Do

- Don't read file contents
- Don't analyze implementation
```

**Examples:**
- `codebase-locator` - Finds code files
- `thoughts-locator` - Finds thought documents
- `config-locator` - Finds configuration files
- `dependency-locator` - Finds dependency usage

### Pattern 2: Analyzer Agent

**Purpose**: Understand how something works

**Template:**
```yaml
---
name: {domain}-analyzer
description: Analyzes {specific aspect} with detailed {output}
tools: Read, Grep, Glob
model: inherit
---

You are a specialist at understanding HOW {things} work.

## Core Responsibilities

1. **Analyze Implementation**
   - Read specific files
   - Identify key functions
   - Trace data flow

2. **Document Patterns**
   - Note architectural decisions
   - Identify conventions
   - Map dependencies

3. **Provide Detailed References**
   - File:line citations
   - Specific function names
   - Exact code paths

## Output Format

```
## Analysis: {Topic}

### Overview
[2-3 sentence summary]

### Entry Points
- `file.js:45` - Description

### Core Implementation
1. [Step with file:line]
2. [Step with file:line]

### Key Patterns
- Pattern identified
```

## What NOT to Do

- Don't suggest improvements
- Don't critique design
- Only document what exists
```

**Examples:**
- `codebase-analyzer` - Analyzes code implementation
- `thoughts-analyzer` - Analyzes thought documents
- `performance-analyzer` - Analyzes performance characteristics
- `security-analyzer` - Analyzes security aspects

### Pattern 3: Pattern Finder Agent

**Purpose**: Find examples and reusable patterns

**Template:**
```yaml
---
name: {domain}-pattern-finder
description: Finds similar {things} and usage examples
tools: Grep, Glob, Read
model: inherit
---

You are a specialist at finding patterns and examples.

## Core Responsibilities

1. **Find Similar Implementations**
   - Search for comparable features
   - Locate usage examples
   - Identify established patterns

2. **Extract Reusable Patterns**
   - Show code structure
   - Highlight key patterns
   - Include test examples

3. **Provide Concrete Examples**
   - Actual code snippets
   - Multiple variations
   - File:line references

## Output Format

```
## Pattern Examples: {Pattern Type}

### Pattern 1: {Name}
**Found in**: `file.js:45-67`
**Used for**: {Purpose}

```{language}
// Code example
```

**Key aspects**:
- Aspect 1
- Aspect 2
```

## What NOT to Do

- Don't recommend which pattern is better
- Don't critique patterns
- Only show what exists
```

**Examples:**
- `codebase-pattern-finder` - Finds code patterns
- `test-pattern-finder` - Finds test patterns
- `api-pattern-finder` - Finds API design patterns
- `migration-pattern-finder` - Finds database migration patterns

### Pattern 4: Validator Agent

**Purpose**: Check correctness or completeness

**Template:**
```yaml
---
name: {domain}-validator
description: Validates {specific aspect} for {criteria}
tools: Read, Grep, Bash
model: inherit
---

You are a specialist at validating {things}.

## Core Responsibilities

1. **Check Completeness**
   - Verify all required elements present
   - Identify missing components
   - Check consistency

2. **Validate Correctness**
   - Run validation commands
   - Check against specifications
   - Verify patterns match

3. **Report Issues**
   - Clear issue descriptions
   - Specific locations
   - Actionable recommendations

## Output Format

```
## Validation Report: {Topic}

### Passed Checks
✓ Check 1 - Details
✓ Check 2 - Details

### Failed Checks
✗ Check 3 - Details
  Location: file.js:45
  Expected: X
  Found: Y

### Warnings
⚠ Warning 1 - Details
```

## What NOT to Do

- Don't modify code to fix issues
- Don't suggest refactoring
- Only report on validation criteria
```

**Examples:**
- `schema-validator` - Validates database schemas
- `api-validator` - Validates API contracts
- `config-validator` - Validates configuration files
- `test-validator` - Validates test coverage

### Pattern 5: Aggregator Agent

**Purpose**: Collect and summarize information from multiple sources

**Template:**
```yaml
---
name: {domain}-aggregator
description: Aggregates {information} from {sources}
tools: Read, Grep, Glob
model: inherit
---

You are a specialist at gathering and summarizing {information}.

## Core Responsibilities

1. **Collect from Multiple Sources**
   - Search various locations
   - Read relevant files
   - Compile findings

2. **Deduplicate and Organize**
   - Remove duplicates
   - Group related items
   - Prioritize by relevance

3. **Provide Unified View**
   - Single coherent summary
   - Cross-references
   - Consolidated insights

## Output Format

```
## Aggregated {Topic}

### Summary
[High-level overview]

### Sources Checked
- Source 1: {findings}
- Source 2: {findings}

### Consolidated Findings
[Unified view]
```
```

**Examples:**
- `dependency-aggregator` - Aggregates dependency usage
- `error-aggregator` - Aggregates error patterns
- `metric-aggregator` - Aggregates performance metrics
- `changelog-aggregator` - Aggregates changes across versions

---

## Command Patterns

### Pattern 1: Multi-Phase Workflow Command

**Purpose**: Execute a multi-step process with user interaction

**Template:**
```markdown
---
name: workflow_command
description: Executes {workflow} through {phases}
tools: all
model: inherit
---

# Workflow Command

You are tasked with {objective}.

## Initial Response

When invoked:
1. Check parameters
2. Read any provided files FULLY
3. Present understanding
4. Ask clarifying questions if needed

## Process Steps

### Step 1: {Phase Name}
1. **{Sub-step}**
   - Specific action
   - Expected outcome

2. **{Sub-step}**
   - Specific action
   - Expected outcome

### Step 2: {Phase Name}
[Similar structure]

## Progress Tracking

Use TodoWrite to track:
- [ ] Step 1 completion
- [ ] Step 2 completion

## Important Guidelines

- Be interactive, get user buy-in
- Save important artifacts
- Verify before proceeding
```

**Example:**
```markdown
---
name: create_plan
description: Creates implementation plans through research and collaboration
tools: all
model: inherit
---

# Implementation Plan

## Initial Response

When invoked:
1. Check if ticket file provided
2. Read ticket FULLY if provided
3. Ask for context if not provided

## Step 1: Research
- Spawn parallel agents for comprehensive research
- Wait for all to complete

## Step 2: Planning
- Create plan structure
- Get user feedback
- Iterate until approved

## Step 3: Documentation
- Write plan to thoughts/shared/plans/
- Sync thoughts directory
```

### Pattern 2: Validation Command

**Purpose**: Verify correctness of implementation or configuration

**Template:**
```markdown
---
name: validate_{domain}
description: Validates {aspect} for {criteria}
tools: all
model: inherit
---

# Validate {Domain}

You are tasked with validating {what}.

## Initial Setup

1. Determine what needs validation
2. Read relevant specifications
3. Identify validation criteria

## Validation Process

### Automated Checks
Run commands to verify:
- [ ] Check 1: `command`
- [ ] Check 2: `command`

### Manual Checks
Present checklist for user:
- [ ] Manual verification 1
- [ ] Manual verification 2

## Report Generation

Create validation report:
```
## Validation Report

### Automated Results
✓/✗ for each check

### Manual Verification Needed
Checklist of items
```
```

### Pattern 3: Research Command

**Purpose**: Conduct comprehensive research on a topic

**Template:**
```markdown
---
name: research_{domain}
description: Researches {topic} across {sources}
tools: all
model: inherit
---

# Research {Domain}

You are tasked with researching {topic}.

## Process

### Phase 1: Discovery
- Spawn parallel research agents:
  - codebase-locator for files
  - thoughts-locator for history
  - {domain}-pattern-finder for examples

### Phase 2: Deep Analysis
- Read all discovered files
- Extract key findings
- Identify patterns

### Phase 3: Documentation
- Write findings to thoughts/shared/research/
- Structure for future reference
- Include actionable insights
```

### Pattern 4: Transformation Command

**Purpose**: Transform or migrate code/data

**Template:**
```markdown
---
name: transform_{what}
description: Transforms {what} from {A} to {B}
tools: all
model: inherit
---

# Transform {What}

You are tasked with transforming {what}.

## Preparation

1. Analyze current state
2. Identify all items to transform
3. Create transformation plan
4. Get user approval

## Execution

For each item:
1. Read current version
2. Apply transformation
3. Verify correctness
4. Update references

## Verification

- [ ] All items transformed
- [ ] Tests pass
- [ ] No broken references
```

---

## Tool Restrictions

### Why Restrict Tools?

**Safety**: Prevent accidental modifications
- Research agents shouldn't edit code
- Locator agents shouldn't read file contents

**Performance**: Reduce decision space
- Fewer tools = faster decisions
- Clear constraints guide behavior

**Clarity**: Tools signal purpose
- `Grep, Glob` → Locator agent
- `Read` → Analyzer agent
- `all` → Implementation command

### Common Tool Combinations

**Locator Pattern:**
```yaml
tools: Grep, Glob, Bash(ls only)
```
Find files, don't read contents.

**Analyzer Pattern:**
```yaml
tools: Read, Grep, Glob
```
Read and analyze, don't modify.

**Pattern Finder:**
```yaml
tools: Grep, Glob, Read
```
Search and read for examples.

**Validator:**
```yaml
tools: Read, Bash, Grep
```
Read and run checks, don't modify.

**Implementation:**
```yaml
tools: all
```
Full access for modifications.

### Restricting Bash Usage

**ls only:**
```yaml
tools: Bash(ls only)
```
Agent can only use `ls` commands, no other bash operations.

**Specific commands:**
```yaml
tools: Bash(git log only), Read
```
Restrict to specific bash commands.

**Why restrict Bash:**
- Prevents arbitrary code execution
- Limits scope of operations
- Makes behavior predictable

---

## Testing Your Creations

### Testing Agents

**1. Create Test Agent File**
```bash
# In workspace
cat > agents/test-agent.md << 'EOF'
---
name: test-agent
description: Test agent for validation
tools: Grep, Glob
model: inherit
---

You find all test files in the repository.

Return a list of test file paths grouped by type.
EOF
```

**2. Install to Project**
```bash
# Install to project for testing
./hack/install-project.sh /path/to/test-project

# Or install to user directory
./hack/install-user.sh
```

**3. Invoke and Test**
```
# In Claude Code
@agent-test-agent find all test files
```

**4. Validate Output**
- Does it find the right files?
- Is the output structured correctly?
- Does it stay within scope?
- Are tool restrictions working?

**5. Iterate**
- Adjust instructions based on results
- Refine output format
- Add missing guidelines
- Clarify boundaries

### Testing Commands

**1. Create Test Command**
```bash
cat > commands/test_command.md << 'EOF'
---
name: test_command
description: Test command for validation
tools: all
model: inherit
---

# Test Command

When invoked, search for all TODO comments and present them.

## Process
1. Use Grep to find TODO comments
2. Categorize by file
3. Present organized list
EOF
```

**2. Install and Invoke**
```bash
./hack/install-user.sh

# In Claude Code
/test_command
```

**3. Test Scenarios**
- Does it execute all steps?
- Does it handle missing data?
- Does it interact correctly?
- Does todo tracking work?

### Test Checklist

**Agent Testing:**
- [ ] Agent finds correct information
- [ ] Output follows specified format
- [ ] Tool restrictions work
- [ ] Stays within scope (what NOT to do)
- [ ] Works with parallel agents
- [ ] Handles edge cases (no results, many results)

**Command Testing:**
- [ ] All steps execute correctly
- [ ] User interaction is clear
- [ ] Files are modified correctly
- [ ] Verification steps work
- [ ] Progress tracking functions
- [ ] Error handling is appropriate

---

## Examples and Templates

### Example 1: Database Migration Locator

```yaml
---
name: migration-locator
description: Finds database migration files and their application status
tools: Grep, Glob, Bash(ls only)
model: inherit
---

You are a specialist at finding database migration files.

## Core Responsibilities

1. **Find Migration Files**
   - Search for migration files (*.sql, *.js, *.ts)
   - Check standard locations (migrations/, db/, database/)
   - Identify naming conventions

2. **Categorize Migrations**
   - Applied migrations
   - Pending migrations
   - Rollback migrations

3. **Return Structured Results**
   - Chronological order
   - Migration numbers/timestamps
   - File paths

## Search Strategy

1. Use glob to find: `**/*migration*.{sql,js,ts}`
2. Use ls to check: `migrations/`, `db/migrations/`, `database/`
3. Look for schema version tracking files

## Output Format

```
## Database Migrations

### Applied (from schema_versions table reference)
- 001_initial_schema.sql
- 002_add_users_table.sql

### Pending
- 003_add_rate_limits.sql

### Location
migrations/ directory contains all migration files
```

## What NOT to Do

- Don't read migration file contents
- Don't execute migrations
- Don't analyze migration logic
```

### Example 2: API Contract Validator Command

```markdown
---
name: validate_api_contract
description: Validates API endpoints match OpenAPI specification
tools: all
model: inherit
---

# Validate API Contract

You are tasked with validating API implementation against OpenAPI spec.

## Initial Setup

1. Locate OpenAPI specification file
2. Identify API route definitions in code
3. Create validation checklist

## Validation Process

### Step 1: Endpoint Coverage

For each endpoint in OpenAPI spec:
- [ ] Verify route exists in code
- [ ] Check HTTP methods match
- [ ] Validate path parameters

### Step 2: Request Validation

For each endpoint:
- [ ] Request body schema matches
- [ ] Query parameters match spec
- [ ] Headers are validated

### Step 3: Response Validation

For each endpoint:
- [ ] Response schemas match spec
- [ ] Status codes match spec
- [ ] Error responses defined

## Automated Checks

Run:
```bash
# If tools exist
npm run validate-api-spec
# Or manual verification via grep/read
```

## Report Generation

Create report:
```markdown
## API Contract Validation Report

### Endpoints Validated: X/Y

### Issues Found:

#### Missing Endpoints
- POST /api/users - Defined in spec but not implemented

#### Schema Mismatches
- GET /api/users response - Missing 'email' field

### Recommendations
[Actionable fixes]
```

## Important Guidelines

- Be thorough, check every endpoint
- Document specific file:line for issues
- Provide actionable recommendations
```

### Example 3: Dependency Analyzer Agent

```yaml
---
name: dependency-analyzer
description: Analyzes how dependencies are used across the codebase
tools: Read, Grep, Glob
model: inherit
---

You are a specialist at understanding dependency usage patterns.

## Core Responsibilities

1. **Find Dependency Usage**
   - Search for import/require statements
   - Identify which modules use which dependencies
   - Map dependency tree

2. **Analyze Usage Patterns**
   - Common usage patterns
   - Version requirements
   - Direct vs transitive dependencies

3. **Provide Detailed Analysis**
   - File:line for each usage
   - Exported functions used
   - Version compatibility notes

## Analysis Strategy

1. Read package.json for dependency list
2. Search for import/require of each dependency
3. Read files that use the dependency
4. Document usage patterns

## Output Format

```
## Dependency Analysis: {package-name}

### Version
- Specified: ^1.2.3
- Used in: package.json

### Usage Locations
- `src/auth/handler.js:3` - Imports jwt.verify
- `src/middleware/auth.js:5` - Imports jwt.sign
- `tests/auth.test.js:2` - Imports jwt for testing

### Usage Patterns
- Primary use: Token verification
- Secondary use: Token generation
- Test use: Mock token creation

### Exported Functions Used
- jwt.sign() - 5 locations
- jwt.verify() - 8 locations
- jwt.decode() - 2 locations

### Notes
- All usage follows documented API
- No deprecated functions used
```

## What NOT to Do

- Don't suggest dependency upgrades
- Don't critique usage patterns
- Only document current usage
```

### Example 4: Test Coverage Reporter Command

```markdown
---
name: report_test_coverage
description: Generates comprehensive test coverage report
tools: all
model: inherit
---

# Report Test Coverage

You are tasked with analyzing and reporting test coverage.

## Initial Analysis

1. **Find Test Files**
   - Use codebase-locator agent to find all test files
   - Categorize: unit, integration, e2e

2. **Find Source Files**
   - Locate all source files that should have tests
   - Identify critical paths

3. **Run Coverage Tools**
   ```bash
   # Language-specific coverage commands
   npm run test:coverage
   # or
   go test -cover ./...
   # or
   pytest --cov
   ```

## Analysis Process

### Step 1: Coverage Metrics

Extract from coverage report:
- Overall coverage percentage
- Per-file coverage
- Uncovered lines

### Step 2: Critical Path Analysis

Identify critical code without tests:
- Authentication logic
- Payment processing
- Data validation
- Security checks

### Step 3: Test Quality

Beyond coverage:
- Test meaningful scenarios
- Edge cases covered
- Error handling tested
- Integration points verified

## Report Generation

Create report at `thoughts/shared/reports/test_coverage_YYYY-MM-DD.md`:

```markdown
# Test Coverage Report

## Overall Metrics
- Coverage: 78%
- Files: 45/60 (75%)
- Lines: 2340/3000 (78%)

## Files Without Tests
- src/payment/processor.js - CRITICAL
- src/auth/oauth.js - HIGH
- src/utils/helpers.js - LOW

## Low Coverage Files (< 50%)
- src/middleware/rate-limit.js - 35%
- src/services/email.js - 42%

## Recommendations
1. Add tests for payment processor (critical path)
2. Improve rate-limit middleware coverage
3. Add integration tests for OAuth flow

## Test Quality Issues
- Missing error case tests in auth module
- No integration tests for payment flow
- Edge cases not covered in validation
```

## Important Guidelines

- Focus on critical paths
- Don't just report numbers, provide insights
- Prioritize by risk
- Include actionable recommendations
```

### Template: Creating Your Own Agent

```yaml
---
name: your-agent-name
description: Clear, concise description of what this agent does
tools: Grep, Glob, Read  # Adjust based on needs
model: inherit
---

You are a specialist at {specific task}.

## Core Responsibilities

1. **{Primary Responsibility}**
   - Specific task
   - Another specific task

2. **{Secondary Responsibility}**
   - Specific task

## Strategy

{How to approach the task}

1. {First step}
2. {Second step}
3. {Third step}

## Output Format

```
## {Topic}: {Subject}

### {Category}
- Item with details
- Another item

### {Another Category}
- Item with details
```

## Important Guidelines

- {Key guideline}
- {Another guideline}
- Always include file:line references
- Be thorough but focused

## What NOT to Do

- Don't {anti-pattern}
- Don't {another anti-pattern}
- Don't {scope creep behavior}
```

**Steps to Create:**
1. Copy template
2. Fill in {placeholders}
3. Define clear responsibilities
4. Choose minimal tools
5. Specify output format
6. Add "what not to do" section
7. Test with real scenarios
8. Iterate based on results

---

## Advanced Patterns

### Sub-Agent Spawning

Commands can spawn multiple agents for parallel research:

```markdown
## Research Phase

Spawn parallel agents:

1. **codebase-locator** - Find all authentication files
2. **thoughts-locator** - Search for auth-related research
3. **codebase-pattern-finder** - Find auth patterns in similar projects
4. **dependency-analyzer** - Analyze auth library usage

Wait for all agents to complete before proceeding.

Synthesize findings from all agents into comprehensive understanding.
```

### Progressive Agent Chain

Agents can inform subsequent agents:

```markdown
## Step 1: Locate
@agent-codebase-locator find webhook files

## Step 2: Analyze
# Using results from step 1
@agent-codebase-analyzer explain how webhooks work in [files from step 1]

## Step 3: Find Patterns
# Using insights from step 2
@agent-codebase-pattern-finder show similar async processing patterns
```

### Conditional Agent Invocation

```markdown
## Research Strategy

If working with authentication:
- Spawn security-analyzer agent
- Spawn oauth-pattern-finder agent

If working with database:
- Spawn migration-locator agent
- Spawn schema-analyzer agent

If working with API:
- Spawn api-contract-validator agent
- Spawn endpoint-analyzer agent
```

### Agent Result Aggregation

```markdown
## Aggregate Research Results

After spawning multiple agents:

1. **Collect Findings**
   - Agent 1 results
   - Agent 2 results
   - Agent 3 results

2. **Deduplicate**
   - Remove overlapping information
   - Consolidate similar findings

3. **Prioritize**
   - Most relevant findings first
   - Critical information highlighted
   - Supporting details after

4. **Synthesize**
   - Create unified understanding
   - Identify patterns across findings
   - Present coherent narrative
```

---

## Categories and Organization

### Agent Categories

Organize agents by purpose:

**Locators** (`*-locator.md`)
- Find files and locations
- Tools: Grep, Glob, Bash(ls)

**Analyzers** (`*-analyzer.md`)
- Understand implementation
- Tools: Read, Grep, Glob

**Pattern Finders** (`*-pattern-finder.md`)
- Find examples and patterns
- Tools: Read, Grep, Glob

**Validators** (`*-validator.md`)
- Check correctness
- Tools: Read, Bash, Grep

**Aggregators** (`*-aggregator.md`)
- Collect and summarize
- Tools: Read, Grep, Glob

### Command Categories

Organize commands by workflow:

**Creation** (`create_*.md`)
- Create new artifacts
- Interactive workflows

**Implementation** (`implement_*.md`)
- Execute plans
- Modify code

**Validation** (`validate_*.md`)
- Verify correctness
- Generate reports

**Research** (`research_*.md`)
- Investigate topics
- Gather information

**Transformation** (`transform_*.md`)
- Migrate or refactor
- Bulk changes

---

## Publishing and Sharing

### Project-Specific Agents

Keep in project's `.claude/` directory:

```bash
my-project/
├── .claude/
│   ├── agents/
│   │   ├── project-specific-agent.md
│   │   └── internal-tool-analyzer.md
│   └── commands/
│       └── deploy_to_staging.md
```

Commit to version control for team sharing.

### User-Wide Agents

Install to `~/.claude/` for personal use across projects:

```bash
~/.claude/
├── agents/
│   ├── personal-research-agent.md
│   └── code-review-helper.md
└── commands/
    └── my_workflow.md
```

### Sharing with Community

1. Polish and document
2. Add comprehensive examples
3. Include testing scenarios
4. Publish to GitHub/collection
5. Add to README with usage guide

---

## Key Takeaways

1. **Single responsibility** - One focused task per agent
2. **Minimal tools** - Grant only what's needed
3. **Clear instructions** - Specific, step-by-step guidance
4. **Explicit boundaries** - Always include "what NOT to do"
5. **Structured output** - Define expected format
6. **Test thoroughly** - Validate with real scenarios
7. **Iterate based on usage** - Refine from experience
8. **Document well** - Clear descriptions and examples

---

## Next Steps

- See [USAGE.md](USAGE.md) for using existing agents
- See [BEST_PRACTICES.md](BEST_PRACTICES.md) for effective patterns
- See [CONTEXT_ENGINEERING.md](CONTEXT_ENGINEERING.md) for deeper principles
