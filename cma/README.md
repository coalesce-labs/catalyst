# `cma/` — Claude Managed Agents scaffolding

This directory holds configuration and documentation for running Catalyst
Phase 1 Routines on **Claude Managed Agents (CMA)** — Anthropic's hosted
agent runtime. It is deployment scaffolding for an external runtime, not
plugin source. Plugin code lives under `plugins/`.

The base scaffolding committed here implements the architecture decisions
from [CTL-286](https://linear.app/catalyst/issue/CTL-286). Phase 1 Routines
([CTL-287](https://linear.app/catalyst/issue/CTL-287)..[CTL-291](https://linear.app/catalyst/issue/CTL-291))
each add their own per-routine agent definition that inherits the base
defined here.

## Layout

```
cma/
  README.md                          ← this file
  environment.yaml                   ← shared CMA environment for all routines
  agents/
    base.yaml                        ← base agent definition (with inlined system prompt)
    base-system-prompt.md            ← system prompt body (source of truth for prose)
  vaults/
    example.yaml                     ← per-developer vault template (no real secrets)
  mcp/
    linear.md                        ← Linear MCP wiring + token provisioning
    github.md                        ← GitHub MCP wiring + PAT scope (also covers thoughts clone)
    slack.md                         ← Slack MCP + REST fallback
    notion.md                        ← Notion MCP + REST fallback
  decisions/
    2026-05-07-thoughts-strategy.md  ← ADR for thoughts portability (Option C: git clone)
  smoke-test/
    README.md                        ← end-to-end manual verification recipe
```

Source research lives outside this directory at
`thoughts/shared/research/2026-05-07-CTL-286-cma-cloud-environment.md`.

## Prerequisites

- **`ant` CLI** installed and authenticated (`ant auth login`). The `ant`
  CLI is Anthropic's first-party CLI for the Claude API, including CMA. See
  [platform.claude.com/docs/en/managed-agents/overview](https://platform.claude.com/docs/en/managed-agents/overview).
- **CMA beta enabled** on your Anthropic org. Beta header:
  `managed-agents-2026-04-01`.
- **Credentials provisioned** for the connectors you'll use:
  - Linear — see `cma/mcp/linear.md`
  - GitHub — see `cma/mcp/github.md` (PAT scope covers both GitHub MCP and
    the session-startup thoughts clone, per the
    [thoughts-strategy ADR](decisions/2026-05-07-thoughts-strategy.md))
  - Slack (optional, Phase 1 has a REST fallback) — see `cma/mcp/slack.md`
  - Notion (optional, Phase 1 has a REST fallback) — see `cma/mcp/notion.md`

## Registration recipe

From the catalyst repo root, run **once**:

```bash
# 1. Register the shared environment
ENV_ID=$(ant beta:environments create -f cma/environment.yaml --json | jq -r '.id')

# 2. (Optional but recommended) Run the system prompt drift check
diff <(yq '.system' cma/agents/base.yaml) cma/agents/base-system-prompt.md
# Empty output (or whitespace-only) is good. If drift shows, re-inline:
#   yq -i '.system = load_str("cma/agents/base-system-prompt.md")' cma/agents/base.yaml

# 3. Register the base agent
AGENT_ID=$(ant beta:agents create -f cma/agents/base.yaml --json | jq -r '.id')

# 4. Set up your private vault
mkdir -p ~/.config/catalyst
cp cma/vaults/example.yaml ~/.config/catalyst/cma-vault.yaml
${EDITOR:-vim} ~/.config/catalyst/cma-vault.yaml   # fill in real secrets

# 5. Register the vault
VAULT_ID=$(ant beta:vaults create -f ~/.config/catalyst/cma-vault.yaml --json | jq -r '.id')

# 6. Capture the IDs locally (NEVER commit)
cat > ~/.config/catalyst/cma.json <<JSON
{
  "environments": { "catalyst-routines-base": "$ENV_ID" },
  "agents":       { "catalyst-routine-base":  "$AGENT_ID" },
  "vaults":       { "catalyst-developer":     "$VAULT_ID" }
}
JSON
```

After registration, run the smoke test (`cma/smoke-test/README.md`) to verify
end-to-end.

## Updating the base agent

CMA agent definitions are versioned with optimistic concurrency on a
`version` integer. Editing the agent locally and re-registering looks like
this:

```bash
# 1. Edit cma/agents/base-system-prompt.md AND/OR cma/agents/base.yaml
${EDITOR:-vim} cma/agents/base-system-prompt.md

# 2. Re-inline if you only edited the prompt body
yq -i '.system = load_str("cma/agents/base-system-prompt.md")' cma/agents/base.yaml

# 3. Pull the current version from CMA
CURRENT_VERSION=$(ant beta:agents retrieve "$AGENT_ID" --json | jq -r '.version')

# 4. Update with that version (CMA rejects on stale version)
ant beta:agents update "$AGENT_ID" \
    -f cma/agents/base.yaml \
    --version "$CURRENT_VERSION"
```

CMA replaces array fields (`tools`, `mcp_servers`, `skills`) entirely on
update; scalar fields are replaced; `metadata` is merged.

## What's NOT in this directory

| Concern | Where it lives |
|---------|----------------|
| Per-routine agent definitions (one per CTL-287..CTL-291) | Each routine ticket contributes its own files (proposed: `cma/agents/<routine-name>.yaml`) |
| Thoughts write-back, conflict handling, Memory Store curation | [CTL-295](https://linear.app/catalyst/issue/CTL-295) |
| Human-in-the-loop approval gate pattern | [CTL-296](https://linear.app/catalyst/issue/CTL-296) |
| Linear webhook → CMA session bridge | [CTL-297](https://linear.app/catalyst/issue/CTL-297) |
| Multi-agent (coordinator + workers) orchestration eval | [CTL-298](https://linear.app/catalyst/issue/CTL-298) |
| Outcomes / quality-gate rubric port | [CTL-292](https://linear.app/catalyst/issue/CTL-292), [CTL-293](https://linear.app/catalyst/issue/CTL-293) |
| Catalyst skills as CMA-native skills | [CTL-294](https://linear.app/catalyst/issue/CTL-294) |
| Slack OAuth (full MCP path) | First routine that requires it (likely [CTL-291](https://linear.app/catalyst/issue/CTL-291)) |
| Notion self-host (full MCP path) | First routine that requires it (likely [CTL-291](https://linear.app/catalyst/issue/CTL-291)) |

## Related tickets (Phase 1 Routines that use this scaffolding)

- **[CTL-287](https://linear.app/catalyst/issue/CTL-287)** — Nightly Linear backlog triage
- **[CTL-288](https://linear.app/catalyst/issue/CTL-288)** — Automated PR code review on open
- **[CTL-289](https://linear.app/catalyst/issue/CTL-289)** — CI failure auto-fix
- **[CTL-290](https://linear.app/catalyst/issue/CTL-290)** — Weekly docs drift detection
- **[CTL-291](https://linear.app/catalyst/issue/CTL-291)** — Daily async dev update (Slack / Notion)

Each routine inherits the base agent's system prompt and adds its own
trigger, success criteria, output target, and wall-clock budget.

## References

- [CMA overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Define your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup)
- [Cloud environment setup](https://platform.claude.com/docs/en/managed-agents/environments)
- [MCP connector](https://platform.claude.com/docs/en/managed-agents/mcp-connector)
- [Authenticate with vaults](https://platform.claude.com/docs/en/managed-agents/vaults)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Multiagent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent)
