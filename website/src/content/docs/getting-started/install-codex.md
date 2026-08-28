---
title: Install the portable skills pack (Codex, OpenCode)
description: Install Catalyst's portable skills pack into Codex or OpenCode via the skills CLI, and what to check to confirm it actually loaded.
sidebar:
  order: 3.1
---

Codex and OpenCode are both "universal" agents in the `skills` CLI's own vocabulary — along with Cursor, Amp, Gemini CLI, GitHub Copilot, and roughly twenty others — meaning they share one project-scope skills directory rather than each having their own. That sharing is convenient, but it also means a `skills add` success line is weaker evidence than it looks; read "Confirm it actually loaded" below before trusting a global-scope install.

⚠️ **Never run a project-scope install with your working directory inside a clone of the `catalyst` repository itself.** Codex and OpenCode's project directory is `.agents/skills/`, which in that repo is the packaging pipeline's own generated output — an install there pollutes it and produces a drift-gate failure attributed to the wrong cause. Run these commands in the project you actually want the skills in.

## Project scope

```sh
npx skills@1.5.23 add coalesce-labs/catalyst-skills --skill '*' -a codex -a opencode -y
```

Verified output (`skills@1.5.23`), confirmed against the actual files written, not just the printed summary:

```
./.agents/skills/setup-catalyst
./.agents/skills/validate-frontmatter
```

Both Codex and OpenCode read from `.agents/skills/` at project scope — there is one canonical copy, not one per agent. If you also request `-a claude-code` in the same invocation, the CLI additionally creates a `.claude/skills/<name>` **symlink** pointing back into `.agents/skills/<name>` — see the [Claude Code guide](/getting-started/install-claude/) for that combined shape. Requesting Codex or OpenCode alone (as above) creates only `.agents/skills/`.

## Global scope — read this before trusting a "success" line

```sh
npx skills@1.5.23 add coalesce-labs/catalyst-skills --skill '*' -g -a codex -a opencode -y
```

This is the one place the CLI's own reporting can mislead you. Verified against a scratch `$HOME` (`skills@1.5.23`): the command reports success for both Codex and OpenCode, and the resulting tree is exactly

```
~/.agents/skills/setup-catalyst
~/.agents/skills/validate-frontmatter
```

**Neither `~/.codex/skills` nor `~/.config/opencode/skills` is created** — the CLI's `getAgentBaseDir` short-circuits every universal agent's global scope to the one canonical directory, `~/.agents/skills/`, and ignores each agent's own declared global directory entirely. The install reports success for Codex and OpenCode alike, but that success line proves only that the CLI wrote to `~/.agents/skills/` — it is not evidence that Codex or OpenCode actually reads from there at global scope. If a future CLI version changes this, this page will be out of date; treat what's printed above as an observation of the current CLI version, not a promise.

## Confirm it actually loaded

- **Project scope:** open the project in Codex or OpenCode and check that the skill is discoverable — a directory existing under `.agents/skills/` is necessary but you should still see it surface inside the agent itself before relying on it.
- **Global scope:** check specifically whether your version of Codex or OpenCode reads skills from `~/.agents/skills/` at all. If it does not, the global-scope install above will report success and do nothing useful for that harness — this is a real, observed gap in the CLI, not a Catalyst limitation, and project scope is the reliable path today.

## Pinning

Same as Claude Code: the pack publishes to `coalesce-labs/catalyst-skills` on every Catalyst release as an ordinary accumulating commit. See the [portable pack overview](/getting-started/install-portable/#pinning) for the full pinning story, including a real limitation in the `skills` CLI worth knowing about before you rely on it.
