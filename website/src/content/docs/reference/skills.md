---
title: Skills
description: Complete reference for all skills across Catalyst plugins — user-invocable and model-invocable.
sidebar:
  order: 0
---

Skills are reusable capabilities delivered as markdown files that teach Claude Code how to approach specific tasks. Every piece of Catalyst functionality — from committing code to researching a codebase — is a skill.

## How Skills Work

There are two types of skills, distinguished by **who activates them**:

**User-invocable skills** are structured workflows you trigger with a slash command. They orchestrate multi-step processes — spawning agents, reading context, interacting with you, and saving artifacts.

**Model-invocable skills** are reference knowledge that Claude activates automatically when it detects relevant context. For example, when Claude sees a ticket ID like `ACME-123`, the `linearis` skill activates and teaches Claude how to use the Linearis CLI — without you having to explain it. These skills shape Claude's behavior the way a README or style guide would, but they load on demand instead of consuming context all the time.

Some skills are both — they can be triggered by you or activated by Claude when relevant.

A third category, **CI skills**, are non-interactive variants designed for automation pipelines. They follow the same conventions but skip all user prompts.

For more on how Claude Code skills work under the hood, see [Anthropic's skills documentation](https://docs.anthropic.com/en/docs/claude-code/skills).

## Invoking Skills

Type `/` followed by the skill name:

```
/research-codebase
/commit
/create-plan
```

Claude Code has excellent auto-complete — start typing `/res` and it will suggest `/research-codebase`. You don't need to include the plugin name; Claude Code resolves skills across all installed plugins automatically.

## How Skills Are Indexed

Claude Code discovers skills through a two-layer system:

1. **Metadata layer** — Every skill's `name` and `description` from its YAML frontmatter are always loaded into Claude's context (~100 words each). This is how Claude decides whether to consult a skill.
2. **Body layer** — The full SKILL.md instructions are loaded only when the skill is triggered. This keeps context costs low while making the full capability available on demand.

For **model-invocable skills**, the description is the primary triggering mechanism. Claude reads all skill descriptions and activates the skill whose description best matches the current task. This is why descriptions include specific trigger phrases — they tell Claude "activate me when you see these patterns."

For **user-invocable skills**, the `/` command is the trigger. The description helps Claude understand what the skill does when presenting auto-complete suggestions.

### Trigger Contexts — catalyst-dev

Each skill's description includes specific phrases and contexts that tell Claude when to activate it. Here's what triggers each dev skill:

| Skill | Trigger Phrases / Contexts |
|-------|---------------------------|
| `research-codebase` | "research", "investigate", "explore the codebase", "how does X work", "find out about", deep analysis of existing code |
| `create-plan` | "plan this", "create a plan", "design the approach", structured TDD implementation planning |
| `iterate-plan` | "update the plan", "change the plan", "requirements changed", "revise the approach" |
| `implement-plan` | "implement the plan", "start implementing", "build from the plan", executing a TDD plan |
| `validate-plan` | "validate the plan", "check if the plan was implemented correctly", "verify the implementation" |
| `oneshot` | "oneshot", "do everything end to end", "full workflow", ticket-to-merged-PR autonomously |
| `code-first-draft` | "build this feature", "implement this PRD", "code this up", "create the initial implementation" |
| `commit` | "commit this", "save my changes", "let's commit", saving session work |
| `create-pr` | "create a PR", "open a pull request", "ship this", "ready for review" |
| `describe-pr` | "describe the PR", "update PR description", after pushing new commits |
| `merge-pr` | "merge the PR", "merge this", "ship it", merging an approved PR |
| `create-handoff` | "create a handoff", "hand this off", "save progress for later", context usage >60% |
| `resume-handoff` | "resume handoff", "pick up where we left off", "continue from handoff" |
| `linear` | "create a ticket", "update the ticket", "move ticket to", "search Linear" |
| `create-worktree` | "create a worktree", "work in parallel", parallel feature development |
| `fix-typescript` | "fix type errors", "fix typescript", "type-check is failing", TypeScript compilation errors |
| `scan-reward-hacking` | After `/fix-typescript`, "scan for hacks", "check for type cheats", verifying TS fixes |
| `validate-type-safety` | "validate types", "check type safety", "run type validation", before PRs with TS changes |
| `review-comments` | "address comments", "fix review feedback", "handle PR comments", "respond to reviewers" |
| `agent-browser` | "open in browser", "check the site", "take a screenshot", "fill the form", visual browser interaction |
| `linearis` | Activates when ticket IDs like `ACME-123` appear, or when working with Linear CLI |
| `ci-commit` | Non-interactive — used by CI pipelines and automation only |
| `ci-describe-pr` | Non-interactive — used by CI pipelines and automation only |

**Legend**: User column: checkmark = invoke with `/skill-name` | Model column: checkmark = Claude activates automatically | `CI` = non-interactive, for automation pipelines

## catalyst-dev

The core development plugin. Skills covering research, planning, implementation, and shipping.

### Research & Planning

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `research-codebase` | &#10003; | — | Parallel codebase research with specialized agents. Produces a research document with file:line references. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/research-codebase/SKILL.md) |
| `create-plan` | &#10003; | — | Interactive TDD implementation planning. Works best after `/research-codebase`. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-plan/SKILL.md) |
| `iterate-plan` | &#10003; | — | Revise existing plans with research-backed modifications after feedback or changed requirements. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/iterate-plan/SKILL.md) |

### Implementation

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `implement-plan` | &#10003; | — | Execute plans phase by phase using TDD (Red-Green-Refactor). Supports team mode for parallel implementation. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/implement-plan/SKILL.md) |
| `validate-plan` | &#10003; | — | Verify implementation against plan success criteria and TDD adherence. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/validate-plan/SKILL.md) |
| `oneshot` | &#10003; | — | End-to-end autonomous workflow — research, plan, implement, validate, ship, and merge with context isolation between phases. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/oneshot/SKILL.md) |
| `code-first-draft` | &#10003; | — | Initial feature implementation from a PRD or feature description. Also generates standalone prototypes when no codebase exists. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/code-first-draft/SKILL.md) |
| `fix-typescript` | &#10003; | — | Fix TypeScript errors with strict anti-reward-hacking rules. Ensures runtime type safety over silencing errors. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/fix-typescript/SKILL.md) |
| `scan-reward-hacking` | &#10003; | — | Scan for forbidden patterns (`as any`, `@ts-ignore`, non-null assertions, async issues) in recent changes. Companion to `/fix-typescript`. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/scan-reward-hacking/SKILL.md) |
| `validate-type-safety` | &#10003; | — | 5-step type safety gate: type check, reward hacking scan, test inclusion, tests, lint. Detects project tooling automatically. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/validate-type-safety/SKILL.md) |

### Shipping

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `commit` | &#10003; | — | Auto-detect commit type, scope, and ticket reference. Conventional commit format for changelog generation. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/commit/SKILL.md) |
| `create-pr` | &#10003; | — | Full PR creation: commit, rebase, push, create PR, generate description, and update Linear ticket. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-pr/SKILL.md) |
| `describe-pr` | &#10003; | — | Generate or incrementally update PR descriptions. Preserves manual edits across updates. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/describe-pr/SKILL.md) |
| `merge-pr` | &#10003; | — | Safe squash merge with test execution, CI verification, approval checks, branch cleanup, and Linear update. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/merge-pr/SKILL.md) |
| `review-comments` | &#10003; | — | Pull PR review comments, analyze context, implement fixes, and push updates. Used by `/oneshot` Phase 5. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/review-comments/SKILL.md) |

### Session Management

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `create-handoff` | &#10003; | — | Save session context, learnings, and next steps for continuation in a fresh session. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-handoff/SKILL.md) |
| `resume-handoff` | &#10003; | — | Resume work from a handoff document. Verifies codebase state and creates an action plan. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/resume-handoff/SKILL.md) |
| `create-worktree` | &#10003; | — | Create git worktree for parallel development without switching branches. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-worktree/SKILL.md) |

### Integrations & References

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `linear` | &#10003; | — | Linear ticket operations: create from thoughts documents, update status, manage workflow. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/linear/SKILL.md) |
| `agent-browser` | — | &#10003; | Browser automation CLI reference — activates when visual browser interaction is needed (OAuth, dashboards, screenshots). | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/agent-browser/SKILL.md) |
| `linearis` | — | &#10003; | Linearis CLI reference — activates when ticket IDs like `ACME-123` appear or when Linear CLI syntax is needed. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/linearis/SKILL.md) |

### CI / Automation

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `ci-commit` | — | CI | Non-interactive variant of `/commit` for CI pipelines. Never prompts the user. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/ci-commit/SKILL.md) |
| `ci-describe-pr` | — | CI | Non-interactive variant of `/describe-pr` for CI pipelines. Auto-detects current PR. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/ci-describe-pr/SKILL.md) |

## catalyst-pm

Project management workflows. 40+ skills covering strategy, research, planning, and reporting.

### Reporting & Analysis

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `analyze-cycle` | &#10003; | — | Cycle health report with risk analysis and recommendations | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/analyze-cycle/SKILL.md) |
| `analyze-milestone` | &#10003; | — | Milestone progress toward target dates | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/analyze-milestone/SKILL.md) |
| `report-daily` | &#10003; | — | Quick daily standup summary | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/report-daily/SKILL.md) |
| `groom-backlog` | &#10003; | — | Backlog health analysis and cleanup | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/groom-backlog/SKILL.md) |
| `sync-prs` | &#10003; | — | GitHub-Linear PR correlation and gap identification | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/sync-prs/SKILL.md) |
| `context-daily` | &#10003; | — | Context engineering adoption dashboard | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/context-daily/SKILL.md) |

### Product Strategy

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `define-north-star` | &#10003; | — | Define north star metrics and strategic goals | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/define-north-star/SKILL.md) |
| `write-prod-strategy` | &#10003; | — | Write product strategy documents | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/write-prod-strategy/SKILL.md) |
| `strategy-sprint` | &#10003; | — | Run a strategy sprint session | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/strategy-sprint/SKILL.md) |
| `expansion-strategy` | &#10003; | — | Plan expansion and growth strategies | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/expansion-strategy/SKILL.md) |

### User Research

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `interview-guide` | &#10003; | — | Create structured interview guides | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/interview-guide/SKILL.md) |
| `interview-prep` | &#10003; | — | Prepare for user interviews | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/interview-prep/SKILL.md) |
| `user-interview` | &#10003; | — | Conduct and document user interviews | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/user-interview/SKILL.md) |
| `interview-feedback` | &#10003; | — | Process and organize interview feedback | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/interview-feedback/SKILL.md) |
| `user-research-synthesis` | &#10003; | — | Synthesize findings from multiple research sessions | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/user-research-synthesis/SKILL.md) |
| `journey-map` | &#10003; | — | Create user journey maps | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/journey-map/SKILL.md) |

### Feature Development

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `prd-draft` | &#10003; | — | Create a modern PRD with guided questions and multi-agent review | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prd-draft/SKILL.md) |
| `prd-review-panel` | &#10003; | — | Multi-agent PRD review panel | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prd-review-panel/SKILL.md) |
| `feature-metrics` | &#10003; | — | Define and track feature-level metrics | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/feature-metrics/SKILL.md) |
| `feature-results` | &#10003; | — | Analyze feature launch results | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/feature-results/SKILL.md) |
| `launch-checklist` | &#10003; | — | Create comprehensive launch checklists | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/launch-checklist/SKILL.md) |

### Experimentation

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `experiment-decision` | &#10003; | — | Make data-driven experiment decisions | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/experiment-decision/SKILL.md) |
| `experiment-metrics` | &#10003; | — | Design experiment metrics and success criteria | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/experiment-metrics/SKILL.md) |
| `impact-sizing` | &#10003; | — | Size the impact of proposed changes | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/impact-sizing/SKILL.md) |

### Meetings & Communication

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `meeting-agenda` | &#10003; | — | Create structured meeting agendas | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-agenda/SKILL.md) |
| `meeting-notes` | &#10003; | — | Transform meeting transcripts into structured action items | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-notes/SKILL.md) |
| `meeting-cleanup` | &#10003; | — | Clean up and organize meeting artifacts | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-cleanup/SKILL.md) |
| `meeting-feedback` | &#10003; | — | Process meeting feedback | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-feedback/SKILL.md) |
| `slack-message` | &#10003; | — | Draft Slack messages for various contexts | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/slack-message/SKILL.md) |
| `status-update` | &#10003; | — | Generate status updates for stakeholders | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/status-update/SKILL.md) |

### Planning & Prioritization

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `daily-plan` | &#10003; | — | Create daily work plans | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/daily-plan/SKILL.md) |
| `weekly-plan` | &#10003; | — | Create weekly work plans | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/weekly-plan/SKILL.md) |
| `weekly-review` | &#10003; | — | Conduct weekly review sessions | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/weekly-review/SKILL.md) |
| `prioritize` | &#10003; | — | Prioritize features and work items | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prioritize/SKILL.md) |

### Prototyping

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `prototype` | &#10003; | — | Build quick prototypes | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prototype/SKILL.md) |
| `generate-ai-prototype` | &#10003; | — | Generate AI-powered prototypes | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/generate-ai-prototype/SKILL.md) |
| `prototype-feedback` | &#10003; | — | Collect and organize prototype feedback | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prototype-feedback/SKILL.md) |
| `napkin-sketch` | &#10003; | — | Quick napkin-sketch ideation | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/napkin-sketch/SKILL.md) |

### Analysis

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `competitor-analysis` | &#10003; | — | Conduct competitor analysis | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/competitor-analysis/SKILL.md) |
| `retention-analysis` | &#10003; | — | Analyze user retention patterns | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/retention-analysis/SKILL.md) |
| `activation-analysis` | &#10003; | — | Analyze user activation funnels | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/activation-analysis/SKILL.md) |
| `metrics-framework` | &#10003; | — | Set up leading vs lagging indicators | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/metrics-framework/SKILL.md) |

### Other

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `decision-doc` | &#10003; | — | Create structured decision documents | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/decision-doc/SKILL.md) |
| `create-tickets` | &#10003; | — | Create Linear tickets from requirements | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/create-tickets/SKILL.md) |
| `connect-mcps` | &#10003; | — | Connect and configure MCP servers | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/connect-mcps/SKILL.md) |

## catalyst-analytics

PostHog integration for product analytics. **~40K token context cost** — enable only when needed.

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `analyze-user-behavior` | &#10003; | — | User behavior patterns and cohorts | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/analytics/skills/analyze-user-behavior/SKILL.md) |
| `segment-analysis` | &#10003; | — | User segment analysis for targeted insights | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/analytics/skills/segment-analysis/SKILL.md) |
| `product-metrics` | &#10003; | — | Key product metrics and conversion rates | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/analytics/skills/product-metrics/SKILL.md) |

## catalyst-debugging

Sentry integration for production error monitoring. **~20K token context cost** — enable only when needed.

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `debug-production-error` | &#10003; | — | Investigate production errors with Sentry data | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/debugging/skills/debug-production-error/SKILL.md) |
| `error-impact-analysis` | &#10003; | — | Analyze error impact across users and releases | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/debugging/skills/error-impact-analysis/SKILL.md) |
| `trace-analysis` | &#10003; | — | Trace error paths through the stack | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/debugging/skills/trace-analysis/SKILL.md) |

## catalyst-meta

Workflow discovery and management for advanced users and plugin developers.

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `discover-workflows` | &#10003; | — | Research external Claude Code repositories for workflow patterns | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/meta/skills/discover-workflows/SKILL.md) |
| `import-workflow` | &#10003; | — | Import and adapt workflows from other repositories | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/meta/skills/import-workflow/SKILL.md) |
| `create-workflow` | &#10003; | — | Create new agents or skills from templates | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/meta/skills/create-workflow/SKILL.md) |
| `validate-frontmatter` | &#10003; | — | Check frontmatter consistency across all workflows | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/meta/skills/validate-frontmatter/SKILL.md) |
| `audit-references` | &#10003; | — | Audit plugin health and find broken references | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/meta/skills/audit-references/SKILL.md) |
| `reorganize` | &#10003; | — | Analyze and reorganize directory structures | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/meta/skills/reorganize/SKILL.md) |
