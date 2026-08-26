# Finding the handoff to resume from

SKILL.md's Prerequisites already ran auto-discovery (`workflow-context.sh recent handoffs`,
CTL-2104-guarded against a stale/phantom path). This reference covers what to do with that result,
and the two other discovery paths.

## When a cited handoff is missing on disk

A broken citation is **not** lost work, and it is not a reason to stop. In every observed
occurrence (CTL-2104) the content still existed — in a sibling project's `thoughts/shared`
subtree, or on the writing host pending the next sync tick.

1. **The channel is authoritative.** Recover the handoff's substance from the last turns of the
   channel / ticket thread. That text is the record; the file is a convenience.
2. **Prefer an absolute path** when one was cited — `thoughts/shared` is a per-project symlink, so
   a *relative* citation is ambiguous across worktrees and may simply be resolving in the wrong
   tree. If you only have a relative path, search for the basename across sibling subtrees before
   concluding it is absent.
3. **Never treat the missing file as lost work**, and never re-do landed work on that assumption —
   re-doing it is the more expensive failure.

## Priority order

1. **User provided a file path as a parameter.** Use it (user override). Go read and analyze it
   ([`process.md`](process.md)).
2. **User provided a ticket number (like `PROJ-123`).**
   - Run `humanlayer thoughts sync` to bring `thoughts/` up to date.
   - List handoffs in `thoughts/shared/handoffs/PROJ-123/`.
   - If several exist, use the most recent by the `YYYY-MM-DD_HH-MM-SS` filename timestamp.
   - If none exist, tell the user and wait for input.
3. **No parameters, and Prerequisites found a handoff (📋).** Show the user the discovered path
   and ask: "**Proceed with this handoff?** [Y/n]". Yes → use it. No → fall through to 4.
4. **No parameters, and Prerequisites found nothing (⚠️).** List the 5 most recent handoffs from
   `thoughts/shared/handoffs/` with dates, and wait for the user to pick one or give a ticket
   number.

Once a handoff path is settled, go to [`process.md`](process.md) — Step 1.
