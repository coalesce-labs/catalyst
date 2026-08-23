# Configuration and Safety Features

## Configuration

Read team configuration from `.catalyst/config.json`:

```bash
CONFIG_FILE=".catalyst/config.json"
[[ ! -f "$CONFIG_FILE" ]] && CONFIG_FILE=".claude/config.json"
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "$CONFIG_FILE")
TEST_CMD=$(jq -r '.catalyst.pr.testCommand // "make test"' "$CONFIG_FILE")
```

Full schema:

```json
{
  "catalyst": {
    "project": { "ticketPrefix": "PROJ" },
    "linear": {
      "teamKey": "PROJ",
      "stateMap": { "done": "Done" }
    },
    "pr": {
      "defaultMergeStrategy": "squash",
      "deleteRemoteBranch": true,
      "deleteLocalBranch": true,
      "updateLinearOnMerge": true,
      "requireApproval": false,
      "requireCI": false,
      "testCommand": "make test"
    }
  }
}
```

State names are read from `stateMap` with sensible defaults.

## Safety features

**Never bypass branch protection:**
- No `--admin`, `--force`, or any flag that circumvents protection rules
- No disabling or modifying branch protection rules
- No suggesting the user disable protections
- Always satisfy requirements legitimately or escalate with specifics

**Fail fast on:**
- Merge conflicts (can't auto-resolve)
- Test failures (unless `--skip-tests`)
- Rebase conflicts
- PR not in mergeable state

**Diagnose and fix automatically:**
- CI failures → analyze errors, fix code, push, re-poll
- Unresolved review threads → run `/review-comments`, resolve via GraphQL
- Branch behind → rebase and push
- Draft PR → mark as ready with `gh pr ready`

**Escalate with actionable specifics:**
- Review required → who to request, how many needed
- Changes requested → what was asked, whether commits address it
- Unknown blockers → full branch protection rule breakdown

**Always automated:**
- Rebase if behind (no conflicts)
- Squash merge
- Delete remote branch (checkout-free, CTL-56)
- Delete local branch (when not in a linked worktree)
- Update Linear to Done (if Linearis available)
- Pull latest base branch

**Graceful degradation:**
- If Linearis not installed, warn but continue
- Merge succeeds regardless of Linear integration
