# Merge Descriptions and Generate the Title (Steps 6–9)

## Step 6 — Merge descriptions intelligently

**Auto-generated sections (always regenerate from ALL changes):** Summary, Changes Made, How to Verify It, Changelog Entry.

**Preserve manual edits in:** Reviewer Notes, Screenshots/Videos, manually checked boxes, Post-Merge Tasks (append new, keep existing).

Merge new content into existing sections rather than overwriting them wholesale — e.g. append a "**New changes** (since last update):" subsection under each area that changed. Add a change-summary block at the top listing what happened in each update (see the metadata format in [metadata-and-errors.md](metadata-and-errors.md)).

## Step 7 — Add the Linear reference

```markdown
## Related Issues/PRs

- Fixes https://linear.app/{workspace}/issue/{ticket}
- Related to #NNN (reference sibling work by its **GitHub PR number**)
```

**Never** reference a sibling ticket by a bare Linear token or issue URL in prose — see [linear-sibling-guard.md](linear-sibling-guard.md) for why, and for the mechanical guard block that neutralizes any sibling tokens the description still ends up carrying. The own ticket's `Fixes` line above is correct and intentional; only sibling references need this treatment.

Get the ticket's title/description via direct SQL against the replica (see the `linearis` skill's "Reading Linear" section) for context.

## Step 8 — Generate the updated title

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh"
if [[ "$ticket" ]]; then
    ticket_title=$(linear_read_ticket "$ticket" 2>/dev/null | jq -r '.title // empty')
    if [[ -n "$ticket_title" ]]; then
        title="$ticket: ${ticket_title:0:60}"
    else
        title="$ticket: $(echo "$branch" | sed "s/^.*$ticket-//" | tr '-' ' ')"
    fi
else
    title="Brief summary of main change"
fi
```

`linear_read_ticket` is replica-first with a loud `linearis` fallback (CTL-1397) — never a bare `linearis issues read`. Title is an auto-generated section: update it without prompting.
