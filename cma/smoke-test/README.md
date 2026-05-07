# CMA base scaffold — smoke test

End-to-end manual recipe to confirm a CMA session created against the base
environment + base agent + your vault can:
1. Resolve the bound target project from `CATALYST_TARGET_REPO`
2. Clone the target repo and read its `.catalyst/config.json`
3. Clone the thoughts repo and surface the project's shared subtree
4. Materialize `/workspace/project-context.md` with the resolved values
5. Call Linear MCP to read an issue from the bound project
6. Call GitHub MCP to read this PR
7. Echo the encoded reward-hacking patterns (verifies system prompt encoding)

Run the smoke test against your **default project** first (Pass A below).
Then optionally run Pass B against a second project to verify multi-project
portability.

This recipe is run by hand — it is not automated CI.

---

## Prerequisites

- `ant` CLI installed and authenticated (`ant auth login`)
- Your CMA org / API key has the `managed-agents-2026-04-01` beta enabled
- You have completed credential provisioning per `cma/mcp/{linear,github}.md`
  (Slack and Notion are NOT exercised in this smoke test)
- The target repo has a `.catalyst/config.json` with `projectKey`,
  `linear.teamKey`, `linear.stateMap`, and `project.ticketPrefix` populated
- Shell variables set:
  ```bash
  export LINEAR_API_KEY=lin_api_...
  export GITHUB_PAT=github_pat_...
  ```

---

## Step 1 — Register environment, base agent, vault (one-time)

From the catalyst repo root:

```bash
# Environment (shared across projects)
ENV_ID=$(ant beta:environments create -f cma/environment.yaml --json | jq -r '.id')
echo "ENV_ID=$ENV_ID"

# Base agent (project-agnostic)
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
  "agents":       { "catalyst-pattern-base":  "agt_..." },
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

## Pass A — Smoke test against Catalyst (`coalesce-labs/catalyst`)

### Step A.1 — Create a session bound to Catalyst

```bash
SESSION_A=$(ant beta:sessions create --json <<YAML | jq -r '.id'
agent: $AGENT_ID
environment_id: $ENV_ID
vault_ids:
  - $VAULT_ID
env:
  CATALYST_TARGET_REPO: coalesce-labs/catalyst
YAML
)
echo "SESSION_A=$SESSION_A"
```

### Step A.2 — Send the smoke prompt

```bash
ant beta:sessions:events send "$SESSION_A" --type user_turn <<'PROMPT'
Run this smoke test, in order, and report each step's result:

1. Execute the startup ritual from your system prompt section 1. Then run
   `cat /workspace/project-context.md`. Expected: the file lists
   - Target repo: coalesce-labs/catalyst
   - Project key: catalyst-workspace
   - Linear team key: CTL
   - Ticket prefix: CTL-
   - State map containing: research -> "In Progress", inReview -> "In Review", done -> "Done"

2. Run `ls /workspace/thoughts/shared/research/ | head -5`.
   Expected: 5 file paths starting with 2026-.

3. Read the research doc that produced you:
   `cat /workspace/thoughts/shared/research/2026-05-07-CTL-299-generic-base-agent.md | head -20`
   Expected: frontmatter + the title line "# CTL-299: Generalize CMA base agent".

4. Call mcp__linear__get_issue with id "CTL-299".
   Expected: title equals "[CMA] Generalize base agent for multi-project use (Catalyst, Adva)".

5. Call mcp__github__get_pull_request with owner=coalesce-labs, repo=catalyst,
   pull_number=<PR number for CTL-299 when this smoke test is run>.
   Expected: title contains "CTL-299"; head ref is "CTL-299".

6. From your system prompt section 6, echo the list of banned reward-hacking
   patterns. Expected: 8 banned patterns matching the table in section 6
   plus the runtime-detected `forEach(async)` and unguarded non-null assertion.

After completing all 6 steps, output a one-line PASS/FAIL summary per step.
PROMPT
```

### Step A.3 — Stream the response

```bash
ant beta:sessions:events stream "$SESSION_A"
```

Expected tool-call sequence:
- `bash` (clone target, parse config, write project-context.md)
- `bash` (cat project-context, ls thoughts research, cat research doc)
- `mcp__linear__get_issue`
- `mcp__github__get_pull_request`
- final assistant turn with PASS/FAIL summary

### Step A.4 — Cleanup

```bash
ant beta:sessions archive "$SESSION_A"
```

---

## Pass B (optional) — Smoke test against a second project

Run Pass B only after Pass A passes. The point is to verify the **same
registered base agent** works for a different target without re-registration.

### Pre-reqs

- A second project (e.g., Adva at `getadva/adva`) with a populated
  `.catalyst/config.json`
- Your vault's GitHub PAT has access to that second repo (see
  `cma/mcp/github.md` for single-PAT vs multi-PAT patterns)
- A known ticket ID and PR number from that project for the smoke prompt

### Step B.1 — Create a session bound to the second project

```bash
SESSION_B=$(ant beta:sessions create --json <<YAML | jq -r '.id'
agent: $AGENT_ID
environment_id: $ENV_ID
vault_ids:
  - $VAULT_ID
env:
  CATALYST_TARGET_REPO: getadva/adva
YAML
)
```

### Step B.2 — Send the same prompt with project-specific identifiers

Same shape as Pass A.2, but adjust:
- The research doc path uses the second project's thoughts directory
- The Linear ticket ID uses the second project's prefix (e.g., `ADV-XXX`)
- The expected `project-context.md` reflects the second project's values
  (different team key, different state-map values if applicable)

### Step B.3 — Stream and cleanup

Same as A.3 / A.4.

---

## Expected pass criteria

| Pass | Step | Pass when |
|------|------|-----------|
| A | 1 | `project-context.md` shows the catalyst-specific values resolved from `.catalyst/config.json` |
| A | 2 | `ls` returns ≥ 5 research files |
| A | 3 | `cat` shows the frontmatter and the matching title line |
| A | 4 | Linear MCP returns the exact ticket title |
| A | 5 | GitHub MCP returns a PR whose head ref is `CTL-299` |
| A | 6 | Agent echoes the 8 banned patterns plus the runtime-detected ones |
| B | 1 | `project-context.md` shows the second project's values (different team key, different state-map values if applicable) |
| B | 2–6 | Equivalent to A but with project-specific identifiers |

### Common failure modes

- **A.1 fails** with `CATALYST_TARGET_REPO: required`: the env var was not
  passed at session creation
- **A.1 fails** with `git clone` 403: PAT lacks read access on the target repo
- **A.1 fails** with `jq: error: .catalyst.projectKey: not defined`: the
  target repo lacks a `.catalyst/config.json` or the file is missing keys
- **A.4 fails**: Linear API key missing scope for the team or vault was not
  bound to the session
- **A.5 fails**: PAT lacks `Pull requests: Read` on the target repo, or the
  PR number is wrong
- **A.6 fails**: the system prompt was not registered correctly — re-run the
  drift check (Step 2) and re-register the agent
- **B.1 fails** but A.1 passes: the GitHub PAT does not include the second
  repo. Either expand single-PAT scope or use the multi-PAT pattern with a
  second vault (see `cma/mcp/github.md`)
