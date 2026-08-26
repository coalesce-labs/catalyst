# Needs user input / manual only

For issues needing user input, explain what's needed and how to provide it — never fix these
silently, and never write a token, account id, or machine-specific path for the user.

| Issue | What to tell the user |
|---|---|
| Linear API token not set | Show the secrets file path, explain where to get the token from Linear settings |
| No project config | Suggest running `setup-catalyst.sh`, or offer to create a minimal `.catalyst/config.json` interactively |
| direnv not installed | Show `brew install direnv` and the shell hook setup |
| No Catalyst Cloud replica mirror on this host | Solo/non-fleet use only — see [cloud-detection.md](cloud-detection.md) for the check and the loud fallback; don't recommend it to a fleet-scale user |
| Cloud token missing from `~/.config/catalyst/cloud-sync.env`, or a cloud-sync symptom from the table in [cloud-detection.md](cloud-detection.md) | Point at `setup-catalyst.sh --cloud-token <token> --cloud-account <id>` (or the matching env vars); never write the token yourself |
| Linear "magic words" auto-move ON | Settings → Team → Workflow → Git — no API surface, must be toggled by hand (see [linear-workspace.md](linear-workspace.md)) |
| Linear `review` git automation set | Run `setup-execution-core-states.sh` to remove it — see [linear-workspace.md](linear-workspace.md) |
| Personal git automations override team ones | Linear lets each member set *personal* git automations that shadow the team defaults — check Settings → Account → Git if drift persists after the team reconcile |
| `catalyst.monitor.linear.botUserId` not set | Requires the app-actor's own token — see [linear-workspace.md](linear-workspace.md) |

**Observability (OTel) is optional.** If Docker or OTel containers aren't found, note it as
informational — don't treat it as an issue. Point the user to
https://github.com/ryanrozich/claude-code-otel if they want to set it up.
