@AGENTS.md

## Claude Code

This is the Claude Code bridge file. All portable project guidance lives in
`AGENTS.md` (imported above). Add **only** genuinely Claude-Code-specific notes
below — if a note applies to any agent, it belongs in `AGENTS.md` instead. (A CI
lint enforces that this file's first line is `@AGENTS.md` and that `AGENTS.md`
stays tool-agnostic.)

### Loading & invocation

- Plugins are surfaced via `.claude/` symlinks; restart Claude Code to reload after editing
  `plugins/*/`. Changes are distributed via the Claude Code plugin marketplace.
- Invoke skills with the slash prefix: `/plugin-name:skill-name` (e.g. `/catalyst-dev:create-plan`).

### Orchestration runtime

- Phase-agent workers run as `claude --bg` jobs; the legacy oneshot mode runs a long-lived
  `claude -p /catalyst-legacy:oneshot` per ticket.

### Always-loaded reference docs

`@`-imports are a Claude Code feature and load the file in full at session start (they do **not**
reduce context), so keep this list minimal. Architecture is the one doc worth keeping always-on;
ADRs and the release process are referenced by path in `AGENTS.md` for on-demand reading.

@docs/architecture.md
