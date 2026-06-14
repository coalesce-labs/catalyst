---
title: Post-reboot and updates
description: How to bring the Catalyst stack back up after a reboot and apply updates after merging.
sidebar:
  order: 5
---

## After a reboot

The Catalyst services (broker, monitor, execution-core) do not auto-start. Run once after each reboot:

```bash
catalyst-stack start
```

That's it. The command is idempotent — already-running services are skipped. Check what's running at any time with:

```bash
catalyst-stack status
```

## Plugin source checkout

Workers run their plugin code (skills, scripts, agents) from a dedicated
**pristine, main-only checkout** of the catalyst repo — registered as
`catalyst.orchestration.pluginDirs` and resolved by `phase-agent-dispatch` when
it builds each worker's `--plugin-dir` flags. Keeping the source on a clean,
single-branch `main` checkout (separate from any worktree you develop in) means
updates are a simple `git pull --ff-only` and there is never local drift between
what you edit and what workers execute.

Provision it once:

```bash
plugins/dev/scripts/setup-plugin-source.sh
```

This clones the repo (main, single-branch) to `~/catalyst/plugin-source` and
registers `~/catalyst/plugin-source/plugins/dev` as `pluginDirs` in your machine
config. Choose a different location with `--path DIR` (or
`$CATALYST_PLUGIN_SOURCE`). Re-running is idempotent: it ff-only pulls the
existing checkout and leaves an already-correct registration untouched (use
`--force` to point `pluginDirs` at a new path).

The script **refuses** to register a linked git worktree or a checkout on any
branch other than `main` — the plugin source must be pristine so the unattended
ff-only auto-pull always succeeds.

Keep it fresh with `catalyst-stack hotpatch` (below) — and, once it ships, the
broker auto-refreshes it on every merge to `main`. `catalyst-stack parity`
flags it as drift if the checkout ever ends up off `main` or becomes a linked
worktree.

## After merging or pulling new code

The fastest way to refresh the plugin-source checkout and restart:

```bash
catalyst-stack restart --hotpatch
```

This does two things in sequence:

1. `git pull --ff-only origin main` in each `pluginDirs` checkout (resolved via
   `lib/plugin-dirs.sh`: `CATALYST_PLUGIN_DIRS` env → repo `.catalyst/config.json`
   → machine config). It refuses dirty or diverged checkouts and emits a
   `node.checkout.updated` event recording the old → new commit.
2. Stops and restarts the stack.

If the pull fails (non-fast-forward), the command aborts before restarting.
Resolve the conflict manually, then retry.

> The legacy marketplace-cache `rsync` flow survives only behind
> `catalyst-stack hotpatch --legacy-rsync` and is deprecated — migrate the node
> to the one-checkout model above.

## Debugging Linear API rate-limiting (mitmproxy, opt-in)

The mitmproxy audit is **off by default** and is a rare diagnostic tool — use it for a short window
when you need to inspect Linear API traffic or rate-limit headers, then turn it off.

**Turn ON:**

```bash
catalyst-stack restart --proxy
```

**Turn OFF:**

```bash
catalyst-stack restart
```

On first use, `catalyst-stack --proxy` installs mitmproxy via `brew install mitmproxy` if absent,
generates the CA cert, and copies the vendored addon to `~/catalyst/mitm_linear_addon.py`. Traffic
is written to `~/catalyst/linear-proxy.jsonl`.

The proxy vars (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`, `NO_PROXY`) are
injected only as an inline env prefix for the daemon process — they are never written to disk and
disappear on the next plain `catalyst-stack restart`.

## Boot-resume guarantee

The execution-core daemon persists its work queue to disk. If you stop the stack in the middle of an autonomous run, the orchestrator resumes where it left off when you `catalyst-stack start` again.

## See also

- [catalyst-stack reference](/reference/catalyst-stack/) — all flags and environment variables
- [Install Catalyst](/getting-started/) — initial setup
- [Remote and unattended hosts](/getting-started/remote-and-unattended-hosts/) — bring the stack up on a headless Mac
