# Act — one re-run, a scoped fix, or a precise "can't fix"

## Suspected flake → re-run once, and mean it

```bash
gh run rerun "$RUN_ID" --failed
```

Then wait — don't stand up a second poll loop here, use `wait-for-github`'s bounded-poll CI preset
(30s interval, 30 iterations, 15 min ceiling) against the new run. If it goes green, the
classification is confirmed and you're done. If it fails again, compare the failing test/step name
against the first attempt using the same log-extraction technique:

- **Same test, same failure shape** → treat as REAL now, no matter what class it looked like the
  first time. This is the AC's hard rule: a second identical failure is real. Fall through to the
  fix path below.
- **Different test, or the class-3 (contention) test now passes but something else timed out** →
  still worth one more look at whether it's still the same mechanism (e.g. contention shifted which
  test paid the uncached cost) before calling it real — but you've spent your one re-run; don't
  re-run again. Classify and act on what you have.

## Real failure → fix scoped to the failure, push, re-verify

1. Fix only what the failing test/assertion needs — this is triage, not a refactor pass on
   adjacent code.
2. If you can run the specific failing test locally, do it before pushing (cheaper feedback than
   another CI round-trip).
3. Commit with a conventional message describing the fix, push to the PR branch.
4. Re-enter `wait-for-github`'s bounded-poll (CI preset) on the new commit to confirm the check
   goes green. Report the outcome either way — don't assume green without checking.

## Can't fix it → say exactly why, don't guess

If the failure needs a product decision, credentials/infrastructure this session doesn't have, or
touches code outside what you can safely change without more context, stop and report precisely
what's missing — the same discipline `merge-blocker-diagnosis.md` uses for `review-required`:
name the specific gap, not a vague "couldn't fix it." Never force-push past a failing required
check and never suggest bypassing branch protection.

## The report

When invoked standalone, end with a structured block:

```text
CI TRIAGE
pr: #<N>
check: <check name>
run: <run_id> (rerun: <rerun_id or "none">)
classification: <flake-class-N-name | real | stale-head> — <one-line evidence citation>
action: <re-ran once, now green | fixed <file>, pushed <sha>, verified green | reported, needs: <what>>
status: <resolved | still red | blocked>
```

When invoked as a step inside another skill's flow (`merge-pr`'s blocker loop, a `relay-ticket`
phase), fold this into that flow's own report instead of emitting a second, competing one — the
caller owns the outer report shape; this skill's job is to hand back a clean verdict + action, not
to talk over it.
