---
title: Skills Reference
description: Complete reference for all skills across Catalyst plugins.
---

Skills are reusable capabilities that teach Claude how to approach specific tasks. They are loaded as context when Claude encounters relevant work — providing domain-specific instructions, CLI references, and workflow guidance.

Skills activate automatically based on trigger conditions described in their frontmatter. You can also invoke user-invocable skills directly with `/{plugin}:{skill_name}`.

## catalyst-dev Skills

The dev plugin includes 21 skills — 18 workflow skills and 3 reference skills.

### Workflow Skills

| Skill | Description | Source |
|-------|-------------|--------|
| `research-codebase` | Parallel codebase research with specialized agents. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/research-codebase/SKILL.md) |
| `create-plan` | Interactive implementation planning. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-plan/SKILL.md) |
| `iterate-plan` | Revise existing plans with feedback. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/iterate-plan/SKILL.md) |
| `implement-plan` | Execute plans with phase-by-phase validation. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/implement-plan/SKILL.md) |
| `validate-plan` | Verify implementation against success criteria. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/validate-plan/SKILL.md) |
| `oneshot` | End-to-end: research, plan, implement in one invocation. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/oneshot/SKILL.md) |
| `commit` | Conventional commits with Linear integration. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/commit/SKILL.md) |
| `ci-commit` | CI-aware commits (non-interactive). | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/ci-commit/SKILL.md) |
| `create-pr` | Pull request creation with auto-description. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-pr/SKILL.md) |
| `describe-pr` | Generate/update PR descriptions. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/describe-pr/SKILL.md) |
| `ci-describe-pr` | CI-aware PR descriptions (non-interactive). | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/ci-describe-pr/SKILL.md) |
| `merge-pr` | Safe merge with verification and Linear integration. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/merge-pr/SKILL.md) |
| `create-handoff` | Save session context for later resumption. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-handoff/SKILL.md) |
| `resume-handoff` | Resume from a handoff document. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/resume-handoff/SKILL.md) |
| `linear` | Direct ticket operations (create, update, comment). | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/linear/SKILL.md) |
| `create-worktree` | Create git worktree for parallel development. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/create-worktree/SKILL.md) |
| `fix-typescript` | Fix TypeScript errors with strict rules. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/fix-typescript/SKILL.md) |
| `scan-reward-hacking` | Scan for reward hacking patterns. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/scan-reward-hacking/SKILL.md) |

### Reference Skills

| Skill | Description | Source |
|-------|-------------|--------|
| `agent-browser` | Fast browser automation CLI for AI agents. Use instead of Playwright MCP tools for web testing, screenshots, form filling, and UI verification. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/agent-browser/SKILL.md) |
| `code-first-draft` | Initial feature implementation guidance for rapid prototyping. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/code-first-draft/SKILL.md) |
| `linearis` | Reference for Linearis CLI commands to interact with Linear project management. Activates when working with ticket IDs like TEAM-123. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/linearis/SKILL.md) |

## catalyst-pm Skills

The PM plugin includes 40 skills covering product management workflows. All are user-invocable via `/catalyst-pm:{skill_name}`.

### Product Strategy

| Skill | Description | Source |
|-------|-------------|--------|
| `define-north-star` | Define north star metrics and strategic goals. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/define-north-star/SKILL.md) |
| `write-prod-strategy` | Write product strategy documents. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/write-prod-strategy/SKILL.md) |
| `strategy-sprint` | Run a strategy sprint session. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/strategy-sprint/SKILL.md) |
| `expansion-strategy` | Plan expansion and growth strategies. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/expansion-strategy/SKILL.md) |

### User Research

| Skill | Description | Source |
|-------|-------------|--------|
| `interview-guide` | Create structured interview guides. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/interview-guide/SKILL.md) |
| `interview-prep` | Prepare for user interviews. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/interview-prep/SKILL.md) |
| `user-interview` | Conduct and document user interviews. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/user-interview/SKILL.md) |
| `interview-feedback` | Process and organize interview feedback. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/interview-feedback/SKILL.md) |
| `user-research-synthesis` | Synthesize findings from multiple user research sessions. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/user-research-synthesis/SKILL.md) |
| `journey-map` | Create user journey maps. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/journey-map/SKILL.md) |

### Feature Development

| Skill | Description | Source |
|-------|-------------|--------|
| `prd-draft` | Create a modern, AI-era PRD for features and initiatives. Guides through clarifying questions, generates draft, and offers multi-agent review. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prd-draft/SKILL.md) |
| `prd-review-panel` | Multi-agent PRD review panel. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prd-review-panel/SKILL.md) |
| `feature-metrics` | Define and track feature-level metrics. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/feature-metrics/SKILL.md) |
| `feature-results` | Analyze feature launch results. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/feature-results/SKILL.md) |
| `launch-checklist` | Create comprehensive launch checklists. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/launch-checklist/SKILL.md) |

### Experimentation

| Skill | Description | Source |
|-------|-------------|--------|
| `experiment-decision` | Make data-driven experiment decisions. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/experiment-decision/SKILL.md) |
| `experiment-metrics` | Design experiment metrics and success criteria. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/experiment-metrics/SKILL.md) |
| `impact-sizing` | Size the impact of proposed changes. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/impact-sizing/SKILL.md) |

### Meetings & Communication

| Skill | Description | Source |
|-------|-------------|--------|
| `meeting-agenda` | Create structured meeting agendas. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-agenda/SKILL.md) |
| `meeting-notes` | Transform meeting transcripts into structured action items, decisions, and key insights. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-notes/SKILL.md) |
| `meeting-cleanup` | Clean up and organize meeting artifacts. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-cleanup/SKILL.md) |
| `meeting-feedback` | Process meeting feedback. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/meeting-feedback/SKILL.md) |
| `slack-message` | Draft Slack messages for various contexts. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/slack-message/SKILL.md) |
| `status-update` | Generate status updates for stakeholders. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/status-update/SKILL.md) |

### Planning & Prioritization

| Skill | Description | Source |
|-------|-------------|--------|
| `daily-plan` | Create daily work plans. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/daily-plan/SKILL.md) |
| `weekly-plan` | Create weekly work plans. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/weekly-plan/SKILL.md) |
| `weekly-review` | Conduct weekly review sessions. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/weekly-review/SKILL.md) |
| `prioritize` | Prioritize features and work items. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prioritize/SKILL.md) |

### Prototyping

| Skill | Description | Source |
|-------|-------------|--------|
| `prototype` | Build quick prototypes. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prototype/SKILL.md) |
| `generate-ai-prototype` | Generate AI-powered prototypes. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/generate-ai-prototype/SKILL.md) |
| `prototype-feedback` | Collect and organize prototype feedback. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/prototype-feedback/SKILL.md) |
| `napkin-sketch` | Quick napkin-sketch ideation. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/napkin-sketch/SKILL.md) |

### Analysis

| Skill | Description | Source |
|-------|-------------|--------|
| `competitor-analysis` | Conduct competitor analysis. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/competitor-analysis/SKILL.md) |
| `retention-analysis` | Analyze user retention patterns. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/retention-analysis/SKILL.md) |
| `activation-analysis` | Analyze user activation funnels. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/activation-analysis/SKILL.md) |
| `metrics-framework` | Set up leading vs lagging indicators for product decisions. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/metrics-framework/SKILL.md) |

### Other

| Skill | Description | Source |
|-------|-------------|--------|
| `decision-doc` | Create structured decision documents. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/decision-doc/SKILL.md) |
| `create-tickets` | Create Linear tickets from requirements. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/create-tickets/SKILL.md) |
| `connect-mcps` | Connect and configure MCP servers. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/connect-mcps/SKILL.md) |
| `ralph-wiggum` | Fun easter egg skill. | [Source](https://github.com/coalesce-labs/catalyst/blob/main/plugins/pm/skills/ralph-wiggum/SKILL.md) |
