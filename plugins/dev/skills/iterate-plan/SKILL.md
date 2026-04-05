---
name: iterate-plan
description: Update existing implementation plans based on feedback or changed requirements
disable-model-invocation: true
allowed-tools: Read, Write, Task, Bash, Grep, Glob
version: 1.0.0
---

# Iterate Plan

You are tasked with updating an existing implementation plan based on user feedback,
partial implementation results, or changed requirements. You update plans with
research-backed modifications, not just text edits.

## Prerequisites

```bash
# Check project setup (thoughts, CLAUDE.md snippet, config)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi

# Auto-discover most recent plan (workflow context + filesystem fallback)
RECENT_PLAN=""
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  RECENT_PLAN=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent plans)
fi
if [[ -n "$RECENT_PLAN" ]]; then
  echo "📋 Auto-discovered recent plan: $RECENT_PLAN"
else
  echo "⚠️ No recent plan found in workflow context or filesystem"
fi
```

## Initial Response

Auto-discovery has already run in Prerequisites above. Check its output and follow this priority:

1. **If user provided a plan file path**: Use the provided path (user override). Read it FULLY immediately.
2. **If no path provided AND Prerequisites discovered a plan (📋)**: Show the path and ask "**Update this plan?** [Y/n]"
3. **If no path AND no plan found (⚠️)**: Ask user to provide the plan file path

Then ask: "What changes need to be made to this plan?"

## Process Steps

### Step 1: Read and Understand the Existing Plan

1. Read the plan document FULLY (no limit/offset)
2. Identify all phases, success criteria, and current completion state
3. Note which phases are already completed vs pending
4. Understand the overall architecture and approach

### Step 2: Understand the Requested Changes

Parse the user's feedback:
- **Scope changes**: Adding/removing phases or features
- **Technical corrections**: Wrong approach, better alternative discovered
- **Feedback from review**: Reviewer comments on the plan
- **Partial implementation learnings**: Things discovered during implementation
- **Requirement changes**: Business requirements shifted

### Step 3: Research If Needed

If the changes require new technical understanding:

1. Spawn parallel sub-agents to research the codebase:
   - **codebase-locator** to find relevant files
   - **codebase-analyzer** to understand current implementation
   - **codebase-pattern-finder** to find similar patterns

2. Wait for ALL agents to complete before modifying the plan

3. Present research findings to user before making changes:
   ```
   Based on my research:
   - [Finding 1 with file:line reference]
   - [Finding 2 with file:line reference]

   This affects the plan in these ways:
   - [Impact 1]
   - [Impact 2]

   Shall I proceed with these updates?
   ```

### Step 4: Update the Plan

1. Preserve completed phases unchanged (unless explicitly asked to modify)
2. Update pending phases with new information
3. Add new phases if scope expanded
4. Remove phases if scope narrowed
5. Update success criteria to reflect changes
6. Add an "Iteration History" section at the bottom:

```markdown
## Iteration History

### Iteration 1 - YYYY-MM-DD
**Reason**: [Why the plan was updated]
**Changes**:
- [Phase X]: [What changed and why]
- [Phase Y]: [Added/removed/modified]
**Research conducted**: [[research-doc-filename]] — [Brief summary, if any]
```

### Step 5: Save and Sync

1. Save the updated plan (overwrite the existing file)
2. Sync thoughts: `humanlayer thoughts sync`
3. Track in workflow context (REQUIRED) — substitute actual path and ticket:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add plans "thoughts/shared/plans/YYYY-MM-DD-description.md" "TICKET-ID"
   ```
4. Verify: `"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent plans` must print the path

### Step 6: Present Summary

```
Plan updated!

**Plan**: [file path]
**Changes made**:
- [Summary of each change]

**Impact on implementation**:
- Phases affected: [list]
- New phases added: [list, if any]
- Phases removed: [list, if any]

Please review the updated plan.
```

## Important Guidelines

1. **Research before modifying** — Don't just edit text; verify changes against the codebase
2. **Preserve completed work** — Never modify phases marked as done unless explicitly asked
3. **Update success criteria** — Every plan change must have corresponding criteria updates
4. **Track iterations** — Always add to the Iteration History section
5. **Read fully** — Always read the entire plan before making changes
6. **No open questions** — Resolve all uncertainties before saving

**IMPORTANT: Document Storage Rules**
- ALWAYS write to `thoughts/shared/plans/` for plan documents
- NEVER write to `thoughts/searchable/` — this is a read-only search index
