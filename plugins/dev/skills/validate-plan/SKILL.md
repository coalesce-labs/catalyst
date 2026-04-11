---
name: validate-plan
description: "Validate that implementation plans were correctly executed. **ALWAYS use when** the user says 'validate the plan', 'check if the plan was implemented correctly', 'verify the implementation', or after completing /implement-plan to confirm all phases were properly executed and success criteria met."
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Task
version: 1.0.0
---

# Validate Plan

You are tasked with validating that an implementation plan was correctly executed, verifying all
success criteria and identifying any deviations or issues.

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

## Initial Setup

Auto-discovery has already run in Prerequisites above. Check its output and follow this priority:

1. **If user provided a plan path as parameter**: Use the provided path (user override).

2. **If no parameter AND Prerequisites discovered a plan (📋)**:
   - Show user the discovered plan path
   - Ask: "**Validate this plan?** [Y/n]"
   - If yes: use it
   - If no: proceed to option 3

3. **If no parameter AND no plan found (⚠️)**:
   - Search recent commits for plan references
   - List available plans from `thoughts/shared/plans/`
   - Ask user which plan to validate

4. **Gather implementation evidence**:

   ```bash
   # Check recent commits
   git log --oneline -n 20
   git diff HEAD~N..HEAD  # Where N covers implementation commits

   # Run comprehensive checks
   cd $(git rev-parse --show-toplevel) && make check test
   ```

## Validation Process

### Step 1: Context Discovery

If starting fresh or need more context:

1. **Read the implementation plan** completely
2. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria (automated and manual)
   - Identify key functionality to verify

3. **Spawn parallel research tasks** to discover implementation:

   ```
   Task 1 - Verify database changes:
   Research if migration [N] was added and schema changes match plan.
   Check: migration files, schema version, table structure
   Return: What was implemented vs what plan specified

   Task 2 - Verify code changes:
   Find all modified files related to [feature].
   Compare actual changes to plan specifications.
   Return: File-by-file comparison of planned vs actual

   Task 3 - Verify test coverage and TDD adherence:
   Check if tests were added/modified as specified.
   Check git history to verify tests were committed before or alongside implementation (TDD).
   Run test commands and capture results.
   Return: Test status, TDD adherence, and any missing coverage
   ```

### Step 2: Systematic Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for checkmarks in the plan (- [x])
   - Verify the actual code matches claimed completion

2. **Run automated verification**:
   - Execute each command from "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

3. **Assess manual criteria**:
   - List what needs manual testing
   - Provide clear steps for user verification

4. **Think deeply about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?

### Step 3: Generate Validation Report

**Before generating report, check context usage**:

Create comprehensive validation summary:

```
# Validation Report: {Feature Name}

**Plan**: `thoughts/shared/plans/YYYY-MM-DD-PROJ-XXXX-feature.md`
**Validated**: {date}
**Validation Status**: {PASS/FAIL/PARTIAL}

## 📊 Context Status
Current usage: {X}% ({Y}K/{Z}K tokens)

{If >60%}:
⚠️ **Context Alert**: Validation consumed {X}% of context.

**Recommendation**: After reviewing this report, clear context before PR creation.

**Why?** PR description generation benefits from fresh context to:
- Synthesize changes clearly
- Write concise summaries
- Avoid accumulated error context

**Next steps**:
1. Review this validation report
2. Address any failures
3. Close this session (clear context)
4. Start fresh for: `/catalyst-dev:commit` and `/catalyst-dev:describe-pr`

{If <60%}:
✅ Context healthy. Ready for PR creation.

---

{Continue with rest of validation report...}
```

```markdown
## Validation Report: [Plan Name]

### Implementation Status

✓ Phase 1: [Name] - Fully implemented ✓ Phase 2: [Name] - Fully implemented ⚠️ Phase 3: [Name] -
Partially implemented (see issues)

### Automated Verification Results

✓ Build passes: `make build` ✓ Tests pass: `make test` ✗ Linting issues: `make lint` (3 warnings)

### Code Review Findings

#### Matches Plan:

- Database migration correctly adds [table]
- API endpoints implement specified methods
- Error handling follows plan

#### Deviations from Plan:

- Used different variable names in [file:line]
- Added extra validation in [file:line] (improvement)

#### Potential Issues:

- Missing index on foreign key could impact performance
- No rollback handling in migration

### Manual Testing Required:

1. UI functionality:
   - [ ] Verify [feature] appears correctly
   - [ ] Test error states with invalid input

2. Integration:
   - [ ] Confirm works with existing [component]
   - [ ] Check performance with large datasets

### Recommendations:

- Address linting warnings before merge
- Consider adding integration test for [scenario]
- Document new API endpoints
```

## Working with Existing Context

If you were part of the implementation:

- Review the conversation history
- Check your todo list for what was completed
- Focus validation on work done in this session
- Be honest about any shortcuts or incomplete items

## Important Guidelines

1. **Be thorough but practical** - Focus on what matters
2. **Run all automated checks** - Don't skip verification commands
3. **Document everything** - Both successes and issues
4. **Think critically** - Question if the implementation truly solves the problem
5. **Consider maintenance** - Will this be maintainable long-term?

## Validation Checklist

Always verify:

- [ ] All phases marked complete are actually done
- [ ] **TDD was followed** — tests exist for each phase and were written before/alongside implementation
- [ ] Automated tests pass
- [ ] Code follows existing patterns
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] Documentation updated if needed
- [ ] Manual test steps are clear

## Relationship to Other Commands

Recommended workflow:

1. `/implement-plan` - Execute the implementation
2. `/commit` - Create atomic commits for changes
3. `/validate-plan` - Verify implementation correctness
4. `/describe-pr` - Generate PR description

The validation works best after commits are made, as it can analyze the git history to understand
what was implemented.

Remember: Good validation catches issues before they reach production. Be constructive but thorough
in identifying gaps or improvements.
