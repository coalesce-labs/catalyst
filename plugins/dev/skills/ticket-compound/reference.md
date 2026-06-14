# Learnings store — schema reference

Entries live in the shared, humanlayer-synced knowledge base at
`thoughts/shared/learnings/<category>/<slug>.md` — alongside `research/` and `plans/`. Append-only
in spirit (entries are updated, rarely deleted), reviewable, and surfaced in the daily briefing.
Source docs/code are never modified by writing a learning.

The store is **grep-first**: filenames are slugs, and frontmatter fields are designed as `rg` targets.
There is no separate index file — discoverability is the category subdirs + frontmatter + (optionally)
`research-curate`'s INDEX.md.

## Two tracks

Pick the track from `problem_type`.

### Bug track
`problem_type` ∈ `build_error | test_failure | runtime_error | logic_error | integration_issue |
performance_issue | data_issue | security_issue`

Body sections (in order): **Problem** → **Symptoms** → **What Didn't Work** → **Solution** →
**Why This Works** → **Prevention** → **Related**.

### Knowledge track
`problem_type` ∈ `best_practice | architecture_pattern | convention | workflow_issue |
developer_experience | documentation_gap | tooling_decision`

Body sections (in order): **Context** → **Guidance** → **Why This Matters** → **When to Apply** →
**Examples** → **Related**.

## Frontmatter

```yaml
---
title: "Daemon declares a live --bg worker dead on its first commit"   # human title
date: 2026-06-06                       # ISO date created
ticket: CTL-619                        # origin ticket (or null)
category: orchestrator-issues          # = the subdir name
problem_type: logic_error              # drives the track + body template
component: execution-core              # grep target (enum below)
severity: high                         # critical | high | medium | low
root_cause: async_timing               # short slug; free-ish but prefer reuse
resolution_type: code_fix              # code_fix|config_change|test_fix|workflow_improvement|doc_update|tooling_addition
tags: [reclaim, revive, signal-ownership]   # grep targets
see_also: ["thoughts/shared/learnings/orchestrator-issues/revive-storm.md"]
last_updated: 2026-06-07               # added when an existing entry is updated
status: active                         # active | stale  (stale set by the refresh audit)
---
```

`component` enum (Catalyst): `orchestrator | phase-agent | broker | monitor | cli | ci | worktree |
linear | execution-core | estimation | website | plugins`.

`category` is the subdirectory; suggested set:
`build-errors | test-failures | runtime-errors | logic-errors | integration-issues |
performance-issues | architecture-patterns | conventions | workflow-issues |
developer-experience | tooling-decisions | documentation-gaps`.

## YAML safety
Double-quote any array item or scalar that starts with `` ` ``, `[`, `*`, `#`, or contains `": "` —
unquoted `#` is silently truncated as a comment and unquoted `: ` is parsed as a mapping. The
`validate-learnings.sh` helper rejects these.

## Three-tier hierarchy (where a learning belongs)
- **Standing rule that every agent must always follow** → propose an **ADR** change (`docs/adrs.md`,
  `@import`ed into CLAUDE.md). APPROVE-gated.
- **Shared domain vocabulary** (what "reclaim", "revive-budget", "orphan", "signal ownership" mean)
  → `thoughts/shared/CONCEPTS.md`. Autonomous.
- **A specific problem→solution pair** → a learnings entry here. Autonomous.

CLAUDE.md itself only ever gets a *pointer* to the store (the "discoverability check"), never the
learnings themselves.
