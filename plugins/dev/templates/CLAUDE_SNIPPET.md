## Catalyst Development Workflow

This project uses [Catalyst](https://github.com/coalesce-labs/catalyst) for AI-assisted development.

### Available Workflows

**Research → Plan → Implement → Validate:**
```
/catalyst-dev:research_codebase    # Research codebase with parallel agents
/catalyst-dev:create_plan          # Create implementation plan (interactive)
/catalyst-dev:iterate_plan         # Update plan based on feedback
/catalyst-dev:implement_plan       # Execute plan (use --team for complex multi-domain work)
/catalyst-dev:validate_plan        # Verify implementation matches plan
```

**Oneshot (end-to-end with context isolation):**
```
/catalyst-dev:oneshot TICKET-123   # Full pipeline: research → plan → implement
/catalyst-dev:oneshot "question"   # Freeform research → plan → implement
```

**Git & PR Lifecycle:**
```
/catalyst-dev:commit               # Conventional commit with auto-detected type/scope
/catalyst-dev:create_pr            # Create PR with Linear integration
/catalyst-dev:describe_pr          # Generate/update PR description
/catalyst-dev:merge_pr             # Merge with verification
```

**CI Commands (non-interactive, for automation):**
```
/catalyst-dev:ci_commit            # Autonomous commit (no prompts)
/catalyst-dev:ci_describe_pr       # Autonomous PR description
```

### Agent Teams

For complex implementations spanning multiple domains (frontend + backend + tests),
use the `--team` flag with implement_plan:

```
/catalyst-dev:implement_plan --team thoughts/shared/plans/my-plan.md
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
