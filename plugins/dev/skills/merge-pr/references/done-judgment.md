# Done-judgment — verify the ticket is genuinely done, not just this PR

Relocated from the retired `phase-teardown` daemon phase-agent (CTL-2223; the original was CTL-1157),
with the worker-dir/signal-file/`open-pr-gate.mjs` daemon plumbing stripped down to the judgment
rubric itself. Applies at Step 10 of this skill (Linear ticket → Done) whenever a ticket plausibly
has more than one PR against it.

**Do not trust "this PR merged" as proof the ticket is done.** A ticket can have more than one PR: a
second slice, a human PR opened outside the automated flow, an abandoned spike from an earlier
attempt. The PR you just merged is only the one you were tracking — marking Done while another open
PR is still part of the solution is silent rot.

## Step 1 — Enumerate the ticket's other open PRs

Search both by ticket key and by any Linear attachment, since a PR can reference the ticket without
the key in its title:

```bash
gh pr list --search "${TICKET} in:title,body" --state open --json number,title,url,headRepository
```

Also check the ticket's Linear attachments for PR links (`linearis issues show <TICKET>` or the
replica) — a PR attached to the ticket may not mention the ticket key anywhere in its own title/body.

**If this enumeration cannot be completed** (search failed, `gh` auth/rate-limit error, an attached
PR you can't view) — that is **unverifiable, not clean**. Do not treat a failed check as "no open PR
remains." Retry, check by hand, or hold the Done transition and say why.

## Step 2 — Reason about every open PR found, and resolve it yourself

- **Still needed / part of the solution** → finish it (rebase, fix CI, merge) before marking Done.
  Don't tear down with deliverable work still unmerged.
- **Abandoned / superseded** (a later PR replaced it, a dead spike, a duplicate) → close it yourself:
  `gh pr close <n> -R <owner/repo> --comment "<why — superseded by #X / abandoned / duplicate of #Y>"`.
  Closing a dead PR is autonomous, not an escalation.
- **Cross-repo PR** — when the enumerator prints a PR as `owner/repo#n` (a different repo than the
  one you're working in), target that repo explicitly on **every** `gh pr` call:
  `gh pr merge <n> -R <owner/repo> …` / `gh pr close <n> -R <owner/repo> …`. A bare `gh pr close <n>`
  runs against your current repo and can close or merge the wrong same-numbered PR there while
  leaving the actual `owner/repo#n` open.
- **Genuine judgment call** (the open PR conflicts with an ADR/principle, or you can't safely decide
  needed-vs-abandoned) → do not mark Done. Report the concrete reason so a human can decide — this is
  the rare case; every mechanically-resolvable PR you finish or close yourself.

## Step 3 — Only then, transition to Done

Once no open PR remains that *should* remain, proceed with the ticket's Done transition and any
cleanup. A ticket torn down with an open PR still attached is exactly the failure this rubric exists
to prevent — if you skip it, there is nothing left to catch the silent rot.
