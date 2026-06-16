---
title: Remote and unattended hosts
description: Run Catalyst on a headless Mac you reach over SSH — plugin install, gh token migration, and bringing the stack up.
sidebar:
  order: 6
---

Catalyst is macOS-only, but the host does not have to be the Mac in front of you. A
common setup is a **headless Mac** (for example, a Mac mini) that you reach over SSH and
leave running. This page covers the parts of setup that differ from the
[interactive install](/getting-started/).

## Install the plugin over SSH

The in-app `/plugin` commands need an interactive Claude Code session. From a shell, use
the CLI form instead:

```bash
claude plugin marketplace add coalesce-labs/catalyst
claude plugin install catalyst-dev@catalyst
```

Then install the CLI tools and start the stack exactly as in the
[main install steps](/getting-started/).

## Move your GitHub login to the remote host

On macOS, `gh auth login` often stores the token in the **macOS keychain**, not in
`~/.config/gh/hosts.yml`. Copying `hosts.yml` to another machine therefore silently
fails — the token field is blank. Pipe the token across instead:

```bash
gh auth token | ssh your-host 'gh auth login --with-token'
```

`gh auth token` reads from whichever store `gh` is using (keychain or `hosts.yml`), so
this works regardless of how you logged in locally.

## After a reboot

After the host reboots, reconnect and run:

```bash
catalyst-stack start
```

On a headless host you'll usually want this to happen automatically. Install the
auto-start LaunchAgent once, then a reboot brings the whole stack back on its own:

```bash
catalyst-stack install-services
```

It runs `catalyst-stack start` at login plus a keep-alive that self-heals a crashed
daemon. Because it's a per-user LaunchAgent, enable **automatic login** so it fires on
boot without anyone signing in. See
[Post-reboot and updates](/getting-started/reboot-and-updates/) for the day-to-day
boot and update flow and the full `install-services` options.

## If the daemon dispatches nothing

The execution-core daemon only dispatches work for **registered** projects. On a fresh or
headless host the project registry (`~/catalyst/execution-core/registry.json`) may never have
been written — the daemon then starts cleanly, logs normal ticks, and dispatches nothing.

As of CTL-854 the daemon logs a one-time warning at startup when the registry is empty. To
enroll a project, run from inside its repo:

```bash
catalyst-execution-core register --team <TEAM> --repo-root "$(git rev-parse --show-toplevel)"
```

The running daemon picks up the change on its next reconcile — no restart needed. Confirm with:

```bash
catalyst-execution-core daemon status
```

See [configuration reference](/reference/configuration/) for details on the registry and
eligible-query format.

## Mirroring config to another node

When adding a second host to a cluster, some config items must be copied verbatim from the seed
node (SHARED) and others must be regenerated on the new host (PER-NODE). See
[Cluster config mirror contract](/reference/cluster-config-mirror/) for the full classification
table, correct file locations for bot OAuth credentials, and the quota field-name schema consumed
by monitoring and heartbeat code.
