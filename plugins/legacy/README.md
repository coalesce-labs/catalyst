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
| `/catalyst-legacy:briefing-followup` | Follow-up on a morning briefing with triage and dispatch |
| `/catalyst-legacy:iterate-plan` | Iterate on an existing implementation plan |

## Architecture

These skills implement the **wave-based** orchestration model where a long-lived session walks a
sequential triage → research → plan → implement cycle per ticket. This model is superseded by
`catalyst-dev`'s **execution-core / phase-agent** pipeline (short-lived workers per phase,
coordinated by the execution-core daemon).

The wave model is preserved here for users who depend on it. For new work, prefer the
phase-agent pipeline via `catalyst-dev`.

## Backing Scripts

All shell scripts remain in `plugins/dev/scripts/` because many (`orchestrate-dispatch-next`,
`orchestrate-phase-advance`, `catalyst-session.sh`, etc.) are shared with the live phase-agent
pipeline. Skills resolve the scripts directory at runtime:

```bash
CATALYST_DEV_SCRIPTS="${CATALYST_DEV_SCRIPTS:-}"
if [[ -z "$CATALYST_DEV_SCRIPTS" ]]; then
  CATALYST_DEV_SCRIPTS="$(ls -d "$HOME"/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts 2>/dev/null | sort -V | tail -1)"
fi
[[ -n "$CATALYST_DEV_SCRIPTS" ]] || CATALYST_DEV_SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
```

Set `CATALYST_DEV_SCRIPTS` explicitly in your environment to override the auto-resolved path
(required for dev-symlink installs where no versioned cache directory exists).

## See Also

- `docs/orchestrator-overview.md` — current execution-core/phase-agent pipeline
- `catalyst-dev` — active development workflow plugin
