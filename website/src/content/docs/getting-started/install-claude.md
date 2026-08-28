---
title: Install the portable skills pack (Claude Code)
description: Install Catalyst's portable skills pack into Claude Code via the skills CLI.
sidebar:
  order: 3
---

Catalyst also publishes a small, hook-free subset of its skills as a **portable pack** — `coalesce-labs/catalyst-skills` — installable into any harness the `skills` CLI supports, including Claude Code. This is a different install path from the one on the [previous page](/getting-started/): that page's setup script wires up the full Catalyst plugin (agents, orchestration, the Linear replica, the whole loop); this page's `npx skills add` installs only the portable subset, with no plugin, no daemon, and no Catalyst-specific tooling required.

## What's in the portable pack today

Two skills: `setup-catalyst` and `validate-frontmatter`. This is not a curation choice you can expand by asking — most of Catalyst's skills live in `catalyst-dev`, and that plugin's safety hooks (`hooks.toml`) veto the **entire plugin** from every portable target, regardless of any individual skill's own settings. See `docs/skill-authoring.md` in the source repo if you're a Catalyst contributor and want the full mechanism.

## Install into a project

Run this in the root of the project you want the skills available in — **never** inside a clone of the `catalyst` repository itself, since a Codex/OpenCode-scoped install writes to `.agents/skills/`, which in that repo is the packaging pipeline's own generated output directory:

```sh
npx skills@1.5.23 add coalesce-labs/catalyst-skills --skill '*' -a claude-code -y
```

Verified output (`skills@1.5.23`, run against the pack in a scratch project):

```
Installation Summary
  ./.claude/skills/setup-catalyst
    copy → Claude Code
  ./.claude/skills/validate-frontmatter
    copy → Claude Code
```

With `-a claude-code` alone, the CLI copies each skill directly into `.claude/skills/<name>/SKILL.md` — it does **not** create a `.agents/skills/` directory at all in this case (that directory only appears when you also request Codex or OpenCode in the same command; see the [Codex guide](/getting-started/install-codex/) for that shape). `<name>` is the skill's frontmatter `name` field, not the pack's source directory name — the pack repo stores each skill under a pack-qualified directory (`catalyst-foundry-setup-catalyst`), but it installs as `setup-catalyst`. This is a `skills` CLI convention (`installSkillForAgent` keys the destination on `name`), not a Catalyst-specific behavior.

A `skills-lock.json` is written at your project root recording the pack source and a content hash per skill — this is what `skills update` and `skills remove` use later; you don't need to touch it by hand.

## Install globally

```sh
npx skills@1.5.23 add coalesce-labs/catalyst-skills --skill '*' -g -a claude-code -y
```

This installs into your global Claude Code skills directory rather than a specific project, so every project you open picks up the pack without a per-project install step.

## Confirm the install actually loaded

A `skills add` success line proves the CLI wrote files — it does **not** by itself prove Claude Code has loaded them (see the [Codex guide](/getting-started/install-codex/) for a case where the CLI reports success and the target harness never sees the skill at all). For Claude Code, confirm by starting a session in the installed project and checking that the skill is listed among the available skills, or by directly invoking it (e.g. `/setup-catalyst` if you installed with `disable-model-invocation` semantics preserved).

## Updating and removing

```sh
npx skills@1.5.23 update          # update installed skills to the latest pack content
npx skills@1.5.23 remove --all -y # remove all installed skills; omit -y and --all for an interactive picker
```

## Pinning

The portable pack is published to `coalesce-labs/catalyst-skills` on every Catalyst release as an ordinary accumulating commit — never a force-push or history rewrite. See the [portable pack overview](/getting-started/install-portable/#pinning) for the full pinning story, including a real limitation in the `skills` CLI worth knowing about before you rely on it.
