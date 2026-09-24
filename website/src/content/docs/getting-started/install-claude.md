---
title: Install Catalyst skills for Claude Code
description: Install Catalyst development and tenant skills with the Skills CLI or their own Claude plugins.
sidebar:
  order: 3
---

The default workstation install uses the Skills CLI from each supported repository:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

The first command installs development workflows. The second installs Catalyst Cloud tenant setup and operation. Run both for a coding workstation. Omit `-g` from both commands and run them in a project root for project-only installs.

## Claude Code plugin alternative

Each repository also provides an optional Claude Code plugin. Use a plugin instead of the Skills CLI for that pack:

```sh
claude plugin marketplace add coalesce-labs/catalyst-dev-skills
claude plugin install catalyst-dev@catalyst-dev-skills

claude plugin marketplace add coalesce-labs/catalyst-cloud-skills
claude plugin install catalyst@catalyst-cloud
```

Do not install `catalyst-dev@catalyst`. That plugin is an outdated, separate copy from the deprecated local-runtime repository. Remove only that plugin and skills whose recorded source is `coalesce-labs/catalyst`; preserve unrelated skills.

The Cloud pack's CLI is a separate tool dependency. To connect to a tenant, install `@catalyst-cloud/catalyst-skills`, then run `catalyst-skills login` and `catalyst-skills ready`.
