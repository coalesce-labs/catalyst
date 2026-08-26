# Metadata, Results, and Error Handling

## Metadata header format

```markdown
<!-- Auto-generated: 2025-10-06T10:00:00Z -->
<!-- Last updated: 2025-10-06T15:30:00Z -->
<!-- PR: #123 -->
<!-- Previous commits: abc123,def456,ghi789,jkl012 -->

---

**Update History:**

- 2025-10-06 15:30: Added error handling, fixed tests (2 commits)
- 2025-10-06 10:00: Initial implementation (2 commits)

---
```

Each subsequent call detects new commits since the last update, appends changes to the right sections, reruns verification, preserves manual edits (reviewer notes, screenshots, checked boxes), and adds an entry to the update history log.

## Step 14 — Communicate the outcome

**First-time generation:**

```
✅ PR description generated!

**PR**: #123 - {title}
**URL**: {url}
**Verification**: {X}/{Y} automated checks passed
**Linear**: {ticket} updated

Manual verification steps remaining:
- [ ] Test feature in staging
- [ ] Verify UI on mobile

Review PR on GitHub!
```

**Incremental update:**

```
✅ PR description updated!

**Changes since last update**: 3 new commits — added validation logic, updated tests
**Verification**: {X}/{Y} automated checks passed
**Sections updated**: Summary, Changes Made, How to Verify It
**Sections preserved**: Reviewer Notes, Screenshots

Review updated PR: {url}
```

## Error handling

- **No PR found** → list open PRs, ask the user which to describe.
- **Template missing** → warn, generate without it.
- **Verification fails** → mark failed checks with the error, continue with the description.

## Configuration

Uses `.catalyst/config.json`:

```json
{
  "catalyst": {
    "project": { "ticketPrefix": "PROJ" },
    "linear": { "teamKey": "PROJ", "stateMap": { "inReview": "In Review" } },
    "pr": { "testCommand": "make test", "lintCommand": "make lint", "buildCommand": "make build" }
  }
}
```

State names come from `stateMap` with sensible defaults; see `.catalyst/config.json` for all keys.
