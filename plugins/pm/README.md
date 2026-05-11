# Catalyst PM Plugin

Product strategy plugin — 12 skills covering strategy docs, PRDs, priorities, and release planning.

> **Operational PM workflows** (cycle health, backlog grooming, cadence, status updates, Slack) live in [catalyst-pm-ops](../pm-ops/README.md).

> **Meeting workflow skills** (agenda, notes, cleanup, effectiveness retro) live in [catalyst-meeting-hygiene](../meeting-hygiene/README.md).

> **User research & discovery** (interviews, journey maps, metrics frameworks, prototyping) live in [catalyst-discovery](../discovery/README.md).

> **Complete inventory:** the full list of skills and agents lives in the website's [Skills Reference](https://catalyst.coalescelabs.ai/reference/skills/#catalyst-pm) and [Agents Reference](https://catalyst.coalescelabs.ai/reference/agents/#catalyst-pm-agents).

## Overview

catalyst-pm is the strategy and definition layer. It answers: "What are we building and why?" Use it when you need to create or evaluate strategic artifacts — north stars, PRDs, decision docs, strategy docs, launch plans, and post-launch results.

For the day-to-day operational question of "what is happening right now?", use [catalyst-pm-ops](../pm-ops/README.md).

## Skills

### PRDs & Document Review

- `/catalyst-pm:prd-draft` — Guided PRD creation with clarifying questions and optional multi-agent review
- `/catalyst-pm:prd-review-panel` — 7-agent parallel PRD review (eng, design, exec, legal, UXR, skeptic, customer)
- `/catalyst-pm:ralph-wiggum` — Single-agent devil's-advocate review of any product doc

### Strategy

- `/catalyst-pm:define-north-star` — North Star Metric framework (Frequency × Core Action × Breadth)
- `/catalyst-pm:write-prod-strategy` — 7-component strategy doc (Objective → Roadmap)
- `/catalyst-pm:expansion-strategy` — NRR-decomposition playbook for upsell/cross-sell/seat growth
- `/catalyst-pm:strategy-sprint` — 1-day / 1-week / 1-month progressive strategy sessions

### Prioritization & Decisions

- `/catalyst-pm:prioritize` — LNO (Leverage/Neutral/Overhead) task classification
- `/catalyst-pm:impact-sizing` — Quantified feature value with driver trees and confidence bands
- `/catalyst-pm:decision-doc` — Structured decision capture with alternatives and tradeoffs

### Launch & Results

- `/catalyst-pm:launch-checklist` — Critical-path launch planning with owners and dependencies
- `/catalyst-pm:feature-results` — Post-launch results doc comparing outcomes to PRD hypothesis

## Agents

- `linear-research` (Haiku) — Gathers Linear data via CLI; natural language interface returning structured JSON

## Prerequisites

**Required**: Linearis CLI

```bash
npm install -g linearis
```

**Optional**: GitHub CLI (for PR sync)

```bash
brew install gh
```

## Configuration

PM skills read from `.catalyst/config.json`:

```json
{
  "catalyst": {
    "projectKey": "acme",
    "linear": {
      "teamKey": "ACME"
    }
  }
}
```

Secrets go in `~/.config/catalyst/config-acme.json` (never commit):

```json
{
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_..."
    }
  }
}
```

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-pm
```

## License

MIT — see LICENSE in the main repository.
