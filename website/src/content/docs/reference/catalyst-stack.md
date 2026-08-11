---
title: catalyst-stack
description: Reference for the catalyst-stack CLI — start, stop, restart, and hotpatch the Catalyst service stack.
sidebar:
  order: 10
---

`catalyst-stack` is the canonical command for bringing the Catalyst service stack up and down. It starts the services in dependency order and is idempotent — already-running services are left alone.

## Logs & retention

Each of the four nohup-launched daemons — execution-core, broker, otel-forward, and orch-monitor — **rotates its log on start**: immediately before truncating the log with `>`, the previous run's content is copied to `<log>.1`, older copies shift down to `<log>.2` … `<log>.N`, and the oldest is dropped. The primary log's **inode is preserved** across a restart (copy-then-truncate, not rename), so Grafana Alloy's `loki.source.file` static-path tailer keeps shipping without a gap.

Retention is controlled by `CATALYST_LOG_RETAIN` (default `5`; `0` disables rotation entirely and restores the old truncate-only behaviour). Log paths:

| Daemon | Log file |
|--------|----------|
| execution-core | `~/catalyst/execution-core/daemon.log` |
| broker | `~/catalyst/broker.log` |
| otel-forward | `~/catalyst/otel-forward.log` |
| orch-monitor | `~/catalyst/monitor.log` |

**Known gaps**: the launchd-managed daemons (updater, cloud-sync, event-mirror) truncate via `StandardOutPath`/`StandardErrorPath` and are **not** rotated by this mechanism. The daemon watchdog intentionally appends to the shared `daemon.log` with `>>` and is never rotated.

### A log file is not proof its writer is alive

A daemon started by hand with its output redirected elsewhere leaves `daemon.log` frozen on a previous run's shutdown line — the file looks dead while a separate daemon instance is actively dispatching.

Every daemon log line carries a `pid` field. When reading a log to judge daemon liveness, **confirm the newest line's `pid` matches the running process**: compare `cat <pidfile>` against the `pid` in the newest log line rather than trusting the file's last line or mtime alone.

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
| `claude-account status\|switch\|sync` | Inspect and control the fleet's active Claude OAuth account (see below). |

## `claude-account` (CTL-1650)

Fleet-wide Claude OAuth-account control, one command. Reads the durable `setup-token`s in
`~/.config/catalyst/claude-accounts.env` and (for `switch`) the encrypted selector in the
`catalyst-cluster` repo's `secrets/node-secret-files.sops.json`.

| Subcommand | Description |
|------------|-------------|
| `status` | Run `claude-accounts-usage.mjs` and print each account's 5h/7d rate-limit utilization, reset times, status, and which account is **ACTIVE**. Exits nonzero if no account reported limits. |
| `switch <handle> [--yes]` | Flip the fleet's active SDK account (handle form `acctN`, e.g. `acct2`). Guards on the local age key + a `catalyst-cluster` clone, validates the handle is provisioned, **probes the target token's auth before switching** (refuses a 401/expired account), flips the `_catalyst_active_token` selector via a non-interactive `sops edit`, commits + pushes the cluster repo, re-materializes `claude-accounts.env`, restarts the stack, and verifies the new account is now ACTIVE. |
| `sync [--yes]` | For a second node after a switch was pushed elsewhere: `git pull` the cluster repo, re-materialize `claude-accounts.env`, restart, and verify. |

**Secrets hygiene:** token values are never echoed, logged, or written anywhere but the `0600`
`~/.config/catalyst/claude-accounts.env` target file. The same token-free posture is surfaced
headlessly by the orch-monitor `GET /api/accounts` endpoint (see the
[orch-monitor API](/reference/orch-monitor-api/)).

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
| `CATALYST_LOG_RETAIN` | `5` | Number of previous log files to keep for each nohup daemon (execution-core, broker, otel-forward, orch-monitor). `0` disables rotation. |
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
