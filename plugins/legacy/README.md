# catalyst-legacy

Pre-phase-agent (wave-based) orchestration workflow, preserved as a documented fallback.
Migrated from `catalyst-dev` v11.0.0 (CTL-726).

## Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-legacy:oneshot` | Single-ticket wave-orchestrated implementation (all phases in one long-lived session) |
| `/catalyst-legacy:orchestrate` | Multi-ticket wave-based orchestrator (legacy predecessor to execution-core) |
| `/catalyst-legacy:god` | God-mode orchestration — wide-scope multi-ticket dispatch |
| `/catalyst-legacy:setup-orchestrate` | Initial orchestrator setup (workspace + config initialization) |

> `briefing-followup` and `iterate-plan` were originally migrated here by CTL-726 but moved back
> to `catalyst-dev` — they are general workflow skills, not wave-orchestration. Use
> `/catalyst-dev:briefing-followup` and `/catalyst-dev:iterate-plan`.

## Architecture

These skills implement the **wave-based** orchestration model where a long-lived session walks a
sequential triage → research → plan → implement cycle per ticket. This model is superseded by
`catalyst-dev`'s **execution-core / phase-agent** pipeline (short-lived workers per phase,
coordinated by the execution-core daemon).

The wave model is preserved here for users who depend on it. For new work, prefer the
phase-agent pipeline via `catalyst-dev`.

## Requires catalyst-dev

catalyst-legacy is a thin skill plugin: the SKILL.md files live here, but all backing shell
scripts remain in `plugins/dev/scripts/` because many (`orchestrate-dispatch-next`,
`orchestrate-phase-advance`, `catalyst-session.sh`, etc.) are shared with the live phase-agent
pipeline. **catalyst-dev is therefore a hard dependency** — declared in `plugin.json`
(`"dependencies": ["catalyst-dev"]`), so the Claude Code install layer auto-installs/enables it and
blocks disabling it while catalyst-legacy is enabled.

Each skill resolves the shared scripts at runtime via the bundled helper, which fails fast with an
actionable message if catalyst-dev cannot be found (older Claude Code versions, source checkouts, or
a disabled dev plugin):

```bash
source "${CLAUDE_PLUGIN_ROOT:-plugins/legacy}/scripts/require-catalyst-dev.sh" \
    "${CLAUDE_PLUGIN_ROOT:-plugins/legacy}" || exit 1
# $CATALYST_DEV_SCRIPTS is now exported and points at catalyst-dev's scripts dir.
```

Set `CATALYST_DEV_SCRIPTS` explicitly in your environment to override the auto-resolved path
(e.g. for dev-symlink installs where no versioned cache directory exists).

## See Also

- `docs/orchestrator-overview.md` — current execution-core/phase-agent pipeline
- `catalyst-dev` — active development workflow plugin
