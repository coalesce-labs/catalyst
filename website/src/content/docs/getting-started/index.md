---
title: Install Catalyst
description: Get Catalyst installed and running in your project in about five minutes.
sidebar:
  order: 2
---

Get Catalyst installed and running in about five minutes.

## What you need first

- **macOS** — Catalyst is built and tested on macOS only.
- **Claude Code** — [install it](https://docs.anthropic.com/en/docs/claude-code) before you start.
- **Git** — needed to detect your repo and run the thoughts system.

The setup script installs the rest for you: `jq`, `sqlite3`, the HumanLayer CLI, and Bun (the
runtime behind the dashboard and broker). It also offers to set up optional tools — the GitHub CLI
(`gh`), the Linearis CLI, `agent-browser`, and `direnv`.

## 1. Run the setup script

```bash
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh
chmod +x setup-catalyst.sh
./setup-catalyst.sh
```

It checks your platform, installs the prerequisites, creates your project config, sets up a shared
thoughts repository, and asks for any API tokens (like Linear).

### On a headless or SSH-only host

There are no prompts to answer, so the whole install is one command:

```bash
curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh \
  | bash -s -- --non-interactive \
      --cloud-token "$CATALYST_CLOUD_TOKEN" --cloud-account "$CATALYST_CLOUD_ACCOUNT"
```

`-s --` is required: without it `bash` consumes the flags instead of passing them to the script, and
the install runs interactive on a host with no terminal to be interactive with.
`CATALYST_AUTONOMOUS=1` is equivalent to `--non-interactive` if you prefer an env var.

### What to have ready

| What                   | How to supply it                                    | Notes                                                                                                                                                             |
| ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalyst Cloud token   | `--cloud-token` or `CATALYST_CLOUD_TOKEN`           | Validated with one authenticated call before anything is written. A bad token fails the install loudly rather than leaving green checkmarks over a broken system. |
| Catalyst Cloud account | `--cloud-account` or `CATALYST_CLOUD_ACCOUNT`       | Required whenever a token is supplied — there is deliberately no default.                                                                                         |
| Linear API token       | `LINEAR_API_TOKEN`, or a `~/.linear_api_token` file | Must be a **personal** API key, beginning `lin_api_`. An OAuth token (`lin_oauth_…`) is rejected.                                                                 |
| Sentry, PostHog, Exa   | Prompted, or their usual env vars                   | All optional.                                                                                                                                                     |

Both cloud flags are optional. Omit them and setup behaves exactly as it did before they existed.

## 2. Install the plugin

In Claude Code:

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

Restart Claude Code after installing.

On a headless or SSH-only host, install from the shell instead:

```bash
claude plugin marketplace add coalesce-labs/catalyst
claude plugin install catalyst-dev@catalyst
```

## 3. Install the command-line tools

Several Catalyst features call shell tools by name (`catalyst-monitor`, `catalyst-hud`,
`catalyst-events`, and more — see the full [CLI command reference](/reference/catalyst-cli/)).

**Setup already installed these.** Its last act is to put the `catalyst-*` commands on your PATH,
provision `plugin-source`, turn on replica reads, and enrol the project. If the run ended with "No
steps were deferred", skip to the check below.

If setup listed this as a deferred step, run it by hand:

```bash
bash ~/catalyst/plugin-source/plugins/dev/scripts/install-cli.sh
```

They install to `$HOME/.catalyst/bin`. If that folder isn't on your PATH, the installer adds it to
your shell's startup file. Open a new terminal to pick up the change, then check it worked:

```bash
which catalyst-events
catalyst-events help
```

## 4. Start the stack

Bring the three core Catalyst services up in dependency order (monitor → broker → execution-core),
plus the opt-in mitmproxy capture service if you pass `--proxy`:

```bash
catalyst-stack start
```

Run this once after each reboot or after pulling new code. See
[catalyst-stack reference](/reference/catalyst-stack/) for flags including `--hotpatch` (apply an
update without reinstalling) and `--proxy` (opt-in Linear traffic capture via mitmproxy).

The stack is three long-running services (plus an opt-in proxy):

- **`catalyst-broker`** — the event bus every agent and the executor read and write through.
- **`catalyst-monitor`** — watches your GitHub PRs and CI status and emits events.
- **`catalyst-execution-core`** — the scheduler: it picks up Todo tickets and dispatches the
  phase-agent workers.
- **`mitmproxy`** _(opt-in, `--proxy` only)_ — logs Linear API traffic.

See the [catalyst-stack reference](/reference/catalyst-stack/) for the full command set.

## 5. Add Catalyst to your project

Copy the Catalyst snippet into your project's `CLAUDE.md` so Claude Code knows the available
workflows:

```bash
cat ~/.claude/plugins/cache/catalyst/catalyst-dev/*/templates/CLAUDE_SNIPPET.md >> .claude/CLAUDE.md
```

## 6. Try it

Start a Claude Code session and run:

```
/catalyst-dev:research-codebase
```

Follow the prompts. Catalyst spawns helper agents, documents what your code does, and saves the
findings to `thoughts/shared/research/`.

## Optional plugins

Catalyst is a set of plugins. Install only what you need:

```bash
/plugin install catalyst-pm-ops       # cycle, backlog, and cadence ops
/plugin install catalyst-analytics    # PostHog analytics
/plugin install catalyst-debugging    # Sentry error monitoring
/plugin install catalyst-meta         # workflow discovery
```

See [Plugins](/reference/plugins/) for what each one does.

## Keeping plugins up to date

Claude Code checks for plugin updates when a session starts and pulls them automatically. Restart
Claude Code to load a new version. To force an update now:

```bash
/plugins update
```

Check your installed versions any time with `/plugins`.

## Next steps

- [How Catalyst works](/getting-started/how-catalyst-works/) — the autonomous loop, end to end
- [Configuration](/reference/configuration/) — the settings Catalyst reads
- [Remote and unattended hosts](/getting-started/remote-and-unattended-hosts/) — set up on a
  headless Mac reached over SSH
