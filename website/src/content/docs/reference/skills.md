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
| `orchestrate` | "orchestrate", "run multiple tickets in parallel", "coordinate workers", multi-ticket autonomous execution |
| `code-first-draft` | "build this feature", "implement this PRD", "code this up", "create the initial implementation" |
| `commit` | "commit this", "save my changes", "let's commit", saving session work |
| `create-pr` | "create a PR", "open a pull request", "ship this", "ready for review" |
| `describe-pr` | "describe the PR", "update PR description", after pushing new commits |
| `merge-pr` | "merge the PR", "merge this", "ship it", merging an approved PR |
| `create-handoff` | "create a handoff", "hand this off", "save progress for later", context usage >60% |
| `resume-handoff` | "resume handoff", "pick up where we left off", "continue from handoff" |
| `linear` | "create a ticket", "update the ticket", "move ticket to", "search Linear" |
| `create-worktree` | "create a worktree", "work in parallel", parallel feature development |
| `setup-orchestrate` | "start orchestration", "set up orchestrator", "bootstrap orchestrate", create orchestrator worktree and launch command |
| `fix-typescript` | "fix type errors", "fix typescript", "type-check is failing", TypeScript compilation errors |
| `scan-reward-hacking` | After `/fix-typescript`, "scan for hacks", "check for type cheats", verifying TS fixes |
| `validate-type-safety` | "validate types", "check type safety", "run type validation", before PRs with TS changes |
| `review-comments` | "address comments", "fix review feedback", "handle PR comments", "respond to reviewers" |
| `agent-browser` | "open in browser", "check the site", "take a screenshot", "fill the form", visual browser interaction |
| `linearis` | Activates when ticket IDs like `ACME-123` appear, or when working with Linear CLI |
| `catalyst-comms` | Activates when agents need to coordinate — "coordinate with", "tell the other agent", orchestrator-dispatched `CATALYST_COMMS_CHANNEL`, team-mode workers. See [Agent Communication](./catalyst-comms/). |
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
| `orchestrate` | &#10003; | — | Multi-ticket parallel coordinator — dispatches Level 2 workers across worktrees with wave-based execution and adversarial verification. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/orchestrate/SKILL.md) |
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
| `setup-orchestrate` | &#10003; | — | Bootstrap an orchestrator worktree and print a ready-to-run launch command for `/orchestrate`. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/setup-orchestrate/SKILL.md) |

### Integrations & References

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `linear` | &#10003; | — | Linear ticket operations: create from thoughts documents, update status, manage workflow. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/linear/SKILL.md) |
| `agent-browser` | — | &#10003; | Browser automation CLI reference — activates when visual browser interaction is needed (OAuth, dashboards, screenshots). | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/agent-browser/SKILL.md) |
| `linearis` | — | &#10003; | Linearis CLI reference — activates when ticket IDs like `ACME-123` appear or when Linear CLI syntax is needed. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/linearis/SKILL.md) |
| `catalyst-comms` | — | &#10003; | Protocol guide for the `catalyst-comms` file-based agent messaging CLI — activates when agents need to coordinate across worktrees, sub-agents, teams, or orchestrators. Full docs: [Agent Communication](./catalyst-comms/). | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/catalyst-comms/SKILL.md) |

### CI / Automation

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `ci-commit` | — | CI | Non-interactive variant of `/commit` for CI pipelines. Never prompts the user. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/ci-commit/SKILL.md) |
| `ci-describe-pr` | — | CI | Non-interactive variant of `/describe-pr` for CI pipelines. Auto-detects current PR. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/ci-describe-pr/SKILL.md) |

## catalyst-pm

Product strategy toolkit. 12 skills covering PRDs, strategy docs, priorities, and release planning.

> Skills for cycle health, backlog ops, cadence, and Slack live in **[catalyst-pm-ops](/plugins/#catalyst-pm-ops)**.
> Meeting skills live in **catalyst-meeting-hygiene**. User research, discovery, and metrics live in **catalyst-discovery**.

### PRDs & Review

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `prd-draft` | &#10003; | — | Create a modern PRD with guided questions and optional multi-agent review | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prd-draft/SKILL.md) |
| `prd-review-panel` | &#10003; | — | 7-agent parallel PRD review (eng, design, exec, legal, UXR, skeptic, customer) | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prd-review-panel/SKILL.md) |
| `ralph-wiggum` | &#10003; | — | Devil's-advocate review of any product doc — surfaces risks and hidden assumptions | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/ralph-wiggum/SKILL.md) |

### Strategy

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `define-north-star` | &#10003; | — | North Star Metric framework (Frequency × Core Action × Breadth) | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/define-north-star/SKILL.md) |
| `write-prod-strategy` | &#10003; | — | 7-component strategy doc (Objective → Roadmap) | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/write-prod-strategy/SKILL.md) |
| `expansion-strategy` | &#10003; | — | NRR-decomposition playbook for upsell/cross-sell/seat growth | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/expansion-strategy/SKILL.md) |
| `strategy-sprint` | &#10003; | — | 1-day / 1-week / 1-month progressive strategy sessions | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/strategy-sprint/SKILL.md) |

### Prioritization & Decisions

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `prioritize` | &#10003; | — | LNO (Leverage/Neutral/Overhead) task classification | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prioritize/SKILL.md) |
| `impact-sizing` | &#10003; | — | Quantified feature value with driver trees and confidence bands | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/impact-sizing/SKILL.md) |
| `decision-doc` | &#10003; | — | Structured decision capture with alternatives and tradeoffs | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/decision-doc/SKILL.md) |

### Launch & Results

| Skill | User | Model | Description | Source |
|-------|:----:|:-----:|-------------|--------|
| `launch-checklist` | &#10003; | — | Critical-path launch planning with owners and dependencies | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/launch-checklist/SKILL.md) |
| `feature-results` | &#10003; | — | Post-launch results doc comparing outcomes to PRD hypothesis | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/feature-results/SKILL.md) |

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
