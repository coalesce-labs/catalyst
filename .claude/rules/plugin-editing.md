---
paths: ["plugins/**"]
---

# Plugin Editing Rules

## Skills Format
- All user-facing functionality goes in `skills/*/SKILL.md`
- No `commands/` directories — skills only
- SKILL.md frontmatter requires: `name`, `description`
- User-invoked skills: add `disable-model-invocation: true`
- CI/background skills: add `user-invocable: false`
- Use `allowed-tools` (not `tools`) for tool restrictions
- Do NOT include `model` or `category` in frontmatter

## Agent Format
- Agents live in `agents/*.md`
- Frontmatter requires: `name`, `description`, `tools`

## Testing
1. Edit files in `plugins/*/`
2. Restart Claude Code (symlinks make changes immediate)
3. Invoke skill/agent to verify

## Versioning
- Never manually edit version.txt, marketplace.json versions, or manifest
- Release Please manages all versions via conventional commits
- Version lives in marketplace.json only (not plugin.json) per Claude Code docs for relative-path plugins
