---
title: Contributing
description: How to contribute to Catalyst — reporting issues, creating workflows, and sharing patterns.
---

Catalyst is a personal workflow workspace shared for learning and inspiration. Contributions are welcome in specific forms.

## Ways to Contribute

### Report Issues

Found a bug or something broken? Open an issue on [GitHub](https://github.com/coalesce-labs/catalyst/issues).

### Share Ideas

Have workflow suggestions or improvement ideas? Open a discussion or issue to share your thinking.

### Fork and Adapt

The best way to contribute is to fork Catalyst, adapt it to your needs, and share what you learned. Different teams have different workflows — your adaptations might inspire new patterns.

### Fix Bugs

If something's broken, PRs for bug fixes are welcome.

## What to Expect

This is a personal workflow workspace optimized for the maintainer's development style. PRs that change core workflows or add features that aren't personally used may not be accepted. That's not a rejection of the idea — it's just that this repo needs to stay aligned with daily use.

## Creating New Workflows

See [Creating Workflows](/contributing/creating-workflows/) for the complete guide to creating agents and commands, including the frontmatter standard.

## Release Strategy

Catalyst uses **Release Please** for automated per-plugin releases with conventional commit messages.

### How Releases Work

1. Merge PRs to main with conventional commit titles
2. Release Please opens release PRs — one per affected plugin
3. Merge a release PR to create: git tag, GitHub Release, updated CHANGELOG, bumped versions

### Commit Conventions

| Prefix | Effect | Example |
|--------|--------|---------|
| `feat(dev):` | Minor bump for catalyst-dev | `feat(dev): add new command` |
| `fix(pm):` | Patch bump for catalyst-pm | `fix(pm): correct cycle calculation` |
| `feat(dev)!:` | Major bump (breaking change) | `feat(dev)!: redesign plan format` |
| `chore(meta):` | No version bump | `chore(meta): update docs` |

### Updating Your Installation

```bash
claude plugin marketplace update catalyst
```

Check per-plugin changelogs in the sidebar for detailed release notes.

## Code of Conduct

Be respectful, constructive, and focused on improving the craft of AI-assisted development.

## License

MIT — use it however you want.
