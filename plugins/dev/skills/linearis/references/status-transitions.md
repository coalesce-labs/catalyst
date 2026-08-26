# Status transitions — UUID calls and the team-key cache

The canonical `stateMap` transition table lives in `SKILL.md` → "Workflow: Status Transitions".
This file is the detail behind it.

## Common flow

```bash
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --status "In Review"
linearis issues update ENG-123 --status "Done"

# With comment — an AGENT posting the "Merged" note goes through linear-reply.mjs, not `discuss`
linearis issues update ENG-123 --status "Done"
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" ENG-123 --as <AGENT> --body "Merged: PR #456" --top
```

## UUID-based calls (CTL-207)

When `.catalyst/config.json` contains `catalyst.linear.stateIds`, prefer passing the UUID directly
to `--status` instead of the display name. Every linearis resolver short-circuits on UUIDs — zero
resolution API calls. The `linear-transition.sh` helper does this automatically.

```bash
# Resolve and cache UUIDs once (single GraphQL query)
plugins/dev/scripts/resolve-linear-ids.sh

# Then transitions use UUIDs from config — 1 fewer API call per update
plugins/dev/scripts/linear-transition.sh --ticket ENG-123 --transition done
```

## Team-key allowlist cache (CTL-633)

The PR-body guard `lib/linear-pr-skip.sh` optionally filters its output through a cached snapshot
of workspace team keys at `${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-team-keys.json`. The
cache is **manual** and **fail-open** — when the file is missing, empty, malformed, or unreadable,
the helper does no filtering (fresh installs behave like today). Populate / refresh it with:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
linearis teams list --json |
  jq '{keys:[.nodes[].key]|sort, fetched_at:(now|todate)}' \
  > "${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-team-keys.json"
```

Re-run after onboarding a new Linear team. The helper is invoked inside non-interactive
`gh pr create` / `gh pr edit` paths — no automatic refresh is wired in.
