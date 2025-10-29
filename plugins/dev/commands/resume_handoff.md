---
description: Resume work from a handoff document
category: workflow
tools: Read, Bash, TodoWrite
model: inherit
version: 1.0.0
---

# Resume work from a handoff document

## Prerequisites

Before executing, verify required tools are installed:

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

## Configuration Note

This command uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket
prefix:

- Read from `.claude/config.json` if available
- Otherwise use a generic format like `TICKET-XXX`
- Examples: `ENG-123`, `FEAT-456`, `BUG-789`

You are tasked with resuming work from a handoff document through an interactive process. These
handoffs contain critical context, learnings, and next steps from previous work sessions that need
to be understood and continued.

## Initial Response

**STEP 1: Auto-discover recent handoff (REQUIRED)**

IMMEDIATELY run this bash script BEFORE any other response:

```bash
# Auto-discover most recent handoff from workflow context
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  RECENT_HANDOFF=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent handoffs)
  if [[ -n "$RECENT_HANDOFF" ]]; then
    echo "📋 Auto-discovered recent handoff: $RECENT_HANDOFF"
    echo ""
  fi
fi
```

**STEP 2: Determine which handoff to use**

After running the auto-discovery script, follow this logic:

1. **If user provided a file path as parameter**:
   - Use the provided path (user override)
   - Skip to Step 3

2. **If user provided a ticket number (like PROJ-123)**:
   - Run `humanlayer thoughts sync` to ensure `thoughts/` is up to date
   - Look in `thoughts/shared/handoffs/PROJ-123/` directory
   - List all handoffs for that ticket
   - If multiple exist, use the most recent (by timestamp in filename `YYYY-MM-DD_HH-MM-SS`)
   - If none exist, tell user and wait for input
   - Skip to Step 3

3. **If no parameters provided AND RECENT_HANDOFF was found**:
   - Show user: "📋 Found recent handoff: $RECENT_HANDOFF"
   - Ask: "**Proceed with this handoff?** [Y/n]"
   - If yes: use RECENT_HANDOFF and skip to Step 3
   - If no: proceed to option 4

4. **If no parameters AND no RECENT_HANDOFF found**:
   - List available handoffs from `thoughts/shared/handoffs/`
   - Show most recent 5 handoffs with dates
   - Ask user which one to use
   - Wait for user input with path or ticket number

**STEP 3: Analyze the handoff**

Once you have a handoff path:
- Read the handoff document FULLY (no limit/offset)
- Immediately read any research or plan documents it references
- Do NOT use sub-agents to read these critical files
- Ingest all context from the handoff
- Propose course of action to user
- Get confirmation before proceeding

## Process Steps

### Step 1: Read and Analyze Handoff

1. **Read handoff document completely**:
   - Use the Read tool WITHOUT limit/offset parameters
   - Extract all sections:
     - Task(s) and their statuses
     - Recent changes
     - Learnings
     - Artifacts
     - Action items and next steps
     - Other notes

2. **Spawn focused research tasks**: Based on the handoff content, spawn parallel research tasks to
   verify current state:

   ```
   Task 1 - Verify recent changes:
   Check if the recent changes mentioned in the handoff still exist.
   1. Verify files mentioned in "Recent changes" section
   2. Check if the described changes are still present
   3. Look for any subsequent modifications
   4. Identify any conflicts or regressions
   Use tools: Read, Grep, Glob
   Return: Current state of recent changes with file:line references
   ```

   ```
   Task 2 - Validate current codebase state:
   Verify the current state against what's described in the handoff.
   1. Check files mentioned in "Learnings" section
   2. Verify patterns and implementations still exist
   3. Look for any breaking changes since handoff
   4. Identify new related code added since handoff
   Use tools: Read, Grep, Glob
   Return: Validation results and any discrepancies found
   ```

   ```
   Task 3 - Gather artifact context:
   Read all artifacts mentioned in the handoff.
   1. Read feature documents listed in "Artifacts"
   2. Read implementation plans referenced
   3. Read any research documents mentioned
   4. Extract key requirements and decisions
   Use tools: Read
   Return: Summary of artifact contents and key decisions
   ```

3. **Wait for ALL sub-tasks to complete** before proceeding

4. **Read critical files identified**:
   - Read files from "Learnings" section completely
   - Read files from "Recent changes" to understand modifications
   - Read any new related files discovered during research

### Step 2: Synthesize and Present Analysis

1. **Present comprehensive analysis**:

   ```
   I've analyzed the handoff from [date] by [researcher]. Here's the current situation:

   **Original Tasks:**
   - [Task 1]: [Status from handoff] → [Current verification]
   - [Task 2]: [Status from handoff] → [Current verification]

   **Key Learnings Validated:**
   - [Learning with file:line reference] - [Still valid/Changed]
   - [Pattern discovered] - [Still applicable/Modified]

   **Recent Changes Status:**
   - [Change 1] - [Verified present/Missing/Modified]
   - [Change 2] - [Verified present/Missing/Modified]

   **Artifacts Reviewed:**
   - [Document 1]: [Key takeaway]
   - [Document 2]: [Key takeaway]

   **Recommended Next Actions:**
   Based on the handoff's action items and current state:
   1. [Most logical next step based on handoff]
   2. [Second priority action]
   3. [Additional tasks discovered]

   **Potential Issues Identified:**
   - [Any conflicts or regressions found]
   - [Missing dependencies or broken code]

   Shall I proceed with [recommended action 1], or would you like to adjust the approach?
   ```

2. **Get confirmation** before proceeding

### Step 3: Create Action Plan

1. **Use TodoWrite to create task list**:
   - Convert action items from handoff into todos
   - Add any new tasks discovered during analysis
   - Prioritize based on dependencies and handoff guidance

2. **Present the plan**:

   ```
   I've created a task list based on the handoff and current analysis:

   [Show todo list]

   Ready to begin with the first task: [task description]?
   ```

### Step 4: Begin Implementation

1. **Start with the first approved task**
2. **Reference learnings from handoff** throughout implementation
3. **Apply patterns and approaches documented** in the handoff
4. **Update progress** as tasks are completed

## Guidelines

1. **Be Thorough in Analysis**:
   - Read the entire handoff document first
   - Verify ALL mentioned changes still exist
   - Check for any regressions or conflicts
   - Read all referenced artifacts

2. **Be Interactive**:
   - Present findings before starting work
   - Get buy-in on the approach
   - Allow for course corrections
   - Adapt based on current state vs handoff state

3. **Leverage Handoff Wisdom**:
   - Pay special attention to "Learnings" section
   - Apply documented patterns and approaches
   - Avoid repeating mistakes mentioned
   - Build on discovered solutions

4. **Track Continuity**:
   - Use TodoWrite to maintain task continuity
   - Reference the handoff document in commits
   - Document any deviations from original plan
   - Consider creating a new handoff when done

5. **Validate Before Acting**:
   - Never assume handoff state matches current state
   - Verify all file references still exist
   - Check for breaking changes since handoff
   - Confirm patterns are still valid

## Common Scenarios

### Scenario 1: Clean Continuation

- All changes from handoff are present
- No conflicts or regressions
- Clear next steps in action items
- Proceed with recommended actions

### Scenario 2: Diverged Codebase

- Some changes missing or modified
- New related code added since handoff
- Need to reconcile differences
- Adapt plan based on current state

### Scenario 3: Incomplete Handoff Work

- Tasks marked as "in_progress" in handoff
- Need to complete unfinished work first
- May need to re-understand partial implementations
- Focus on completing before new work

### Scenario 4: Stale Handoff

- Significant time has passed
- Major refactoring has occurred
- Original approach may no longer apply
- Need to re-evaluate strategy

## Example Interaction Flow

```
User: /catalyst-dev:resume_handoff specification/feature/handoffs/handoff-0.md
Assistant: Let me read and analyze that handoff document...

[Reads handoff completely]
[Spawns research tasks]
[Waits for completion]
[Reads identified files]

I've analyzed the handoff from [date]. Here's the current situation...

[Presents analysis]

Shall I proceed with implementing the webhook validation fix, or would you like to adjust the approach?

User: Yes, proceed with the webhook validation
Assistant: [Creates todo list and begins implementation]
```
