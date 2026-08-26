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
- Never manually edit version.txt, plugin.json version, or manifest
- Release Please manages all versions via conventional commits
- Version lives in the two `plugin.json` files only (`.claude-plugin/plugin.json` and
  `.codex-plugin/plugin.json`, each plugin) — never in `pack.json`
- marketplace.json and the Codex catalog (`.agents/plugins/marketplace.json`) are discovery
  manifests only — they must NOT have version fields
- release-please updates version.txt and BOTH plugin.json files via extra-files, in the same commit
- All plugins share a single combined release PR (avoids manifest conflicts)
- Release PRs auto-merge via `--squash --auto` in the workflow

## Packaging (CTL-1463, CTL-1461)
- `plugins/<name>/pack.json` is hand-authored: identity and distribution targets. It carries everything except the version and per-skill neutral classification.
- Per-skill neutral classification (`effects`/`invocation`/`exposure`) lives in each skill's own `agents/portability.yaml` sidecar (CTL-1461) — never in `pack.json`. A skill with no sidecar is legal (`neutral: null`); it simply cannot reach a non-Claude target. A mutating skill (an effect in `file-write`/`shell-exec`) must declare `invocation: explicit` in its sidecar AND `disable-model-invocation: true` in its `SKILL.md` frontmatter — the invocation-parity rule (`core/safety-gate.mjs`) is a hard error at render time if the two vocabularies disagree.
- `.codex-plugin/`, `.agents/plugins/`, and `.agents/skills/` are **generated** by `bun scripts/packaging/cli.mjs render --target <name> --write` — never hand-edited. Each generated file/dir is `.gitattributes`-marked `linguist-generated`; skill dirs and each plugin's `.codex-plugin/` both carry a `.generated-by-catalyst-packaging` marker.
- `.claude-plugin/` stays hand-authored-then-Release-Please-versioned exactly as before — the packaging pipeline's Claude emitter only *regenerates* it (byte-identically) for verification; it is not the thing that edits it day to day.
- **The drift gate** (`packaging-gate.yml`, CTL-1461 Phase 3) regenerates all three targets on every PR and fails on ANY drift — both a tracked-file diff (`git diff --exit-code`) and a separate untracked-file check (`git status --porcelain`), since a diff-only gate is blind to a brand-new generated file nobody committed. If it fails: run `bun scripts/packaging/cli.mjs render --write --allow-losses` locally, review the diff, and commit the regenerated output.
