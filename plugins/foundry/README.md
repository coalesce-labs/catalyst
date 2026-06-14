# catalyst-foundry

Setup, maintenance, and compounding upkeep of the Catalyst framework and the `thoughts/`
knowledge base. Where `catalyst-dev` runs the development loop, **foundry tends the framework
itself** — diagnosing the install, configuring the terminal launcher, and curating the research
corpus.

## Skills

| Skill | Description |
|-------|-------------|
| `/catalyst-foundry:setup-catalyst`  | Diagnose & repair a Catalyst install — tools, db, config, OTel, direnv, and the `thoughts/` repo. |
| `/catalyst-foundry:setup-warp`      | Configure Warp terminal as a Catalyst launcher (main / PM / worktree tabs), idempotent. |
| `/catalyst-foundry:research-curate` | Curate `thoughts/shared/research` and `thoughts/shared/plans` — staleness scoring, `INDEX.md`, `CONTRADICTIONS.md`. |

## Architecture

- **foundry vs catalyst-dev** — foundry maintains the framework + knowledge base; catalyst-dev is
  the research → ship development loop.
- **foundry vs catalyst-meta** — meta *authors new* skills from external/community patterns;
  foundry *maintains what you already have*.

## Backing scripts

The shell scripts that power these skills remain in `plugins/dev/scripts/` (e.g.
`research-curate/run.sh`, `check-setup.sh`, `catalyst-thoughts.sh`, `launch-worktree-tab.sh`).
The moved skills resolve them at runtime via the `CATALYST_DEV_SCRIPTS` cache shim — the same
pattern `catalyst-legacy` uses — so the scripts stay co-located with the live `catalyst-dev`
tooling they share.

## See also

- `catalyst-dev` — active development workflow (research, plan, implement, ship, orchestrate).
- `catalyst-legacy` — pre-phase-agent wave orchestration, preserved as a fallback.
