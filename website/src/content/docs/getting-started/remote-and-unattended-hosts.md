---
title: Remote and unattended workstations
description: Install the supported Catalyst skill packs on a remote workstation.
sidebar:
  order: 6
---

The old `setup-catalyst.sh` installer provisioned a local Catalyst runtime from the deprecated `coalesce-labs/catalyst` repository. Do not use it for new workstation setup. The supported setup installs skills from their two source repositories:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

These commands install the packs globally for agents on the remote workstation. To keep them in one project, omit `-g` and run the commands in that project's root. Use the corresponding Claude Code plugin from each source repository only when choosing the plugin rail for that pack. Do not install `catalyst-dev@catalyst` from the deprecated repository.

An unattended machine can install the public skills without a personal credential. Do not put a person's Cloud login in a shared host or image. Connect a workstation with `catalyst-skills login` when an authorized person can complete the browser approval. See [Install Catalyst skills](/getting-started/) for the Cloud CLI and plugin alternatives.

This page no longer covers the retired local Catalyst daemon, LaunchAgents, or project registration commands. Historical runtime notes remain in the [previous `catalyst` README](https://github.com/coalesce-labs/catalyst/blob/73bc0645252ce8be38f8c87be6b67b950b3f0b56/README.md).
