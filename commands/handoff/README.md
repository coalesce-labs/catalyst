# Thoughts Commands

Context handoff and collaboration tools using the thoughts system.

## Commands

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
