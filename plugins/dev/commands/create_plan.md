---
description: Create detailed implementation plans through an interactive process
category: workflow
tools: Read, Write, Grep, Glob, Task, TodoWrite, Bash
model: opus
version: 1.0.0
---

# Implementation Plan

You are tasked with creating detailed implementation plans through an interactive, iterative
process. You should be skeptical, thorough, and work collaboratively with the user to produce
high-quality technical specifications.

Replace `PROJ` in ticket references with your Linear team's prefix from `.claude/config.json`.

## Prerequisites

```bash
# Check project setup (thoughts, CLAUDE.md snippet, config)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## Initial Response

**STEP 1: Check for recent research**

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  RECENT_RESEARCH=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent research)
  if [[ -n "$RECENT_RESEARCH" ]]; then
    echo "Found recent research: $RECENT_RESEARCH"
  fi
fi
```

**STEP 2: Gather initial input**

1. **If user provided parameters** (file path or ticket reference):
   - Read any provided files FULLY
   - If RECENT_RESEARCH was found, mention it and ask if it should inform the plan
   - Begin the research process

2. **If no parameters provided**:
   - Show any RECENT_RESEARCH found
   - Ask for: task/ticket description, context/constraints, related research
   - Wait for user's input

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Read all mentioned files immediately and FULLY**:
   - Ticket files, research documents, related plans, JSON/data files
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters
   - **CRITICAL**: Read these files yourself before spawning sub-tasks

2. **Spawn initial research tasks in parallel**:
   - **codebase-locator** — find all files related to the ticket/task
   - **codebase-analyzer** — understand how the current implementation works
   - **thoughts-locator** — find existing thoughts documents about this feature (if relevant)

3. **Read all files identified by research tasks** FULLY into the main context

4. **Analyze and verify understanding**:
   - Cross-reference ticket requirements with actual code
   - Identify discrepancies, assumptions, and true scope

5. **Present informed understanding and focused questions**:
   - Show what you found with file:line references
   - Only ask questions you genuinely cannot answer through code investigation

### Step 2: Research & Discovery

After getting initial clarifications:

1. **If the user corrects any misunderstanding**:
   - Spawn new research tasks to verify — don't just accept corrections
   - Only proceed once you've verified the facts yourself

2. **Create a research todo list** using TodoWrite

3. **Spawn parallel sub-tasks for comprehensive research**:

   **For local codebase:**
   - **codebase-locator** — find specific files
   - **codebase-analyzer** — understand implementation details
   - **codebase-pattern-finder** — find similar features to model after

   **For external research:**
   - **external-research** — framework patterns and best practices from popular repos

   **For historical context:**
   - **thoughts-locator** / **thoughts-analyzer** — find past research, plans, decisions

4. **Wait for ALL sub-tasks to complete** before proceeding

5. **Present findings and design options** with pros/cons for each approach

### Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline** showing phases and what each accomplishes
2. **Get feedback on structure** before writing details

### Step 4: Detailed Plan Writing

After structure approval:

1. **Gather metadata**:

   ```bash
   CURRENT_ISO_DATETIME=$(date -Iseconds)
   CURRENT_DATE=$(date +%Y-%m-%d)
   GIT_COMMIT_SHORT=$(git rev-parse --short HEAD)
   GIT_BRANCH=$(git branch --show-current)
   REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
   ```

   **IMPORTANT: Document Storage Rules**
   - ALWAYS write to `thoughts/shared/plans/`
   - NEVER write to `thoughts/searchable/` (read-only search index)

2. **Write the plan** to `thoughts/shared/plans/YYYY-MM-DD-PROJ-XXXX-description.md`
   - With ticket: `2025-01-08-PROJ-123-parent-child-tracking.md`
   - Without ticket: `2025-01-08-improve-error-handling.md`

3. **Use this template structure** (frontmatter comes BEFORE the heading):

````markdown
---
date: {CURRENT_ISO_DATETIME}
researcher: claude
git_commit: {GIT_COMMIT_SHORT}
branch: {GIT_BRANCH}
repository: {REPO_NAME}
topic: "{PLAN_TITLE}"
tags: [plan, implementation, {RELEVANT_COMPONENT_TAGS}]
status: ready_for_implementation
last_updated: {CURRENT_DATE}
last_updated_by: claude
type: implementation_plan
---

# [Feature/Task Name] Implementation Plan

## Overview

[Brief description of what we're implementing and why]

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

## Desired End State

[Specification of the desired end state and how to verify it]

### Key Discoveries:

- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview

[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]

**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Specific code to add/modify
```

### Success Criteria:

#### Automated Verification:

- [ ] Unit tests pass: `make test`
- [ ] Type checking passes: `make check`
- [ ] Linting passes: `make lint`

#### Manual Verification:

- [ ] Feature works as expected when tested
- [ ] No regressions in related features

---

## Phase 2: [Descriptive Name]

[Similar structure...]

---

## Testing Strategy

[Unit tests, integration tests, manual testing steps]

## Performance Considerations

[Any performance implications]

## Migration Notes

[If applicable]

## References

- Original ticket: `thoughts/shared/tickets/PROJ-XXX.md`
- Related research: `thoughts/shared/research/[relevant].md`
- Similar implementation: `[file:line]`
````

### Step 5: Sync and Review

1. **Sync**: Run `humanlayer thoughts sync`

2. **Track in Workflow Context**:
   ```bash
   if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
     "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add plans "$PLAN_FILE" "${TICKET_ID}"
   fi
   ```

3. **Present plan** and ask for review:
   - Show plan location
   - Ask: Are phases properly scoped? Success criteria specific enough? Missing edge cases?
   - If context >60%, recommend clearing before implementation phase

4. **Iterate based on feedback** until the user is satisfied
   - Re-sync thoughts after changes

5. **After plan approval**, provide implementation command:

   **Use `--team` when:** 3+ parallel phases, distinct domains, non-overlapping files, 10+ files
   **Use standard mode when:** sequential phases, same directory, <10 files, tightly coupled

   ```
   ## Ready to Implement

   Start a new session and run:
   /catalyst-dev:implement_plan [--team] thoughts/shared/plans/{PLAN_FILENAME}

   Tip: Start a fresh session — implementation needs context for source files and progress tracking.
   ```

## Important Guidelines

1. **Be Skeptical**: Question vague requirements. Don't assume — verify with code.
2. **Be Interactive**: Don't write the full plan in one shot. Get buy-in at each step.
3. **Be Thorough**: Read all context files COMPLETELY. Include file:line references.
   Use `make check` over individual lint/test commands when available.
4. **Be Practical**: Focus on incremental, testable changes. Include "what we're NOT doing".
5. **No Open Questions in Final Plan**: Research or ask for clarification immediately.
   The plan must be complete and actionable — every decision made before finalizing.

## Success Criteria Guidelines

**Always separate into two categories:**

1. **Automated Verification** (run by agents): `make test`, `make lint`, type checking, etc.
2. **Manual Verification** (requires human): UI/UX, performance, edge cases, acceptance criteria

## Common Patterns

### For Database Changes:
Schema/migration → store methods → business logic → API → clients

### For New Features:
Research patterns → data model → backend logic → API endpoints → UI

### For Refactoring:
Document behavior → incremental changes → backwards compatibility → migration strategy
