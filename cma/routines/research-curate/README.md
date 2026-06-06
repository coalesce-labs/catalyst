# Research-Curate — CMA Routine

The cloud-scheduled wrapper around the
[`/catalyst-foundry:research-curate`](../../../plugins/foundry/skills/research-curate/SKILL.md) skill. Fires
every Sunday at 9pm America/New_York, regenerates `INDEX.md` and updates `CONTRADICTIONS.md` for
both `thoughts/shared/research/` and `thoughts/shared/plans/`, and pushes the result to the
`routines/curation` branch on `coalesce-labs/thoughts`.

This is Phase 3 of Initiative 4 (Weekly thoughts curation Routine) in
[`thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md`](../../../thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md).
Tracked in [CTL-469](https://linear.app/coalesce-labs/issue/CTL-469).

## Files

| File                               | Purpose                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `routine.yaml`                     | CMA Routine definition (schedule + repos + prompt + env)           |
| `agent.yaml`                       | Per-routine agent (extends `cma/agents/base.yaml` via composition) |
| `__tests__/routine-config.test.sh` | Local schema + contract checks                                     |
| `README.md`                        | This file                                                          |

The skill code itself lives at
[`plugins/foundry/skills/research-curate/`](../../../plugins/foundry/skills/research-curate/) and is the
source of truth for what the routine does on each run. This directory is purely the cloud wiring.

## What it does

Every Sunday at 9pm (`0 21 * * 0`, America/New_York):

1. CMA starts a new session against the per-routine agent
2. The base agent runs its startup ritual (clones target repo + thoughts read-only, materializes
   `/workspace/project-context.md`)
3. Because `routine.yaml` sets `WRITABLE_THOUGHTS=true`, the base agent's §1a block also clones
   thoughts writable at `/workspace/thoughts-writable/` on the `routines/curation` branch (creating
   the branch from `main` if it does not yet exist)
4. The routine prompt invokes
   [`plugins/dev/scripts/research-curate/run.sh`](../../../plugins/dev/scripts/research-curate/run.sh)
   twice — once against `/workspace/thoughts-writable/repos/<dir>/shared/research`, once against
   `/workspace/thoughts-writable/repos/<dir>/shared/plans`. The skill regenerates each directory's
   `INDEX.md` (overwrites) and appends to `CONTRADICTIONS.md` (append-only). Source markdown is
   never modified
5. At session exit, the base agent's §1a write-back block commits and pushes `routines/curation` to
   `coalesce-labs/thoughts`. Rebase + retry once on push failure; hard exit if the retry also fails

### Why absolute paths instead of the §1a symlink

The §1a block in `cma/agents/base-system-prompt.md` creates a `/workspace/thoughts/briefings`
symlink that is specific to the morning-briefing routine. Research-curate writes into
`shared/research/` and `shared/plans/`, both of which sit under `shared/` — a subtree that the
read-only clone serves. Symlinking into a read-only mount does not work, and generalising §1a to
support multiple writable subpaths would require re-inlining morning-briefing's `agent.yaml` and
`base.yaml`.

The simpler approach (chosen here): the routine prompt calls `run.sh` with absolute paths into the
writable clone (`/workspace/thoughts-writable/repos/<dir>/...`). The §1a write-back block picks up
the changes from anywhere under `/workspace/thoughts-writable/` via `git add -A`, so no symlink is
needed for this routine. The §1a `briefings` symlink is a harmless no-op when
`WRITABLE_THOUGHTS=true` and the routine writes outside of `briefings/`.

The write-back contract is documented in
[`cma/decisions/2026-05-17-briefing-write-back.md`](../../decisions/2026-05-17-briefing-write-back.md).

## Register

Routine and agent registration happen separately. Register the agent first, then the routine.

```bash
# 0. (Pre-req) Environment + vault are shared across all routines. Register
#    them once per cma/README.md if you haven't:
#      ant beta:environments create -f cma/environment.yaml
#      ant beta:vaults create -f ~/.config/catalyst/cma-vault.yaml
#    Make sure the vault's coalesce-labs/thoughts PAT has Contents: Read+Write
#    (the write-back ADR documents the scope upgrade — same vault used by
#    morning-briefing).

# 1. Run the local contract tests
bash cma/routines/research-curate/__tests__/routine-config.test.sh

# 2. Register the per-routine agent
AGENT_ID=$(ant beta:agents create \
  -f cma/routines/research-curate/agent.yaml --json | jq -r '.id')

# 3. Register the routine (references the agent by ID)
ROUTINE_ID=$(ant beta:routines create \
  -f cma/routines/research-curate/routine.yaml --json | jq -r '.id')

# 4. Capture the IDs locally (NEVER commit)
jq --arg routine "$ROUTINE_ID" --arg agent "$AGENT_ID" \
  '.agents["catalyst-research-curate-agent"] = $agent
   | .routines["catalyst-research-curate"] = $routine' \
  ~/.config/catalyst/cma.json > /tmp/cma.json && mv /tmp/cma.json ~/.config/catalyst/cma.json
```

The exact `ant beta:routines` verb may evolve while CMA Routines remain in research preview; the
parent plan accepts "or equivalent CMA validation command." If `ant` rejects a field, match the
shape to whatever `ant beta:routines validate -f routine.yaml` reports.

## Change cadence

Edit `routine.yaml`'s `schedule.cron` to the new expression. Standard 5-field cron
(`min hour dom month dow`). The minimum interval CMA accepts is 1 hour (per the Claude Code Routines
docs); weekly is well above that.

```bash
# Edit, then re-register
${EDITOR:-vim} cma/routines/research-curate/routine.yaml
ant beta:routines update "$ROUTINE_ID" -f cma/routines/research-curate/routine.yaml
```

Common edits:

| Goal                           | `schedule.cron` |
| ------------------------------ | --------------- |
| Sundays 9pm (default)          | `0 21 * * 0`    |
| Saturdays 6pm                  | `0 18 * * 6`    |
| First of the month, 9pm        | `0 21 1 * *`    |
| Every Sunday and Wednesday 9pm | `0 21 * * 0,3`  |

To pause without deleting: toggle the **Repeats** switch on the routine's
[claude.ai/code/routines](https://claude.ai/code/routines) detail page, or run
`/schedule update <routine-id>` in the Claude Code CLI and disable.

## Re-inline the agent's system body

`agent.yaml`'s `system` field is the routine-specific extension block + the entire
`cma/agents/base-system-prompt.md` body. After editing either, re-inline:

```bash
python3 - <<'PY'
import yaml

ROUTINE_EXTENSION = '''# Research-Curate — Routine extension

You are the **Research-Curate** routine, a Catalyst Pattern Routine that
runs weekly on Sunday 9pm via CMA. ...
'''  # keep this in sync with the existing block at the top of agent.yaml's system

with open('cma/agents/base-system-prompt.md') as f:
    base = f.read()

with open('cma/routines/research-curate/agent.yaml') as f:
    agent = yaml.safe_load(f)

agent['system'] = ROUTINE_EXTENSION + base

with open('cma/routines/research-curate/agent.yaml', 'w') as f:
    yaml.dump(agent, f, default_flow_style=False, sort_keys=False, width=120, allow_unicode=True)
PY
```

Then run the tests to confirm:

```bash
bash cma/routines/research-curate/__tests__/routine-config.test.sh
```

## Debug

| Symptom                                    | Likely cause                                                                                                                    | Fix                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `routines/curation` fails with 403 | PAT lacks `Contents: Read+Write` on `coalesce-labs/thoughts`                                                                    | Provision a new PAT per [`cma/mcp/github.md`](../../mcp/github.md); rebind the vault                                                  |
| `git push --rebase` aborts on conflict     | Two routines pushed the same minute (extremely unlikely — weekly cadence on a dedicated branch)                                 | Re-run; the rebase will succeed once the first push lands                                                                             |
| Source markdown changed unexpectedly       | Bug in `score.sh` or `inventory.sh` — they should never write into the target dir except for `INDEX.md` and `CONTRADICTIONS.md` | Check `git diff` for paths under `shared/research/` / `shared/plans/` other than `INDEX.md` and `CONTRADICTIONS.md`; file a skill bug |
| `CONTRADICTIONS.md` grows without bound    | Expected — entries are append-only by design. CTL-471 (follow-on) will add a pruning policy                                     | No fix needed in this routine                                                                                                         |
| LLM contradiction step fails or times out  | `claude -p` rate-limited or unavailable                                                                                         | Pass `--skip-contradictions` to `run.sh` to drop back to inventory-only and surface in the run output                                 |
| Routine doesn't fire at the scheduled time | Schedule paused, or routine deleted, or daily run cap hit                                                                       | Open [claude.ai/code/routines](https://claude.ai/code/routines) and check the **Repeats** toggle + the day's run history              |

## Related

- [`cma/decisions/2026-05-17-briefing-write-back.md`](../../decisions/2026-05-17-briefing-write-back.md)
  — the ADR for the routine-scoped write-back path (covers both routines)
- [`cma/decisions/2026-05-07-thoughts-strategy.md`](../../decisions/2026-05-07-thoughts-strategy.md)
  — the parent ADR (read posture)
- [`cma/agents/base-system-prompt.md`](../../agents/base-system-prompt.md) — §1a is the
  writable-clone block this routine uses
- [`cma/routines/morning-briefing/`](../morning-briefing/) — the sibling routine on
  `routines/briefings`
- [`plugins/foundry/skills/research-curate/SKILL.md`](../../../plugins/foundry/skills/research-curate/SKILL.md)
  — the skill the routine wraps
- [`thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md`](../../../thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md)
  §Initiative 4 Phase 3 — the parent plan
- [`thoughts/shared/plans/2026-05-17-CTL-469-research-curate-routine-wiring.md`](../../../thoughts/shared/plans/2026-05-17-CTL-469-research-curate-routine-wiring.md)
  — the implementation plan for this routine
- [CTL-469](https://linear.app/coalesce-labs/issue/CTL-469) — this ticket
- [CTL-470](https://linear.app/coalesce-labs/issue/CTL-470) — follow-on (blocked by this)
- [CTL-446](https://linear.app/coalesce-labs/issue/CTL-446) — parent ticket
- [CTL-295](https://linear.app/coalesce-labs/issue/CTL-295) — the long-term thoughts write-back /
  Memory Store model that may supersede the write-back ADR
