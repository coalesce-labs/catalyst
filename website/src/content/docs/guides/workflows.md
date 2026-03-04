---
title: Core Workflow
description: The research, plan, implement, validate workflow explained phase by phase.
---

Catalyst's core workflow is built on one principle: **frequent intentional compaction** — design the entire development cycle around context management, keeping context utilization in the 40-60% range.

## Phase Overview

```
Research → Plan → [Handoff] → Worktree → Implement → Validate → PR → Done
   ↓         ↓                               ↓          ↓         ↓
Clear    Clear                            Clear     Clear    Clear
Context  Context                          Context   Context  Context
```

Clear context between every phase for optimal performance.

## Phase 1: Research

**When**: Ticket requires codebase understanding before planning.

```
/research-codebase
```

Catalyst spawns parallel sub-agents (locator, analyzer, pattern-finder), documents what exists, and saves findings to `thoughts/shared/research/`.

**Output**: `thoughts/shared/research/YYYY-MM-DD-PROJ-XXXX-description.md`

Clear context after research is saved. Research loads many files; compacting keeps the next phase efficient.

## Phase 2: Planning

**When**: After research, or directly from a ticket if the codebase is well-understood.

```
/create-plan
```

References your research automatically and creates a detailed plan interactively with you. If revisions are needed: `/iterate-plan`.

**Output**: `thoughts/shared/plans/YYYY-MM-DD-PROJ-XXXX-description.md`

Clear context after the plan is approved.

## Phase 3: Handoff (Optional)

**When**: Pausing work, transferring to another session, switching machines, or context exceeding 60%.

```
/create-handoff
```

**Output**: `thoughts/shared/handoffs/PROJ-XXXX/YYYY-MM-DD_HH-MM-SS_description.md`

Handoffs capture current state, action items, critical file references, and learnings. Resume with `/resume-handoff`.

## Phase 4: Worktree Creation

**When**: Ready to implement after plan approval.

```
/create-worktree PROJ-123 feature-name
```

Creates a git worktree at `~/wt/{project}/{ticket-feature}` with `.claude/` copied, dependencies installed, and thoughts shared via symlink.

## Phase 5: Implementation

**When**: In a worktree with an approved plan.

```
/implement-plan
```

Reads the complete plan, implements each phase sequentially, runs automated verification, and updates checkboxes.

May clear context between phases if context fills above 60%.

## Phase 6: Validation

```
/validate-plan
```

Runs all automated tests, verifies success criteria, performs manual testing steps, and documents deviations.

## Phase 7: PR Creation

```bash
/commit         # Create commit
/create-pr      # Create PR with description
```

## Common Patterns

### Quick Feature

```bash
/research-codebase          # Research
# Clear context
/create-plan                # Plan
# Clear context
/create-worktree PROJ-123 feature
/implement-plan             # Implement
# Clear context
/commit && /create-pr       # Ship
```

### Multi-Day Feature

```bash
# Day 1
/research-codebase
/create-handoff
# Day 2
/resume-handoff PROJ-123
/create-plan
/create-handoff
# Day 3
/resume-handoff PROJ-123
/implement-plan             # Phases 1-2
/create-handoff
# Day 4
/resume-handoff PROJ-123
/implement-plan             # Phases 3-4
/validate-plan
/commit && /create-pr
```

### One-Shot

For straightforward tasks, chain everything:

```
/oneshot PROJ-123
```
