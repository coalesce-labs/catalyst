# Catalyst PM Ops Plugin

Linear backlog grooming — orphan, stale, and duplicate ticket detection.

> CTL-2237 removed the other 11 skills in this plugin (cycle/milestone analysis, ticket creation,
> PR↔issue sync, daily/weekly cadence, status updates, Slack drafting, MCP setup): they hard-coded
> team/assignee assumptions this solo-dev repo doesn't have, or duplicated more shallowly what
> `catalyst-dev` already does. `groom-backlog` is the one skill that survived triage.

## Skills (1)

- `/catalyst-pm-ops:groom-backlog` — Orphan / stale / duplicate detection

## Agents (1)

Registered globally via `plugin.json`:
- `backlog-analyzer` — sonnet

## Prerequisites

- `linearis` CLI (`npm install -g linearis`) for Linear integration
- `gh` CLI for GitHub PR queries
- `jq` for JSON processing

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-pm-ops
```

## License

MIT
