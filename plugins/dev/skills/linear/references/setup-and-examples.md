# Setup, configuration, and worked examples

## Prerequisites

```bash
if ! command -v linearis &> /dev/null; then
    echo "❌ Linearis CLI not found"
    echo "Install with: npm install -g linearis"
    echo "Configure with: export LINEAR_API_TOKEN=your_token  # or ~/.linear_api_token"
    exit 1
fi
```

## Configuration

Read team config from `.catalyst/config.json` (fallback `.claude/config.json`):

```bash
CONFIG_FILE=".catalyst/config.json"
[[ ! -f "$CONFIG_FILE" ]] && CONFIG_FILE=".claude/config.json"

TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "$CONFIG_FILE")
# Team UUID — required for issues create/search (keys don't work); discover via `linearis teams usage`.
TEAM_UUID=$(jq -r '.catalyst.linear.teamUuid // empty' "$CONFIG_FILE")
THOUGHTS_URL=$(jq -r '.catalyst.linear.thoughtsRepoUrl // "https://github.com/org/thoughts/blob/main"' "$CONFIG_FILE")
```

```json
{ "catalyst": { "linear": { "teamKey": "ENG", "teamUuid": "<team-uuid>" } } }
```

## URL mapping for thoughts documents

- `thoughts/shared/...` → `{thoughtsRepoUrl}/repos/{project}/shared/...`
- `thoughts/{user}/...` → `{thoughtsRepoUrl}/repos/{project}/{user}/...`
- `thoughts/global/...` → `{thoughtsRepoUrl}/global/...`

## Default values

- **Status**: new tickets start in "Backlog".
- **Priority**: default Medium (3) — Urgent(1)/High(2)/Medium(3)/Low(4).

## Worked example: Thought → Ticket → Plan → Implement

```bash
/catalyst-dev:research-codebase "authentication patterns"
# Saves to thoughts/shared/research/auth-patterns.md

/catalyst-dev:linear create thoughts/shared/research/auth-patterns.md
# Creates ticket in Backlog

/catalyst-dev:create-plan
# Reads research, creates plan; ticket moves to stateMap.planning

/catalyst-dev:implement-plan thoughts/shared/plans/2025-01-08-auth-feature.md
# Ticket moves to stateMap.inProgress

/catalyst-dev:create-pr
# Ticket moves to stateMap.inReview

/catalyst-dev:merge-pr
# Ticket moves to stateMap.done
```

State names throughout come from the `linearis` skill's single-source `stateMap` table — this example does not restate it.
