---
description: Implement approved technical plans from thoughts/shared/plans/
category: workflow
tools: Read, Write, Edit, Grep, Glob, Task, TodoWrite, Bash
model: inherit
version: 1.0.0
---

# Implement Plan

You are tasked with implementing an approved technical plan from `thoughts/shared/plans/`. These
plans contain phases with specific changes and success criteria.

## Prerequisites

Before executing, verify required tools are installed:

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

## Initial Response

**STEP 1: Auto-discover recent plan (REQUIRED)**

IMMEDIATELY run this bash script BEFORE any other response:

```bash
# Auto-discover most recent plan from workflow context
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  RECENT_PLAN=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent plans)
  if [[ -n "$RECENT_PLAN" ]]; then
    echo "📋 Auto-discovered recent plan: $RECENT_PLAN"
    echo ""
  fi
fi
```

**STEP 2: Determine which plan to implement**

After running the auto-discovery script, follow this logic:

1. **If user provided a plan path as parameter**:
   - Use the provided path (user override)
   - Skip to Step 3

2. **If no parameter provided AND RECENT_PLAN was found**:
   - Show user: "📋 Found recent plan: $RECENT_PLAN"
   - Ask: "**Proceed with this plan?** [Y/n]"
   - If yes: use RECENT_PLAN and skip to Step 3
   - If no: proceed to option 3

3. **If no parameter AND no RECENT_PLAN found**:
   - List available plans from `thoughts/shared/plans/`
   - Show most recent 5 plans with dates and ticket numbers
   - Ask user which plan to implement
   - Wait for user input with plan path

**STEP 3: Read and prepare**

Once you have a plan path:
- Read the plan completely (no limit/offset)
- Check for any existing checkmarks (- [x]) to see what's done
- Read the original ticket and all files mentioned in the plan
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Start implementing if you understand what needs to be done

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:

- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

When things don't match the plan exactly, think about why and communicate clearly. The plan is your
guide, but your judgment matters too.

If you encounter a mismatch:

- STOP and think deeply about why the plan can't be followed
- Present the issue clearly:

  ```
  Issue in Phase [N]:
  Expected: [what the plan says]
  Found: [actual situation]
  Why this matters: [explanation]

  How should I proceed?
  ```

## Verification Approach

After implementing a phase:

- Run the success criteria checks (usually `make check test` covers everything)
- Fix any issues before proceeding
- Update your progress in both the plan and your todos
- Check off completed items in the plan file itself using Edit
- **Check context usage** - monitor token consumption

Don't let verification interrupt your flow - batch it at natural stopping points.

## Context Management During Implementation

**Monitor context proactively throughout implementation**:

**After Each Phase**:

```
✅ Phase {N} complete!

## 📊 Context Status
Current usage: {X}% ({Y}K/{Z}K tokens)

{If >60%}:
⚠️ **Context Alert**: We're at {X}% usage.

**Recommendation**: Create a handoff before continuing to Phase {N+1}.

**Why?** Implementation accumulates context:
- File reads
- Code changes
- Test outputs
- Error messages
- Context clears ensure continued high performance

**Options**:
1. ✅ Create handoff and clear context (recommended)
   - Use `/create-handoff` to generate properly formatted handoff
   - Format: `thoughts/shared/handoffs/{ticket}/YYYY-MM-DD_HH-MM-SS_description.md`
   - Includes timestamp for lexical sorting by recency
2. Continue to next phase (if close to completion)

**To resume**: Start fresh session, run `/implement-plan {plan-path}`
(The plan file tracks progress with checkboxes - you'll resume automatically)

{If <60%}:
✅ Context healthy. Ready for Phase {N+1}.
```

**When to Warn**:

- After any phase if context >60%
- If context >70%, strongly recommend handoff
- If context >80%, STOP and require handoff
- If user is spinning on errors (3+ attempts), suggest context clear

**Educate About Phase-Based Context**:

- Explain that implementation is designed to work in chunks
- Each phase completion is a natural handoff point
- Plan file preserves progress across sessions
- Fresh context = fresh perspective on next phase

**Creating a Handoff**:

When recommending a handoff, guide the user:

1. Offer to create the handoff using `/create-handoff`
2. Or create a manual handoff following the timestamp convention
3. Handoff filename format: `thoughts/shared/handoffs/{ticket}/YYYY-MM-DD_HH-MM-SS_description.md`
4. Include: completed phases, next steps, key learnings, file references
5. Update plan file with checkboxes for completed work

## If You Get Stuck

When something isn't working as expected:

- First, make sure you've read and understood all the relevant code
- Consider if the codebase has evolved since the plan was written
- Present the mismatch clearly and ask for guidance

Use sub-tasks sparingly - mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

If the plan has existing checkmarks:

- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and
maintain forward momentum.
