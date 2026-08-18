# Stalls — noticing, nudging, escalating

## What a stall is

A ticket that has been in **one phase for more than 45 minutes** with no new comment, no state change and
no push. That is the default threshold; the long phases are the exceptions, not the rule:

| phase | expect | stalled at |
| -- | -- | -- |
| triage, plan, research, review | minutes | 45 min |
| implement | tens of minutes | 60 min |
| pr, verify, remediate | minutes | 45 min |
| monitor-merge, monitor-deploy | as long as CI/deploy takes — these **legitimately** sit | 90 min with no CI event |
| teardown | minutes | 30 min |

⚠️ **A monitor phase sitting quietly is usually correct** — it is waiting on GitHub. Before calling it a
stall, check whether the thing it waits for has happened. A wedged CI job and a slow one look identical
in the PR view; the discriminator is that workflow's own recent durations, not your patience.

## ⛔ A stall with no nudge in its thread is your defect

This is the failure that motivated the rule. On 2026-08-18 two dispatched tickets sat in Triage from
11:24 to 12:47 — 83 minutes. The coordinator was explicitly asked for an in-thread nudge. **No nudge was
ever posted.** Both tickets eventually moved on their own, which is the worst possible outcome: it makes
the gap invisible and teaches everyone the nudge was unnecessary.

The nudge costs one comment. Not posting it costs the only signal anyone has that the scope is watched.

## The nudge

Threaded on **that ticket**, not in your plan thread:

> `steward/<scope>`: this has been in `<phase>` for `<N>` min with no activity. If you are blocked, say
> what on — in this thread. If you are working, one line on where you are is enough. If this ticket is
> wrong (bad ACs, retired surface, missing dependency) say so and I will fix it rather than you working
> around it.

Then add the ticket to the status doc's **In flight** row with the stall noted. A stall the human can see
in one screen is a stall nobody has to ask about.

## Escalating

1. **Nudge** in-thread (above).
2. **Second miss on the same item** → escalate to the concierge on the channel, naming the ticket, the
   phase, the elapsed time and what you already tried.
3. **Needs a decision** → an ask ticket, and proceed on the default.

⛔ **Never escalate straight to the human.** The ladder is instrument → steward → concierge → human, and
the human is only ever reached as an ask. A bare `needs-human` label with no ask behind it puts a row in
their queue that nothing can clear.

## When the instrument pages you

Board-health and the stalled-PR sweep page **you** first, in-thread, tagged `instrument/<name>`. Treat the
page as data, not as a verdict: verify the item is actually stalled before acting, then act, nudge, or
convert it into an ask. An instrument that reached you correctly and was ignored twice will escalate over
your head — that is the design, not a punishment.
