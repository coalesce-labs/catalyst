---
name: implement-plan
description:
  "Implement approved technical plans from thoughts/shared/plans/. **ALWAYS use when** the user says
  'implement the plan', 'start implementing', 'build from the plan', or wants to execute a
  previously created implementation plan using TDD (Red-Green-Refactor). Supports team mode for
  parallel implementation."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Grep, Glob, Task, TodoWrite, Bash
version: 1.0.0
---

# Implement Plan

You are tasked with implementing an approved technical plan from `thoughts/shared/plans/`. These
plans contain phases with specific changes and success criteria.

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

## Session Tracking

```bash
SESSION_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "implement-plan" \
    --ticket "${TICKET_ID:-}" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
  "$SESSION_SCRIPT" phase "$CATALYST_SESSION_ID" "implementing" --phase 1
fi
```

## Initial Response

Auto-discovery has already run in Prerequisites above. Check its output and follow this priority:

1. **If user provided a plan path as parameter**: Use the provided path (user override). Skip to
   Step 3.

2. **If no parameter provided AND Prerequisites output shows a discovered plan (📋)**:
   - Show user the discovered plan path
   - Ask: "**Proceed with this plan?** [Y/n]"
   - If yes: use it and skip to Step 3
   - If no: proceed to option 3

3. **If no parameter AND Prerequisites shows no plan found (⚠️)**:
   - List available plans from `thoughts/shared/plans/`
   - Show most recent 5 plans with dates and ticket numbers
   - Ask user which plan to implement
   - Wait for user input with plan path

**STEP 3: Read and prepare**

Once you have a plan path:

- Read the plan completely (no limit/offset)
- Check for any existing checkmarks (- [x]) to see what's done
- Read the original ticket and all files mentioned in the plan
- **Extract ticket from plan frontmatter** (`source_ticket` field) and update Linear state
  to `stateMap.inProgress` from config using Linearis CLI (run `linearis issues usage` for syntax).
  If Linearis CLI is not available, skip silently and continue implementation.
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Start implementing if you understand what needs to be done

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:

- **Follow TDD: write tests before implementation code** in each phase
- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

### TDD Rhythm Per Phase

For each phase, follow **Red → Green → Refactor**:

1. **Red** — Write the tests specified in the plan's "Tests First" section. Run them to confirm they
   fail.
2. **Green** — Implement the minimum code from the plan's "Implementation" section to make tests
   pass.
3. **Refactor** — Clean up while keeping tests green. Apply any refactoring notes from the plan.

This order is non-negotiable. If a phase doesn't have a "Tests First" section, write tests for the
phase's expected behavior before implementing. The tests serve as executable acceptance criteria.

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

**Within each phase (TDD cycle):**

- Write tests first → run them → confirm they fail (Red)
- Write implementation → run tests → confirm they pass (Green)
- Refactor if needed → run tests → confirm they still pass (Refactor)

**After completing a phase:**

- Run the full success criteria checks (usually `make check test` covers everything)
- Fix any issues before proceeding
- Update your progress in both the plan and your todos
- Check off completed items in the plan file itself using Edit
- **Check context usage** - monitor token consumption

Don't let verification interrupt your flow - batch full suite runs at natural stopping points. But
always run the specific tests you wrote during each Red → Green cycle.

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

## Quality Gates (After All Phases Complete)

After all implementation phases pass, run quality gates before marking work as done. These gates
catch issues that per-phase testing might miss.

**Gate execution order:**

```
Quality Gates:
├── 1. /validate-type-safety  → tsc + reward hacking scan + tsconfig check + tests + lint
├── 2. /security-review       → scan for security vulnerabilities (built-in Claude Code skill)
├── 3. code-reviewer agent    → style/guideline adherence check
└── 4. pr-test-analyzer agent → test coverage verification
```

### Running the Gates

**Gate 1: Type Safety Validation**

Invoke `/validate-type-safety`. This runs the full 5-step gate (type check, reward hacking scan,
test inclusion, tests, lint). If it fails, fix issues and re-run before proceeding.

**Gate 2: Security Review**

Invoke the built-in `/security-review` skill. Review findings and fix any vulnerabilities before
proceeding.

**Gate 3: Code Review**

Spawn the `code-reviewer` agent:

```
Agent(subagent_type="pr-review-toolkit:code-reviewer",
      prompt="Review the uncommitted changes for adherence to project guidelines and style.")
```

Address any findings that violate project conventions.

**Gate 4: Test Coverage**

Spawn the `pr-test-analyzer` agent:

```
Agent(subagent_type="pr-review-toolkit:pr-test-analyzer",
      prompt="Analyze test coverage for the uncommitted changes. Identify critical gaps.")
```

If critical gaps exist, write the missing tests.

### End Session Tracking

After all quality gates pass (or are skipped), end the session:

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done
fi
```

### Autofix Behavior

For gates 1 and 2, attempt to fix issues automatically and re-run the gate. For gates 3 and 4,
address findings and verify. If a gate fails after 2 fix attempts, report the remaining issues to
the user and ask how to proceed.

### Skipping Quality Gates

If the plan or user specifies `--skip-quality-gates`, skip this section entirely. Report that
quality gates were skipped in the completion summary.

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

## Agent Team Mode (Optional)

When invoked with `--team` flag or when the plan spans 3+ independent domains:

### When to Use Team Mode

- Plan has phases that can be implemented in parallel
- Changes span distinct domains (frontend, backend, tests, infra)
- Each domain's changes don't overlap in files

### Team Structure

```
Lead (Opus) — Coordinates implementation
├── Teammate 1 (Sonnet) — Frontend changes
│   └── Can spawn subagents for research
├── Teammate 2 (Sonnet) — Backend changes
│   └── Can spawn subagents for research
└── Teammate 3 (Sonnet) — Test changes
    └── Can spawn subagents for research
```

### Process

1. **Analyze plan phases** — Identify which phases can be parallelized
2. **Assign file ownership** — Each teammate gets distinct files (no overlap)
3. **Create task list** — Use TaskCreate with dependencies between phases
4. **Launch team** — Spawn teammates with focused instructions
5. **Review gates** — Lead reviews teammate work via approvePlan/rejectPlan
6. **Integration** — Lead verifies all changes work together
7. **Commit** — Single atomic commit or per-phase commits

### Important Constraints

- **File ownership is strict** — no two teammates edit the same file
- **Sequential phases stay sequential** — only parallelize truly independent work
- **Lead reviews all code** — use plan approval gates before proceeding
- **Fallback gracefully** — if agent teams unavailable, execute sequentially

## Linear Integration

If a ticket is detected (from plan document's `source_ticket` frontmatter or from context):

- **At implementation start** (Step 3): Update ticket status to `stateMap.inProgress` from config
  using Linearis CLI (run `linearis issues usage` for syntax).
- If Linearis CLI not available, skip silently and continue implementation
