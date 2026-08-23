# Flags, Error Handling, and Examples

## Flags

**`--skip-tests`** — Skip local test execution.
**`--no-update`** — Don't update Linear ticket.
**`--keep-branch`** — Don't delete local branch.

```bash
/catalyst-dev:merge-pr 123
/catalyst-dev:merge-pr 123 --skip-tests
/catalyst-dev:merge-pr 123 --no-update
/catalyst-dev:merge-pr 123 --keep-branch
/catalyst-dev:merge-pr 123 --skip-tests --no-update
```

## Error handling

For all errors, provide clear messages with the specific error, what went wrong, and how to fix
it. **Never give up with a generic message** — always diagnose the specific cause and provide
actionable next steps.

**Fail fast (stop execution):**
- Rebase conflicts → show conflicting files, instructions to resolve manually, then re-run
- Test failures → show failed tests, suggest fix or `--skip-tests`
- PR not open/mergeable → show current state

**Diagnose and attempt to fix (Step 6 blocker loop):**
- CI checks failing → analyze failure, attempt code fix, re-push, re-poll
- Unresolved threads → run `/review-comments`, resolve threads
- Branch behind → rebase and push
- Draft PR → mark as ready
- Changes requested → check if addressed, suggest re-request review
- Infrastructure failures → suggest re-run, provide log URL

**Escalate with specifics (never generic):**
- Review required → tell user exactly how many approvals needed and who to request
- Unresolvable conflicts → list specific files and what conflicts exist
- Unknown blockers → query branch protection rules and list every requirement with its status

**Never suggest:**
- Force merge, admin override, or disabling branch protection
- Skipping required checks or reviews
- Any workaround that bypasses the protection rather than satisfying it

**Warn but continue (graceful degradation):**
- Linearis CLI not found → warn, suggest install, merge proceeds
- Linear API error → warn, merge proceeds
- Branch deletion error → warn, merge already succeeded

## Remember

- **Never bypass branch protection** — diagnose and resolve blockers legitimately
- **Always squash merge** — clean history
- **Always delete branches** — no orphan branches
- **Always run tests** — unless explicitly skipped
- **Auto-rebase** — keep up-to-date with base
- **Diagnose, don't give up** — identify specific blockers and fix or explain them
- **Update Linear** — move ticket to Done automatically (if Linearis available)
- **Graceful degradation** — work without Linearis if needed
- For Linearis CLI syntax, see the `linearis` skill reference
