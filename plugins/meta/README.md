# Catalyst Meta Plugin

Workflow discovery, creation, and management for Catalyst plugin developers and advanced users.

The meta plugin is for people who **build new skills and agents** or need to audit, reorganize, and validate an existing Catalyst installation. Most users don't need it — install it only when you're extending Catalyst itself.

## Skills (6)

- `/catalyst-meta:discover-workflows` — Research external Claude Code repositories to find workflow patterns worth adopting
- `/catalyst-meta:import-workflow` — Import and adapt workflows from other repositories into your plugin
- `/catalyst-meta:create-workflow` — Create new agents or skills from templates, following Catalyst conventions
- `/catalyst-meta:validate-frontmatter` — Check frontmatter consistency across all skills and agents (name, description, allowed-tools, disable-model-invocation)
- `/catalyst-meta:audit-references` — Audit plugin health: find broken skill references, dead agent invocations, missing scripts
- `/catalyst-meta:reorganize` — Analyze and reorganize directory structures (move skills/agents, update references)

## Scripts

Under `scripts/`:

- `audit-references.sh` — Shell-level reference auditor (used by `/catalyst-meta:audit-references`)
- `check-prerequisites.sh` — Verify required tools are installed
- `move-and-rereference.sh` — Move a file and update all references to it
- `test-move-and-rereference.sh` — Test harness for the mover

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-meta
```

The meta plugin has no agents and minimal context cost — it's safe to keep enabled all the time.

## When to use each skill

| You want to | Run |
|-------------|-----|
| Browse what other Claude Code users have built | `/catalyst-meta:discover-workflows` |
| Port a skill you saw elsewhere into Catalyst form | `/catalyst-meta:import-workflow` |
| Bootstrap a new skill or agent from Catalyst's template | `/catalyst-meta:create-workflow` |
| Verify frontmatter on all your custom skills | `/catalyst-meta:validate-frontmatter` |
| Check for broken `/plugin:skill` references after a rename | `/catalyst-meta:audit-references` |
| Move a skill to a different plugin and update all callers | `/catalyst-meta:reorganize` |

## Philosophy

The meta plugin treats Catalyst as its own first-class target. Every skill in it should be usable **on Catalyst itself** — if it can't audit its own plugin, it's not ready for anyone else's.

## Documentation

- [Plugin Editing Rules](../../.claude/rules/plugin-editing.md)
- [Architecture](../../docs/architecture.md)
- [Documentation Site](https://catalyst.coalescelabs.ai)

## License

MIT
