---
title: catalyst-stack
description: Reference for the catalyst-stack CLI — start, stop, restart, and hotpatch the Catalyst service stack.
sidebar:
  order: 10
---

`catalyst-stack` is the canonical command for bringing the Catalyst service stack up and down. It starts the services in dependency order and is idempotent — already-running services are left alone.

## Dependency order

| Start order | Stop order |
|-------------|------------|
| mitmproxy (opt-in, `--proxy` only) | log-shipper |
| monitor | execution-core |
| broker | otel-forward |
| execution-core | monitor |
| otel-forward | broker |
| log-shipper | mitmproxy |

The core daemons start **monitor → broker → execution-core** (CTL-1084 known-good order; the daemon always comes up last), followed by `otel-forward` and the `log-shipper`. Once `install-services` is run, the log-shipper is supervised by its own launchd `KeepAlive` agent (see below), so `catalyst-stack` defers to launchd for it.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `start` | Start all services (idempotent). |
| `stop` | Stop all services in reverse order. |
| `restart` | Stop then start. Accepts the same flags as `start`. |
| `status` | Print running/stopped state for each service. |
| `install-services` | Install the launchd LaunchAgents (stack keep-alive, thoughts-sync, log-shipper) that auto-start on boot. macOS only. |
| `uninstall-services` | Unload and remove the auto-start LaunchAgents (leaves running daemons up). |
| `services-status` | Show whether the auto-start LaunchAgents are installed and loaded. |

## Flags

### `--proxy`

Opt-in to Linear traffic capture via mitmproxy. When passed, `catalyst-stack` will:

1. Verify `mitmdump` is installed (offer `brew install mitmproxy` if absent).
2. Generate the mitmproxy CA cert at `~/.mitmproxy/mitmproxy-ca-cert.pem` if missing.
3. Copy the vendored addon to `~/catalyst/mitm_linear_addon.py` if absent.
4. Start mitmproxy, then set `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` / `NODE_EXTRA_CA_CERTS` /
   `NO_PROXY=api.anthropic.com,...` as an **inline env prefix** for the execution-core daemon.

Traffic is logged to `~/catalyst/linear-proxy.jsonl` (one JSON record per Linear API response,
including rate-limit headers and caller attribution).

Proxy is **off by default**. The daemon runs correctly without it — use `--proxy` only for short
diagnostic windows (e.g. investigating Linear rate-limiting). The proxy vars are never written to
disk; a plain `catalyst-stack restart` removes them. `NO_PROXY` ensures Claude worker API calls
bypass the proxy even if mitmdump hiccups.

### `--no-proxy`

Accepted for backward compatibility; no-op (proxy is already off by default).

### `--hotpatch`

Apply a post-merge update in one command: ff-only pull each `pluginDirs` checkout, then start/restart.

```bash
# After merging or pulling new code:
catalyst-stack restart --hotpatch
```

Behavior:
- Resolves the checkout(s) from `pluginDirs` via `lib/plugin-dirs.sh` (`CATALYST_PLUGIN_DIRS` env → repo `.catalyst/config.json` → machine config).
- Uses `git pull --ff-only origin main` — aborts on non-fast-forward merges or a dirty/diverged checkout (resolve manually, then retry).
- Emits a `node.checkout.updated` event recording the old → new commit.
- `start --hotpatch` refuses if the stack is already running. Use `restart --hotpatch` instead.
- The deprecated marketplace-cache rsync survives only behind `catalyst-stack hotpatch --legacy-rsync` (uses `CATALYST_REPO_DIR`).

### `setup-plugin-source.sh`

`plugins/dev/scripts/setup-plugin-source.sh` provisions the pristine, main-only checkout that `--hotpatch` keeps fresh and registers it as `catalyst.orchestration.pluginDirs` in the machine config.

```bash
plugins/dev/scripts/setup-plugin-source.sh [--path DIR] [--repo-url URL] [--force]
```

- Clones the repo (main, single-branch) to `~/catalyst/plugin-source` by default (`--path` or `$CATALYST_PLUGIN_SOURCE` to override), or ff-only pulls an existing checkout.
- Registers `<path>/plugins/dev` as `pluginDirs`, preserving every other machine-config key. Idempotent; `--force` re-points to a new path.
- **Refuses** a linked git worktree or a non-`main` checkout — the source must stay pristine.

### `parity`

`catalyst-stack parity` reports node-freshness + setup drift for the `pluginDirs` checkout (exit code = number of drift findings). In addition to the freshness/dirty/manifest checks, it flags a checkout that is **off `main`** or is a **linked worktree** (run `setup-plugin-source.sh` to fix).

### `install-services` / `uninstall-services` / `services-status`

Auto-start the stack on boot via **three** launchd LaunchAgents — the stack keep-alive
(`ai.coalesce.catalyst-stack`), the thoughts-sync agent
(`ai.coalesce.catalyst-thoughts-sync`, which fast-forwards your thoughts checkouts so
research agents read fresh peer state), and the log-shipper
(`ai.coalesce.catalyst-log-shipper`, which supervises Grafana Alloy with `KeepAlive`) —
so a reboot never leaves the fleet down.

```bash
catalyst-stack install-services                     # write + load all three agents
catalyst-stack install-services --interval 300      # stack keep-alive cadence, seconds (default 600)
catalyst-stack install-services --sync-interval 120 # thoughts-sync cadence, seconds (default 300)
catalyst-stack install-services --print             # print the plists to stdout, install nothing
catalyst-stack services-status                      # installed? loaded?
catalyst-stack uninstall-services                   # unload + remove all three (running daemons stay up)
```

The stack agent runs `catalyst-stack start` at login (`RunAtLoad`) and every `--interval`
seconds. Because `start` is ordered (monitor → broker → execution-core) and no-ops a
running service, the agent never double-starts and self-heals a daemon that died
between intervals. It is a **per-user LaunchAgent** (the stack runs as you, with
`$HOME` paths), so it fires at **login** — enable automatic login on a headless Mac.
Logs go to `~/catalyst/stack-launchd.log`. macOS only; `--print` works anywhere for
review. Re-running `install-services` is idempotent (it boots out the old instance
first). See [Post-reboot and updates](/getting-started/reboot-and-updates/).

### `--yes`

Non-interactive mode under `--proxy`: auto-approves `brew install mitmproxy` instead of prompting.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CATALYST_REPO_DIR` | `~/code-repos/github/coalesce-labs/catalyst` | Repo root used by the deprecated `hotpatch --legacy-rsync` path. |
| `CATALYST_PLUGIN_SOURCE` | `~/catalyst/plugin-source` | Default checkout location used by `setup-plugin-source.sh`. |
| `MITM_LOG` | `~/catalyst/linear-proxy.jsonl` | JSONL capture path read by the mitmproxy addon (`mitm_linear_addon.py`) — not the process log. The mitmdump process log is fixed at `~/catalyst/mitm.log` and cannot be overridden. |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Error (unknown argument, proxy preflight failed, non-ff pull, etc.). |

## Examples

```bash
# Start the stack (proxy off by default)
catalyst-stack start

# Start with Linear traffic logging
catalyst-stack start --proxy

# Check what's running
catalyst-stack status

# Stop everything
catalyst-stack stop

# Restart after pulling new code
catalyst-stack restart --hotpatch

# Restart with proxy enabled
catalyst-stack restart --proxy

# Auto-start the stack on boot (install once per host)
catalyst-stack install-services
```

## See also

- [catalyst CLI reference](/reference/catalyst-cli/) — full list of every `catalyst-*` tool with purpose + key subcommands
- [Post-reboot and updates](/getting-started/reboot-and-updates/) — day-to-day workflow for booting and updating
- [Install Catalyst](/getting-started/) — initial setup including `catalyst-stack start` as step 4
