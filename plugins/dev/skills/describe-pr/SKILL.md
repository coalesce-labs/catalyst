---
name: describe-pr
description:
  "Generate or update PR description with incremental changes. **ALWAYS use when** the user says
  'describe the PR', 'update PR description', 'generate PR description', or after pushing new
  commits to an existing PR. Supports incremental updates that preserve manual edits."
disable-model-invocation: false
allowed-tools: Bash, Read, Write
version: 2.0.0
---

# Generate/Update PR Description

Generates or updates a PR description with incremental information, auto-updates the title, and
links the Linear ticket — fully automated, no interactive prompts.

## Prerequisites

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## No Claude attribution

Never write "Generated with Claude Code", "Co-Authored-By: Claude", or any AI-assistance reference
into a PR title or body. Descriptions are professional and attributed to the human author.

## Process overview

1. **Read the template, identify the PR, extract its ticket, gather its diff/commits/checks.** See
   [process.md](references/process.md).
2. **Merge the new analysis into the existing description** (regenerate auto-generated sections,
   preserve manual edits), **add the Linear reference, generate the title.** See
   [merge-and-title.md](references/merge-and-title.md) — sibling tickets are referenced by GitHub
   PR number, never a bare Linear token; see
   [linear-sibling-guard.md](references/linear-sibling-guard.md) for why.
3. **Run verification checks, save to `thoughts/shared/prs/`, write the description and title back
   to GitHub** (appending the CTL-623/633 sibling-skip guard block), **update the Linear ticket.**
   See [verify-and-writeback.md](references/verify-and-writeback.md).
4. **Report the outcome** — first-time generation vs. incremental update. See
   [metadata-and-errors.md](references/metadata-and-errors.md), which also covers error handling
   and configuration.

## Configuration

Uses `.catalyst/config.json` (`teamKey`, `stateMap.inReview`, `pr.testCommand` etc.) — see
[metadata-and-errors.md](references/metadata-and-errors.md) for the full schema.

## Load on demand

| Situation | Reference |
|---|---|
| Identify PR, extract ticket, read existing description, gather diff/commits/checks | [process.md](references/process.md) |
| Merge descriptions, add Linear reference, generate title | [merge-and-title.md](references/merge-and-title.md) |
| Why sibling tickets are referenced by PR number, not a bare Linear token | [linear-sibling-guard.md](references/linear-sibling-guard.md) |
| Verification checks, save/sync, write back to GitHub, update Linear | [verify-and-writeback.md](references/verify-and-writeback.md) |
| Metadata header format, result templates, error handling, config schema | [metadata-and-errors.md](references/metadata-and-errors.md) |

## Remember

- Fully automated — no interactive prompts, incremental updates preserve manual edits.
- For Linearis CLI syntax and the direct-SQLite read rule (reads → replica, writes → linearis),
  see the `linearis` skill's "Reading Linear" section.
