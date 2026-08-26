# Write-back — resolutions into the briefing markdown

Before ending the session, persist the recorded resolutions into the briefing markdown's
frontmatter `resolutions:` block and append a "## Decisions Made Today" section to the body. The
script commits to the routine-scoped branch when running inside the morning-briefing routine's
writable clone, and emits a `briefing.followup.complete.<date>` event so the next morning's
briefing can surface yesterday's decisions as carryovers.

```bash
WRITEBACK_RESULT=$(bash "$SCRIPT_DIR/writeback.sh" \
  --briefing "$BRIEFING_PATH" \
  --resolutions "$LOG_DIR/briefing-followup-$DATE-resolutions.json" \
  --date "$DATE" 2>&1)

WRITEBACK_STATUS=$(echo "$WRITEBACK_RESULT" | jq -r '.status // "failed"')
case "$WRITEBACK_STATUS" in
  updated)
    COMMIT_SHA=$(echo "$WRITEBACK_RESULT" | jq -r '.commit_sha // "none"')
    echo "Wrote resolutions back to $BRIEFING_PATH (commit: $COMMIT_SHA)"
    ;;
  skipped)
    REASON=$(echo "$WRITEBACK_RESULT" | jq -r '.reason // "no resolutions"')
    echo "Skipped write-back: $REASON"
    ;;
  *)
    echo "Write-back failed: $WRITEBACK_RESULT" >&2
    ;;
esac
```

## Flags

| Flag | Meaning |
|---|---|
| `--no-commit` | Update the markdown in place but do not run `git commit`. |
| `--no-push` | Commit but do not push. Default in cloud routine mode is push. |
| `--no-event` | Skip emitting `briefing.followup.complete.<date>`. |
| `--events-dir DIR` | Override the event log dir (defaults to `$CATALYST_DIR/events`). |

## Idempotence

Re-running with the same resolutions file produces the same markdown: the previous "## Decisions
Made Today" block is stripped before the new one is appended, and the `resolutions:` array is
replaced rather than amended.

## Phase history

- Phase 1 (CTL-462): load, parse, walk with placeholder approve/reject/defer.
- Phase 2 (CTL-463): action handlers — calendar, ticket, dispatch, email.
- Phase 3 (CTL-464): ADR-drift resolution (`action-adr.sh`).
- Phase 4 (CTL-465, this write-back step): resolutions write-back to the briefing frontmatter.
- Compound engineering (CTL-789): `pending:` decisions route to `action-compound.sh`.
