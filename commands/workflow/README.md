# Workflow Commands

Core research → plan → implement → validate workflow automation.

## Commands

### `/workflow-research`

Research codebase with parallel agents (codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator, thoughts-analyzer).

**Usage:**

```
/workflow-research
> What are you researching?
```

**Output:** Research document saved to `thoughts/shared/research/YYYY-MM-DD-description.md`

### `/workflow-plan`

Create implementation plan from research and Linear ticket.

**Usage:**

```
/workflow-plan
> Ticket: BRV-123 (or description)
> Research: thoughts/shared/research/YYYY-MM-DD-file.md
```

**Output:** Plan document saved to `thoughts/shared/plans/YYYY-MM-DD-TICKET-description.md`

### `/workflow-implement`

Execute plan with validation and automated testing.

**Usage:**

```
/workflow-implement thoughts/shared/plans/YYYY-MM-DD-TICKET-plan.md
```

**Process:**

- Reads full plan (no partial reads)
- Implements each phase sequentially
- Runs automated verification
- Updates checkboxes as work completes

### `/workflow-validate`

Verify implementation against plan success criteria.

**Usage:**

```
/workflow-validate
```

**Checks:**

- All phases completed
- Automated tests passing
- Manual validation steps documented
- Deviations from plan noted

## Typical Workflow

1. **/workflow-research** → Research existing code
2. **/workflow-plan** → Create implementation plan
3. **/workflow-implement** → Execute plan
4. **/workflow-validate** → Verify completion

All commands integrate with the thoughts system for persistent context.
