---
title: Claude Code plugin alternatives
description: Optional Claude Code plugins from the two supported Catalyst skills repositories.
sidebar:
  order: 1
---

The default workstation install uses `npx skills` from each supported repository. Each pack also has an optional Claude Code plugin that installs the same skills from that repository.

| Pack | Claude Code plugin | Purpose |
| --- | --- | --- |
| [`catalyst-dev-skills`](https://github.com/coalesce-labs/catalyst-dev-skills) | `catalyst-dev@catalyst-dev-skills` | Development workflows |
| [`catalyst-cloud-skills`](https://github.com/coalesce-labs/catalyst-cloud-skills) | `catalyst@catalyst-cloud` | Catalyst Cloud tenant setup and operation |

Install the plugin from its own marketplace:

```sh
claude plugin marketplace add coalesce-labs/catalyst-dev-skills
claude plugin install catalyst-dev@catalyst-dev-skills

claude plugin marketplace add coalesce-labs/catalyst-cloud-skills
claude plugin install catalyst@catalyst-cloud
```

Choose one install method per pack. The legacy `catalyst-dev@catalyst` plugin is an outdated copy from the deprecated `coalesce-labs/catalyst` repository; remove that plugin when migrating. Preserve unrelated skills.
