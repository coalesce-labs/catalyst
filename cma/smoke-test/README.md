# CMA base scaffold — smoke test

End-to-end manual recipe to confirm a CMA session created against the base
environment + base agent + your vault can:
1. Clone the thoughts repo (verifies thoughts strategy + GitHub PAT scope)
2. Read a research doc from the cloned tree
3. Call Linear MCP to read an issue
4. Call GitHub MCP to read this PR
5. Echo the encoded reward-hacking patterns (verifies system prompt encoding)

This recipe is run by hand — it is not automated CI.

---

## Prerequisites

- `ant` CLI installed and authenticated (`ant auth login`)
- Your CMA org / API key has the `managed-agents-2026-04-01` beta enabled
- You have completed credential provisioning per `cma/mcp/{linear,github}.md`
  (Slack and Notion are NOT exercised in this smoke test; their auth setup
  is independent and can be deferred)
- Shell variables set:
  ```bash
  export LINEAR_API_KEY=lin_api_...
  export GITHUB_PAT=github_pat_...
  ```

---

## Step 1 — Register environment, base agent, vault

From the catalyst repo root:

```bash
# Environment
ENV_ID=$(ant beta:environments create -f cma/environment.yaml --json | jq -r '.id')
echo "ENV_ID=$ENV_ID"

# Base agent
AGENT_ID=$(ant beta:agents create -f cma/agents/base.yaml --json | jq -r '.id')
echo "AGENT_ID=$AGENT_ID"

# Vault — copy the example to a private location and substitute real values
cp cma/vaults/example.yaml ~/.config/catalyst/cma-vault.yaml
${EDITOR:-vim} ~/.config/catalyst/cma-vault.yaml   # replace ${...} placeholders

VAULT_ID=$(ant beta:vaults create -f ~/.config/catalyst/cma-vault.yaml --json | jq -r '.id')
echo "VAULT_ID=$VAULT_ID"
```

Capture all three IDs in your local `~/.config/catalyst/cma.json` (NEVER
commit). Suggested shape:

```json
{
  "environments": { "catalyst-routines-base": "env_..." },
  "agents":       { "catalyst-routine-base":  "agt_..." },
  "vaults":       { "catalyst-developer":     "vlt_..." }
}
```

---

## Step 2 — Drift check before first run

The base agent's `system` prompt is inlined into `cma/agents/base.yaml` from
`cma/agents/base-system-prompt.md`. Run the drift check before registering or
re-registering:

```bash
diff <(yq '.system' cma/agents/base.yaml) cma/agents/base-system-prompt.md
```

Should be empty (or whitespace-only differences from YAML literal-block
formatting). If it shows drift, re-inline before registering:

```bash
yq -i '.system = load_str("cma/agents/base-system-prompt.md")' cma/agents/base.yaml
```

(Verify the result before committing.)

---

## Step 3 — Create a smoke-test session

```bash
SESSION_ID=$(ant beta:sessions create --json <<YAML | jq -r '.id'
agent: $AGENT_ID
environment_id: $ENV_ID
vault_ids:
  - $VAULT_ID
YAML
)
echo "SESSION_ID=$SESSION_ID"
```

---

## Step 4 — Send the smoke prompt

```bash
ant beta:sessions:events send "$SESSION_ID" --type user_turn <<'PROMPT'
Run this smoke test, in order, and report each step's result:

1. Run the startup ritual:
   git clone --depth=1 \
     "https://x-access-token:${GITHUB_PAT}@github.com/coalesce-labs/thoughts.git" \
     /workspace/thoughts-repo
   mkdir -p /workspace/thoughts
   ln -s /workspace/thoughts-repo/repos/catalyst-workspace/shared /workspace/thoughts/shared
   ln -s /workspace/thoughts-repo/global                          /workspace/thoughts/global
   Then `ls /workspace/thoughts/shared/research/ | head -5`.
   Expected: 5 file paths starting with 2026-.

2. Read the research doc that produced you:
   `cat /workspace/thoughts/shared/research/2026-05-07-CTL-286-cma-cloud-environment.md | head -20`
   Expected: frontmatter + the title line "# CTL-286: Scaffold CMA cloud environment".

3. Call mcp__linear__get_issue with id "CTL-286".
   Expected: title equals "[CMA] Scaffold cloud environment and Catalyst context architecture".

4. Call mcp__github__get_pull_request with owner=coalesce-labs, repo=catalyst,
   pull_number=<the PR number for CTL-286 when this smoke test is run>.
   Expected: title contains "CTL-286"; head ref is "CTL-286".

5. From your system prompt, echo the list of banned reward-hacking patterns
   (section 5). Expected: 8 banned patterns matching
   `plugins/dev/skills/fix-typescript/SKILL.md:22-31`.

After completing all 5 steps, output a one-line PASS/FAIL summary per step.
PROMPT
```

---

## Step 5 — Stream the response

```bash
ant beta:sessions:events stream "$SESSION_ID"
```

Watch for the agent's tool calls. Expected sequence:
- `bash` (clone, mkdir, ln, ls)
- `bash` (cat first research doc)
- `mcp__linear__get_issue`
- `mcp__github__get_pull_request`
- final assistant turn with PASS/FAIL summary

---

## Step 6 — Cleanup

```bash
ant beta:sessions archive "$SESSION_ID"
```

The session container is destroyed; the cloned thoughts repo is gone. The
environment, agent, and vault remain registered for the next session.

---

## Expected pass criteria

| Step | Pass when |
|------|-----------|
| 1 | `git clone` succeeds; `ls` returns ≥ 5 research files |
| 2 | `cat` shows the frontmatter and the matching title line |
| 3 | Linear MCP returns the exact ticket title |
| 4 | GitHub MCP returns a PR whose head ref is `CTL-286` |
| 5 | Agent echoes the 8 banned patterns matching the skill source |

If any step fails, the most likely causes:
- **Step 1 fails:** `GITHUB_PAT` lacks `coalesce-labs/thoughts` Contents:Read access
- **Step 3 fails:** `LINEAR_API_KEY` lacks workspace access; or the vault was
  not bound to this session
- **Step 4 fails:** PAT lacks `coalesce-labs/catalyst` Pull requests:Read; or
  the PR number is wrong
- **Step 5 fails:** the system prompt was not registered correctly — re-run
  the drift check (Step 2) and re-register the agent
