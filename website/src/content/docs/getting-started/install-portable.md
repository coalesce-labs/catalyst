---
title: The portable skills pack
description: What coalesce-labs/catalyst-skills is, what it currently contains, and how to install it into any skills-CLI-compatible harness.
sidebar:
  order: 3.2
---

Catalyst is normally installed as a full plugin — the [install guide](/getting-started/) covers that path, and it's the one to use if you want the whole autonomous workflow: agents, orchestration, the Linear replica, the daemon stack. This page is about a narrower, separate thing: a small, hook-free **subset** of Catalyst's skills, published as a portable pack that installs into any harness the [`skills` CLI](https://skills.sh/) supports — Claude Code, Codex, OpenCode, and roughly twenty others — with no Catalyst plugin, daemon, or orchestration required at all.

## What this actually is

[`coalesce-labs/catalyst-skills`](https://github.com/coalesce-labs/catalyst-skills) is a **generated repository** — every file under its `skills/` directory is emitted by `scripts/packaging/` in the main [`coalesce-labs/catalyst`](https://github.com/coalesce-labs/catalyst) repo and pushed there by CI on release. Its own README says, in its first line, never to hand-edit it. If you want to change what's in the pack, the change happens in the source repo's `plugins/*/skills/`, not here.

**The current portable surface is two skills**: `setup-catalyst` and `validate-frontmatter` — not "all of Catalyst." Most of Catalyst's skills live under the `catalyst-dev` plugin, and that plugin's safety hooks veto its entire skill set from every portable target, regardless of any individual skill's own settings — this is a deliberate safety outcome, not a gap waiting to be filled. See `docs/skill-authoring.md` in the source repo for the full mechanism if you're curious why, or if you're a contributor trying to get a new skill into the pack.

## Install

```sh
npx skills@1.5.23 add coalesce-labs/catalyst-skills --skill '*' -a claude-code -a codex -a opencode -y
```

⚠️ **Run this in the project you want the skills in — never inside a clone of the `catalyst` repository itself.** A Codex/OpenCode-scoped install writes to `.agents/skills/`, which in that repo is the packaging pipeline's own generated output directory; installing there produces a drift-gate failure attributed to the wrong cause.

For harness-specific detail — exact install paths, the project/global asymmetry, and how to confirm the skill actually loaded rather than just that the CLI reported success — see the [Claude Code guide](/getting-started/install-claude/) and the [Codex/OpenCode guide](/getting-started/install-codex/). If you just want to see what's in the pack before installing anything:

```sh
npx skills@1.5.23 add coalesce-labs/catalyst-skills --list
```

Verified output (`skills@1.5.23`, run against the live repo):

```
Found 2 skills

Available Skills
  setup-catalyst
  validate-frontmatter
```

## Pinning

The pack publishes to `coalesce-labs/catalyst-skills` on every Catalyst release as an ordinary accumulating commit on `main` — **never** a force-push or a history rewrite, so nothing ever moves out from under a commit SHA recorded today. That's what makes the pack usable as a pinning unit for a reproducible build: catalyst-cloud's runner-container image label (CTC-977/CTC-1034) records the exact pack commit SHA it was built against, so a container build can always trace back to the source that produced the skills it shipped. Each publish from an actual GitHub Release also pushes a lightweight tag mirroring the release tag (a `workflow_dispatch` run has no release tag to mirror and skips that step).

**`skills add` itself can only pin by branch or tag, not by a raw commit SHA.** Verified against the real CLI (`skills@1.5.23`): it shallow-clones with `git clone --depth 1 --branch <ref>`, and `--branch` accepts a branch or tag name but not an arbitrary commit — `npx skills@1.5.23 add coalesce-labs/catalyst-skills#<commit-sha>` fails with `fatal: Remote branch <sha> not found in upstream origin`, while `npx skills@1.5.23 add coalesce-labs/catalyst-skills#main` (or a real tag, once a GitHub Release has been cut) works. So the pack SHA recorded downstream is a **traceability and audit** pin — the value a container build records for "exactly this commit produced these skills" — not something you hand to `skills add` directly; if you need to install from an exact historical commit rather than whatever `main` currently is, clone the pack repo yourself at that SHA and point `skills add` at the local path.

See `docs/releases.md` in the source repo for the full publish mechanism — the conformance re-grade before every push, the `no-change`/`publish`/`inconclusive` decision, and how the pack SHA is recorded downstream.
