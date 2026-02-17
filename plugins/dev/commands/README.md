# Commands

Development workflow commands provided by the catalyst-dev plugin.

## Workflow Commands

### `/iterate-plan`

Iterate on an existing implementation plan based on feedback or changed requirements.

**Usage:**

```
/iterate-plan
/iterate-plan thoughts/shared/plans/YYYY-MM-DD-PROJ-XXX-feature.md
```

**Process:**

- Auto-discovers recent plan from workflow context
- Reads current plan fully
- Gathers feedback on what needs to change
- Updates plan in place with tracked changes

### `/oneshot`

All-in-one workflow that chains research, planning, and implementation with context isolation.

**Usage:**

```
/oneshot PROJ-123
```

**Process:**

- Auto-discovers ticket context
- Runs research phase with specialized agents
- Creates implementation plan
- Implements plan phase by phase
- Each phase runs with proper context isolation

### `/ci-commit`

CI-aware commit command that runs pre-flight checks before committing.

**Usage:**

```
/ci-commit
```

**Process:**

- Runs linting and type checks before commit
- Creates conventional commit with Linear integration
- Validates CI requirements are met

### `/ci-describe-pr`

CI-aware PR description generator that includes CI status information.

**Usage:**

```
/ci-describe-pr
```

**Process:**

- Generates PR description from commits and changes
- Includes CI check status in description
- Links to relevant tickets

## Handoff Commands

### `/create-handoff`

Create handoff document for passing work to another developer or session.

**Usage:**

```
/create-handoff
> What work are you handing off?
```

**Creates:**

- Handoff document in `thoughts/shared/handoffs/YYYY-MM-DD-description.md`
- Includes: Current state, work completed, next steps, blockers, context

**Content:**

- Current ticket/task
- Work completed (with file:line references)
- Files modified
- Next steps (prioritized)
- Known blockers
- Important context

### `/resume-handoff`

Resume work from handoff document.

**Usage:**

```
/resume-handoff thoughts/shared/handoffs/YYYY-MM-DD-file.md
```

**Process:**

- Reads full handoff document
- Loads context (ticket, files, blockers)
- Presents next steps
- Asks how to proceed

**Benefits:**

- Quick context restoration
- No lost work
- Clear continuation path

## Use Cases

**Handoffs:**

- End of day → Resume next morning
- Developer → Developer
- Blocked work → When unblocked

**Collaboration:**

- Pair programming context
- Code review preparation
- Onboarding new team members

## Thoughts System

Commands use the HumanLayer thoughts system:

- `thoughts/personal/` - Your private notes
- `thoughts/shared/` - Team-shared documents
- `thoughts/global/` - Cross-project knowledge

Initialize with: `humanlayer thoughts init`
