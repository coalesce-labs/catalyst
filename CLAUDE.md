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

### Pull request review (Codex)

The repo runs **Codex** (`chatgpt-codex-connector[bot]`) as an automated PR reviewer (this is the
concrete instance of the tool-agnostic "automated code reviewer" in `AGENTS.md` → "Pull requests").

- **Triggers:** PR opened for review, draft marked ready, or a `@codex review` comment — **not**
  every push. After a remediation push, request a re-review with `@codex review`.
- **Findings:** posted as inline **review threads** (P1/P2/P3). Resolve each via GraphQL
  `addPullRequestReviewThreadReply` + `resolveReviewThread` — never `--admin`.
- **No findings = a clean pass:** Codex reacts 👍 **or** posts an issue comment "Codex Review:
  Didn't find any major issues 🎉 / Reviewed commit: `<sha>`". This is a resolved review, not a
  missing one. Note the clean-pass result is an **issue comment / reaction**, not a `reviews` API
  node — so a `reviews{}`-only poll misses it; also check `issues/<n>/comments` and reactions.

### Code understanding (Serena MCP)

Serena is wired into the research/analysis agents for semantic code retrieval — see
`AGENTS.md` → "Code Understanding (Serena)" for what it is and how it's used. Register it
once per machine as a **user-scope** MCP (the absolute `serena` path lets restricted-`PATH`
`claude --bg` phase-agent workers launch it; the headless flags keep it browser-free on servers):

```bash
uv tool install -p 3.13 serena-agent
claude mcp add --scope user serena -- "$HOME/.local/bin/serena" start-mcp-server \
  --context claude-code --enable-web-dashboard False --enable-gui-log-window False
```

It connects with no startup project and activates lazily, so a fresh session connects fast and pays
the language-server startup cost only when an agent first calls `activate_project`.

### Always-loaded reference docs

`@`-imports are a Claude Code feature and load the file in full at session start (they do **not**
reduce context), so keep this list minimal. Architecture is the one doc worth keeping always-on;
ADRs and the release process are referenced by path in `AGENTS.md` for on-demand reading.

@docs/architecture.md
