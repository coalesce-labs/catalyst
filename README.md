# Catalyst local runtime is deprecated

This repository is kept for history and migration work. It is no longer the supported way to install Catalyst skills or run Catalyst locally. Catalyst Cloud is the supported runtime.

## Install the supported skills

Use the two source repositories. A coding workstation that also operates a Catalyst Cloud tenant normally installs both:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

- [`catalyst-dev-skills`](https://github.com/coalesce-labs/catalyst-dev-skills) guides an agent writing code through research, planning, implementation, review, and shipping.
- [`catalyst-cloud-skills`](https://github.com/coalesce-labs/catalyst-cloud-skills) lets an agent set up and operate a Catalyst Cloud tenant. Follow its README to install the tenant CLI and connect.

Each repository also offers its own Claude Code plugin as an alternative to `npx skills` for that pack: `catalyst-dev@catalyst-dev-skills` and `catalyst@catalyst-cloud`. Choose one install method per pack. The `catalyst-dev@catalyst` plugin from this repository contains a separate, older copy and should be removed during migration. Do not remove unrelated skills when replacing it.

Runner images should pin tested commits from the two source repositories and verify their final skill listings. They should not fetch a branch at startup or bake in a person's Cloud login.

The [previous README](https://github.com/coalesce-labs/catalyst/blob/73bc0645252ce8be38f8c87be6b67b950b3f0b56/README.md) records the former local setup. Its commands are historical and unsupported; use the repositories above for new or migrated installs.
