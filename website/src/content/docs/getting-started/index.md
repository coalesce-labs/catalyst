---
title: Install Catalyst skills
description: Install Catalyst development skills and Catalyst Cloud tenant skills from their supported repositories.
sidebar:
  order: 2
---

The `coalesce-labs/catalyst` repository is deprecated as a local runtime and is no longer a source for workstation skills. Install the two supported packs from their own repositories.

## Install both packs on a coding workstation

Run these commands in a terminal. They install globally for the workstation and can serve Claude Code, Codex, OpenCode and other agents supported by the Skills CLI:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

The development pack provides coding workflows. The Cloud pack provides tenant setup and operation. Their versions are independent. To install into only the current project, omit `-g` from both commands and run them from the project root.

For Claude Code, each pack also offers its own plugin as an alternative to that pack's `npx skills` install:

```sh
claude plugin marketplace add coalesce-labs/catalyst-dev-skills
claude plugin install catalyst-dev@catalyst-dev-skills

claude plugin marketplace add coalesce-labs/catalyst-cloud-skills
claude plugin install catalyst@catalyst-cloud
```

Choose one install method per pack. Do not install `catalyst-dev@catalyst`; it is a separate, outdated copy from the deprecated repository. During migration, remove that exact plugin and remove copied skills only when their lock file records `coalesce-labs/catalyst` as the source. Preserve unrelated skills and local data.

## Connect to Catalyst Cloud

The Cloud skills use the `@catalyst-cloud/catalyst-skills` CLI. Install it when you want to connect this workstation to a tenant:

```sh
npm install -g @catalyst-cloud/catalyst-skills
catalyst-skills login
catalyst-skills ready
```

For more detail, see [Claude Code](./install-claude/), [Codex and OpenCode](./install-codex/), and [remote or unattended hosts](./remote-and-unattended-hosts/).

The historical local-runtime setup is in the [previous `catalyst` README](https://github.com/coalesce-labs/catalyst/blob/73bc0645252ce8be38f8c87be6b67b950b3f0b56/README.md); its setup and plugin commands are not current install instructions.
