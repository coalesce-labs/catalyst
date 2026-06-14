---
title: catalyst-stack
description: Reference for the catalyst-stack CLI — start, stop, restart, and hotpatch the four Catalyst services.
sidebar:
  order: 10
---

`catalyst-stack` is the canonical command for bringing the Catalyst service stack up and down. It starts the four services in dependency order and is idempotent — already-running services are left alone.

## Dependency order

| Start order | Stop order |
|-------------|------------|
| mitmproxy (opt-in, `--proxy` only) | execution-core |
| broker | monitor |
| monitor | broker |
| execution-core | mitmproxy |

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `start` | Start all services (idempotent). |
| `stop` | Stop all services in reverse order. |
| `restart` | Stop then start. Accepts the same flags as `start`. |
| `status` | Print running/stopped state for each service. |

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
```

## See also

- [Post-reboot and updates](/getting-started/reboot-and-updates/) — day-to-day workflow for booting and updating
- [Install Catalyst](/getting-started/) — initial setup including `catalyst-stack start` as step 4
