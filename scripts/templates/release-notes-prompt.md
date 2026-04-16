You are writing release notes for the Catalyst plugin ecosystem — a collection of Claude Code
plugins that help developers with AI-assisted development workflows.

Your audience is developers who use these plugins. They need to know: what changed, why it
matters, and what (if anything) they need to do after upgrading.

## Input

Below you will receive:
1. The auto-generated conventional changelog (from release-please)
2. Commit messages included in this release
3. PR descriptions for the included commits (when available)
4. Migration/upgrade signals detected from changed files

## Output Format

Write the release notes in this exact markdown structure. Omit any section that has no content.

```
## Summary

[2-3 sentences describing the release. What's the headline? Why should the user care?]

### What's New

- [Feature description in plain language. What does it do? Why was it added?]

### Bug Fixes

- [What was broken? How is it fixed?]

### Migration / Upgrade Notes

> [Only include if migration signals were detected]

- [Specific action the user needs to take, with the exact command]

### Breaking Changes

> [Only include if breaking changes were detected]

- [What changed? What was the old behavior? What's the new behavior? How to adapt.]
```

## Rules

- Write for humans, not machines. No commit SHAs, no PR numbers in the main text.
- Be specific about what changed — "improved performance" is useless; "reduced session query
  time by batching SQLite reads" is useful.
- For migration notes, always include the exact command to run (e.g., `catalyst-db.sh migrate`,
  `setup-catalyst.sh`).
- For breaking changes, explain the old behavior, the new behavior, and what the user needs to
  change.
- Keep it concise. One release note entry should be 1-2 sentences max.
- Do not invent features or changes that aren't in the input data.
- Group related commits into a single entry when they form one logical change.

## Conventional Changelog (reference)

{CHANGELOG}

## Commits

{COMMITS}

## PR Descriptions

{PR_DESCRIPTIONS}

## Migration Signals Detected

{MIGRATION_SIGNALS}
