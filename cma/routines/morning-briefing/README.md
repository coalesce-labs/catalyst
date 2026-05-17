# Morning Briefing — CMA Routine

The cloud-scheduled wrapper around the
[`/catalyst-dev:morning-briefing`](../../../plugins/dev/skills/morning-briefing/SKILL.md) skill.
Fires every weekday at 7am, runs the skill end-to-end, and pushes the resulting briefing
markdown to the `routines/briefings` branch on `coalesce-labs/thoughts`.

This is Phase 5 of Initiative 2 (Morning Briefing Routine) in
[`thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md`](../../../thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md).
Tracked in [CTL-460](https://linear.app/coalesce-labs/issue/CTL-460).

## Files

| File | Purpose |
|---|---|
| `routine.yaml` | CMA Routine definition (schedule + repos + prompt + env) |
| `agent.yaml` | Per-routine agent (extends `cma/agents/base.yaml` via composition) |
| `__tests__/routine-config.test.sh` | Local schema + contract checks |
| `README.md` | This file |

The skill code itself lives at
[`plugins/dev/skills/morning-briefing/`](../../../plugins/dev/skills/morning-briefing/) and is
the source of truth for what the routine does on each run. This directory is purely the cloud
wiring.

## What it does

Every weekday at 7am (`0 7 * * 1-5`, America/New_York):

1. CMA starts a new session against the per-routine agent
2. The base agent runs its startup ritual (clones target repo + thoughts read-only,
   materializes `/workspace/project-context.md`)
3. Because `routine.yaml` sets `WRITABLE_THOUGHTS=true`, the base agent's §1a block also
   clones thoughts writable at `/workspace/thoughts-writable/` on the `routines/briefings`
   branch and symlinks `/workspace/thoughts/briefings` to the writable subtree
4. The routine prompt invokes
   [`plugins/dev/skills/morning-briefing/SKILL.md`](../../../plugins/dev/skills/morning-briefing/SKILL.md)
   end-to-end. The skill renders `thoughts/briefings/<date>.md` (which lands in the writable
   clone via the symlink) and fans the result out to Slack DM, Slack channel, Notion, and a
   local Loom script file
5. At session exit, the base agent's §1a write-back block commits and pushes
   `routines/briefings` to `coalesce-labs/thoughts`. Rebase + retry once on push failure;
   hard exit if the retry also fails

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
#    (the write-back ADR documents the scope upgrade).

# 1. Run the local contract tests
bash cma/routines/morning-briefing/__tests__/routine-config.test.sh

# 2. Register the per-routine agent
AGENT_ID=$(ant beta:agents create \
  -f cma/routines/morning-briefing/agent.yaml --json | jq -r '.id')

# 3. Register the routine (references the agent by ID)
ROUTINE_ID=$(ant beta:routines create \
  -f cma/routines/morning-briefing/routine.yaml --json | jq -r '.id')

# 4. Capture the IDs locally (NEVER commit)
jq --arg routine "$ROUTINE_ID" --arg agent "$AGENT_ID" \
  '.agents["catalyst-morning-briefing-agent"] = $agent
   | .routines["catalyst-morning-briefing"] = $routine' \
  ~/.config/catalyst/cma.json > /tmp/cma.json && mv /tmp/cma.json ~/.config/catalyst/cma.json
```

The exact `ant beta:routines` verb may evolve while CMA Routines remain in research preview;
the parent plan accepts "or equivalent CMA validation command." If `ant` rejects a field,
match the shape to whatever `ant beta:routines validate -f routine.yaml` reports.

## Change cadence

Edit `routine.yaml`'s `schedule.cron` to the new expression. Standard 5-field cron
(`min hour dom month dow`). The minimum interval CMA accepts is 1 hour (per the Claude Code
Routines docs).

```bash
# Edit, then re-register
${EDITOR:-vim} cma/routines/morning-briefing/routine.yaml
ant beta:routines update "$ROUTINE_ID" -f cma/routines/morning-briefing/routine.yaml
```

Common edits:

| Goal | `schedule.cron` |
|---|---|
| Weekdays 7am (default) | `0 7 * * 1-5` |
| Every weekday at 8am | `0 8 * * 1-5` |
| Weekdays 7am and 4pm | `0 7,16 * * 1-5` |
| Every Monday 9am | `0 9 * * 1` |

To pause without deleting: toggle the **Repeats** switch on the routine's
[claude.ai/code/routines](https://claude.ai/code/routines) detail page, or run
`/schedule update <routine-id>` in the Claude Code CLI and disable.

## Re-inline the agent's system body

`agent.yaml`'s `system` field is the routine-specific extension block + the entire
`cma/agents/base-system-prompt.md` body. After editing either, re-inline:

```bash
python3 - <<'PY'
import yaml

ROUTINE_EXTENSION = '''# Morning Briefing — Routine extension

You are the **Morning Briefing** routine, a Catalyst Pattern Routine that
runs weekdays at 7am via CMA. ...
'''  # keep this in sync with the existing block at the top of agent.yaml's system

with open('cma/agents/base-system-prompt.md') as f:
    base = f.read()

with open('cma/routines/morning-briefing/agent.yaml') as f:
    agent = yaml.safe_load(f)

agent['system'] = ROUTINE_EXTENSION + base

with open('cma/routines/morning-briefing/agent.yaml', 'w') as f:
    yaml.dump(agent, f, default_flow_style=False, sort_keys=False, width=120, allow_unicode=True)
PY
```

Then run the tests to confirm:

```bash
bash cma/routines/morning-briefing/__tests__/routine-config.test.sh
```

## Debug

| Symptom | Likely cause | Fix |
|---|---|---|
| Push to `routines/briefings` fails with 403 | PAT lacks `Contents: Read+Write` on `coalesce-labs/thoughts` | Provision a new PAT per [`cma/mcp/github.md`](../../mcp/github.md); rebind the vault |
| `git push --rebase` aborts on conflict | Two routines pushed the same minute (extremely unlikely) | Re-run; the rebase will succeed once the first push lands |
| Briefing markdown frontmatter fails validation | A gather source produced malformed JSON | Read the run transcript; the skill's `validate-frontmatter.sh` step prints the offending field |
| Fan-out destination silent | Credentials missing in the vault for that destination | Check `output_status` block in the briefing markdown — every destination reports `skipped`, `sent`, or `failed` |
| Routine doesn't fire at the scheduled time | Schedule paused, or routine deleted, or daily run cap hit | Open [claude.ai/code/routines](https://claude.ai/code/routines) and check the **Repeats** toggle + the day's run history |

## Related

- [`cma/decisions/2026-05-17-briefing-write-back.md`](../../decisions/2026-05-17-briefing-write-back.md) — the ADR for the routine-scoped write-back path
- [`cma/decisions/2026-05-07-thoughts-strategy.md`](../../decisions/2026-05-07-thoughts-strategy.md) — the parent ADR (read posture)
- [`cma/agents/base-system-prompt.md`](../../agents/base-system-prompt.md) — §1a is the writable-clone block this routine uses
- [`plugins/dev/skills/morning-briefing/SKILL.md`](../../../plugins/dev/skills/morning-briefing/SKILL.md) — the skill the routine wraps
- [`thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md`](../../../thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md) §Initiative 2 Phase 5 — the parent plan
- [CTL-460](https://linear.app/coalesce-labs/issue/CTL-460) — this ticket
- [CTL-461](https://linear.app/coalesce-labs/issue/CTL-461) — first real-world run + acceptance (blocked by CTL-460)
- [CTL-469](https://linear.app/coalesce-labs/issue/CTL-469) — research-curate routine that re-uses the same writable-clone path on `routines/curation`
- [CTL-295](https://linear.app/coalesce-labs/issue/CTL-295) — the long-term thoughts write-back / Memory Store model that may supersede this ADR
