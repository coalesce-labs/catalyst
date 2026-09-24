---
title: Install Catalyst skills for Codex and OpenCode
description: Install both supported Catalyst skill packs from their own repositories.
sidebar:
  order: 3.1
---

Install the development workflows and Cloud tenant skills from their separate repositories:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

These commands install globally for the workstation. To install only in the current project, omit `-g` from both commands and run them from the project root.

The Skills CLI writes the universal global skills directory. Confirm that your Codex or OpenCode version reads that directory, then check that both packs' skills appear in the agent. A successful install message confirms files were written, not that a particular agent loaded them.

The packs have independent versions. Update global installs with `npx skills@latest update -g -y`. For project installs, run `npx skills@latest update -y` from the project root. Do not install `catalyst-dev@catalyst` from the deprecated `coalesce-labs/catalyst` repository.
