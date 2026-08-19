# /goal Condition and Sweep SOP

## /goal condition — your self-evaluated stop condition

This is your **self-evaluated stop condition. There is no `/goal` command, and
none can be invoked from a skill or a `claude --bg` session.** Read the block
below as a plain-English success criterion that YOU check your own printed
resolution lines against — it is not handed to any evaluator.

PRINT a per-item resolution line carrying the proof signal — that is your own
audit record of the goal being met. The goal is the fleet condition — keep
iterating until it reads unequivocally TRUE.

```
/goal "THE BOARD IS MOVING. I am the delegate on watch — a senior operator reading
       the whole board the way the operator does — NOT an item-by-item resolver. The flagged
       stuck set is necessary but NOT sufficient: a clean flagged list while the
       board is frozen is still FAILURE. Concretely, ALL of:

       (1) HOLISTIC — I scanned the WHOLE board (Step -1) and there is no
           SILENT wedge. For each board-level invariant I confirmed it healthy or
           handled the violation:
             - dispatch is live: open worker slots are FILLING, not held while an
               eligible queue waits (the liveness-hold class — open slots + a
               waiting queue + ~0 dispatch is a wedge, even though no ticket emits
               a 'stuck' signal);
             - no worker is stuck far past normal for its phase;
             - the blocked-dependency tree is alive: nothing is blocked by a ticket
               that is itself unscheduled/stuck (walk the tree);
             - no project I own has gone silent;
             - we are not near a Linear/GitHub rate-limit cliff.
           Every anomaly I FIXED, or — if it is a system-wide change — ESCALATED
           with a briefing (Tier 3 below).

       (2) ITEMS — every item the deterministic eyes+hands flagged as YOURS (HRW-
           owned) is now UNSTUCK (resolved autonomously — rebased / resolved the
           conflict / merged the green PR / re-dispatched the dead phase / reconciled
           the orphan PR), LEAVE-ALONE-verdicted (reviewed healthy — the verdict
           EMITTED via recovery-emit, never just concluded), or ESCALATED. Before
           I ACT on any item I VERIFIED its LIVE Linear state (verify-before-act)
           — never the stale board cache. CONTEXT (another host's HRW-owned) items
           I read for awareness, never act on.

       (3) LEARNING — for anything I had to do that points at an automation gap —
           ESPECIALLY a daemon restart — I filed a finding in the Self-Healing
           Delegate Linear project (Tier-2 below).

       I PRINTED a resolution line per item AND per board anomaly, carrying the proof
       signal (the exit 0 / mergeable:MERGEABLE / merged SHA / re-dispatch event id /
       the finding's ticket id). A mere merge conflict / CI failure / stale branch /
       unmerged-green-PR / stale cache is NEVER an escalation — those are fixes. I
       escalate ONLY genuine value / architecture / trade-off / ADR / system-wide
       decisions."
```

## Sweep SOP — diagnose Catalyst yourself (no brief)

When the context script printed `MODE=sweep`, there is NO pre-written brief: YOU
reconstruct each item's diagnosis from the local sources before you act.

**Act on YOURS, not CONTEXT.** The script tags each item `YOURS` (you own it under
HRW — act on it) or `CONTEXT` (another host owns it). Read CONTEXT items for
context; never act on them in multiHost mode.

**The pipeline model.** Catalyst ships work through a 10-phase pipeline — triage →
research → plan → implement → verify → review → pr → monitor-merge →
monitor-deploy → teardown. Each phase runs as one short-lived `claude --bg` worker
and writes its state to `${ORCH_DIR}/workers/<ticket>/phase-*.json`.

**Where to look (per item).**

- **The worker signal** — `${ORCH_DIR}/workers/<ticket>/phase-*.json`: which phase,
  its `status`, its `failureReason`, and the `bg_job_id`.
- **The worker transcript** — `claude logs <shortId>` (the first 8 chars of the
  signal's `bg_job_id`): what the worker actually did and where it stopped.
- **The unified event log** — `~/catalyst/events/YYYY-MM.jsonl`: the surrounding
  phase/recovery events for this ticket (escalations, dispatches, completions).
- **The worktree** — `~/catalyst/wt/catalyst-workspace/<ticket>`: the live branch
  state — `git status`, `git log`, conflict markers, a half-finished rebase.
- **The PR** — `gh pr list --search <ticket>` then `gh pr view <n> --json
  mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`.
- **The Linear cache** — the `linear-state=…` / `labels=…` the context script
  printed for the item (orientation snapshot only; always verify by reading the
  ticket via direct SQL against the replica before acting).

**Then diagnose like a senior engineer.** From those: what phase is it in? what
failed — a conflict, a failed check, a dead worker, an un-merged green PR, a
stalled dispatch? Write yourself the one-line diagnosis the brief would have
carried, then drop into the Step-1/2 fix loop below (skip Step 0's "consume
the brief" — you just built it yourself).

**Verify the work, not the status (CTL-1214).** When an item is BLOCKED on a
dependency marked Done, OR itself claims completion but is stuck, do NOT trust the
Done/complete status. Verify the deliverable actually SHIPPED: (a) was a PR whose
SCOPE matches the ticket's deliverable merged to main — check the merged PR's
actual diff (`gh pr view <n> --json files,title` / `gh pr diff <n>`), not just
that *a* PR closed it (an unrelated PR merged under its number is the trap —
e.g. CTL-1214 was marked Done but a cluster-installer PR merged under its number;
its config-reader migration never shipped, wedging SLI-17/OTL-13); and (b) does
the claimed code/artifact actually exist on main (grep/read it)? A "Done" ticket
whose deliverable never shipped is a real finding, not a clean dependency.

**What to do when it didn't ship.** If you can confidently ship the small missing
piece yourself, do it (FIX). If the missing deliverable is load-bearing (a
schema/config migration, a structural change), escalate as a `decision` — reopen
the falsely-Done ticket and ship it first, vs authorize me to do the migration now
— with the inbox+push authored (Step 4). A falsely-Done load-bearing dependency
meets the "serious architecture change" / "genuinely cannot proceed autonomously"
bar; it is NOT a mechanical conflict to merge past.
