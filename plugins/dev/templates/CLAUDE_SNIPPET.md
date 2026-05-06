## Catalyst Development Workflow

This project uses [Catalyst](https://github.com/coalesce-labs/catalyst) for AI-assisted development.

### Available Workflows

**Research → Plan → Implement → Validate:**
```
/research-codebase    # Research codebase with parallel agents
/create-plan          # Create implementation plan (interactive)
/iterate-plan         # Update plan based on feedback
/implement-plan       # Execute plan (use --team for complex multi-domain work)
/validate-plan        # Verify implementation matches plan
```

**Oneshot (end-to-end with context isolation):**
```
/oneshot TICKET-123   # Full pipeline: research → plan → implement
/oneshot "question"   # Freeform research → plan → implement
```

**Git & PR Lifecycle:**
```
/commit               # Conventional commit with auto-detected type/scope
/create-pr            # Create PR with Linear integration
/describe-pr          # Generate/update PR description
/merge-pr             # Merge with verification
/wait-for-github      # Event-driven CI/PR wait — NEVER poll gh pr view/checks directly
```

**CI Commands (non-interactive, for automation):**
```
/ci-commit            # Autonomous commit (no prompts)
/ci-describe-pr       # Autonomous PR description
```

**Orchestration:**
```
/catalyst-filter      # Register semantic event interests (orchestrators only)
```

### Agent Teams

For complex implementations spanning multiple domains (frontend + backend + tests),
use the `--team` flag with implement-plan:

```
/implement-plan --team thoughts/shared/plans/my-plan.md
```

**When to use `--team`:**
- Plan spans 3+ independent domains with non-overlapping file changes
- Total scope is 10+ files across 3+ directories
- Phases can be executed in parallel

**When NOT to use `--team`:**
- Sequential phases with tight dependencies
- Changes concentrated in same directory
- Small scope (fewer than 10 files)

### Model Selection

Catalyst uses explicit model tiers for optimal cost/quality:
- **Opus**: Planning, complex analysis, implementation orchestration
- **Sonnet**: Code analysis, PR workflows, structured research
- **Haiku**: File finding, data collection, fast lookups

### Thoughts System

This project uses the thoughts system for persistent context:
- Research → `thoughts/shared/research/`
- Plans → `thoughts/shared/plans/`
- Handoffs → `thoughts/shared/handoffs/`
- PR descriptions → `thoughts/shared/prs/`

**IMPORTANT**: NEVER write to `thoughts/searchable/` — it's a read-only search index.

