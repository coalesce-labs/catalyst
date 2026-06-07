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

## After merging or pulling new code

The fastest way to apply an update to the live plugin cache and restart:

```bash
catalyst-stack restart --hotpatch
```

This does three things in sequence:

1. `git pull --ff-only origin main` in your catalyst repo checkout.
2. `rsync -ac --exclude=node_modules` from `plugins/dev/` into the resolved plugin-cache version directory.
3. Stops and restarts the stack.

If the pull fails (non-fast-forward), the command aborts before touching the cache. Resolve the conflict manually, then retry.

The default repo path is `~/code-repos/github/coalesce-labs/catalyst`. Override with `CATALYST_REPO_DIR`:

```bash
CATALYST_REPO_DIR=/path/to/catalyst catalyst-stack restart --hotpatch
```

## Linear traffic capture (optional)

To log every Linear API call with rate-limit headers and caller attribution, opt in to the mitmproxy proxy:

```bash
catalyst-stack start --proxy
```

On first use, this offers to install mitmproxy via `brew install mitmproxy` if absent, generates the CA cert, and copies the vendored addon to `~/catalyst/mitm_linear_addon.py`. Traffic is written to `~/catalyst/linear-proxy.jsonl`.

The proxy is **off by default**. The execution-core daemon runs correctly without it.

## Boot-resume guarantee

The execution-core daemon persists its work queue to disk. If you stop the stack in the middle of an autonomous run, the orchestrator resumes where it left off when you `catalyst-stack start` again.

## See also

- [catalyst-stack reference](/reference/catalyst-stack/) — all flags and environment variables
- [Install Catalyst](/getting-started/) — initial setup
